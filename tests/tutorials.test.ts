import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express, { type Request } from "express";
import type { AddressInfo } from "node:net";
import type { AuthenticatedRequest, AuthUser } from "../server/lib/auth";
import {
  WORKBENCH_TUTORIAL_KEY,
  WORKBENCH_TUTORIAL_VERSION,
  parseTutorialReceiptState,
} from "../src/tutorials/tutorialContract";
import { resetPostgresTestDatabase } from "./postgresTestDatabase";
import {
  isWorkbenchTutorialBlocking,
  setWorkbenchTutorialBlocking,
} from "../src/tutorials/tutorialRuntime";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-tutorials-"));
process.env.DATA_DIR = temp;
process.env.SQLITE_IMPORT_FILE = "missing.db";
process.env.INITIAL_ADMIN_ACCOUNT_ID = "tutorial-admin";
process.env.INITIAL_ADMIN_PASSWORD = "Initial1234";

await resetPostgresTestDatabase();
const { closeDatabaseForTests, initializeDatabase, query, queryOne } = await import("../server/lib/database");
const { tutorialsRouter } = await import("../server/routes/tutorials");
const { authRouter } = await import("../server/routes/auth");
const { requireAuth, requirePasswordChanged, SESSION_COOKIE } = await import("../server/lib/auth");

const users: Record<string, AuthUser> = {
  owner: {
    id: "tutorial-owner",
    accountId: "tutorial-owner",
    displayName: "教程用户",
    role: "user",
    mustChangePassword: false,
  },
  other: {
    id: "tutorial-other",
    accountId: "tutorial-other",
    displayName: "另一用户",
    role: "user",
    mustChangePassword: false,
  },
};

await initializeDatabase();
const now = new Date().toISOString();
for (const user of Object.values(users)) {
  await query(`
    INSERT INTO users (
      id, account_id, display_name, role, password_hash, must_change_password,
      active, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, 'test-only', 0, 1, $5, $5)
  `, [user.id, user.accountId, user.displayName, user.role, now]);
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  const user = users[String(req.headers["x-test-user"] ?? "")];
  if (!user) {
    res.status(401).json({ error: "test user required" });
    return;
  }
  (req as AuthenticatedRequest).authUser = user;
  next();
});
app.use("/tutorials", tutorialsRouter);

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const address = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${address.port}`;

function request(pathname: string, user: keyof typeof users, init: RequestInit = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-test-user": user,
      ...init.headers,
    },
  });
}

async function state(user: keyof typeof users) {
  const response = await request("/tutorials/workbench-onboarding", user);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return parseTutorialReceiptState(await response.json());
}

async function acknowledge(
  user: keyof typeof users,
  outcome: "dismissed" | "completed",
  tutorialVersion = WORKBENCH_TUTORIAL_VERSION,
) {
  return request("/tutorials/workbench-onboarding/acknowledge", user, {
    method: "POST",
    body: JSON.stringify({
      tutorialKey: WORKBENCH_TUTORIAL_KEY,
      tutorialVersion,
      outcome,
    }),
  });
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("V1.2.0 版本化教程回执测试");

setWorkbenchTutorialBlocking(true);
assert.equal(isWorkbenchTutorialBlocking(), true);
setWorkbenchTutorialBlocking(false);
assert.equal(isWorkbenchTutorialBlocking(), false);
const appSource = fs.readFileSync(path.resolve("src/App.tsx"), "utf8");
assert.match(appSource, /if \(isWorkbenchTutorialBlocking\(\)\) return;/);
console.log("  ✓ 教程显示期间阻断工作台全局保存、撤销、复制和粘贴快捷键");

await test("现有账号没有 V1.2.0 回执时必须显示教程", async () => {
  assert.deepEqual(await state("owner"), {
    tutorialKey: WORKBENCH_TUTORIAL_KEY,
    tutorialVersion: WORKBENCH_TUTORIAL_VERSION,
    acknowledged: false,
    outcome: null,
    acknowledgedAt: null,
  });
});

await test("旧版本回执不会跳过 V1.2.0", async () => {
  await query(`
    INSERT INTO user_tutorial_receipts (
      user_id, tutorial_key, tutorial_version, outcome, acknowledged_at
    ) VALUES ($1, $2, 'V1.0.0', 'completed', $3)
  `, [users.owner.id, WORKBENCH_TUTORIAL_KEY, now]);
  assert.equal((await state("owner")).acknowledged, false);
});

await test("接口拒绝伪造的未来版本和错误教程标识", async () => {
  assert.equal((await acknowledge("owner", "completed", "V9.9.9")).status, 400);
  const wrongKey = await request("/tutorials/workbench-onboarding/acknowledge", "owner", {
    method: "POST",
    body: JSON.stringify({
      tutorialKey: "another-tutorial",
      tutorialVersion: WORKBENCH_TUTORIAL_VERSION,
      outcome: "completed",
    }),
  });
  assert.equal(wrongKey.status, 400);
  assert.equal((await state("owner")).acknowledged, false);
});

await test("显式关闭后刷新仍返回 dismissed，且不同账号隔离", async () => {
  const response = await acknowledge("owner", "dismissed");
  assert.equal(response.status, 200);
  const dismissed = parseTutorialReceiptState(await response.json());
  assert.equal(dismissed.outcome, "dismissed");
  assert.equal((await state("owner")).outcome, "dismissed");
  assert.equal((await state("other")).acknowledged, false);
});

await test("完成结果优先且不能降级为 dismissed", async () => {
  const completedResponse = await acknowledge("owner", "completed");
  assert.equal(completedResponse.status, 200);
  const completed = parseTutorialReceiptState(await completedResponse.json());
  assert.equal(completed.outcome, "completed");
  const completedAt = completed.acknowledgedAt;
  assert.ok(completedAt);

  const downgradeResponse = await acknowledge("owner", "dismissed");
  assert.equal(downgradeResponse.status, 200);
  const protectedState = parseTutorialReceiptState(await downgradeResponse.json());
  assert.equal(protectedState.outcome, "completed");
  assert.equal(protectedState.acknowledgedAt, completedAt);
});

await test("修改密码前后不创建、完成或重置教程回执", async () => {
  const realApp = express();
  realApp.use(express.json({ limit: "1mb" }));
  realApp.use("/api/auth", authRouter);
  realApp.use("/api", requireAuth, requirePasswordChanged);
  realApp.use("/api/tutorials", tutorialsRouter);
  const realServer = realApp.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    realServer.once("listening", resolve);
    realServer.once("error", reject);
  });
  try {
    const realAddress = realServer.address() as AddressInfo;
    const realBase = `http://127.0.0.1:${realAddress.port}`;
    const login = await fetch(`${realBase}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "tutorial-admin", password: "Initial1234" }),
    });
    assert.equal(login.status, 200, await login.text());
    let cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));

    const firstChange = await fetch(`${realBase}/api/auth/change-password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ currentPassword: "Initial1234", newPassword: "Tutorial1234" }),
    });
    assert.equal(firstChange.status, 200, await firstChange.text());
    cookie = firstChange.headers.get("set-cookie")?.split(";")[0] ?? "";

    const unseen = await fetch(`${realBase}/api/tutorials/workbench-onboarding`, {
      headers: { cookie },
    });
    assert.equal(unseen.status, 200);
    assert.equal(parseTutorialReceiptState(await unseen.json()).acknowledged, false);

    const complete = await fetch(`${realBase}/api/tutorials/workbench-onboarding/acknowledge`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        tutorialKey: WORKBENCH_TUTORIAL_KEY,
        tutorialVersion: WORKBENCH_TUTORIAL_VERSION,
        outcome: "completed",
      }),
    });
    assert.equal(complete.status, 200, await complete.text());

    const secondChange = await fetch(`${realBase}/api/auth/change-password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ currentPassword: "Tutorial1234", newPassword: "Tutorial5678" }),
    });
    assert.equal(secondChange.status, 200, await secondChange.text());
    cookie = secondChange.headers.get("set-cookie")?.split(";")[0] ?? "";

    const preserved = await fetch(`${realBase}/api/tutorials/workbench-onboarding`, {
      headers: { cookie },
    });
    assert.equal(preserved.status, 200);
    assert.equal(parseTutorialReceiptState(await preserved.json()).outcome, "completed");
  } finally {
    await new Promise<void>((resolve, reject) => {
      realServer.close((error) => error ? reject(error) : resolve());
    });
  }
});

await test("删除用户时教程回执随用户级联删除", async () => {
  const receiptCount = await queryOne<{ count: number }>(`
    SELECT COUNT(*)::int AS count FROM user_tutorial_receipts WHERE user_id = $1
  `, [users.owner.id]);
  assert.equal(receiptCount?.count, 2);
  await query("DELETE FROM users WHERE id = $1", [users.owner.id]);
  const afterDelete = await queryOne<{ count: number }>(`
    SELECT COUNT(*)::int AS count FROM user_tutorial_receipts WHERE user_id = $1
  `, [users.owner.id]);
  assert.equal(afterDelete?.count, 0);
});

const authSource = fs.readFileSync(path.resolve("server/routes/auth.ts"), "utf8");
const authContextSource = fs.readFileSync(path.resolve("src/auth/AuthContext.tsx"), "utf8");
assert.doesNotMatch(authSource, /tutorial|onboarding/i);
assert.doesNotMatch(authContextSource, /tutorial|onboarding/i);
console.log("  ✓ 教程状态未混入改密接口、/api/auth/me 或 CurrentUser");

await new Promise<void>((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});
await closeDatabaseForTests();
fs.rmSync(temp, { recursive: true, force: true });
console.log(`完成：${passed + 2} 项教程回归测试通过`);

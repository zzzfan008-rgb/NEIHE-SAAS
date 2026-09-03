import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Request } from "express";
import express from "express";
import type { AddressInfo } from "node:net";
import { resetPostgresTestDatabase } from "./postgresTestDatabase";
import type { ExecutionPlan } from "../src/types/workflow";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-auth-"));
process.env.DATA_DIR = temp;
process.env.SQLITE_IMPORT_FILE = "missing.db";
process.env.INITIAL_ADMIN_ACCOUNT_ID = "test-admin";
process.env.INITIAL_ADMIN_PASSWORD = "Initial1234";

await resetPostgresTestDatabase();
const { closeDatabaseForTests, db, initializeDatabase, query, queryOne } = await import("../server/lib/database");
const { authenticateRequest, authenticatedUser, createSession, SESSION_COOKIE } = await import("../server/lib/auth");
const { authRouter } = await import("../server/routes/auth");
const { purgeExpiredProjects } = await import("../server/routes/projects");
const { verifyPassword } = await import("../server/lib/password");
const {
  completeGenerationRecord, createGenerationRecord, failGenerationRecord, registerGeneratedFiles,
} = await import("../server/lib/generationRecords");
const { createRun } = await import("../server/engine/runner");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("用户、会话与 PostgreSQL 消耗存储回归测试");
await initializeDatabase();
const admin = await queryOne<Record<string, unknown>>("SELECT * FROM users WHERE account_id = $1", ["test-admin"]);
assert.ok(admin);
let replacedToken = "";
let activeToken = "";

await test("首次启动从私密环境创建管理员且强制改密", () => {
  assert.equal(admin.role, "admin");
  assert.equal(admin.must_change_password, 1);
  assert.equal(verifyPassword("Initial1234", String(admin.password_hash)), true);
  assert.equal(String(admin.password_hash).includes("Initial1234"), false);
});

await test("单账号新登录会使旧设备会话失效", async () => {
  const first = await createSession(String(admin.id));
  replacedToken = first.token;
  const firstRequest = { headers: { cookie: `${SESSION_COOKIE}=${first.token}` } } as Request;
  assert.equal((await authenticatedUser(firstRequest))?.id, admin.id);
  const second = await createSession(String(admin.id));
  activeToken = second.token;
  const secondRequest = { headers: { cookie: `${SESSION_COOKIE}=${second.token}` } } as Request;
  assert.equal(await authenticatedUser(firstRequest), undefined);
  assert.equal((await authenticateRequest(firstRequest)).status, "replaced");
  assert.equal((await authenticatedUser(secondRequest))?.id, admin.id);
  const count = await queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM sessions WHERE user_id = $1", [admin.id]);
  assert.equal(count?.count, 1);
});

await test("改密式会话轮换不会把同一浏览器旧 token 误标为其他设备替换", async () => {
  const previousToken = activeToken;
  const rotated = await createSession(String(admin.id), { markExistingAsReplaced: false });
  activeToken = rotated.token;
  const previousRequest = { headers: { cookie: `${SESSION_COOKIE}=${previousToken}` } } as Request;
  assert.deepEqual(await authenticateRequest(previousRequest), { status: "unauthenticated" });
});

await test("服务启动后会周期清理过期与已撤销会话", () => {
  const source = fs.readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  assert.match(source, /setInterval\([\s\S]*pruneExpiredSessions/);
  assert.match(source, /sessionPruneTimer\.unref\(\)/);
});

await test("认证 401 不清 Cookie，旧设备仍收到明确替换原因且显式退出会清理", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/api/auth/me`;
    const protectedEndpoint = `http://127.0.0.1:${address.port}/api/auth/users`;
    const protectedResponse = await fetch(protectedEndpoint, {
      headers: { cookie: `${SESSION_COOKIE}=${replacedToken}` },
    });
    assert.equal(protectedResponse.status, 401);
    assert.equal(protectedResponse.headers.get("set-cookie"), null);

    const forcedPasswordAdmin = await fetch(protectedEndpoint, {
      headers: { cookie: `${SESSION_COOKIE}=${activeToken}` },
    });
    assert.equal(forcedPasswordAdmin.status, 403);
    assert.equal(((await forcedPasswordAdmin.json()) as { code: string }).code, "PASSWORD_CHANGE_REQUIRED");

    const replaced = await fetch(endpoint, { headers: { cookie: `${SESSION_COOKIE}=${replacedToken}` } });
    assert.equal(replaced.status, 401);
    assert.equal(replaced.headers.get("cache-control"), "no-store");
    assert.equal(replaced.headers.get("set-cookie"), null);
    assert.deepEqual(await replaced.json(), {
      error: "账号已在其他设备登录",
      code: "SESSION_REPLACED",
    });

    const active = await fetch(endpoint, { headers: { cookie: `${SESSION_COOKIE}=${activeToken}` } });
    assert.equal(active.status, 200);
    assert.equal(active.headers.get("cache-control"), "no-store");
    assert.equal(((await active.json()) as { user: { id: string } }).user.id, admin.id);

    const anonymous = await fetch(endpoint);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get("cache-control"), "no-store");
    assert.equal(anonymous.headers.get("set-cookie"), null);
    assert.equal(((await anonymous.json()) as { code: string }).code, "UNAUTHENTICATED");

    const logout = await fetch(endpoint.replace(/\/me$/, "/logout"), {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${activeToken}` },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") ?? "", /^gc_session=;/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

await test("同一账号并发登录均正常响应且最终仅保留一个有效设备", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}/api/auth`;
    const login = () => fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "test-admin", password: "Initial1234" }),
    });
    const responses = await Promise.all([login(), login()]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    const cookies = responses.map((response) => response.headers.get("set-cookie")?.split(";")[0] ?? "");
    assert.ok(cookies.every(Boolean));
    const meResponses = await Promise.all(cookies.map((cookie) => fetch(`${base}/me`, { headers: { cookie } })));
    assert.deepEqual(meResponses.map((response) => response.status).sort(), [200, 401]);
    const count = await queryOne<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM sessions WHERE user_id = $1",
      [admin.id],
    );
    assert.equal(count?.count, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

await test("账号数据转移会化解重复付费请求号而不触发唯一键冲突", async () => {
  const sourceId = "transfer-source";
  const targetId = "transfer-target";
  const createdAt = new Date().toISOString();
  await query("UPDATE users SET must_change_password = 0 WHERE id = $1", [admin.id]);
  await query(`
    INSERT INTO users (id, account_id, display_name, role, password_hash, active, created_at, updated_at)
    VALUES
      ($1, 'transfer-source', '转出账号', 'user', 'test-only', 1, $3, $3),
      ($2, 'transfer-target', '接收账号', 'user', 'test-only', 1, $3, $3)
  `, [sourceId, targetId, createdAt]);
  await query(`
    INSERT INTO generation_runs (
      id, owner_id, node_id, node_label, kind, requested_count, status, started_at,
      client_request_id, request_fingerprint
    ) VALUES
      ('transfer-source-run', $1, 'source-node', '源任务', 'ai-modify', 1, 'failed', 1,
       'shared-transfer-request', 'source-fingerprint'),
      ('transfer-target-run', $2, 'target-node', '目标任务', 'ai-modify', 1, 'failed', 2,
       'shared-transfer-request', 'target-fingerprint')
  `, [sourceId, targetId]);

  const adminSession = await createSession(String(admin.id), { markExistingAsReplaced: false });
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/users/${sourceId}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${adminSession.token}`,
      },
      body: JSON.stringify({ transferToUserId: targetId }),
    });
    assert.equal(response.status, 200, await response.text());
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  const rows = await query<{
    id: string;
    owner_id: string;
    client_request_id: string | null;
    request_fingerprint: string | null;
  }>(`
    SELECT id, owner_id, client_request_id, request_fingerprint
    FROM generation_runs WHERE id IN ('transfer-source-run', 'transfer-target-run')
    ORDER BY id
  `);
  assert.deepEqual(rows, [
    {
      id: "transfer-source-run",
      owner_id: targetId,
      client_request_id: null,
      request_fingerprint: null,
    },
    {
      id: "transfer-target-run",
      owner_id: targetId,
      client_request_id: "shared-transfer-request",
      request_fingerprint: "target-fingerprint",
    },
  ]);
});

await test("账号转移不会合并出超过安全恢复上限的活动任务", async () => {
  const sourceId = "transfer-capacity-source";
  const targetId = "transfer-capacity-target";
  const createdAt = new Date().toISOString();
  await query(`
    INSERT INTO users (id, account_id, display_name, role, password_hash, active, created_at, updated_at)
    VALUES
      ($1, $1, '容量转出账号', 'user', 'test-only', 1, $3, $3),
      ($2, $2, '容量接收账号', 'user', 'test-only', 1, $3, $3)
  `, [sourceId, targetId, createdAt]);
  await query(`
    INSERT INTO generation_runs (
      id, owner_id, node_id, node_label, kind, requested_count, status, started_at, plan_json
    )
    SELECT 'transfer-capacity-source-' || index, $1, 'source-node-' || index,
      '源活动任务', 'ai-modify', 1, 'queued', index, '{"steps":[]}'
    FROM generate_series(1, 91) AS index
    UNION ALL
    SELECT 'transfer-capacity-target-' || index, $2, 'target-node-' || index,
      '目标活动任务', 'ai-modify', 1, 'running', 1000 + index, '{"steps":[]}'
    FROM generate_series(1, 90) AS index
  `, [sourceId, targetId]);

  const adminSession = await createSession(String(admin.id), { markExistingAsReplaced: false });
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/users/${sourceId}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${adminSession.token}`,
      },
      body: JSON.stringify({ transferToUserId: targetId }),
    });
    const body = await response.text();
    assert.equal(response.status, 409, body);
    assert.match(body, /活动任务.*180/);
    assert.deepEqual(await queryOne<{ active: number; deleted_at: string | null }>(`
      SELECT active, deleted_at FROM users WHERE id = $1
    `, [sourceId]), { active: 1, deleted_at: null });
    assert.equal((await queryOne<{ count: number }>(`
      SELECT COUNT(*)::int AS count FROM generation_runs WHERE owner_id = $1
    `, [sourceId]))?.count, 91);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await query("DELETE FROM generation_runs WHERE owner_id = ANY($1::text[])", [[sourceId, targetId]]);
    await query("DELETE FROM users WHERE id = ANY($1::text[])", [[sourceId, targetId]]);
  }
});

await test("仍有活动生成任务的账号不能直接删除", async () => {
  const userId = "delete-active-user";
  const runId = "delete-active-run";
  const createdAt = new Date().toISOString();
  await query(`
    INSERT INTO users (id, account_id, display_name, role, password_hash, active, created_at, updated_at)
    VALUES ($1, $1, '活动任务账号', 'user', 'test-only', 1, $2, $2)
  `, [userId, createdAt]);
  await query(`
    INSERT INTO generation_runs (
      id, owner_id, node_id, node_label, kind, requested_count, status, started_at, plan_json
    ) VALUES ($1, $2, 'active-node', '活动任务', 'ai-modify', 1, 'queued', 1, '{"steps":[]}')
  `, [runId, userId]);

  const adminSession = await createSession(String(admin.id), { markExistingAsReplaced: false });
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/users/${userId}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${adminSession.token}`,
      },
      body: JSON.stringify({ deleteData: true }),
    });
    const body = await response.text();
    assert.equal(response.status, 409, body);
    assert.match(body, /生成任务.*结束|取消任务/);
    assert.deepEqual(await queryOne<{ active: number; deleted_at: string | null }>(`
      SELECT active, deleted_at FROM users WHERE id = $1
    `, [userId]), { active: 1, deleted_at: null });
    assert.equal((await queryOne<{ deleted_at: string | null }>(`
      SELECT deleted_at FROM generation_runs WHERE id = $1
    `, [runId]))?.deleted_at, null);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await query("DELETE FROM generation_runs WHERE id = $1", [runId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
  }
});

await test("升级遗留且没有执行计划的 queued 记录不会永久阻止账号删除", async () => {
  const userId = "delete-legacy-queued-user";
  const runId = "delete-legacy-queued-run";
  const createdAt = new Date().toISOString();
  await query(`
    INSERT INTO users (id, account_id, display_name, role, password_hash, active, created_at, updated_at)
    VALUES ($1, $1, '旧队列账号', 'user', 'test-only', 1, $2, $2)
  `, [userId, createdAt]);
  await query(`
    INSERT INTO generation_runs (
      id, owner_id, node_id, node_label, kind, requested_count, status, started_at
    ) VALUES ($1, $2, 'legacy-node', '旧队列任务', 'ai-modify', 1, 'queued', 1)
  `, [runId, userId]);

  const adminSession = await createSession(String(admin.id), { markExistingAsReplaced: false });
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/users/${userId}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${adminSession.token}`,
      },
      body: JSON.stringify({ deleteData: true }),
    });
    assert.equal(response.status, 200, await response.text());
    assert.ok((await queryOne<{ deleted_at: string | null }>(`
      SELECT deleted_at FROM generation_runs WHERE id = $1
    `, [runId]))?.deleted_at);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await query("DELETE FROM generation_runs WHERE id = $1", [runId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
  }
});

await test("账号转移等待 Worker 行锁时不会触发表锁升级死锁", async () => {
  const sourceId = "transfer-worker-source";
  const targetId = "transfer-worker-target";
  const runId = "transfer-worker-run";
  const fileId = "transfer-worker-file.png";
  const createdAt = new Date().toISOString();
  await query(`
    INSERT INTO users (id, account_id, display_name, role, password_hash, active, created_at, updated_at)
    VALUES
      ($1, $1, 'Worker 转出账号', 'user', 'test-only', 1, $3, $3),
      ($2, $2, 'Worker 接收账号', 'user', 'test-only', 1, $3, $3)
  `, [sourceId, targetId, createdAt]);
  await query(`
    INSERT INTO generation_runs (
      id, owner_id, node_id, node_label, kind, requested_count, status, started_at, plan_json
    ) VALUES ($1, $2, 'worker-node', 'Worker 任务', 'ai-modify', 1, 'queued', 1, '{"steps":[]}')
  `, [runId, sourceId]);

  const worker = await db().connect();
  const adminSession = await createSession(String(admin.id), { markExistingAsReplaced: false });
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  let transferResponse: Promise<Response> | undefined;
  try {
    await worker.query("BEGIN");
    await worker.query("SELECT id FROM generation_runs WHERE id = $1 FOR UPDATE", [runId]);
    const address = server.address() as AddressInfo;
    transferResponse = fetch(`http://127.0.0.1:${address.port}/api/auth/users/${sourceId}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${adminSession.token}`,
      },
      body: JSON.stringify({ transferToUserId: targetId }),
    });

    const deadline = Date.now() + 3_000;
    let transferIsWaiting = false;
    while (Date.now() < deadline) {
      transferIsWaiting = Boolean(await queryOne(`
        SELECT 1 FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND query LIKE '%UPDATE generation_runs SET owner_id%'
      `));
      if (transferIsWaiting) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(transferIsWaiting, true, "账号转移应等待 Worker 持有的 Run 行锁");

    // Worker 已持有行锁后仍应能取得 UPDATE 所需表锁；旧的表级转移锁会在这里形成死锁环。
    await worker.query("UPDATE generation_runs SET status = 'running' WHERE id = $1", [runId]);
    // 文件 owner 外键会对 users 取 KEY SHARE；账号事务必须使用兼容的
    // NO KEY UPDATE 用户锁，否则这里会与它等待中的 Run 行锁形成死锁。
    await worker.query(`
      INSERT INTO files (id, owner_id, source_type, run_id, created_at)
      VALUES ($1, $2, 'generated', $3, $4)
    `, [fileId, sourceId, runId, createdAt]);
    await worker.query("COMMIT");
    const response = await transferResponse;
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(await queryOne<{ owner_id: string; status: string }>(`
      SELECT owner_id, status FROM generation_runs WHERE id = $1
    `, [runId]), { owner_id: targetId, status: "running" });
    assert.equal((await queryOne<{ owner_id: string }>(`
      SELECT owner_id FROM files WHERE id = $1
    `, [fileId]))?.owner_id, targetId, "等待期间新登记的文件也必须被转移");
  } finally {
    await worker.query("ROLLBACK").catch(() => undefined);
    worker.release();
    if (transferResponse) await transferResponse.catch(() => undefined);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await query("DELETE FROM files WHERE id = $1", [fileId]);
    await query("DELETE FROM generation_runs WHERE id = $1", [runId]);
    await query("DELETE FROM users WHERE id = ANY($1::text[])", [[sourceId, targetId]]);
  }
});

await test("删除账号时全部业务数据进入 15 天回收期并在到期后清理", async () => {
  const userId = "retention-user";
  const createdAt = new Date().toISOString();
  await query("UPDATE users SET must_change_password = 0 WHERE id = $1", [admin.id]);
  await query(`
    INSERT INTO users (id, account_id, display_name, role, password_hash, active, created_at, updated_at)
    VALUES ($1, 'retention-user', '待删除用户', 'user', 'test-only', 1, $2, $2)
  `, [userId, createdAt]);
  await query(`
    INSERT INTO projects (id, owner_id, name, flow_json, updated_at, created_at)
    VALUES ('retention-project', $1, '待删除项目', '{"schemaVersion":1,"nodes":[],"edges":[]}', $2, $2)
  `, [userId, createdAt]);
  await query(`
    INSERT INTO files (id, owner_id, source_type, project_id, run_id, created_at)
    VALUES ('retention.png', $1, 'generated', 'retention-project', 'retention-run', $2)
  `, [userId, createdAt]);
  await query(`
    INSERT INTO assets (id, owner_id, scope, name, category, image, created_at)
    VALUES ('retention-asset', $1, 'private', '待删除素材', 'reference', '/api/files/retention.png', $2)
  `, [userId, createdAt]);
  await query(`
    INSERT INTO generation_runs (
      id, owner_id, project_id, node_id, node_label, kind, requested_count,
      successful_count, provider_requests, status, started_at, finished_at
    ) VALUES ('retention-run', $1, 'retention-project', 'node', '节点', 'ai-modify', 1, 1, 1, 'success', 1, 2)
  `, [userId]);
  await query(`
    INSERT INTO usage_events (
      id, owner_id, run_id, project_id, node_id, successful_count,
      provider_requests, duration_ms, created_at
    ) VALUES ('retention-usage', $1, 'retention-run', 'retention-project', 'node', 1, 1, 1, $2)
  `, [userId, createdAt]);
  const uploads = path.join(temp, "uploads");
  fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(path.join(uploads, "retention.png"), "test");

  const adminSession = await createSession(String(admin.id), { markExistingAsReplaced: false });
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/users/${userId}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${adminSession.token}`,
      },
      body: JSON.stringify({ deleteData: true }),
    });
    assert.equal(response.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  for (const table of ["projects", "assets", "files", "generation_runs", "usage_events"] as const) {
    const row = await queryOne<{ deleted_at: string | null; purge_after: string | null }>(
      `SELECT deleted_at, purge_after FROM ${table} WHERE owner_id = $1`,
      [userId],
    );
    assert.ok(row?.deleted_at, `${table} should be tombstoned`);
    assert.ok(row?.purge_after, `${table} should have a purge deadline`);
  }

  const expired = new Date(Date.now() - 1_000).toISOString();
  for (const table of ["projects", "assets", "files", "generation_runs", "usage_events"] as const) {
    await query(`UPDATE ${table} SET purge_after = $1 WHERE owner_id = $2`, [expired, userId]);
  }
  await purgeExpiredProjects();
  for (const table of ["projects", "assets", "files", "generation_runs", "usage_events"] as const) {
    assert.equal((await queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${table} WHERE owner_id = $1`,
      [userId],
    ))?.count, 0, `${table} should be purged`);
  }
  assert.equal(fs.existsSync(path.join(uploads, "retention.png")), false);
});

await test("到期清理保留仍被其他项目引用的素材文件", async () => {
  const createdAt = new Date().toISOString();
  const expired = new Date(Date.now() - 1_000).toISOString();
  await query(`
    INSERT INTO users (id, account_id, display_name, role, password_hash, active, created_at, updated_at)
    VALUES ('retention-consumer', 'retention-consumer', '引用用户', 'user', 'test-only', 1, $1, $1)
  `, [createdAt]);
  await query(`
    INSERT INTO projects (id, owner_id, name, flow_json, updated_at, created_at)
    VALUES ('retention-consumer-project', 'retention-consumer', '引用项目', '{"schemaVersion":1,"nodes":[],"edges":[]}', $1, $1)
  `, [createdAt]);
  await query(`
    INSERT INTO files (id, owner_id, source_type, created_at, deleted_at, purge_after)
    VALUES ('referenced-retention.png', 'retention-user', 'asset', $1, $1, $2)
  `, [createdAt, expired]);
  await query(`
    INSERT INTO assets (
      id, owner_id, scope, name, category, image, created_at, deleted_at, purge_after
    ) VALUES (
      'referenced-retention-asset', 'retention-user', 'shared', '仍被引用', 'reference',
      '/api/files/referenced-retention.png', $1, $1, $2
    )
  `, [createdAt, expired]);
  await query(`
    INSERT INTO project_asset_refs (project_id, asset_id, created_at)
    VALUES ('retention-consumer-project', 'referenced-retention-asset', $1)
  `, [createdAt]);

  await purgeExpiredProjects();
  assert.ok(await queryOne("SELECT id FROM files WHERE id = 'referenced-retention.png'"));
  assert.ok(await queryOne("SELECT id FROM assets WHERE id = 'referenced-retention-asset'"));
});

await test("删除管理员后仍保留有效通用素材及其底层文件", async () => {
  const ownerId = "global-asset-admin";
  const fileId = "global-retention.png";
  const createdAt = new Date().toISOString();
  await query(`
    INSERT INTO users (id, account_id, display_name, role, password_hash, active, created_at, updated_at)
    VALUES ($1, 'global-asset-admin', '素材管理员', 'admin', 'test-only', 1, $2, $2)
  `, [ownerId, createdAt]);
  await query(`
    INSERT INTO files (id, owner_id, source_type, created_at)
    VALUES ($1, $2, 'asset', $3)
  `, [fileId, ownerId, createdAt]);
  await query(`
    INSERT INTO assets (id, owner_id, scope, name, category, image, created_at)
    VALUES ('global-retention-asset', NULL, 'global', '有效通用素材', 'reference', $1, $2)
  `, [`/api/files/${fileId}`, createdAt]);
  const uploads = path.join(temp, "uploads");
  fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(path.join(uploads, fileId), "global");

  const adminSession = await createSession(String(admin.id), { markExistingAsReplaced: false });
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/users/${ownerId}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        cookie: `${SESSION_COOKIE}=${adminSession.token}`,
      },
      body: JSON.stringify({ deleteData: true }),
    });
    assert.equal(response.status, 200, await response.text());
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  const expired = new Date(Date.now() - 1_000).toISOString();
  await query("UPDATE files SET purge_after = $1 WHERE id = $2", [expired, fileId]);
  await purgeExpiredProjects();

  assert.ok(await queryOne("SELECT id FROM assets WHERE id = 'global-retention-asset' AND deleted_at IS NULL"));
  assert.ok(await queryOne("SELECT id FROM files WHERE id = $1", [fileId]));
  assert.equal(fs.existsSync(path.join(uploads, fileId)), true);
});

await test("成功图片写消耗流水，失败任务不写消耗", async () => {
  await createGenerationRecord("run-success", {
    userId: String(admin.id), nodeId: "node", nodeLabel: "AI 改款", kind: "ai-modify", requestedCount: 2,
  }, 1000);
  await completeGenerationRecord({
    runId: "run-success", images: ["/api/files/a.png"], model: "stub", providerRequests: 3,
    startedAt: 1000, finishedAt: 2000,
  });
  await createGenerationRecord("run-failure", {
    userId: String(admin.id), nodeId: "node", nodeLabel: "AI 改款", kind: "ai-modify", requestedCount: 1,
  }, 3000);
  await failGenerationRecord("run-failure", "timeout", 4000);
  const rows = await query<Record<string, unknown>>(
    "SELECT run_id, successful_count, provider_requests FROM usage_events ORDER BY run_id",
  );
  assert.deepEqual(rows, [{ run_id: "run-success", successful_count: 1, provider_requests: 3 }]);
});

await test("执行计划中的中间生成图片也登记用户和节点归属", async () => {
  const context = {
    userId: String(admin.id), projectId: "project-1", nodeId: "target", nodeLabel: "结果", kind: "result", requestedCount: 1,
  };
  await registerGeneratedFiles(context, "run-success", "upstream-ai", ["/api/files/intermediate.png"], 5000);
  const file = await queryOne<Record<string, unknown>>(
    "SELECT owner_id, project_id, node_id, run_id FROM files WHERE id = $1",
    ["intermediate.png"],
  );
  assert.deepEqual(file, {
    owner_id: admin.id,
    project_id: "project-1",
    node_id: "upstream-ai",
    run_id: "run-success",
  });
});

async function waitForRun(run: { finished: boolean; emitter: { once: (event: string, listener: () => void) => void } }): Promise<void> {
  if (run.finished) return;
  await new Promise<void>((resolve) => run.emitter.once("finish", resolve));
}

function plan(...steps: ExecutionPlan["steps"]): ExecutionPlan {
  return { steps };
}

await test("运行在前置节点失败时会结束记录而不是永久 queued", async () => {
  const run = await createRun(
    plan(
      { nodeId: "upstream", kind: "ai-modify", inputImages: [], params: {} },
      { nodeId: "target", kind: "result", inputImages: [], params: {} },
    ),
    String(admin.id),
    { userId: String(admin.id), nodeId: "target", nodeLabel: "结果", kind: "result", requestedCount: 1 },
  );
  await waitForRun(run);
  const row = await queryOne<{ status: string }>("SELECT status FROM generation_runs WHERE id = $1", [run.id]);
  assert.equal(row?.status, "error");
});

await test("下游失败不会让已提前完成的目标记录假 success", async () => {
  const run = await createRun(
    plan(
      { nodeId: "target", kind: "image-input", inputImages: [], params: {} },
      {
        nodeId: "downstream", kind: "ai-modify", inputImages: [],
        upstream: [{ nodeId: "target", images: [] }], params: {},
      },
    ),
    String(admin.id),
    { userId: String(admin.id), nodeId: "target", nodeLabel: "目标", kind: "image-input", requestedCount: 1 },
  );
  await waitForRun(run);
  const row = await queryOne<{ status: string }>("SELECT status FROM generation_runs WHERE id = $1", [run.id]);
  assert.equal(row?.status, "error");
});

await test("成功的多 AI 节点按整次运行汇总 provider_requests", async () => {
  const originalFetch = globalThis.fetch;
  process.env.APIYI_BASE_URL = "https://provider.test";
  process.env.APIYI_API_KEY = "test-key";
  globalThis.fetch = async () => Response.json({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" }] });
  try {
    const run = await createRun(
      plan(
        { nodeId: "first", kind: "sketch-to-render", inputImages: [], params: {} },
        { nodeId: "second", kind: "sketch-to-render", inputImages: [], params: {} },
        { nodeId: "target", kind: "result", inputImages: [], upstream: [
          { nodeId: "first", images: [] }, { nodeId: "second", images: [] },
        ], params: {} },
      ),
      String(admin.id),
      { userId: String(admin.id), nodeId: "target", nodeLabel: "结果", kind: "result", requestedCount: 1 },
    );
    await waitForRun(run);
    const row = await queryOne<{ status: string; provider_requests: number }>(
      "SELECT status, provider_requests FROM generation_runs WHERE id = $1", [run.id],
    );
    assert.equal(row?.status, "success");
    assert.equal(row?.provider_requests, 2);

    const uploads = path.join(temp, "uploads");
    const filesBeforeFailedRun = new Set(fs.readdirSync(uploads));
    const failed = await createRun(
      plan(
        { nodeId: "paid-upstream", kind: "sketch-to-render", inputImages: [], params: {} },
        {
          nodeId: "too-many-inputs", kind: "ai-modify", inputImages: [],
          upstream: Array.from({ length: 9 }, () => ({ nodeId: "paid-upstream", images: [] })),
          params: {},
        },
      ),
      String(admin.id),
      {
        userId: String(admin.id), nodeId: "too-many-inputs", nodeLabel: "下游",
        kind: "ai-modify", requestedCount: 1,
      },
    );
    await waitForRun(failed);
    assert.equal((await queryOne<{ status: string }>(
      "SELECT status FROM generation_runs WHERE id = $1", [failed.id],
    ))?.status, "error");
    assert.equal((await queryOne<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM files WHERE run_id = $1", [failed.id],
    ))?.count, 0);
    assert.deepEqual(new Set(fs.readdirSync(uploads)), filesBeforeFailedRun);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

console.log(`\n通过 ${passed} 项`);
await closeDatabaseForTests();
fs.rmSync(temp, { recursive: true, force: true });

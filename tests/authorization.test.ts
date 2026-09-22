import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express, { type Request } from "express";
import type { AddressInfo } from "node:net";
import type { AuthenticatedRequest, AuthUser } from "../server/lib/auth";
import { resetPostgresTestDatabase } from "./postgresTestDatabase";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-authorization-"));
process.env.DATA_DIR = temp;
process.env.SQLITE_IMPORT_FILE = "missing.db";
process.env.INITIAL_ADMIN_ACCOUNT_ID = "authorization-admin";
process.env.INITIAL_ADMIN_PASSWORD = "Initial1234";

await resetPostgresTestDatabase();
const { closeDatabaseForTests, db, initializeDatabase, query, queryOne } = await import("../server/lib/database");
const { deleteStoredImage, uploadsDir } = await import("../server/lib/fileStore");
const { createSession, SESSION_COOKIE } = await import("../server/lib/auth");
const { createRun } = await import("../server/engine/runner");
const { buildExecutionPlan } = await import("../server/engine/dag");
const { createExecutionInputFingerprint } = await import("../server/lib/executionInputFingerprint");
const { authRouter } = await import("../server/routes/auth");
const { runPlanRouter } = await import("../server/routes/runPlan");
const { generateRouter } = await import("../server/routes/generate");
const { assetsRouter } = await import("../server/routes/assets");
const { filesRouter } = await import("../server/routes/files");
const { drawingBoardsRouter } = await import("../server/routes/drawingBoards");
const {
  initialDraftProjectName,
  projectsRouter,
  purgeExpiredProjects,
} = await import("../server/routes/projects");
const { usageRouter } = await import("../server/routes/usage");
const { historyRouter } = await import("../server/routes/history");
const { ensureBuiltinTemplates, templatesRouter } = await import("../server/routes/templates");
const { tryOnStylePresetsRouter } = await import("../server/routes/tryOnStylePresets");
const { migrateLegacyData } = await import("../server/lib/legacyMigration");
const {
  migrateLegacyUserTemplateOwners,
  prepareUserTemplateAccountMutation,
  reconcileUserTemplateAccountMutations,
} = await import("../server/lib/userTemplateLifecycle");

const users: Record<string, AuthUser> = {
  owner: {
    id: "user-owner",
    accountId: "owner",
    displayName: "Owner",
    role: "user",
    mustChangePassword: false,
  },
  other: {
    id: "user-other",
    accountId: "other",
    displayName: "Other",
    role: "user",
    mustChangePassword: false,
  },
  admin: {
    id: "user-admin",
    accountId: "admin",
    displayName: "Admin",
    role: "admin",
    mustChangePassword: false,
  },
};

let passed = 0;
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function flow(images: string[] = []) {
  return {
    schemaVersion: 1,
    nodes: images.map((imageUrl, index) => ({
      id: `image_${index}`,
      type: "image-input",
      position: { x: index * 100, y: 0 },
      data: {
        kind: "image-input",
        label: `图片 ${index + 1}`,
        status: "idle",
        imageRole: "default",
        imageUrl,
      },
    })),
    edges: [],
  };
}

function generationFlow(prompt: string) {
  return {
    schemaVersion: 2,
    nodes: [{
      id: "generate",
      type: "sketch-to-render",
      position: { x: 0, y: 0 },
      data: {
        kind: "sketch-to-render",
        label: "生成效果图",
        status: "idle",
        modelId: "gemini-3.1-flash-image",
        modelOptions: { aspectRatio: "1:1", imageSize: "1K" },
        prompt,
        aspectRatio: "1:1",
        batchSize: 1,
        outputImages: [],
      },
    }],
    edges: [],
  };
}

function editFlow(imageUrl: string) {
  return {
    schemaVersion: 2,
    nodes: [
      {
        id: "source",
        type: "image-input",
        position: { x: 0, y: 0 },
        data: {
          kind: "image-input",
          label: "原图",
          status: "idle",
          imageRole: "default",
          imageUrl,
        },
      },
      {
        id: "edit",
        type: "ai-modify",
        position: { x: 320, y: 0 },
        data: {
          kind: "ai-modify",
          label: "改款",
          status: "idle",
          modelId: "gpt-image-2-vip",
          modelOptions: { size: "2048x2048" },
          prompt: "改成短袖",
          aspectRatio: "1:1",
          batchSize: 1,
          outputImages: [],
        },
      },
    ],
    edges: [{ id: "source-edit", source: "source", target: "edit" }],
  };
}

await initializeDatabase();
const now = new Date().toISOString();
for (const user of Object.values(users)) {
  await query(`
    INSERT INTO users (id, account_id, display_name, role, password_hash, active, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'test-only', 1, $5, $5)
  `, [user.id, user.accountId, user.displayName, user.role, now]);
}
const legacyTemplateId = "legacy-unowned-template";
const legacyTemplateDir = path.join(temp, "templates", "user");
fs.mkdirSync(legacyTemplateDir, { recursive: true });
fs.writeFileSync(path.join(legacyTemplateDir, `${legacyTemplateId}.json`), JSON.stringify({
  schemaVersion: 1,
  id: legacyTemplateId,
  name: "历史无归属模板",
  description: "升级后应归属原始管理员",
  flow: flow(),
  createdAt: now,
}));
assert.equal(await migrateLegacyUserTemplateOwners(), 1);
const legacyTemplateOwner = await queryOne<{ id: string }>(`
  SELECT id FROM users
  WHERE deleted_at IS NULL
  ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, created_at ASC, id ASC
  LIMIT 1
`);
assert.equal(
  (JSON.parse(fs.readFileSync(path.join(legacyTemplateDir, `${legacyTemplateId}.json`), "utf8")) as { ownerId?: string }).ownerId,
  legacyTemplateOwner?.id,
);
const adminSession = await createSession(users.admin.id, { markExistingAsReplaced: false });

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
app.use("/auth", authRouter);
app.use("/run-plan", runPlanRouter);
app.use("/generate", generateRouter);
app.use("/assets", assetsRouter);
app.use("/files", filesRouter);
app.use("/projects", projectsRouter);
app.use("/drawing-boards", drawingBoardsRouter);
app.use("/usage", usageRouter);
app.use("/history", historyRouter);
app.use("/templates", templatesRouter);
app.use("/try-on-style-presets", tryOnStylePresetsRouter);

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

async function waitForDatabaseCondition(
  description: string,
  condition: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待数据库条件超时：${description}`);
}

function directGenerateBody(referenceImage: string, projectId?: string, clientRequestId = "direct-request") {
  return {
    clientRequestId,
    modelId: "gpt-image-2-vip",
    kind: "ai-modify",
    projectId,
    projectName: "客户端伪造名称",
    nodeId: "direct-edit",
    request: {
      prompt: "改成短袖",
      aspectRatio: "1:1",
      batchSize: 1,
      referenceImages: [referenceImage],
      modelOptions: { size: "2048x2048" },
    },
  };
}

console.log("运行任务与素材引用授权回归测试");

await test("色彩收藏由服务端按账号隔离、规范化并跨会话读取", async () => {
  const ownerSession = await createSession(users.owner.id, { markExistingAsReplaced: false });
  const otherSession = await createSession(users.other.id, { markExistingAsReplaced: false });
  const authenticatedRequest = (
    pathname: string,
    user: "owner" | "other",
    token: string,
    init: RequestInit = {},
  ) => {
    const headers = {
      ...Object.fromEntries(new Headers(init.headers).entries()),
      cookie: `${SESSION_COOKIE}=${token}`,
    };
    return request(pathname, user, { ...init, headers });
  };
  try {
    const releaseId = "d".repeat(64);
    const pantoneA = {
      catalogId: "c".repeat(64), releaseId, libraryKey: "pantone-tcx",
      code: "11-1000 TCX", hex: "#AABBCC",
    };
    const pantoneB = {
      catalogId: "b".repeat(64), releaseId, libraryKey: "pantone-tcx",
      code: "11-1001 TCX", hex: "#AABBCC",
    };
    await query("INSERT INTO color_catalog_releases(id, created_at, color_count) VALUES ($1, $2, 2)", [releaseId, new Date().toISOString()]);
    for (const color of [pantoneA, pantoneB]) {
      await query("INSERT INTO color_catalog_identities(id, library_key, code) VALUES ($1, $2, $3)", [color.catalogId, color.libraryKey, color.code]);
      await query(`
        INSERT INTO color_catalog_versions(release_id, color_id, status, hex, hue, out_of_gamut, data)
        VALUES ($1, $2, 'ready', $3, 'neutral', FALSE, '{}'::jsonb)
      `, [releaseId, color.catalogId, color.hex]);
    }
    const ownerSave = await authenticatedRequest("/auth/color-preferences", "owner", ownerSession.token, {
      method: "PUT",
      body: JSON.stringify({ favorites: ["#abc", "rgb(255, 0, 0)", "#AABBCC"] }),
    });
    const ownerSaveText = await ownerSave.text();
    assert.equal(ownerSave.status, 200, ownerSaveText);
    assert.deepEqual((JSON.parse(ownerSaveText) as { favorites: string[] }).favorites, ["#AABBCC", "#FF0000"]);

    const ownerRead = await authenticatedRequest("/auth/color-preferences", "owner", ownerSession.token);
    assert.equal(ownerRead.status, 200);
    assert.equal(ownerRead.headers.get("cache-control"), "no-store");
    assert.deepEqual(await ownerRead.json(), {
      ownerId: users.owner.id, favorites: ["#AABBCC", "#FF0000"],
      pantoneFavorites: [], initialized: true,
    });
    assert.deepEqual(await (await authenticatedRequest("/auth/color-preferences", "other", otherSession.token)).json(), {
      ownerId: users.other.id,
      favorites: [],
      pantoneFavorites: [],
      initialized: false,
    });

    const otherSave = await authenticatedRequest("/auth/color-preferences", "other", otherSession.token, {
      method: "PUT",
      body: JSON.stringify({ favorites: ["hsl(240,100%,50%)"] }),
    });
    const otherSaveText = await otherSave.text();
    assert.equal(otherSave.status, 200, otherSaveText);
    assert.deepEqual((JSON.parse(otherSaveText) as { favorites: string[] }).favorites, ["#0000FF"]);
    assert.deepEqual((await query<{ user_id: string; favorite_colors: string[] }>(`
      SELECT user_id, favorite_colors FROM user_color_preferences ORDER BY user_id
    `)).map((row) => ({ userId: row.user_id, favorites: row.favorite_colors })), [
      { userId: users.other.id, favorites: ["#0000FF"] },
      { userId: users.owner.id, favorites: ["#AABBCC", "#FF0000"] },
    ]);

    const ignoredReplacement = await authenticatedRequest("/auth/color-preferences", "owner", ownerSession.token, {
      method: "PUT",
      body: JSON.stringify({ favorites: ["#00FF00"] }),
    });
    assert.deepEqual((await ignoredReplacement.json() as { favorites: string[] }).favorites, ["#AABBCC", "#FF0000"]);

    const patchFavorite = (color: string, favorite: boolean) => authenticatedRequest(
      "/auth/color-preferences", "owner", ownerSession.token, {
        method: "PATCH",
        body: JSON.stringify({ color, favorite, bootstrapFavorites: ["#AABBCC", "#FF0000"] }),
      },
    );
    const concurrentAdds = await Promise.all([
      patchFavorite("#112233", true),
      patchFavorite("#445566", true),
    ]);
    assert.equal(concurrentAdds.every((response) => response.status === 200), true);
    const afterConcurrentAdds = await authenticatedRequest("/auth/color-preferences", "owner", ownerSession.token);
    const concurrentFavorites = (await afterConcurrentAdds.json() as { favorites: string[] }).favorites;
    assert.deepEqual([...concurrentFavorites].sort(), ["#112233", "#445566", "#AABBCC", "#FF0000"].sort());

    for (const pantone of [pantoneA, pantoneB]) {
      const response = await authenticatedRequest(
        "/auth/color-preferences", "owner", ownerSession.token, {
          method: "PATCH",
          body: JSON.stringify({
            pantone, favorite: true,
            bootstrapFavorites: [], bootstrapPantoneFavorites: [],
          }),
        },
      );
      assert.equal(response.status, 200, await response.text());
    }
    const withPantone = await authenticatedRequest(
      "/auth/color-preferences", "owner", ownerSession.token,
    );
    const withPantoneBody = await withPantone.json() as {
      favorites: string[]; pantoneFavorites: typeof pantoneA[];
    };
    assert.deepEqual(withPantoneBody.pantoneFavorites, [pantoneA, pantoneB]);
    assert.equal(withPantoneBody.favorites.includes("#AABBCC"), true);
    const rawPreferences = await queryOne<{ favorite_colors: unknown[] }>(`
      SELECT favorite_colors FROM user_color_preferences WHERE user_id = $1
    `, [users.owner.id]);
    assert.equal((rawPreferences?.favorite_colors.filter((value) => typeof value === "object") ?? []).length, 2);

    const forgedPantone = await authenticatedRequest(
      "/auth/color-preferences", "owner", ownerSession.token, {
        method: "PATCH",
        body: JSON.stringify({ pantone: { ...pantoneA, code: "FAKE" }, favorite: true }),
      },
    );
    assert.equal(forgedPantone.status, 409);

    const removeFavorite = await patchFavorite("#112233", false);
    assert.equal(removeFavorite.status, 200, await removeFavorite.text());
    const oversizedColor = await patchFavorite(`#${"1".repeat(64)}`, true);
    assert.equal(oversizedColor.status, 400);
    const invalidList = await authenticatedRequest("/auth/color-preferences", "owner", ownerSession.token, {
      method: "PUT",
      body: JSON.stringify({ favorites: "#FFFFFF" }),
    });
    assert.equal(invalidList.status, 400);
    const unauthenticated = await fetch(`${baseUrl}/auth/color-preferences`, {
      headers: { "content-type": "application/json", "x-test-user": "owner" },
    });
    assert.equal(unauthenticated.status, 401);
    const switchedAccountRequests: RequestInit[] = [
      {},
      { method: "PUT", body: JSON.stringify({ favorites: ["#FFFFFF"] }) },
      { method: "PATCH", body: JSON.stringify({ color: "#FFFFFF", favorite: true }) },
    ];
    for (const init of switchedAccountRequests) {
      const switchedAccount = await authenticatedRequest(
        "/auth/color-preferences", "owner", ownerSession.token, {
          ...init, headers: { "x-expected-user-id": users.other.id },
        },
      );
      assert.equal(switchedAccount.status, 409);
      assert.equal((await switchedAccount.json() as { code?: string }).code, "SESSION_OWNER_MISMATCH");
    }

    const invalid = await authenticatedRequest("/auth/color-preferences", "owner", ownerSession.token, {
      method: "PUT",
      body: JSON.stringify({ favorites: ["not-a-color"] }),
    });
    assert.equal(invalid.status, 400);
    const ownerAfterInvalid = await authenticatedRequest(
      "/auth/color-preferences", "owner", ownerSession.token,
    );
    const ownerAfterInvalidBody = await ownerAfterInvalid.json() as { favorites: string[] };
    assert.deepEqual(ownerAfterInvalidBody.favorites, ["#AABBCC", "#FF0000", "#445566"]);
  } finally {
    await query("DELETE FROM color_catalog_versions WHERE release_id = $1", ["d".repeat(64)]);
    await query("DELETE FROM color_catalog_identities WHERE id = ANY($1::text[])", [["c".repeat(64), "b".repeat(64)]]);
    await query("DELETE FROM color_catalog_releases WHERE id = $1", ["d".repeat(64)]);
    await query("DELETE FROM sessions WHERE user_id = ANY($1::text[])", [[users.owner.id, users.other.id]]);
  }
});

await test("已退役的配色替换内置模板即使被旧服务重写也不会暴露", async () => {
  const builtinDir = path.join(temp, "templates", "builtin");
  const retiredPath = path.join(builtinDir, "builtin-tool-color-replace.json");
  fs.writeFileSync(retiredPath, JSON.stringify({
    schemaVersion: 1,
    id: "builtin-tool-color-replace",
    name: "配色替换",
    description: "旧服务遗留的内置模板",
    builtIn: true,
    flow: flow(),
    createdAt: now,
  }));

  const listResponse = await request("/templates", "owner");
  assert.equal(listResponse.status, 200);
  const templates = await listResponse.json() as Array<{ id: string; name: string }>;
  assert.equal(templates.some((template) => template.id === "builtin-tool-color-replace"), false);
  assert.equal(templates.find((template) => template.id === "builtin-tool-fabric-replace")?.name, "面料配色替换");
  assert.equal(fs.existsSync(retiredPath), false);
  assert.equal((await request("/templates/builtin-tool-color-replace", "owner")).status, 404);
});

await test("托管内置模板刷新不改写旧用户项目或用户模板", async () => {
  const projectId = "managed-refresh-preserves-project";
  const projectFlow = generationFlow("旧用户项目内容不得改写");
  const savedProject = await request("/projects", "owner", {
    method: "POST",
    body: JSON.stringify({ id: projectId, name: "旧用户项目", flow: projectFlow }),
  });
  assert.equal(savedProject.status, 200, await savedProject.text());

  const createdTemplate = await request("/templates", "owner", {
    method: "POST",
    body: JSON.stringify({
      name: "旧用户模板",
      description: "内置模板刷新时必须保持原字节",
      flow: projectFlow,
    }),
  });
  const templateResponseText = await createdTemplate.text();
  assert.equal(createdTemplate.status, 200, templateResponseText);
  const templateId = (JSON.parse(templateResponseText) as { id: string }).id;
  const templateFile = path.join(legacyTemplateDir, `${templateId}.json`);

  const projectBefore = await queryOne<{
    name: string;
    flow_json: string;
    lifecycle: string;
    draft_revision: number;
    updated_at: string;
  }>(`
    SELECT name, flow_json, lifecycle, draft_revision, updated_at::text AS updated_at
    FROM projects WHERE id = $1
  `, [projectId]);
  const templateBefore = fs.readFileSync(templateFile, "utf8");

  ensureBuiltinTemplates();
  const builtinPath = path.join(temp, "templates", "builtin", "builtin-tool-one-click-try-on.json");
  const staleBuiltin = JSON.parse(fs.readFileSync(builtinPath, "utf8")) as {
    flow: {
      nodes: Array<{ id: string; type?: string; position?: { x: number; y: number }; data?: Record<string, unknown> }>;
      edges: Array<{ id?: string; source: string; sourceHandle?: string; target: string; targetHandle?: string }>;
    };
  };
  staleBuiltin.flow.nodes.push({ id: "view-angle", type: "ti-angle", position: { x: 0, y: 0 }, data: {
    kind: "ti-angle", label: "3D 视角", status: "idle",
    angle: { version: 1, enabled: false, azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 },
  } });
  staleBuiltin.flow.edges.push({ id: "legacy-angle-edge", source: "view-angle", sourceHandle: "text", target: "stabilize", targetHandle: "angle-direction" });
  fs.writeFileSync(builtinPath, JSON.stringify(staleBuiltin, null, 2), "utf8");

  ensureBuiltinTemplates();

  const refreshedBuiltin = JSON.parse(fs.readFileSync(builtinPath, "utf8")) as {
    flow: {
      nodes: Array<{ id: string }>;
      edges: Array<{ source: string; sourceHandle?: string; target: string; targetHandle?: string }>;
    };
  };
  assert.equal(refreshedBuiltin.flow.nodes.some((node) => node.id === "view-angle"), false);
  assert.equal(refreshedBuiltin.flow.edges.some((edge) => (
    edge.source === "person" && edge.sourceHandle === "image" &&
    edge.target === "view-angle" && edge.targetHandle === "preview-image"
  )), false);
  assert.equal(refreshedBuiltin.flow.edges.some((edge) => (
    edge.source === "view-angle" || edge.targetHandle === "angle-direction"
  )), false);

  const projectAfter = await queryOne<{
    name: string;
    flow_json: string;
    lifecycle: string;
    draft_revision: number;
    updated_at: string;
  }>(`
    SELECT name, flow_json, lifecycle, draft_revision, updated_at::text AS updated_at
    FROM projects WHERE id = $1
  `, [projectId]);
  assert.deepEqual(projectAfter, projectBefore);
  assert.equal(fs.readFileSync(templateFile, "utf8"), templateBefore);
  assert.equal((await request(`/templates/${templateId}`, "other")).status, 404);

  assert.equal((await request(`/templates/${templateId}`, "owner", { method: "DELETE" })).status, 200);
  await query("DELETE FROM projects WHERE id = $1", [projectId]);
});

await test("用户模板按账号隔离，其他用户无法读取或删除，管理员可审计", async () => {
  const create = async (user: keyof typeof users, name: string) => {
    const response = await request("/templates", user, {
      method: "POST",
      body: JSON.stringify({ name, description: `${name} 描述`, flow: flow() }),
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    return (JSON.parse(responseText) as { id: string }).id;
  };

  const ownerTemplateId = await create("owner", "Owner Template");
  const otherTemplateId = await create("other", "Other Template");

  const ownerList = await request("/templates", "owner");
  assert.equal(ownerList.status, 200);
  assert.equal(ownerList.headers.get("cache-control"), "no-store");
  const ownerTemplates = await ownerList.json() as Array<{ id: string; ownerId?: string }>;
  assert.equal(ownerTemplates.some((template) => template.id === ownerTemplateId), true);
  assert.equal(ownerTemplates.some((template) => template.id === otherTemplateId), false);
  assert.equal(ownerTemplates.find((template) => template.id === ownerTemplateId)?.ownerId, users.owner.id);

  assert.equal((await request(`/templates/${ownerTemplateId}`, "other")).status, 404);
  assert.equal((await request(`/templates/${ownerTemplateId}`, "other", { method: "DELETE" })).status, 404);
  assert.equal((await request(`/templates/${ownerTemplateId}`, "owner")).status, 200);

  const adminList = await request("/templates", "admin");
  const adminTemplates = await adminList.json() as Array<{ id: string }>;
  assert.equal(adminTemplates.some((template) => template.id === ownerTemplateId), true);
  assert.equal(adminTemplates.some((template) => template.id === otherTemplateId), true);
  assert.equal(adminTemplates.some((template) => template.id === legacyTemplateId), true);
  assert.equal((await request(`/templates/${otherTemplateId}`, "admin", { method: "DELETE" })).status, 200);
  assert.equal((await request(`/templates/${ownerTemplateId}`, "owner", { method: "DELETE" })).status, 200);
  assert.equal((await request(`/templates/${legacyTemplateId}`, "admin", { method: "DELETE" })).status, 200);
});

await test("账号转移、15 天回收与到期清理同步覆盖用户模板", async () => {
  const sourceKey = "templateLifecycleSource";
  const targetKey = "templateLifecycleTarget";
  const source: AuthUser = {
    id: "template-lifecycle-source", accountId: sourceKey, displayName: "模板转出账号",
    role: "user", mustChangePassword: false,
  };
  const target: AuthUser = {
    id: "template-lifecycle-target", accountId: targetKey, displayName: "模板接收账号",
    role: "user", mustChangePassword: false,
  };
  users[sourceKey] = source;
  users[targetKey] = target;
  await query(`
    INSERT INTO users (id, account_id, display_name, role, password_hash, active, created_at, updated_at)
    VALUES
      ($1, $2, $3, 'user', 'test-only', 1, $7, $7),
      ($4, $5, $6, 'user', 'test-only', 1, $7, $7)
  `, [source.id, source.accountId, source.displayName, target.id, target.accountId, target.displayName, now]);

  let templateId = "";
  try {
    const createResponse = await request("/templates", sourceKey, {
      method: "POST",
      body: JSON.stringify({ name: "账号生命周期模板", description: "", flow: flow() }),
    });
    const createBody = await createResponse.json() as { id: string };
    assert.equal(createResponse.status, 200);
    templateId = createBody.id;

    const analysisId = "transferred-material-analysis";
    await query(`
      INSERT INTO material_analyses(id,owner_id,status,source_image,crop_image,crop,created_at,updated_at)
      VALUES ($1,$2,'draft','/api/files/transfer-source.png','/api/files/transfer-crop.png',
        '{"x":0,"y":0,"width":1,"height":1}'::jsonb,$3,$3)
    `, [analysisId, source.id, now]);
    await query("UPDATE material_analyses SET status='analyzing' WHERE id=$1", [analysisId]);
    const blockedTransfer = await request(`/auth/users/${source.id}`, "admin", {
      method: "DELETE",
      headers: { cookie: `${SESSION_COOKIE}=${adminSession.token}` },
      body: JSON.stringify({ transferToUserId: target.id }),
    });
    assert.equal(blockedTransfer.status, 409);
    assert.match((await blockedTransfer.json() as { error: string }).error, /材质分析/);
    await query("UPDATE material_analyses SET updated_at=$1 WHERE id=$2", [new Date(Date.now() - 16 * 60_000).toISOString(), analysisId]);
    const transfer = await request(`/auth/users/${source.id}`, "admin", {
      method: "DELETE",
      headers: { cookie: `${SESSION_COOKIE}=${adminSession.token}` },
      body: JSON.stringify({ transferToUserId: target.id }),
    });
    assert.equal(transfer.status, 200, await transfer.text());
    assert.deepEqual(await queryOne<{ owner_id: string; status: string }>("SELECT owner_id,status FROM material_analyses WHERE id=$1", [analysisId]), {
      owner_id: target.id, status: "outcome_unknown",
    });
    const targetTemplates = await (await request("/templates", targetKey)).json() as Array<{ id: string }>;
    assert.equal(targetTemplates.some((template) => template.id === templateId), true);
    const templateFile = path.join(legacyTemplateDir, `${templateId}.json`);
    assert.equal((JSON.parse(fs.readFileSync(templateFile, "utf8")) as { ownerId: string }).ownerId, target.id);

    const discard = await request(`/auth/users/${target.id}`, "admin", {
      method: "DELETE",
      headers: { cookie: `${SESSION_COOKIE}=${adminSession.token}` },
      body: JSON.stringify({ deleteData: true }),
    });
    const discardBody = await discard.json() as { purgeAfter?: string };
    assert.equal(discard.status, 200);
    assert.ok(discardBody.purgeAfter);
    const tombstone = JSON.parse(fs.readFileSync(templateFile, "utf8")) as {
      deletedAt?: string;
      purgeAfter?: string;
    };
    assert.ok(tombstone.deletedAt);
    assert.equal(tombstone.purgeAfter, discardBody.purgeAfter);
    const adminTemplates = await (await request("/templates", "admin")).json() as Array<{ id: string }>;
    assert.equal(adminTemplates.some((template) => template.id === templateId), false);

    fs.writeFileSync(templateFile, JSON.stringify({ ...tombstone, purgeAfter: "2000-01-01T00:00:00.000Z" }));
    await request("/templates", "admin");
    assert.equal(fs.existsSync(templateFile), false);
  } finally {
    if (templateId) fs.rmSync(path.join(legacyTemplateDir, `${templateId}.json`), { force: true });
    await query("DELETE FROM sessions WHERE user_id = ANY($1::text[])", [[source.id, target.id]]);
    await query("DELETE FROM users WHERE id = ANY($1::text[])", [[source.id, target.id]]);
    delete users[sourceKey];
    delete users[targetKey];
  }
});

await test("模板账号 journal 可在数据库回滚或提交后恢复文件状态", async () => {
  const sourceKey = "templateJournalSource";
  const targetKey = "templateJournalTarget";
  const source: AuthUser = {
    id: "template-journal-source", accountId: sourceKey, displayName: "模板 journal 源账号",
    role: "user", mustChangePassword: false,
  };
  const target: AuthUser = {
    id: "template-journal-target", accountId: targetKey, displayName: "模板 journal 目标账号",
    role: "user", mustChangePassword: false,
  };
  users[sourceKey] = source;
  users[targetKey] = target;
  await query(`
    INSERT INTO users (id, account_id, display_name, role, password_hash, active, created_at, updated_at)
    VALUES
      ($1, $2, $3, 'user', 'test-only', 1, $7, $7),
      ($4, $5, $6, 'user', 'test-only', 1, $7, $7)
  `, [source.id, source.accountId, source.displayName, target.id, target.accountId, target.displayName, now]);

  const templateId = "template-journal-recovery";
  const templateFile = path.join(legacyTemplateDir, `${templateId}.json`);
  const original = {
    schemaVersion: 3,
    id: templateId,
    ownerId: source.id,
    name: "journal 恢复模板",
    description: "",
    flow: flow(),
    createdAt: now,
  };
  try {
    fs.writeFileSync(templateFile, JSON.stringify(original));
    const rollbackMutation = prepareUserTemplateAccountMutation({
      sourceOwnerId: source.id,
      transferToOwnerId: target.id,
      sourceDeletedAt: "2099-01-01T00:00:00.000Z",
    });
    rollbackMutation.apply();
    assert.equal((JSON.parse(fs.readFileSync(templateFile, "utf8")) as { ownerId: string }).ownerId, target.id);
    await reconcileUserTemplateAccountMutations();
    assert.equal((JSON.parse(fs.readFileSync(templateFile, "utf8")) as { ownerId: string }).ownerId, source.id);

    const commitMutation = prepareUserTemplateAccountMutation({
      sourceOwnerId: source.id,
      transferToOwnerId: target.id,
      sourceDeletedAt: now,
    });
    commitMutation.apply();
    await query("UPDATE users SET active = 0, deleted_at = $1 WHERE id = $2", [now, source.id]);
    await reconcileUserTemplateAccountMutations();
    assert.equal((JSON.parse(fs.readFileSync(templateFile, "utf8")) as { ownerId: string }).ownerId, target.id);
    assert.equal(fs.readdirSync(path.join(temp, "templates", ".account-mutations")).filter((name) => name.endsWith(".json")).length, 0);
  } finally {
    fs.rmSync(templateFile, { force: true });
    await query("DELETE FROM sessions WHERE user_id = ANY($1::text[])", [[source.id, target.id]]);
    await query("DELETE FROM users WHERE id = ANY($1::text[])", [[source.id, target.id]]);
    delete users[sourceKey];
    delete users[targetKey];
  }
});

await test("Run 状态与 SSE 仅任务所有者可读，管理员也不隐式越权", async () => {
  const plan = buildExecutionPlan([{
    id: "result",
    type: "result",
    data: { kind: "result", label: "结果", status: "idle", images: [] },
  }], []);
  const run = await createRun(plan, users.owner.id);

  assert.equal((await request(`/run-plan/${run.id}`, "owner")).status, 200);
  assert.equal((await request(`/run-plan/${run.id}`, "other")).status, 404);
  assert.equal((await request(`/run-plan/${run.id}`, "admin")).status, 404);
  assert.equal((await request(`/run-plan/${run.id}/events`, "other")).status, 404);
});

await test("所有鉴权图片禁止缓存，未共享资源返回非披露 404，撤回共享后立即恢复访问控制", async () => {
  const upload = await request("/files", "owner", {
    method: "POST",
    body: JSON.stringify({
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    }),
  });
  const uploaded = await upload.json() as { id: string; url: string; error?: string };
  assert.equal(upload.status, 200, uploaded.error);

  const hijack = await request("/assets", "other", {
    method: "POST",
    body: JSON.stringify({
      name: "越权共享", category: "reference", scope: "shared", image: uploaded.url,
    }),
  });
  assert.equal(hijack.status, 404);

  for (const pathname of [`/files/${uploaded.id}`, `/files/${uploaded.id}/thumbnail`]) {
    const privateResponse = await request(pathname, "owner");
    assert.equal(privateResponse.status, 200);
    assert.equal(privateResponse.headers.get("cache-control"), "private, no-store");
    assert.match(privateResponse.headers.get("vary") ?? "", /(?:^|,\s*)Cookie(?:,|$)/i);
    await privateResponse.arrayBuffer();

    assert.equal((await request(pathname, "other")).status, 404);
  }

  await query(`
    INSERT INTO assets (id, owner_id, scope, name, category, image, created_at)
    VALUES ('uploaded-shared-asset', $1, 'shared', '可共享图片', 'reference', $2, $3)
  `, [users.owner.id, uploaded.url, now]);

  for (const pathname of [`/files/${uploaded.id}`, `/files/${uploaded.id}/thumbnail`]) {
    const sharedResponse = await request(pathname, "other");
    assert.equal(sharedResponse.status, 200);
    assert.equal(sharedResponse.headers.get("cache-control"), "private, no-store");
    assert.match(sharedResponse.headers.get("vary") ?? "", /(?:^|,\s*)Cookie(?:,|$)/i);
    await sharedResponse.arrayBuffer();
  }

  const revoke = await request("/assets/uploaded-shared-asset", "owner", {
    method: "PATCH",
    body: JSON.stringify({ scope: "private" }),
  });
  assert.equal(revoke.status, 200, await revoke.text());

  for (const pathname of [`/files/${uploaded.id}`, `/files/${uploaded.id}/thumbnail`]) {
    const denied = await request(pathname, "other");
    assert.equal(denied.status, 404);
    await denied.arrayBuffer();

    const ownerResponse = await request(pathname, "owner");
    assert.equal(ownerResponse.status, 200);
    assert.equal(ownerResponse.headers.get("cache-control"), "private, no-store");
    assert.match(ownerResponse.headers.get("vary") ?? "", /(?:^|,\s*)Cookie(?:,|$)/i);
    await ownerResponse.arrayBuffer();
  }
});

await test("私有换装风格预设按账号隔离并校验参考图权限", async () => {
  const upload = await request("/files", "owner", {
    method: "POST",
    body: JSON.stringify({ dataUrl: PNG_DATA_URL }),
  });
  const uploaded = await upload.json() as { url: string; error?: string };
  assert.equal(upload.status, 200, uploaded.error);
  const create = await request("/try-on-style-presets", "owner", {
    method: "POST",
    body: JSON.stringify({ name: "我的硬光", prompt: "单一左侧硬光，低饱和色调", referenceImage: uploaded.url }),
  });
  const created = await create.json() as { id?: string; error?: string };
  assert.equal(create.status, 201, created.error);
  assert.ok(created.id);

  const ownerPresets = await (await request("/try-on-style-presets", "owner")).json() as Array<{ id: string; builtIn: boolean }>;
  const otherPresets = await (await request("/try-on-style-presets", "other")).json() as Array<{ id: string; builtIn: boolean }>;
  assert.ok(ownerPresets.some((preset) => preset.id === created.id && preset.builtIn === false));
  assert.equal(otherPresets.some((preset) => preset.id === created.id), false);
  assert.equal((await request(`/try-on-style-presets/${created.id}`, "other", { method: "DELETE" })).status, 404);
  assert.equal((await request(`/try-on-style-presets/${created.id}`, "owner", { method: "DELETE" })).status, 200);
});

await test("没有 files 元数据的物理孤儿文件对所有账号返回非披露 404", async () => {
  const orphanId = "purge-failed-orphan.png";
  fs.writeFileSync(
    path.join(uploadsDir(), orphanId),
    Buffer.from(PNG_DATA_URL.slice(PNG_DATA_URL.indexOf(",") + 1), "base64"),
  );
  assert.equal(await queryOne("SELECT id FROM files WHERE id = $1", [orphanId]), undefined);
  for (const actor of ["owner", "other", "admin"] as const) {
    assert.equal((await request(`/files/${orphanId}`, actor)).status, 404);
    assert.equal((await request(`/files/${orphanId}/thumbnail`, actor)).status, 404);
  }
  deleteStoredImage(orphanId);
});

await test("启动迁移保留归属含糊的既有公开素材", async () => {
  const maskId = "legacy-public-mask.png";
  const maskUrl = `/api/files/${maskId}`;
  fs.writeFileSync(
    path.join(uploadsDir(), maskId),
    Buffer.from(PNG_DATA_URL.slice(PNG_DATA_URL.indexOf(",") + 1), "base64"),
  );
  await query(`
    INSERT INTO files (id, owner_id, source_type, project_id, node_id, mime_type, created_at)
    VALUES ($1, $2, 'mask-draft', 'mask-project', 'mask-node', 'image/png', $3)
  `, [maskId, users.owner.id, now]);
  await query(`
    INSERT INTO assets (id, owner_id, scope, name, category, image, source_note, created_at)
    VALUES ('legacy-public-mask-asset', NULL, 'global', '历史素材-legacy-public-mask',
      'reference', $1, '从升级前服务器文件迁移', $2)
  `, [maskUrl, now]);
  const leakedOwnerFiles = [
    { id: "legacy-public-upload.png", assetId: "legacy-public-upload-asset", sourceType: "upload" },
    { id: "legacy-public-generated.png", assetId: "legacy-public-generated-asset", sourceType: "generated" },
    { id: "legacy-public-video-upload.png", assetId: "legacy-public-video-upload-asset", sourceType: "video-upload" },
  ];
  for (const leaked of leakedOwnerFiles) {
    fs.writeFileSync(
      path.join(uploadsDir(), leaked.id),
      Buffer.from(PNG_DATA_URL.slice(PNG_DATA_URL.indexOf(",") + 1), "base64"),
    );
    await query(`
      INSERT INTO files (id, owner_id, source_type, mime_type, created_at)
      VALUES ($1, $2, $3, 'image/png', $4)
    `, [leaked.id, users.owner.id, leaked.sourceType, now]);
    await query(`
      INSERT INTO assets (id, owner_id, scope, name, category, image, source_note, created_at)
      VALUES ($1, NULL, 'global', $2, 'reference', $3, '从升级前服务器文件迁移', $4)
    `, [leaked.assetId, `历史素材-${path.parse(leaked.id).name}`, `/api/files/${leaked.id}`, now]);
  }
  const sharedMaskId = "valid-shared-mask.png";
  const sharedMaskUrl = `/api/files/${sharedMaskId}`;
  fs.writeFileSync(
    path.join(uploadsDir(), sharedMaskId),
    Buffer.from(PNG_DATA_URL.slice(PNG_DATA_URL.indexOf(",") + 1), "base64"),
  );
  await query(`
    INSERT INTO files (id, owner_id, source_type, project_id, node_id, mime_type, created_at)
    VALUES ($1, $2, 'mask', 'mask-project', 'shared-mask-node', 'image/png', $3)
  `, [sharedMaskId, users.owner.id, now]);
  await query(`
    INSERT INTO assets (id, owner_id, scope, name, category, image, created_at)
    VALUES ('valid-shared-mask-asset', $1, 'shared', '用户主动共享的蒙版素材', 'reference', $2, $3)
  `, [users.owner.id, sharedMaskUrl, now]);

  assert.equal((await request(`/files/${maskId}`, "other")).status, 200);
  for (const leaked of leakedOwnerFiles) {
    assert.equal((await request(`/files/${leaked.id}`, "other")).status, 200);
  }
  await migrateLegacyData();

  for (const actor of ["owner", "other", "admin"] as const) {
    const assets = await (await request("/assets", actor)).json() as Array<{ id: string }>;
    assert.equal(assets.some((asset) => asset.id === "legacy-public-mask-asset"), true);
    for (const leaked of leakedOwnerFiles) {
      assert.equal(assets.some((asset) => asset.id === leaked.assetId), true);
    }
    assert.equal(assets.some((asset) => asset.id === "valid-shared-mask-asset"), true);
  }
  assert.equal((await request(`/files/${maskId}`, "other")).status, 200);
  assert.equal((await request(`/files/${maskId}`, "owner")).status, 200);
  for (const leaked of leakedOwnerFiles) {
    assert.equal((await request(`/files/${leaked.id}`, "other")).status, 200);
    assert.equal((await request(`/files/${leaked.id}`, "owner")).status, 200);
  }
  assert.equal((await request(`/files/${sharedMaskId}`, "other")).status, 200);
  const preserved = await queryOne<{
    owner_id: string | null; scope: string; deleted_at: string | null;
  }>(`
    SELECT owner_id, scope, deleted_at FROM assets
    WHERE id = 'legacy-public-mask-asset'
  `);
  assert.deepEqual(preserved, {
    owner_id: null,
    scope: "global",
    deleted_at: null,
  });
  for (const leaked of leakedOwnerFiles) {
    const preservedOwnerFile = await queryOne<{
      owner_id: string | null; scope: string; deleted_at: string | null;
    }>(`
      SELECT owner_id, scope, deleted_at FROM assets WHERE id = $1
    `, [leaked.assetId]);
    assert.deepEqual(preservedOwnerFile, {
      owner_id: null,
      scope: "global",
      deleted_at: null,
    });
  }
  assert.deepEqual(await queryOne<{
    owner_id: string | null; scope: string; deleted_at: string | null;
  }>(`
    SELECT owner_id, scope, deleted_at FROM assets
    WHERE id = 'valid-shared-mask-asset'
  `), {
    owner_id: users.owner.id,
    scope: "shared",
    deleted_at: null,
  });
});

await test("管理员创建通用素材时解除底层文件的个人归属", async () => {
  const upload = await request("/files", "admin", {
    method: "POST",
    body: JSON.stringify({
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    }),
  });
  const uploaded = await upload.json() as { id: string; url: string; error?: string };
  assert.equal(upload.status, 200, uploaded.error);

  const create = await request("/assets", "admin", {
    method: "POST",
    body: JSON.stringify({
      name: "通用素材", category: "reference", scope: "global", image: uploaded.url,
    }),
  });
  const created = await create.json() as { id?: string; error?: string };
  assert.equal(create.status, 201, created.error);
  assert.ok(created.id);
  assert.deepEqual(
    await queryOne<{ owner_id: string | null; deleted_at: string | null; purge_after: string | null }>(
      "SELECT owner_id, deleted_at, purge_after FROM files WHERE id = $1",
      [uploaded.id],
    ),
    { owner_id: null, deleted_at: null, purge_after: null },
  );
  assert.equal((await request(`/files/${uploaded.id}`, "other")).status, 200);

  const otherReference = await request("/assets", "other", {
    method: "POST",
    body: JSON.stringify({
      name: "引用同一通用素材", category: "reference", scope: "private", image: uploaded.url,
    }),
  });
  const otherAsset = await otherReference.json() as { id?: string; error?: string };
  assert.equal(otherReference.status, 201, otherAsset.error);
  assert.ok(otherAsset.id);

  const blocked = await request(`/assets/${created.id}`, "admin", {
    method: "PATCH",
    body: JSON.stringify({ scope: "private" }),
  });
  assert.equal(blocked.status, 409, await blocked.text());
  assert.equal((await request(`/files/${uploaded.id}`, "other")).status, 200);
  const removedReference = await request(`/assets/${otherAsset.id}`, "other", { method: "DELETE" });
  assert.equal(removedReference.status, 200, await removedReference.text());

  const blockedRecoverable = await request(`/assets/${created.id}`, "admin", {
    method: "PATCH",
    body: JSON.stringify({ scope: "private" }),
  });
  assert.equal(blockedRecoverable.status, 409, await blockedRecoverable.text());
  const restoredReference = await request(`/assets/${otherAsset.id}/restore`, "other", { method: "POST" });
  assert.equal(restoredReference.status, 200, await restoredReference.text());
  assert.equal((await request(`/files/${uploaded.id}`, "other")).status, 200);
  await query("DELETE FROM assets WHERE id = $1", [otherAsset.id]);

  const privatized = await request(`/assets/${created.id}`, "admin", {
    method: "PATCH",
    body: JSON.stringify({ scope: "private" }),
  });
  assert.equal(privatized.status, 200, await privatized.text());
  assert.deepEqual(
    await queryOne<{ owner_id: string | null; deleted_at: string | null; purge_after: string | null }>(
      "SELECT owner_id, deleted_at, purge_after FROM files WHERE id = $1",
      [uploaded.id],
    ),
    { owner_id: users.admin.id, deleted_at: null, purge_after: null },
  );
  assert.equal((await request(`/files/${uploaded.id}`, "other")).status, 404);

  const republished = await request(`/assets/${created.id}`, "admin", {
    method: "PATCH",
    body: JSON.stringify({ scope: "global" }),
  });
  assert.equal(republished.status, 200, await republished.text());
  assert.deepEqual(
    await queryOne<{ owner_id: string | null; deleted_at: string | null; purge_after: string | null }>(
      "SELECT owner_id, deleted_at, purge_after FROM files WHERE id = $1",
      [uploaded.id],
    ),
    { owner_id: null, deleted_at: null, purge_after: null },
  );
  assert.equal((await request(`/files/${uploaded.id}`, "other")).status, 200);

  await migrateLegacyData();
  assert.deepEqual(
    await queryOne<{ owner_id: string | null; scope: string; deleted_at: string | null }>(
      "SELECT owner_id, scope, deleted_at FROM assets WHERE id = $1",
      [created.id],
    ),
    { owner_id: null, scope: "global", deleted_at: null },
  );
  assert.equal((await request(`/files/${uploaded.id}`, "other")).status, 200);
});

await test("资产分类支持筛选和调整，并保持所有权与输入校验", async () => {
  const createdIds: string[] = [];
  for (const category of ["upload", "generated", "print", "fabric"]) {
    const response = await request("/assets", "owner", {
      method: "POST",
      body: JSON.stringify({ name: `分类测试-${category}`, category, image: PNG_DATA_URL }),
    });
    assert.equal(response.status, 201);
    const { id } = await response.json() as { id: string };
    createdIds.push(id);
    const list = await (await request(`/assets?category=${category}&search=分类测试`, "owner")).json() as Array<{ id: string; category: string }>;
    assert.deepEqual(list.map((asset) => [asset.id, asset.category]), [[id, category]]);
    const otherList = await (await request(`/assets?category=${category}&search=分类测试`, "other")).json();
    assert.deepEqual(otherList, []);
  }
  const patch = (actor: string, category: unknown) => request(`/assets/${createdIds[0]}`, actor, {
    method: "PATCH", body: JSON.stringify({ category }),
  });
  assert.equal((await patch("other", "fabric")).status, 403);
  assert.equal((await patch("admin", "fabric")).status, 403);
  for (const invalid of ["bad", null, 1, {}, ["fabric"]]) {
    assert.equal((await patch("owner", invalid)).status, 400);
  }
  assert.equal((await patch("owner", "fabric")).status, 200);
  assert.deepEqual(await queryOne("SELECT category, owner_id, scope FROM assets WHERE id = $1", [createdIds[0]]), {
    category: "fabric", owner_id: users.owner.id, scope: "private",
  });
  assert.deepEqual(await (await request("/assets?category=upload&search=分类测试", "owner")).json(), []);
  assert.equal((await request("/assets?category=invalid", "owner")).status, 400);
  await query("DELETE FROM assets WHERE id = ANY($1::text[])", [createdIds]);
});

await test("图片上传可在一次请求中标准化并创建私有素材", async () => {
  const create = await request("/assets", "owner", {
    method: "POST",
    body: JSON.stringify({
      name: "节点本地上传",
      category: "reference",
      scope: "private",
      image: PNG_DATA_URL,
      sourceNote: "来自图片上传节点",
    }),
  });
  const body = await create.json() as {
    ok?: boolean;
    id?: string;
    url?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    byteLength?: number;
    normalized?: boolean;
    error?: string;
  };
  assert.equal(create.status, 201, body.error);
  assert.equal(body.ok, true);
  assert.ok(body.id);
  assert.match(body.url ?? "", /^\/api\/files\/[A-Za-z0-9_-]+\.(?:jpg|png)$/);
  assert.match(body.mimeType ?? "", /^image\/(?:jpeg|png)$/);
  assert.equal(body.width, 1);
  assert.equal(body.height, 1);
  assert.ok((body.byteLength ?? 0) > 0);
  assert.equal(body.normalized, true);
  assert.deepEqual(
    await queryOne<{ owner_id: string; scope: string; image: string }>(
      "SELECT owner_id, scope, image FROM assets WHERE id = $1",
      [body.id],
    ),
    { owner_id: users.owner.id, scope: "private", image: body.url },
  );
  assert.deepEqual(
    await queryOne<{ owner_id: string; source_type: string; normalized: boolean }>(
      "SELECT owner_id, source_type, normalized FROM files WHERE id = $1",
      [path.basename(body.url ?? "")],
    ),
    { owner_id: users.owner.id, source_type: "asset", normalized: true },
  );
});

await test("已有文件创建素材持共享锁，使并发 TTL 清理等待并保留刚提交的引用", async () => {
  const fileId = "asset-purge-race.png";
  const advisoryKey = 2_608_210_317;
  fs.writeFileSync(
    path.join(uploadsDir(), fileId),
    Buffer.from(PNG_DATA_URL.slice(PNG_DATA_URL.indexOf(",") + 1), "base64"),
  );
  await query(`
    INSERT INTO files (
      id, owner_id, source_type, mime_type, created_at, purge_after
    ) VALUES ($1, $2, 'upload', 'image/png', $3, $4)
  `, [fileId, users.owner.id, now, new Date(Date.now() - 1_000).toISOString()]);
  await query(`
    CREATE OR REPLACE FUNCTION test_block_asset_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(${advisoryKey});
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER test_block_asset_insert_trigger
    BEFORE INSERT ON assets
    FOR EACH ROW WHEN (NEW.name = '并发回收素材')
    EXECUTE FUNCTION test_block_asset_insert();
  `);

  const blocker = await db().connect();
  let createRequest: Promise<Response> | undefined;
  let purgeRequest: Promise<void> | undefined;
  let createdAssetId: string | undefined;
  try {
    await blocker.query("SELECT pg_advisory_lock($1)", [advisoryKey]);
    createRequest = request("/assets", "owner", {
      method: "POST",
      body: JSON.stringify({
        name: "并发回收素材",
        category: "reference",
        scope: "private",
        image: `/api/files/${fileId}`,
      }),
    });
    await waitForDatabaseCondition("素材 INSERT 已在触发器等待", async () => {
      const waiting = await queryOne<{ count: number }>(`
        SELECT COUNT(*)::int AS count FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND query LIKE '%INSERT INTO assets%'
      `);
      return (waiting?.count ?? 0) > 0;
    });

    purgeRequest = purgeExpiredProjects();
    await waitForDatabaseCondition("TTL 清理在已授权文件共享锁处等待", async () => {
      const waiting = await queryOne<{ count: number }>(`
        SELECT COUNT(*)::int AS count FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND query LIKE '%SELECT f.id%'
          AND query LIKE '%FOR UPDATE OF f%'
      `);
      return (waiting?.count ?? 0) > 0;
    });

    assert.equal((await blocker.query<{ unlocked: boolean }>(
      "SELECT pg_advisory_unlock($1) AS unlocked",
      [advisoryKey],
    )).rows[0]?.unlocked, true);
    const createResponse = await createRequest;
    const createBody = await createResponse.json() as { id?: string; error?: string };
    assert.equal(createResponse.status, 201, createBody.error);
    assert.ok(createBody.id);
    createdAssetId = createBody.id;
    await purgeRequest;

    assert.ok(await queryOne("SELECT id FROM files WHERE id = $1", [fileId]));
    assert.ok(fs.existsSync(path.join(uploadsDir(), fileId)));
    assert.deepEqual(
      await queryOne<{ image: string }>("SELECT image FROM assets WHERE id = $1", [createdAssetId]),
      { image: `/api/files/${fileId}` },
    );
  } finally {
    try { await blocker.query("SELECT pg_advisory_unlock($1)", [advisoryKey]); } catch { /* best effort */ }
    blocker.release();
    await createRequest?.catch(() => undefined);
    await purgeRequest?.catch(() => undefined);
    await query("DROP TRIGGER IF EXISTS test_block_asset_insert_trigger ON assets");
    await query("DROP FUNCTION IF EXISTS test_block_asset_insert()");
    await query("DELETE FROM assets WHERE id = $1 OR name = '并发回收素材'", [createdAssetId ?? ""]);
    await query("DELETE FROM files WHERE id = $1", [fileId]);
    deleteStoredImage(fileId);
  }
});

await query(`
  INSERT INTO files (id, owner_id, source_type, created_at)
  VALUES
    ('shared.png', $1, 'legacy', $3),
    ('private.png', $2, 'legacy', $3),
    ('own-private.png', $1, 'legacy', $3)
`, [users.owner.id, users.other.id, now]);
await query(`
  INSERT INTO assets (id, owner_id, scope, name, category, image, created_at)
  VALUES
    ('shared-asset', $1, 'shared', '共享素材', 'reference', '/api/files/shared.png', $3),
    ('other-private', $2, 'private', '他人私有素材', 'reference', '/api/files/private.png', $3),
    ('own-private', $1, 'private', '本人私有素材', 'reference', '/api/files/own-private.png', $3)
`, [users.owner.id, users.other.id, now]);
await query(`
  INSERT INTO projects (id, owner_id, name, flow_json, updated_at, created_at)
  VALUES ('owner-project', $1, 'Owner Project', $2, $3, $3)
`, [users.owner.id, JSON.stringify(flow()), now]);

await test("素材引用接口拒绝跨用户与管理员写入他人项目", async () => {
  for (const actor of ["other", "admin"] as const) {
    const response = await request("/assets/shared-asset/references", actor, {
      method: "POST",
      body: JSON.stringify({ projectId: "owner-project" }),
    });
    assert.equal(response.status, 404);
  }
  const missing = await request("/assets/shared-asset/references", "owner", {
    method: "POST",
    body: JSON.stringify({ projectId: "unsaved-project" }),
  });
  assert.equal(missing.status, 404);
  const count = await queryOne<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM project_asset_refs WHERE project_id = 'owner-project'",
  );
  assert.equal(count?.count, 0);
});

await test("普通用户的回收站只显示自己删除的素材", async () => {
  await query(`
    INSERT INTO assets (id, owner_id, scope, name, category, image, created_at, deleted_at, purge_after)
    VALUES ('other-deleted-shared', $1, 'shared', '他人已删共享素材', 'reference',
      '/api/files/deleted-shared.png', $2, $2, $3)
  `, [users.other.id, now, new Date(Date.now() + 86_400_000).toISOString()]);
  const response = await request("/assets?deleted=true", "owner");
  assert.equal(response.status, 200);
  const rows = await response.json() as Array<{ id: string }>;
  assert.equal(rows.some((row) => row.id === "other-deleted-shared"), false);
});

await test("素材名称搜索按字面子串匹配，且不绕过 scope 权限过滤", async () => {
  await query(`
    INSERT INTO assets (id, owner_id, scope, name, category, image, created_at)
    VALUES
      ('search-own-print', $1, 'private', '花朵印花A', 'print', '/api/files/search-a.png', $3),
      ('search-other-private', $2, 'private', '花朵印花B', 'print', '/api/files/search-b.png', $3)
  `, [users.owner.id, users.other.id, now]);
  const response = await request("/assets?search=%E8%8A%B1%E6%9C%B5", "owner");
  assert.equal(response.status, 200);
  const ids = (await response.json() as Array<{ id: string }>).map((row) => row.id);
  assert.equal(ids.includes("search-own-print"), true);
  assert.equal(ids.includes("search-other-private"), false);
});

await test("素材名称搜索把 % 和 _ 当字面字符而非 LIKE 通配符", async () => {
  await query(`
    INSERT INTO assets (id, owner_id, scope, name, category, image, created_at)
    VALUES
      ('search-percent', $1, 'private', 'A%B', 'reference', '/api/files/search-p.png', $2),
      ('search-plain', $1, 'private', 'AB', 'reference', '/api/files/search-q.png', $2),
      ('search-underscore', $1, 'private', 'A_C', 'reference', '/api/files/search-u.png', $2),
      ('search-anychar', $1, 'private', 'AXC', 'reference', '/api/files/search-x.png', $2)
  `, [users.owner.id, now]);

  const percent = await request("/assets?search=A%25B", "owner");
  assert.equal(percent.status, 200);
  const percentIds = (await percent.json() as Array<{ id: string }>).map((row) => row.id);
  assert.equal(percentIds.includes("search-percent"), true);
  assert.equal(percentIds.includes("search-plain"), false);

  const underscore = await request("/assets?search=A_C", "owner");
  assert.equal(underscore.status, 200);
  const underscoreIds = (await underscore.json() as Array<{ id: string }>).map((row) => row.id);
  assert.equal(underscoreIds.includes("search-underscore"), true);
  assert.equal(underscoreIds.includes("search-anychar"), false);
});

await test("不存在或已删除的 projectId 不能污染运行历史元数据", async () => {
  const response = await request("/run-plan", "owner", {
    method: "POST",
    body: JSON.stringify({
      nodes: [{
        id: "result-only", type: "result", position: { x: 0, y: 0 },
        data: { kind: "result", label: "结果", status: "idle", images: [] },
      }],
      edges: [],
      projectId: "missing-project",
      clientRequestId: "missing-project-request",
    }),
  });
  assert.equal(response.status, 404);
});

await test("运行必须绑定项目，且他人与管理员都不能运行项目所有者的画布", async () => {
  const withoutProject = await request("/run-plan", "owner", {
    method: "POST",
    body: JSON.stringify({ ...flow(), clientRequestId: "missing-project-binding" }),
  });
  assert.equal(withoutProject.status, 400, await withoutProject.text());

  const withoutRequestId = await request("/run-plan", "owner", {
    method: "POST",
    body: JSON.stringify({ ...flow(), projectId: "owner-project" }),
  });
  assert.equal(withoutRequestId.status, 400, await withoutRequestId.text());

  for (const actor of ["other", "admin"] as const) {
    const denied = await request("/run-plan", actor, {
      method: "POST",
      body: JSON.stringify({
        ...flow(), projectId: "owner-project", clientRequestId: `forbidden-${actor}-request`,
      }),
    });
    assert.equal(denied.status, 403, `${actor}: ${await denied.text()}`);
  }
});

await test("简化提示词拒绝无目标、下游执行、非法模式与旧节点", async () => {
  const savedFlow = generationFlow("普通节点");
  await request("/projects", "owner", { method: "POST", body: JSON.stringify({ id: "concise-legacy", name: "旧节点", flow: savedFlow }) });
  for (const override of [
    { multiImagePromptMode: "bad", onlyNodeId: "generate" },
    { multiImagePromptMode: "concise" },
    { multiImagePromptMode: "concise", onlyNodeId: "generate", includeDownstream: true },
    { multiImagePromptMode: "concise", onlyNodeId: "generate" },
    { candidateReviewMode: "bad", onlyNodeId: "generate" },
    { candidateReviewMode: "disabled" },
    { candidateReviewMode: "disabled", onlyNodeId: "generate", includeDownstream: true },
    { candidateReviewMode: "disabled", onlyNodeId: "generate" },
  ]) {
    const result = await request("/run-plan", "owner", { method: "POST", body: JSON.stringify({
      ...savedFlow, projectId: "concise-legacy", clientRequestId: "concise-invalid-request", ...override,
    }) });
    assert.equal(result.status, 400, await result.text());
  }
});

await test("多图简化仅进入本次运行，保留项目快照、权限和请求去重", async () => {
  const template = JSON.parse(fs.readFileSync(new URL("../templates/multi-image-try-on.workflow.json", import.meta.url), "utf8"));
  const generation = template.flow.nodes.find((node: { id: string }) => node.id === "stabilize");
  const roles = ["pose", "person", "scene", "outfit"];
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const savedFlow = { schemaVersion: 2, nodes: [generation, ...roles.map(id => ({ id, type: "image-input", position: { x: 0, y: 0 },
    data: { kind: "image-input", label: id, status: "idle", imageRole: "reference", imageUrl: image },
  }))], edges: roles.map(id => ({ id, source: id, sourceHandle: "image", target: "stabilize", targetHandle: id })) };
  const save = await request("/projects", "owner", { method: "POST", body: JSON.stringify({ id: "concise-multi", name: "多图", flow: savedFlow }) });
  assert.equal(save.status, 200, await save.text());
  const before = await queryOne<{ flow_json: string }>("SELECT flow_json FROM projects WHERE id = 'concise-multi'");
  const body = { ...savedFlow, projectId: "concise-multi", onlyNodeId: "stabilize", includeDownstream: false,
    clientRequestId: "concise-valid-request", multiImagePromptMode: "concise", candidateReviewMode: "disabled" };
  for (const actor of ["other", "admin"] as const) {
    const denied = await request("/run-plan", actor, { method: "POST", body: JSON.stringify(body) });
    assert.equal(denied.status, 403, await denied.text());
  }
  const accepted = await request("/run-plan", "owner", { method: "POST", body: JSON.stringify(body) });
  const result = await accepted.json() as { runId?: string; error?: string };
  assert.equal(accepted.status, 202, result.error);
  const row = await queryOne<{ parameters_json: string }>("SELECT parameters_json FROM generation_runs WHERE id = $1", [result.runId]);
  assert.equal(JSON.parse(row!.parameters_json).multiImagePromptMode, "concise");
  assert.equal(JSON.parse(row!.parameters_json).candidateReviewMode, "disabled");
  assert.deepEqual(await queryOne("SELECT flow_json FROM projects WHERE id = 'concise-multi'"), before);
  const replay = await request("/run-plan", "owner", { method: "POST", body: JSON.stringify(body) });
  assert.equal(replay.status, 202);
  assert.equal((await replay.json() as { runId: string }).runId, result.runId);
  const changed = await request("/run-plan", "owner", { method: "POST", body: JSON.stringify({ ...body, multiImagePromptMode: undefined }) });
  assert.equal(changed.status, 409, "同一请求编号不能改变提示词模式");
});

await test("同 ID 项目不能被其他账号覆盖", async () => {
  const denied = await request("/projects", "other", {
    method: "POST",
    body: JSON.stringify({ id: "owner-project", name: "恶意覆盖", flow: generationFlow("恶意覆盖") }),
  });
  assert.equal(denied.status, 403, await denied.text());
  const row = await queryOne<{ owner_id: string; name: string; flow_json: string }>(
    "SELECT owner_id, name, flow_json FROM projects WHERE id = 'owner-project'",
  );
  assert.equal(row?.owner_id, users.owner.id);
  assert.equal(row?.name, "Owner Project");
  assert.deepEqual(JSON.parse(row?.flow_json ?? "{}"), flow());
});

await test("运行只接受当前已保存画布，且项目名称以服务端为准", async () => {
  const savedFlow = generationFlow("已保存提示词");
  const save = await request("/projects", "owner", {
    method: "POST",
    body: JSON.stringify({
      id: "run-persisted-project",
      name: "服务端项目名",
      flow: savedFlow,
    }),
  });
  assert.equal(save.status, 200, await save.text());

  const forged = await request("/run-plan", "owner", {
    method: "POST",
    body: JSON.stringify({
      ...generationFlow("未保存的篡改提示词"),
      onlyNodeId: "generate",
      projectId: "run-persisted-project",
      projectName: "伪造项目名",
      clientRequestId: "forged-persisted-plan",
    }),
  });
  assert.equal(forged.status, 409, await forged.text());

  const queuedClientFlow = structuredClone(savedFlow);
  queuedClientFlow.nodes[0].position = { x: 999, y: 999 };
  queuedClientFlow.nodes[0].data.label = "客户端瞬态标签";
  queuedClientFlow.nodes[0].data.status = "queued";
  const accepted = await request("/run-plan", "owner", {
    method: "POST",
    body: JSON.stringify({
      ...queuedClientFlow,
      onlyNodeId: "generate",
      projectId: "run-persisted-project",
      projectName: "伪造项目名",
      clientRequestId: "accepted-persisted-plan",
    }),
  });
  const payload = await accepted.json() as { runId?: string; error?: string };
  assert.equal(accepted.status, 202, payload.error);
  const row = await queryOne<{ project_name: string; parameters_json: string }>(
    "SELECT project_name, parameters_json FROM generation_runs WHERE id = $1",
    [payload.runId],
  );
  assert.equal(row?.project_name, "服务端项目名");
  assert.equal((JSON.parse(row?.parameters_json ?? "{}") as { prompt?: string }).prompt, "已保存提示词");

  const replay = await request("/run-plan", "owner", {
    method: "POST",
    body: JSON.stringify({
      ...queuedClientFlow,
      onlyNodeId: "generate",
      projectId: "run-persisted-project",
      clientRequestId: "accepted-persisted-plan",
    }),
  });
  const replayPayload = await replay.json() as { runId?: string; error?: string };
  assert.equal(replay.status, 202, replayPayload.error);
  assert.equal(replayPayload.runId, payload.runId);
  assert.equal((await queryOne<{ count: number }>(`
    SELECT COUNT(*)::int AS count FROM generation_runs
    WHERE owner_id = $1 AND client_request_id = 'accepted-persisted-plan'
  `, [users.owner.id]))?.count, 1);
  assert.equal((await queryOne<{ count: number }>(`
    SELECT COUNT(*)::int AS count FROM generation_jobs WHERE run_id = $1
  `, [payload.runId]))?.count, 1);

  const changedSavedFlow = generationFlow("后来保存的提示词");
  const changedSave = await request("/projects", "owner", {
    method: "POST",
    body: JSON.stringify({
      id: "run-persisted-project",
      name: "服务端项目名",
      flow: changedSavedFlow,
    }),
  });
  assert.equal(changedSave.status, 200, await changedSave.text());
  const semanticDrift = await request("/run-plan", "owner", {
    method: "POST",
    body: JSON.stringify({
      ...changedSavedFlow,
      onlyNodeId: "generate",
      projectId: "run-persisted-project",
      clientRequestId: "accepted-persisted-plan",
    }),
  });
  assert.equal(semanticDrift.status, 409, await semanticDrift.text());
  assert.equal((await queryOne<{ count: number }>(`
    SELECT COUNT(*)::int AS count FROM generation_runs
    WHERE owner_id = $1 AND client_request_id = 'accepted-persisted-plan'
  `, [users.owner.id]))?.count, 1);
});

await test("第二轮接受用户选择的单张结果且保留项目权限检查", async () => {
  const projectId = "manual-baseline-selection";
  const sharp = (await import("sharp")).default;
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123456" } }).png().toBuffer();
  const chosen = `data:image/png;base64,${png.toString("base64")}`;
  const flow = {
    schemaVersion: 18,
    nodes: [
      { id: "candidates", type: "result", position: { x: 0, y: 0 }, data: {
        kind: "result", label: "第一轮候选", status: "success", images: [PNG_DATA_URL, chosen],
      } },
      { id: "outfit", type: "image-input", position: { x: 0, y: 300 }, data: {
        kind: "image-input", label: "主穿搭", status: "success", imageRole: "garment", imageUrl: PNG_DATA_URL,
      } },
      { id: "refine", type: "virtual-try-on", position: { x: 400, y: 0 }, data: {
        kind: "virtual-try-on", label: "第二轮", status: "idle", workflowStage: "garment-refine",
        modelId: "gpt-image-2", modelOptions: { quality: "medium" }, imageSize: "2K", aspectRatio: "1:1",
        prompt: "", outputImages: [], promptEnhancement: false, qualityMode: "fast", safetyFallback: false,
        stylePresetId: "faithful",
      } },
    ],
    edges: [
      { id: "chosen", source: "candidates", sourceHandle: "image:1", target: "refine", targetHandle: "baseline" },
      { id: "outfit", source: "outfit", sourceHandle: "image", target: "refine", targetHandle: "outfit" },
    ],
  };
  try {
    const saved = await request("/projects", "owner", {
      method: "POST", body: JSON.stringify({ id: projectId, name: "手选基准", flow }),
    });
    assert.equal(saved.status, 200, await saved.text());
    const body = { ...flow, projectId, onlyNodeId: "refine", clientRequestId: "manual-baseline-run" };
    const denied = await request("/run-plan", "other", { method: "POST", body: JSON.stringify(body) });
    assert.equal(denied.status, 403, await denied.text());
    const accepted = await request("/run-plan", "owner", { method: "POST", body: JSON.stringify(body) });
    assert.equal(accepted.status, 202, await accepted.clone().text());
    const { runId } = await accepted.json() as { runId: string };
    const queued = await queryOne<{ plan_json: string }>("SELECT plan_json FROM generation_runs WHERE id = $1", [runId]);
    const plan = JSON.parse(queued!.plan_json);
    assert.deepEqual(plan.steps.find((step: { nodeId: string }) => step.nodeId === "refine").inputImages, [chosen, PNG_DATA_URL]);
    flow.edges[0].sourceHandle = "image";
    const resaved = await request("/projects", "owner", {
      method: "POST", body: JSON.stringify({ id: projectId, name: "手选基准", flow }),
    });
    assert.equal(resaved.status, 200, await resaved.text());
    const ambiguous = await request("/run-plan", "owner", {
      method: "POST", body: JSON.stringify({ ...body, ...flow, clientRequestId: "ambiguous-baseline-run" }),
    });
    assert.equal(ambiguous.status, 400, await ambiguous.text());
    assert.equal(await queryOne("SELECT id FROM generation_runs WHERE client_request_id = $1", ["ambiguous-baseline-run"]), undefined);
  } finally {
    await query("DELETE FROM generation_runs WHERE project_id = $1", [projectId]);
    await query("DELETE FROM projects WHERE id = $1", [projectId]);
  }
});

await test("第二轮不能仅凭客户端审批字段伪造未完成的第一轮基准", async () => {
  const projectId = "staged-input-fingerprint-gate";
  const otherProjectId = "staged-input-fingerprint-other-project";
  const firstImage = PNG_DATA_URL;
  const imageNode = (id: string, label: string) => ({
    id,
    type: "image-input",
    position: { x: 0, y: 0 },
    data: {
      kind: "image-input" as const,
      label,
      status: "success" as const,
      imageRole: "reference" as const,
      imageUrl: firstImage,
    },
  });
  const angleNode = {
    id: "fingerprint-angle",
    type: "ti-angle",
    position: { x: 0, y: 240 },
    data: {
      kind: "ti-angle" as const,
      label: "3D 视角",
      status: "idle" as const,
      angle: {
        version: 1 as const,
        enabled: true,
        azimuthDeg: 35,
        elevationDeg: 10,
        rollDeg: 0,
      },
    },
  };
  const firstStage = {
    id: "fingerprint-first-stage",
    type: "virtual-try-on",
    position: { x: 320, y: 0 },
    data: {
      kind: "virtual-try-on" as const,
      label: "第一轮场景定版",
      status: "success" as const,
      workflowStage: "scene-stabilize" as const,
      prompt: "保持人物动作",
      modelId: "gemini-3.1-flash-image" as const,
      modelOptions: { aspectRatio: "1:1", imageSize: "2K" },
      imageSize: "2K",
      aspectRatio: "1:1",
      basisRevision: 1,
      promptEnhancement: false,
      safetyFallback: false,
      qualityMode: "fast" as const,
      stylePresetId: "faithful",
      outputImages: [firstImage],
    },
  };
  const approval = {
    id: "fingerprint-approval",
    type: "stage-approval",
    position: { x: 680, y: 0 },
    data: {
      kind: "stage-approval" as const,
      label: "确认第一轮基准",
      status: "success" as const,
      approvalKind: "scene-baseline" as const,
      approvedSourceNodeId: firstStage.id,
      approvedBaselineRef: firstImage,
      approvedBasisRevision: 1,
      approvedAt: now,
    },
  };
  const secondStage = {
    id: "fingerprint-second-stage",
    type: "virtual-try-on",
    position: { x: 1040, y: 0 },
    data: {
      kind: "virtual-try-on" as const,
      label: "第二轮服装精修",
      status: "idle" as const,
      workflowStage: "garment-refine" as const,
      prompt: "保持人物和场景不变",
      modelId: "gpt-image-2" as const,
      modelOptions: { quality: "medium" as const },
      imageSize: "2K",
      aspectRatio: "1:1",
      garmentCategory: "knit" as const,
      materialSpec: "羊毛双股纱",
      constructionSpec: "12GG 平针",
      promptEnhancement: false,
      qualityMode: "balanced" as const,
      safetyFallback: false,
      stylePresetId: "faithful",
      outputImages: [],
    },
  };
  const firstStageEdges = [
    { id: "fingerprint-person-edge", source: "fingerprint-person", target: firstStage.id, targetHandle: "person" as const },
    { id: "fingerprint-scene-edge", source: "fingerprint-scene", target: firstStage.id, targetHandle: "scene" as const },
    { id: "fingerprint-pose-edge", source: "fingerprint-pose", target: firstStage.id, targetHandle: "pose" as const },
    { id: "fingerprint-outfit-first-edge", source: "fingerprint-outfit", target: firstStage.id, targetHandle: "outfit" as const },
  ];
  const stagedFlow = {
    schemaVersion: 18 as const,
    nodes: [
      angleNode,
      imageNode("fingerprint-person", "人物身份"),
      imageNode("fingerprint-scene", "场景"),
      imageNode("fingerprint-pose", "姿势"),
      imageNode("fingerprint-outfit", "主穿搭"),
      firstStage,
      approval,
      secondStage,
    ],
    edges: [
      ...firstStageEdges,
      { id: "fingerprint-angle-edge", source: angleNode.id, sourceHandle: "text", target: firstStage.id, targetHandle: "angle-direction" as const },
      { id: "fingerprint-candidate-edge", source: firstStage.id, target: approval.id, targetHandle: "baseline-candidate" as const },
      { id: "fingerprint-baseline-edge", source: approval.id, target: secondStage.id, targetHandle: "baseline" as const },
      { id: "fingerprint-outfit-second-edge", source: "fingerprint-outfit", target: secondStage.id, targetHandle: "outfit" as const },
    ],
  };
  const saved = await request("/projects", "owner", {
    method: "POST",
    body: JSON.stringify({ id: projectId, name: "指纹门禁项目", flow: stagedFlow }),
  });
  assert.equal(saved.status, 200, await saved.text());
  try {
    const submittedAngleDrift = structuredClone(stagedFlow);
    const submittedAngleNode = submittedAngleDrift.nodes.find((node) => node.id === angleNode.id);
    assert.equal(submittedAngleNode?.data.kind, "ti-angle");
    if (submittedAngleNode?.data.kind === "ti-angle") {
      submittedAngleNode.data.angle.azimuthDeg = -55;
    }
    const angleConflictRequestId = "staged-angle-plan-conflict";
    const angleConflict = await request("/run-plan", "owner", {
      method: "POST",
      body: JSON.stringify({
        ...submittedAngleDrift,
        onlyNodeId: firstStage.id,
        projectId,
        clientRequestId: angleConflictRequestId,
      }),
    });
    const angleConflictBody = await angleConflict.text();
    assert.equal(angleConflict.status, 409, angleConflictBody);
    assert.match(angleConflictBody, /画布尚未保存|已在其他位置更新/);
    assert.equal(
      await queryOne<{ id: string }>(`
        SELECT id FROM generation_runs WHERE client_request_id = $1
      `, [angleConflictRequestId]),
      undefined,
    );

    const angleConflictOtherOwner = await request("/run-plan", "other", {
      method: "POST",
      body: JSON.stringify({
        ...submittedAngleDrift,
        onlyNodeId: firstStage.id,
        projectId,
        clientRequestId: "staged-angle-plan-other-owner",
      }),
    });
    assert.equal(angleConflictOtherOwner.status, 403, await angleConflictOtherOwner.text());

    const response = await request("/run-plan", "owner", {
      method: "POST",
      body: JSON.stringify({
        ...stagedFlow,
        onlyNodeId: secondStage.id,
        projectId,
        clientRequestId: "staged-fingerprint-forged-approval",
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 400, body);
    assert.match(body, /完整输入|重新生成并确认/);

    const firstStagePlan = buildExecutionPlan(stagedFlow.nodes, stagedFlow.edges, {
      onlyNodeId: firstStage.id,
      includeDownstream: false,
    });
    const firstFingerprint = createExecutionInputFingerprint({
      runType: "workflow",
      projectId,
      nodeId: firstStage.id,
      plan: firstStagePlan,
    });
    const firstRunId = "staged-first-success";
    const finishedAt = Date.now();
    await query(`
      INSERT INTO generation_runs (
        id, owner_id, project_id, project_name, node_id, node_label, kind, model,
        requested_count, successful_count, status, started_at, finished_at,
        plan_json, run_type, client_request_id, request_fingerprint, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'virtual-try-on', $7, 1, 1, 'success', $8, $9, $10, 'workflow', $11, $12, $9)
    `, [
      firstRunId,
      users.owner.id,
      projectId,
      "指纹门禁项目",
      firstStage.id,
      "第一轮场景定版",
      firstStage.data.modelId,
      finishedAt - 1,
      finishedAt,
      JSON.stringify(firstStagePlan),
      "staged-first-success-request",
      firstFingerprint,
    ]);
    await query(`
      INSERT INTO generation_outputs (id, run_id, image, status, created_at)
      VALUES ('staged-first-success-output', $1, $2, 'success', $3)
    `, [firstRunId, firstImage, finishedAt]);

    const otherProject = await request("/projects", "owner", {
      method: "POST",
      body: JSON.stringify({ id: otherProjectId, name: "跨项目指纹门禁", flow: stagedFlow }),
    });
    assert.equal(otherProject.status, 200, await otherProject.text());
    const crossProjectResponse = await request("/run-plan", "owner", {
      method: "POST",
      body: JSON.stringify({
        ...stagedFlow,
        onlyNodeId: secondStage.id,
        projectId: otherProjectId,
        clientRequestId: "staged-fingerprint-cross-project",
      }),
    });
    const crossProjectBody = await crossProjectResponse.text();
    assert.equal(crossProjectResponse.status, 400, crossProjectBody);
    assert.match(crossProjectBody, /完整输入|重新生成并确认/);

    const accepted = await request("/run-plan", "owner", {
      method: "POST",
      body: JSON.stringify({
        ...stagedFlow,
        onlyNodeId: secondStage.id,
        projectId,
        clientRequestId: "staged-fingerprint-valid",
      }),
    });
    const acceptedBody = await accepted.json() as { runId?: string; error?: string };
    assert.equal(accepted.status, 202, acceptedBody.error);
    assert.ok(acceptedBody.runId);
    const queuedBeforeChange = await queryOne<{ plan_json: string; request_fingerprint: string }>(`
      SELECT plan_json, request_fingerprint FROM generation_runs WHERE id = $1
    `, [acceptedBody.runId]);
    assert.ok(queuedBeforeChange);
    const queuedPlan = JSON.parse(queuedBeforeChange.plan_json) as { steps: Array<{ nodeId: string; params: Record<string, unknown> }> };
    assert.equal(queuedPlan.steps.at(-1)?.nodeId, secondStage.id);
    assert.equal("angleControl" in (queuedPlan.steps.at(-1)?.params ?? {}), false);

    const changedFlow = structuredClone(stagedFlow);
    const changedAngleNode = changedFlow.nodes.find((node) => node.id === angleNode.id);
    assert.equal(changedAngleNode?.data.kind, "ti-angle");
    if (changedAngleNode?.data.kind === "ti-angle") {
      changedAngleNode.data.angle.azimuthDeg = -55;
    }
    const changedFirstStage = changedFlow.nodes.find((node) => node.id === firstStage.id);
    assert.equal(changedFirstStage?.data.kind, "virtual-try-on");
    if (changedFirstStage?.data.kind === "virtual-try-on") {
      changedFirstStage.data.basisRevision = 2;
    }
    const changedApproval = changedFlow.nodes.find((node) => node.id === approval.id);
    assert.equal(changedApproval?.data.kind, "stage-approval");
    if (changedApproval?.data.kind === "stage-approval") {
      changedApproval.data.approvedBasisRevision = 2;
    }
    const changedProject = await request("/projects", "owner", {
      method: "POST",
      body: JSON.stringify({ id: projectId, name: "指纹门禁项目", flow: changedFlow }),
    });
    assert.equal(changedProject.status, 200, await changedProject.text());
    const staleResponse = await request("/run-plan", "owner", {
      method: "POST",
      body: JSON.stringify({
        ...changedFlow,
        onlyNodeId: secondStage.id,
        projectId,
        clientRequestId: "staged-fingerprint-stale",
      }),
    });
    const staleBody = await staleResponse.text();
    assert.equal(staleResponse.status, 400, staleBody);
    assert.match(staleBody, /完整输入|重新生成并确认/);
    assert.deepEqual(
      await queryOne<{ plan_json: string; request_fingerprint: string }>(`
        SELECT plan_json, request_fingerprint FROM generation_runs WHERE id = $1
      `, [acceptedBody.runId]),
      queuedBeforeChange,
    );

    const restoredProject = await request("/projects", "owner", {
      method: "POST",
      body: JSON.stringify({ id: projectId, name: "指纹门禁项目", flow: stagedFlow }),
    });
    assert.equal(restoredProject.status, 200, await restoredProject.text());
    const restoredResponse = await request("/run-plan", "owner", {
      method: "POST",
      body: JSON.stringify({
        ...stagedFlow,
        onlyNodeId: secondStage.id,
        projectId,
        clientRequestId: "staged-fingerprint-restored",
      }),
    });
    const restoredBody = await restoredResponse.json() as { runId?: string; error?: string };
    assert.equal(restoredResponse.status, 202, restoredBody.error);
    assert.ok(restoredBody.runId);
  } finally {
    await query("DELETE FROM generation_runs WHERE project_id = ANY($1::text[])", [[projectId, otherProjectId]]);
    await query("DELETE FROM projects WHERE id = ANY($1::text[])", [[projectId, otherProjectId]]);
  }
});

await test("项目保存与运行都拒绝引用他人的私有文件", async () => {
  await query(`
    INSERT INTO files (id, owner_id, source_type, created_at)
    VALUES ('other-secret.png', $1, 'upload', $2)
  `, [users.other.id, now]);
  const unsafeFlow = editFlow("/api/files/other-secret.png");
  const deniedSave = await request("/projects", "owner", {
    method: "POST",
    body: JSON.stringify({ id: "unsafe-save-project", name: "越权项目", flow: unsafeFlow }),
  });
  assert.equal(deniedSave.status, 403, await deniedSave.text());
  assert.equal(await queryOne("SELECT id FROM projects WHERE id = 'unsafe-save-project'"), undefined);

  await query(`
    INSERT INTO projects (id, owner_id, name, flow_json, updated_at, created_at)
    VALUES ('legacy-unsafe-project', $1, '历史越权项目', $2, $3, $3)
  `, [users.owner.id, JSON.stringify(unsafeFlow), now]);
  const deniedRun = await request("/run-plan", "owner", {
    method: "POST",
    body: JSON.stringify({
      ...unsafeFlow,
      onlyNodeId: "edit",
      projectId: "legacy-unsafe-project",
      clientRequestId: "legacy-unsafe-request",
    }),
  });
  assert.equal(deniedRun.status, 403, await deniedRun.text());
});

await test("深度图的嵌套中性源必须经过保存和计划文件授权", async () => {
  const uploaded = await request("/files", "owner", { method: "POST", body: JSON.stringify({ dataUrl: PNG_DATA_URL }) });
  assert.equal(uploaded.status, 200);
  const { url } = await uploaded.json() as { url: string };
  const nested = flow([url]);
  Object.assign(nested.nodes[0].data, { poseReferenceSource: { kind: "depth", image: url, neutralSource: "/api/files/other-secret.png" } });
  const denied = await request("/projects", "owner", { method: "POST", body: JSON.stringify({ id: "unsafe-neutral-source", name: "深度来源", flow: nested }) });
  assert.equal(denied.status, 403, await denied.text());
  const { assertImageReferencesAccessible } = await import("../server/lib/imageReferenceAccess");
  await assert.rejects(assertImageReferencesAccessible({ steps: [{ params: { poseNeutralSource: "/api/files/other-secret.png" } }] }, users.owner.id), /无权/);
});

await test("不存在或已软删除的本地文件不能进入项目或运行队列", async () => {
  const missingFlow = editFlow("/api/files/missing-image.png");
  const missingSave = await request("/projects", "owner", {
    method: "POST",
    body: JSON.stringify({ id: "missing-file-project", name: "缺失文件", flow: missingFlow }),
  });
  assert.equal(missingSave.status, 403, await missingSave.text());

  await query(`
    INSERT INTO files (id, owner_id, source_type, created_at, deleted_at, purge_after)
    VALUES ('deleted-image.png', $1, 'upload', $2, $2, $3)
  `, [users.owner.id, now, new Date(Date.now() + 86_400_000).toISOString()]);
  const deletedFlow = editFlow("/api/files/deleted-image.png");
  const deletedSave = await request("/projects", "owner", {
    method: "POST",
    body: JSON.stringify({ id: "deleted-file-project", name: "已删文件", flow: deletedFlow }),
  });
  assert.equal(deletedSave.status, 403, await deletedSave.text());

  for (const [projectId, projectFlow] of [
    ["legacy-missing-file", missingFlow],
    ["legacy-deleted-file", deletedFlow],
  ] as const) {
    await query(`
      INSERT INTO projects (id, owner_id, name, flow_json, updated_at, created_at)
      VALUES ($1, $2, '历史项目', $3, $4, $4)
    `, [projectId, users.owner.id, JSON.stringify(projectFlow), now]);
    const response = await request("/run-plan", "owner", {
      method: "POST",
      body: JSON.stringify({
        ...projectFlow,
        onlyNodeId: "edit",
        projectId,
        clientRequestId: `${projectId}-request`,
      }),
    });
    assert.equal(response.status, 403, await response.text());
  }
});

await test("直连生成复用项目与文件授权，且不信任客户端项目名称", async () => {
  const before = (await queryOne<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM generation_runs",
  ))?.count ?? 0;
  const missingRequestIdBody = directGenerateBody(PNG_DATA_URL);
  delete (missingRequestIdBody as { clientRequestId?: string }).clientRequestId;
  const missingRequestId = await request("/generate", "owner", {
    method: "POST",
    body: JSON.stringify(missingRequestIdBody),
  });
  assert.equal(missingRequestId.status, 400, await missingRequestId.text());

  const accepted = await request("/generate", "owner", {
    method: "POST",
    body: JSON.stringify(directGenerateBody(
      PNG_DATA_URL,
      "run-persisted-project",
      "direct-project-request",
    )),
  });
  const acceptedBody = await accepted.json() as { runId?: string; error?: string };
  assert.equal(accepted.status, 202, acceptedBody.error);
  const stored = await queryOne<{ project_id: string; project_name: string; owner_id: string }>(
    "SELECT project_id, project_name, owner_id FROM generation_runs WHERE id = $1",
    [acceptedBody.runId],
  );
  assert.deepEqual(stored, {
    project_id: "run-persisted-project",
    project_name: "服务端项目名",
    owner_id: users.owner.id,
  });
  const replay = await request("/generate", "owner", {
    method: "POST",
    body: JSON.stringify(directGenerateBody(
      PNG_DATA_URL,
      "run-persisted-project",
      "direct-project-request",
    )),
  });
  const replayBody = await replay.json() as { runId?: string; error?: string };
  assert.equal(replay.status, 202, replayBody.error);
  assert.equal(replayBody.runId, acceptedBody.runId);
  const changedBody = directGenerateBody(
    PNG_DATA_URL,
    "run-persisted-project",
    "direct-project-request",
  );
  changedBody.request.prompt = "同请求号的另一份语义";
  const conflict = await request("/generate", "owner", {
    method: "POST",
    body: JSON.stringify(changedBody),
  });
  assert.equal(conflict.status, 409, await conflict.text());

  const otherProject = await request("/generate", "other", {
    method: "POST",
    body: JSON.stringify(directGenerateBody(
      PNG_DATA_URL,
      "run-persisted-project",
      "direct-forbidden-project",
    )),
  });
  assert.equal(otherProject.status, 403, await otherProject.text());

  for (const [index, ref] of [
    "/api/files/other-secret.png",
    "/api/files/nested/other-secret.png",
    "/api/files/missing-image.png",
    "/api/files/deleted-image.png",
  ].entries()) {
    const denied = await request("/generate", "owner", {
      method: "POST",
      body: JSON.stringify(directGenerateBody(ref, undefined, `direct-denied-${index}`)),
    });
    assert.equal(denied.status, 403, `${ref}: ${await denied.text()}`);
  }

  const shared = await request("/generate", "other", {
    method: "POST",
    body: JSON.stringify(directGenerateBody(
      "/api/files/shared.png",
      undefined,
      "direct-shared-request",
    )),
  });
  assert.equal(shared.status, 202, await shared.text());
  const after = (await queryOne<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM generation_runs",
  ))?.count ?? 0;
  assert.equal(after, before + 2, "只有项目内合法请求与共享图片请求可以入队");
});

await test("回收站项目不能被同 ID 保存请求隐式复活", async () => {
  await query(`
    INSERT INTO projects (
      id, owner_id, name, flow_json, updated_at, created_at, deleted_at, purge_after
    ) VALUES ('deleted-save-project', $1, '已删除项目', $2, $3, $3, $3, $4)
  `, [users.owner.id, JSON.stringify(flow()), now, new Date(Date.now() + 86_400_000).toISOString()]);
  const response = await request("/projects", "owner", {
    method: "POST",
    body: JSON.stringify({ id: "deleted-save-project", name: "不应复活", flow: flow() }),
  });
  assert.equal(response.status, 409, await response.text());
  const row = await queryOne<{ name: string; deleted_at: string | null }>(
    "SELECT name, deleted_at FROM projects WHERE id = 'deleted-save-project'",
  );
  assert.equal(row?.name, "已删除项目");
  assert.ok(row?.deleted_at);
});

await test("初始草稿名称按上海日期固定生成", () => {
  assert.equal(
    initialDraftProjectName(new Date("2026-08-25T15:59:59.000Z")),
    "未修改项目名称20260825000000",
  );
  assert.equal(
    initialDraftProjectName(new Date("2026-08-25T16:00:00.000Z")),
    "未修改项目名称20260826000000",
  );
});

await test("并发 bootstrap 只创建一个草稿，revision 冲突不覆盖且正式保存原子提升同一项目", async () => {
  const candidateIds = ["initial-draft-concurrent-a", "initial-draft-concurrent-b"];
  let draftId = "";
  try {
    const responses = await Promise.all(candidateIds.map((id) => request(
      "/projects/initial-draft/bootstrap",
      "owner",
      {
        method: "POST",
        body: JSON.stringify({ id, flow: flow() }),
      },
    )));
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]);
    const payloads = await Promise.all(responses.map((response) => response.json() as Promise<{
      created: boolean;
      draft: {
        id: string;
        name: string;
        revision: number;
        lifecycle: string;
        flow: ReturnType<typeof flow>;
      };
    }>));
    assert.equal(payloads.filter((payload) => payload.created).length, 1);
    assert.equal(new Set(payloads.map((payload) => payload.draft.id)).size, 1);
    draftId = payloads[0].draft.id;
    assert.match(payloads[0].draft.name, /^未修改项目名称\d{8}000000$/);
    assert.equal(payloads[0].draft.revision, 0);
    assert.equal(payloads[0].draft.lifecycle, "initial_draft");

    const storedDrafts = await query<{ id: string; lifecycle: string; draft_revision: number }>(`
      SELECT id, lifecycle, draft_revision FROM projects
      WHERE owner_id = $1 AND lifecycle = 'initial_draft' AND deleted_at IS NULL
    `, [users.owner.id]);
    assert.deepEqual(storedDrafts, [{ id: draftId, lifecycle: "initial_draft", draft_revision: 0 }]);

    const ownerDraftResponse = await request("/projects/initial-draft", "owner");
    assert.equal(ownerDraftResponse.status, 200);
    assert.equal(ownerDraftResponse.headers.get("cache-control"), "no-store");
    const ownerDraft = await ownerDraftResponse.json() as { draft: { id: string; revision: number } | null };
    assert.equal(ownerDraft.draft?.id, draftId);
    assert.equal(ownerDraft.draft?.revision, 0);
    const otherDraft = await (await request("/projects/initial-draft", "other")).json() as { draft: unknown };
    assert.equal(otherDraft.draft, null);

    for (const viewer of ["owner", "admin"] as const) {
      const list = await (await request("/projects", viewer)).json() as Array<{ id: string }>;
      assert.equal(list.some((project) => project.id === draftId), false);
      assert.equal((await request(`/projects/${draftId}`, viewer)).status, 404);
    }

    const editedFlow = flow(["/api/files/own-private.png"]);
    const synchronized = await request(`/projects/initial-draft/${draftId}`, "owner", {
      method: "PUT",
      body: JSON.stringify({
        expectedRevision: 0,
        name: "本地旧草稿名称",
        flow: editedFlow,
      }),
    });
    const synchronizedPayload = await synchronized.json() as {
      draft: { id: string; name: string; revision: number };
      error?: string;
    };
    assert.equal(synchronized.status, 200, synchronizedPayload.error);
    assert.equal(synchronizedPayload.draft.id, draftId);
    assert.equal(synchronizedPayload.draft.name, "本地旧草稿名称");
    assert.equal(synchronizedPayload.draft.revision, 1);
    assert.deepEqual(await query<{ asset_id: string }>(`
      SELECT asset_id FROM project_asset_refs WHERE project_id = $1 ORDER BY asset_id
    `, [draftId]), [{ asset_id: "own-private" }]);

    const runsBeforeDraftBypass = (await queryOne<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM generation_runs",
    ))?.count ?? 0;
    const draftRunPlan = await request("/run-plan", "owner", {
      method: "POST",
      body: JSON.stringify({
        nodes: editedFlow.nodes,
        edges: editedFlow.edges,
        onlyNodeId: "image_0",
        includeDownstream: false,
        projectId: draftId,
        clientRequestId: "initial-draft-run-plan-blocked",
      }),
    });
    assert.equal(draftRunPlan.status, 404, await draftRunPlan.text());
    const draftDirectRun = await request("/generate", "owner", {
      method: "POST",
      body: JSON.stringify(directGenerateBody(
        PNG_DATA_URL,
        draftId,
        "initial-draft-direct-blocked",
      )),
    });
    assert.equal(draftDirectRun.status, 404, await draftDirectRun.text());
    assert.equal((await queryOne<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM generation_runs",
    ))?.count, runsBeforeDraftBypass);

    const stale = await request(`/projects/initial-draft/${draftId}`, "owner", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 0, name: "不应覆盖", flow: flow() }),
    });
    const stalePayload = await stale.json() as { currentRevision: number; error?: string };
    assert.equal(stale.status, 409, stalePayload.error);
    assert.equal(stalePayload.currentRevision, 1);
    assert.deepEqual(await queryOne<{ name: string; draft_revision: number }>(`
      SELECT name, draft_revision FROM projects WHERE id = $1
    `, [draftId]), { name: "本地旧草稿名称", draft_revision: 1 });

    const stalePromotion = await request("/projects", "owner", {
      method: "POST",
      body: JSON.stringify({
        id: draftId,
        name: "旧设备不应提升",
        flow: flow(),
        expectedDraftRevision: 0,
      }),
    });
    const stalePromotionPayload = await stalePromotion.json() as {
      currentRevision?: number;
      error?: string;
    };
    assert.equal(stalePromotion.status, 409, stalePromotionPayload.error);
    assert.equal(stalePromotionPayload.currentRevision, 1);

    const deniedPromotion = await request("/projects", "owner", {
      method: "POST",
      body: JSON.stringify({
        id: draftId,
        name: "不应提升",
        flow: flow(["/api/files/other-secret.png"]),
        expectedDraftRevision: 1,
      }),
    });
    assert.equal(deniedPromotion.status, 403, await deniedPromotion.text());
    assert.deepEqual(await queryOne<{ lifecycle: string; name: string; draft_revision: number }>(`
      SELECT lifecycle, name, draft_revision FROM projects WHERE id = $1
    `, [draftId]), {
      lifecycle: "initial_draft",
      name: "本地旧草稿名称",
      draft_revision: 1,
    });

    const promoted = await request("/projects", "owner", {
      method: "POST",
      body: JSON.stringify({
        id: draftId,
        name: "正式项目",
        flow: editedFlow,
        expectedDraftRevision: 1,
      }),
    });
    assert.equal(promoted.status, 200, await promoted.text());
    const savedBeforeStaleTab = await queryOne<{
      id: string;
      lifecycle: string;
      name: string;
      flow_json: string;
    }>(`
      SELECT id, lifecycle, name, flow_json FROM projects WHERE id = $1
    `, [draftId]);
    assert.equal(savedBeforeStaleTab?.id, draftId);
    assert.equal(savedBeforeStaleTab?.lifecycle, "saved");
    assert.equal(savedBeforeStaleTab?.name, "正式项目");

    const staleTabPromotion = await request("/projects", "owner", {
      method: "POST",
      body: JSON.stringify({
        id: draftId,
        name: "旧页签不应覆盖",
        flow: flow(),
        expectedDraftRevision: 1,
      }),
    });
    assert.equal(staleTabPromotion.status, 409, await staleTabPromotion.text());
    assert.deepEqual(await queryOne<{
      id: string;
      lifecycle: string;
      name: string;
      flow_json: string;
    }>(`
      SELECT id, lifecycle, name, flow_json FROM projects WHERE id = $1
    `, [draftId]), savedBeforeStaleTab);
    const afterPromotion = await (await request("/projects/initial-draft", "owner")).json() as { draft: unknown };
    assert.equal(afterPromotion.draft, null);
    const officialList = await (await request("/projects", "owner")).json() as Array<{ id: string }>;
    assert.equal(officialList.some((project) => project.id === draftId), true);
  } finally {
    await query("DELETE FROM projects WHERE id = ANY($1::text[])", [candidateIds]);
  }
});

await test("草稿权限统一隐藏，放弃需确认且 15 天内可恢复", async () => {
  const ownerDraftId = "abandon-owner-initial-draft";
  const otherDraftId = "abandon-other-initial-draft";
  const replacementDraftId = "abandon-owner-replacement";
  const maskFileId = "abandon-owner-mask";
  const retiredMaskFileId = "abandon-owner-retired-mask";
  try {
    for (const [user, id] of [["owner", ownerDraftId], ["other", otherDraftId]] as const) {
      const bootstrap = await request("/projects/initial-draft/bootstrap", user, {
        method: "POST",
        body: JSON.stringify({ id, flow: flow() }),
      });
      assert.equal(bootstrap.status, 201, await bootstrap.text());
    }
    const retiredPurgeAfter = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString();
    await query(`
      INSERT INTO files (
        id, owner_id, source_type, mime_type, project_id, node_id, created_at,
        deleted_at, purge_after
      ) VALUES
        ($1, $3, 'mask', 'image/png', $4, 'mask-node', $5, NULL, NULL),
        ($2, $3, 'mask', 'image/png', $4, 'retired-mask-node', $5, NULL, $6)
    `, [
      maskFileId,
      retiredMaskFileId,
      users.owner.id,
      ownerDraftId,
      now,
      retiredPurgeAfter,
    ]);

    const deniedUpdate = await request(`/projects/initial-draft/${ownerDraftId}`, "other", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 0, name: "不应该可见", flow: flow() }),
    });
    const unknownUpdate = await request("/projects/initial-draft/unknown-draft-id", "other", {
      method: "PUT",
      body: JSON.stringify({ expectedRevision: 0, name: "不存在", flow: flow() }),
    });
    assert.equal(deniedUpdate.status, 404);
    assert.equal(unknownUpdate.status, 404);
    assert.deepEqual(await deniedUpdate.json(), await unknownUpdate.json());

    const deniedDelete = await request(`/projects/initial-draft/${ownerDraftId}`, "other", {
      method: "DELETE",
      body: JSON.stringify({ confirm: true, expectedRevision: 0 }),
    });
    assert.equal(deniedDelete.status, 404, await deniedDelete.text());

    const missingConfirmation = await request(`/projects/initial-draft/${ownerDraftId}`, "owner", {
      method: "DELETE",
      body: JSON.stringify({ expectedRevision: 0 }),
    });
    assert.equal(missingConfirmation.status, 400, await missingConfirmation.text());
    const stale = await request(`/projects/initial-draft/${ownerDraftId}`, "owner", {
      method: "DELETE",
      body: JSON.stringify({ confirm: true, expectedRevision: 1 }),
    });
    assert.equal(stale.status, 409, await stale.text());
    assert.deepEqual(await queryOne<{ deleted_at: string | null; draft_revision: number }>(`
      SELECT deleted_at, draft_revision FROM projects WHERE id = $1
    `, [ownerDraftId]), { deleted_at: null, draft_revision: 0 });

    const beforeAbandon = Date.now();
    const abandoned = await request(`/projects/initial-draft/${ownerDraftId}`, "owner", {
      method: "DELETE",
      body: JSON.stringify({ confirm: true, expectedRevision: 0 }),
    });
    const abandonedPayload = await abandoned.json() as { ok?: boolean; purgeAfter?: string; error?: string };
    assert.equal(abandoned.status, 200, abandonedPayload.error);
    assert.equal(abandonedPayload.ok, true);
    const purgeAfterMs = new Date(abandonedPayload.purgeAfter ?? "").getTime();
    assert.ok(purgeAfterMs >= beforeAbandon + 15 * 24 * 60 * 60 * 1_000 - 2_000);
    assert.ok(purgeAfterMs <= Date.now() + 15 * 24 * 60 * 60 * 1_000 + 2_000);
    const abandonedRow = await queryOne<{
      lifecycle: string;
      deleted_at: string | null;
      purge_after: string | null;
    }>(`
      SELECT lifecycle, deleted_at, purge_after FROM projects WHERE id = $1
    `, [ownerDraftId]);
    assert.equal(abandonedRow?.lifecycle, "initial_draft");
    assert.ok(abandonedRow?.deleted_at);
    assert.equal(abandonedRow?.purge_after, abandonedPayload.purgeAfter);
    const abandonedMask = await queryOne<{ deleted_at: string | null; purge_after: string | null }>(`
      SELECT deleted_at, purge_after FROM files WHERE id = $1
    `, [maskFileId]);
    assert.ok(abandonedMask?.deleted_at);
    assert.equal(abandonedMask?.purge_after, abandonedPayload.purgeAfter);
    const afterAbandon = await (await request("/projects/initial-draft", "owner")).json() as { draft: unknown };
    assert.equal(afterAbandon.draft, null);

    const replacement = await request("/projects/initial-draft/bootstrap", "owner", {
      method: "POST",
      body: JSON.stringify({ id: replacementDraftId, flow: flow() }),
    });
    const replacementPayload = await replacement.json() as { draft?: { id: string }; error?: string };
    assert.equal(replacement.status, 201, replacementPayload.error);
    assert.equal(replacementPayload.draft?.id, replacementDraftId);

    const blockedRestore = await request(`/projects/initial-draft/${ownerDraftId}/restore`, "owner", {
      method: "POST",
      body: "{}",
    });
    const blockedRestorePayload = await blockedRestore.json() as { currentDraftId?: string; error?: string };
    assert.equal(blockedRestore.status, 409, blockedRestorePayload.error);
    assert.equal(blockedRestorePayload.currentDraftId, replacementDraftId);

    const abandonReplacement = await request(`/projects/initial-draft/${replacementDraftId}`, "owner", {
      method: "DELETE",
      body: JSON.stringify({ confirm: true, expectedRevision: 0 }),
    });
    assert.equal(abandonReplacement.status, 200, await abandonReplacement.text());
    const restored = await request(`/projects/initial-draft/${ownerDraftId}/restore`, "owner", {
      method: "POST",
      body: "{}",
    });
    const restoredPayload = await restored.json() as { draft?: { id: string; revision: number }; error?: string };
    assert.equal(restored.status, 200, restoredPayload.error);
    assert.equal(restoredPayload.draft?.id, ownerDraftId);
    assert.equal(restoredPayload.draft?.revision, 0);
    assert.deepEqual(await queryOne<{ deleted_at: string | null; purge_after: string | null }>(`
      SELECT deleted_at, purge_after FROM files WHERE id = $1
    `, [maskFileId]), { deleted_at: null, purge_after: null });
    assert.deepEqual(await queryOne<{ deleted_at: string | null; purge_after: string | null }>(`
      SELECT deleted_at, purge_after FROM files WHERE id = $1
    `, [retiredMaskFileId]), { deleted_at: null, purge_after: retiredPurgeAfter });
  } finally {
    await query("DELETE FROM files WHERE id = ANY($1::text[])", [[maskFileId, retiredMaskFileId]]);
    await query("DELETE FROM projects WHERE id = ANY($1::text[])", [[
      ownerDraftId,
      otherDraftId,
      replacementDraftId,
    ]]);
  }
});

await test("账号转移遇到双方各自的初始草稿时明确拒绝且不改变归属", async () => {
  const sourceDraftId = "transfer-source-initial-draft";
  const targetDraftId = "transfer-target-initial-draft";
  await query(`
    INSERT INTO projects (
      id, owner_id, name, flow_json, lifecycle, draft_revision, updated_at, created_at
    ) VALUES
      ($1, $3, '转出草稿', $5, 'initial_draft', 0, $6, $6),
      ($2, $4, '接收草稿', $5, 'initial_draft', 0, $6, $6)
  `, [sourceDraftId, targetDraftId, users.owner.id, users.other.id, JSON.stringify(flow()), now]);
  try {
    const response = await request(`/auth/users/${users.owner.id}`, "admin", {
      method: "DELETE",
      headers: { cookie: `${SESSION_COOKIE}=${adminSession.token}` },
      body: JSON.stringify({ transferToUserId: users.other.id }),
    });
    const payload = await response.json() as { error: string };
    assert.equal(response.status, 409, payload.error);
    assert.match(payload.error, /初始草稿/);
    assert.deepEqual(await query<{ id: string; owner_id: string }>(`
      SELECT id, owner_id FROM projects WHERE id = ANY($1::text[]) ORDER BY id
    `, [[sourceDraftId, targetDraftId]]), [
      { id: sourceDraftId, owner_id: users.owner.id },
      { id: targetDraftId, owner_id: users.other.id },
    ]);
    assert.equal((await queryOne<{ active: number }>(`
      SELECT active FROM users WHERE id = $1
    `, [users.owner.id]))?.active, 1);
  } finally {
    await query("DELETE FROM projects WHERE id = ANY($1::text[])", [[sourceDraftId, targetDraftId]]);
  }
});

await test("项目保存按最终画布原子同步可访问素材引用", async () => {
  const save = await request("/projects", "owner", {
    method: "POST",
    body: JSON.stringify({
      id: "owner-project",
      name: "Owner Project",
      flow: flow(["/api/files/shared.png", "/api/files/own-private.png"]),
    }),
  });
  assert.equal(save.status, 200, await save.text());
  const refs = await query<{ asset_id: string }>(
    "SELECT asset_id FROM project_asset_refs WHERE project_id = $1 ORDER BY asset_id",
    ["owner-project"],
  );
  assert.deepEqual(refs, [{ asset_id: "own-private" }, { asset_id: "shared-asset" }]);

  const clear = await request("/projects", "owner", {
    method: "POST",
    body: JSON.stringify({ id: "owner-project", name: "Owner Project", flow: flow() }),
  });
  assert.equal(clear.status, 200, await clear.text());
  const remaining = await queryOne<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM project_asset_refs WHERE project_id = $1",
    ["owner-project"],
  );
  assert.equal(remaining?.count, 0);
});

await test("素材删除与项目引用写入使用互斥行锁避免 TOCTOU", () => {
  const assetsSource = fs.readFileSync(new URL("../server/routes/assets.ts", import.meta.url), "utf8");
  const projectsSource = fs.readFileSync(new URL("../server/routes/projects.ts", import.meta.url), "utf8");
  assert.match(assetsSource, /SELECT owner_id, scope FROM assets[\s\S]*FOR UPDATE/);
  assert.match(projectsSource, /FROM assets[\s\S]*FOR KEY SHARE/);
});

await test("项目写入先持 owner 锁时，真实账号转移等待并接收刚提交的数据", async () => {
  const sourceKey = "lockTransferSource";
  const targetKey = "lockTransferTarget";
  const source: AuthUser = {
    id: "owner-lock-transfer-source", accountId: sourceKey, displayName: "锁转移来源",
    role: "user", mustChangePassword: false,
  };
  const target: AuthUser = {
    id: "owner-lock-transfer-target", accountId: targetKey, displayName: "锁转移目标",
    role: "user", mustChangePassword: false,
  };
  users[sourceKey] = source;
  users[targetKey] = target;
  const projectId = "owner-lock-order-project";
  const createdAt = new Date().toISOString();
  await query(`
    INSERT INTO users (id, account_id, display_name, role, password_hash, active, created_at, updated_at)
    VALUES
      ($1, $2, $3, 'user', 'test-only', 1, $7, $7),
      ($4, $5, $6, 'user', 'test-only', 1, $7, $7)
  `, [source.id, source.accountId, source.displayName, target.id, target.accountId, target.displayName, createdAt]);
  await query(`
    INSERT INTO projects (id, owner_id, name, flow_json, updated_at, created_at)
    VALUES ($1, $2, '锁顺序旧名称', $3, $4, $4)
  `, [projectId, source.id, JSON.stringify(flow()), createdAt]);
  const projectBlocker = await db().connect();
  let projectBlockerOpen = false;
  let savePromise: Promise<Response> | undefined;
  let transferPromise: Promise<Response> | undefined;
  try {
    await projectBlocker.query("BEGIN");
    projectBlockerOpen = true;
    const blockerPid = (await projectBlocker.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    )).rows[0].pid;
    await projectBlocker.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [projectId]);

    savePromise = request("/projects", sourceKey, {
      method: "POST",
      body: JSON.stringify({ id: projectId, name: "锁顺序新名称", flow: flow() }),
    });
    let saveBackendPid = 0;
    await waitForDatabaseCondition("项目保存已在 owner guard 后等待项目行锁", async () => {
      const row = await queryOne<{ pid: number }>(`
        SELECT activity.pid FROM pg_stat_activity activity
        WHERE $1::int = ANY(pg_blocking_pids(activity.pid))
          AND activity.query LIKE '%FROM projects WHERE id = $1 FOR UPDATE%'
        LIMIT 1
      `, [blockerPid]);
      saveBackendPid = row?.pid ?? 0;
      return saveBackendPid > 0;
    });

    transferPromise = request(`/auth/users/${source.id}`, "admin", {
      method: "DELETE",
      headers: { cookie: `${SESSION_COOKIE}=${adminSession.token}` },
      body: JSON.stringify({ transferToUserId: target.id }),
    });
    await waitForDatabaseCondition("真实账号转移等待项目保存持有的用户共享锁", async () => {
      const row = await queryOne<{ count: number }>(`
        SELECT COUNT(*)::int AS count FROM pg_stat_activity activity
        WHERE $1::int = ANY(pg_blocking_pids(activity.pid))
          AND activity.query LIKE '%SELECT id, active, deleted_at FROM users%FOR NO KEY UPDATE%'
      `, [saveBackendPid]);
      return (row?.count ?? 0) >= 1;
    });

    await projectBlocker.query("COMMIT");
    projectBlockerOpen = false;
    const [saveResponse, transferResponse] = await Promise.all([savePromise, transferPromise]);
    assert.equal(saveResponse.status, 200, await saveResponse.text());
    assert.equal(transferResponse.status, 200, await transferResponse.text());
    assert.deepEqual(await queryOne<{ owner_id: string; name: string }>(`
      SELECT owner_id, name FROM projects WHERE id = $1
    `, [projectId]), { owner_id: target.id, name: "锁顺序新名称" });
    const transferredSource = await queryOne<{ active: number; deleted_at: string | null }>(`
      SELECT active, deleted_at FROM users WHERE id = $1
    `, [source.id]);
    assert.equal(transferredSource?.active, 0);
    assert.ok(transferredSource?.deleted_at);
  } finally {
    if (projectBlockerOpen) await projectBlocker.query("ROLLBACK");
    if (savePromise || transferPromise) {
      await Promise.allSettled([savePromise, transferPromise].filter(Boolean) as Promise<Response>[]);
    }
    projectBlocker.release();
    await query("DELETE FROM project_asset_refs WHERE project_id = $1", [projectId]);
    await query("DELETE FROM projects WHERE id = $1", [projectId]);
    await query("DELETE FROM sessions WHERE user_id = ANY($1::text[])", [[source.id, target.id]]);
    await query("DELETE FROM users WHERE id = ANY($1::text[])", [[source.id, target.id]]);
    delete users[sourceKey];
    delete users[targetKey];
  }
});

await test("真实账号删除先持 owner 锁时，全部并发写入等待后拒绝并补偿文件", async () => {
  const sourceKey = "lockDeleteSource";
  const source: AuthUser = {
    id: "owner-lock-delete-source", accountId: sourceKey, displayName: "锁删除来源",
    role: "user", mustChangePassword: false,
  };
  users[sourceKey] = source;
  const patchAssetId = "owner-lock-patch-asset";
  const restoreAssetId = "owner-lock-restore-asset";
  const existingFileId = "owner-lock-existing.png";
  const runId = "owner-lock-history-run";
  const outputId = "owner-lock-history-output";
  const blockerProjectId = "owner-lock-existing-project";
  const projectId = "owner-lock-blocked-project";
  const createdAt = new Date().toISOString();
  await query(`
    INSERT INTO users (id, account_id, display_name, role, password_hash, active, created_at, updated_at)
    VALUES ($1, $2, $3, 'user', 'test-only', 1, $4, $4)
  `, [source.id, source.accountId, source.displayName, createdAt]);
  await query(`
    INSERT INTO projects (id, owner_id, name, flow_json, updated_at, created_at)
    VALUES ($1, $2, '账号删除锁项目', $3, $4, $4)
  `, [blockerProjectId, source.id, JSON.stringify(flow()), createdAt]);
  await query(`
    INSERT INTO files (id, owner_id, source_type, created_at)
    VALUES ($1, $2, 'upload', $3)
  `, [existingFileId, source.id, createdAt]);
  await query(`
    INSERT INTO assets (
      id, owner_id, scope, name, category, image, created_at, deleted_at, purge_after
    ) VALUES
      ($1, $3, 'private', '锁前名称', 'reference', '/api/files/lock-patch.png', $4, NULL, NULL),
      ($2, $3, 'private', '回收站素材', 'reference', '/api/files/lock-restore.png', $4, $4, $4)
  `, [patchAssetId, restoreAssetId, source.id, createdAt]);
  await query(`
    INSERT INTO generation_runs (
      id, owner_id, node_id, node_label, kind, requested_count, status, started_at, finished_at
    ) VALUES ($1, $2, 'history-node', '历史节点', 'ai-modify', 1, 'failed', 1, 2)
  `, [runId, source.id]);
  await query(`
    INSERT INTO generation_outputs (id, run_id, image, status, error, created_at)
    VALUES ($1, $2, '', 'error', '失败', 2)
  `, [outputId, runId]);
  const beforeStored = new Set(fs.readdirSync(uploadsDir()));
  const lifecycleBlocker = await db().connect();
  let lifecycleBlockerOpen = false;
  let deletePromise: Promise<Response> | undefined;
  let responsesPromise: Promise<Response[]> | undefined;
  try {
    await lifecycleBlocker.query("BEGIN");
    lifecycleBlockerOpen = true;
    const blockerPid = (await lifecycleBlocker.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    )).rows[0].pid;
    await lifecycleBlocker.query(
      "SELECT id FROM projects WHERE id = $1 FOR UPDATE",
      [blockerProjectId],
    );

    deletePromise = request(`/auth/users/${source.id}`, "admin", {
      method: "DELETE",
      headers: { cookie: `${SESSION_COOKIE}=${adminSession.token}` },
      body: JSON.stringify({ deleteData: true }),
    });
    let lifecyclePid = 0;
    await waitForDatabaseCondition("真实账号删除已持用户锁并等待项目扫描", async () => {
      const row = await queryOne<{ pid: number }>(`
        SELECT activity.pid FROM pg_stat_activity activity
        WHERE $1::int = ANY(pg_blocking_pids(activity.pid))
          AND activity.query LIKE '%UPDATE projects SET deleted_at%'
        LIMIT 1
      `, [blockerPid]);
      lifecyclePid = row?.pid ?? 0;
      return lifecyclePid > 0;
    });

    responsesPromise = Promise.all([
      request("/projects", sourceKey, {
        method: "POST",
        body: JSON.stringify({ id: projectId, name: "被阻止项目", flow: flow() }),
      }),
      request("/files", sourceKey, {
        method: "POST",
        body: JSON.stringify({ dataUrl: PNG_DATA_URL }),
      }),
      request("/assets", sourceKey, {
        method: "POST",
        body: JSON.stringify({
          name: "被阻止素材", category: "reference", scope: "private", image: PNG_DATA_URL,
        }),
      }),
      request(`/assets/${patchAssetId}`, sourceKey, {
        method: "PATCH",
        body: JSON.stringify({ name: "不应写入的新名称" }),
      }),
      request(`/assets/${restoreAssetId}/restore`, sourceKey, { method: "POST" }),
      request(`/history/${outputId}`, sourceKey, { method: "DELETE" }),
    ]);
    await waitForDatabaseCondition("六类 owner 写请求均等待真实账号删除锁", async () => {
      const row = await queryOne<{ count: number }>(`
        SELECT COUNT(*)::int AS count FROM pg_stat_activity activity
        WHERE $1::int = ANY(pg_blocking_pids(activity.pid))
          AND activity.query LIKE '%SELECT active, deleted_at FROM users%FOR SHARE%'
      `, [lifecyclePid]);
      return (row?.count ?? 0) >= 6;
    });

    await lifecycleBlocker.query("COMMIT");
    lifecycleBlockerOpen = false;
    const [deleteResponse, responses] = await Promise.all([deletePromise, responsesPromise]);
    assert.equal(deleteResponse.status, 200, await deleteResponse.text());
    assert.deepEqual(responses.map((response) => response.status), [409, 409, 409, 409, 409, 409]);

    assert.equal(await queryOne("SELECT id FROM projects WHERE id = $1", [projectId]), undefined);
    assert.equal(await queryOne("SELECT id FROM assets WHERE name = '被阻止素材'"), undefined);
    for (const [table, id] of [
      ["projects", blockerProjectId],
      ["files", existingFileId],
      ["assets", patchAssetId],
      ["assets", restoreAssetId],
      ["generation_runs", runId],
    ] as const) {
      assert.ok((await queryOne<{ deleted_at: string | null }>(
        `SELECT deleted_at FROM ${table} WHERE id = $1`,
        [id],
      ))?.deleted_at, `${table}/${id} 应进入回收期`);
    }
    assert.equal((await queryOne<{ name: string }>(
      "SELECT name FROM assets WHERE id = $1",
      [patchAssetId],
    ))?.name, "锁前名称");
    assert.ok(await queryOne("SELECT id FROM generation_outputs WHERE id = $1", [outputId]));
    assert.deepEqual(new Set(fs.readdirSync(uploadsDir())), beforeStored);
  } finally {
    if (lifecycleBlockerOpen) await lifecycleBlocker.query("ROLLBACK");
    if (deletePromise || responsesPromise) {
      await Promise.allSettled([deletePromise, responsesPromise].filter(Boolean) as Promise<unknown>[]);
    }
    lifecycleBlocker.release();
    await query("DELETE FROM generation_outputs WHERE run_id = $1", [runId]);
    await query("DELETE FROM generation_jobs WHERE run_id = $1", [runId]);
    await query("DELETE FROM generation_run_steps WHERE run_id = $1", [runId]);
    await query("DELETE FROM usage_events WHERE run_id = $1", [runId]);
    await query("DELETE FROM generation_runs WHERE id = $1", [runId]);
    await query("DELETE FROM project_asset_refs WHERE project_id = ANY($1::text[])", [
      [projectId, blockerProjectId],
    ]);
    await query("DELETE FROM projects WHERE id = ANY($1::text[])", [[projectId, blockerProjectId]]);
    await query("DELETE FROM assets WHERE id = ANY($1::text[]) OR name = '被阻止素材'", [
      [patchAssetId, restoreAssetId],
    ]);
    await query("DELETE FROM files WHERE id = $1", [existingFileId]);
    await query("DELETE FROM sessions WHERE user_id = $1", [source.id]);
    await query("DELETE FROM users WHERE id = $1", [source.id]);
    delete users[sourceKey];
    const leakedFiles = fs.readdirSync(uploadsDir()).filter((id) => !beforeStored.has(id));
    if (leakedFiles.length > 0) {
      await query("DELETE FROM files WHERE id = ANY($1::text[])", [leakedFiles]);
      leakedFiles.forEach(deleteStoredImage);
    }
  }
});

await test("历史记录只有所有者能删除，其他人与不存在记录统一返回 404", async () => {
  await query(`
    INSERT INTO generation_runs (
      id, owner_id, node_id, node_label, kind, requested_count, status, started_at, finished_at
    ) VALUES
      ('history-other-run', $1, 'node', '节点', 'ai-modify', 1, 'error', 1, 2),
      ('history-owner-run', $2, 'node', '节点', 'ai-modify', 1, 'error', 1, 2)
  `, [users.other.id, users.owner.id]);
  await query(`
    INSERT INTO generation_outputs (id, run_id, image, status, error, created_at)
    VALUES
      ('history-other-output', 'history-other-run', '', 'error', '失败', 2),
      ('history-owner-output', 'history-owner-run', '', 'error', '失败', 2)
  `);
  assert.equal((await request("/history/history-other-output", "owner", { method: "DELETE" })).status, 404);
  assert.equal((await request("/history/missing-output", "owner", { method: "DELETE" })).status, 404);
  assert.equal((await request("/history/history-owner-output", "owner", { method: "DELETE" })).status, 200);
  assert.equal(await queryOne("SELECT id FROM generation_outputs WHERE id = 'history-owner-output'"), undefined);
});

interface HistoryPage {
  records: Array<{
    id: string;
    runId: string;
    clientRequestId?: string;
    status?: string;
    parameters?: unknown;
    referenceImages?: unknown;
  }>;
  nextCursor: string | null;
  hasMore: boolean;
}

await test("普通历史不会把无执行计划的旧活动状态恢复成正在运行", async () => {
  const runIds = ["legacy-planless-active", "legacy-planless-terminal"];
  try {
    await query(`
      INSERT INTO generation_runs (
        id, owner_id, node_id, node_label, kind, requested_count, status, started_at, finished_at
      ) VALUES
        ($1, $3, 'legacy-active-node', '旧活动任务', 'ai-modify', 1, 'queued', 95000, NULL),
        ($2, $3, 'legacy-terminal-node', '旧终态任务', 'ai-modify', 1, 'failed', 94000, 94001)
    `, [runIds[0], runIds[1], users.owner.id]);

    const response = await request("/history?limit=20&before=100000", "owner");
    assert.equal(response.status, 200);
    const page = await response.json() as HistoryPage;
    assert.equal(page.records.some((record) => record.runId === runIds[0]), false);
    assert.equal(page.records.some((record) => record.runId === runIds[1]), true);
  } finally {
    await query("DELETE FROM generation_runs WHERE id = ANY($1::text[])", [runIds]);
  }
});

await test("活动任务使用独立完整集合，不会被最近历史的 20 条分页截断", async () => {
  const ids = ["old-active-run"];
  try {
    await query(`
      INSERT INTO generation_runs (
        id, owner_id, node_id, node_label, kind, requested_count, status, started_at,
        plan_json, client_request_id, request_fingerprint
      ) VALUES (
        'old-active-run', $1, 'old-active-node', '旧活动任务', 'ai-modify', 1, 'running', 90000,
        '{"steps":[]}', 'old-active-request', 'old-active-fingerprint'
      )
    `, [users.owner.id]);
    for (let index = 0; index < 25; index += 1) {
      const id = `newer-terminal-${index}`;
      ids.push(id);
      await query(`
        INSERT INTO generation_runs (
          id, owner_id, node_id, node_label, kind, requested_count, status, started_at,
          finished_at, plan_json
        ) VALUES ($1, $2, 'terminal-node', '新终态', 'ai-modify', 1, 'failed', $3, $3, '{"steps":[]}')
      `, [id, users.owner.id, 100000 + index]);
    }

    const recent = await request("/history?limit=20&before=200000", "owner");
    assert.equal(recent.status, 200);
    const recentPage = await recent.json() as HistoryPage;
    assert.equal(recentPage.records.some((record) => record.runId === "old-active-run"), false);

    const active = await request("/history/active", "owner");
    const activePage = await active.json() as HistoryPage;
    assert.equal(active.status, 200, JSON.stringify(activePage));
    const oldActive = activePage.records.find((record) => record.runId === "old-active-run");
    assert.equal(oldActive?.status, "running");
    assert.equal(oldActive?.clientRequestId, "old-active-request");
    assert.equal(oldActive?.parameters, undefined, "活动恢复接口不得回传大参数体");
    assert.equal(oldActive?.referenceImages, undefined, "活动恢复接口不得回传参考图数组");
    assert.equal(activePage.hasMore, false);
  } finally {
    await query("DELETE FROM generation_runs WHERE id = ANY($1::text[])", [ids]);
  }
});

await test("活动任务超过安全恢复上限时接口 fail-closed", async () => {
  try {
    await query(`
      INSERT INTO generation_runs (
        id, owner_id, node_id, node_label, kind, requested_count, status, started_at, plan_json
      )
      SELECT
        'active-overflow-' || index, $1, 'active-overflow-node-' || index,
        '活动任务上限', 'ai-modify', 1, 'running', 300000 + index, '{"steps":[]}'
      FROM generate_series(1, 181) AS index
    `, [users.owner.id]);
    const response = await request("/history/active", "owner");
    assert.equal(response.status, 409, await response.text());
    const enqueue = await request("/run-plan", "owner", {
      method: "POST",
      body: JSON.stringify({
        ...generationFlow("后来保存的提示词"),
        onlyNodeId: "generate",
        projectId: "run-persisted-project",
        clientRequestId: "active-overflow-new-request",
      }),
    });
    const enqueueBody = await enqueue.text();
    assert.equal(enqueue.status, 409, enqueueBody);
    assert.match(enqueueBody, /活动任务.*上限/);
    assert.equal(
      await queryOne("SELECT id FROM generation_runs WHERE client_request_id = 'active-overflow-new-request'"),
      undefined,
    );
  } finally {
    await query("DELETE FROM generation_runs WHERE id LIKE 'active-overflow-%'");
  }
});

await test("画板版本按 owner/project/node/base 授权并以请求号幂等", async () => {
  const projectId = "drawing-owner-project";
  const nodeId = "drawing-node";
  const boardFlow = {
    schemaVersion: 5,
    nodes: [{
      id: nodeId,
      type: "drawing-board",
      position: { x: 0, y: 0 },
      data: {
        kind: "drawing-board", label: "画板", status: "idle", boardVersion: 1,
        width: 1024, height: 1024, background: "#FFFFFF",
      },
    }],
    edges: [],
  };
  const project = await request("/projects", "owner", {
    method: "POST",
    body: JSON.stringify({ id: projectId, name: "画板项目", flow: boardFlow }),
  });
  assert.equal(project.status, 200, await project.text());

  const document = {
    version: 1,
    canvas: { width: 1024, height: 1024, background: "#FFFFFF" },
    layers: [{ id: "layer-1", name: "图层 1", visible: true, locked: false, opacity: 1, objects: [] }],
  };
  const body = {
    clientRequestId: "drawing-request-0001", projectId, nodeId, baseContentRef: null, document,
  };
  const foreignUpload = await request("/files", "other", { method: "POST", body: JSON.stringify({ dataUrl: PNG_DATA_URL }) });
  const foreignImage = await foreignUpload.json() as { url: string };
  assert.equal((await request("/drawing-boards/versions", "owner", {
    method: "POST", body: JSON.stringify({ ...body, clientRequestId: "drawing-foreign-image", document: { ...document, baseImage: { url: foreignImage.url, width: 1, height: 1 } } }),
  })).status, 404);
  const created = await request("/drawing-boards/versions", "owner", {
    method: "POST", body: JSON.stringify(body),
  });
  const createdText = await created.text();
  assert.equal(created.status, 201, createdText);
  const createdBody = JSON.parse(createdText) as { contentRef: string; sha256: string };
  assert.match(createdBody.contentRef, /^draw_/);
  assert.match(createdBody.sha256, /^[0-9a-f]{64}$/);

  const replay = await request("/drawing-boards/versions", "owner", {
    method: "POST", body: JSON.stringify(body),
  });
  const replayText = await replay.text();
  assert.equal(replay.status, 200, replayText);
  assert.equal((JSON.parse(replayText) as { contentRef: string }).contentRef, createdBody.contentRef);
  const advancedBoardFlow = structuredClone(boardFlow);
  advancedBoardFlow.nodes[0].data.contentRef = createdBody.contentRef;
  await query("UPDATE projects SET flow_json = $1 WHERE id = $2", [JSON.stringify(advancedBoardFlow), projectId]);
  const replayAfterAdvance = await request("/drawing-boards/versions", "owner", {
    method: "POST", body: JSON.stringify(body),
  });
  const replayAfterAdvanceText = await replayAfterAdvance.text();
  assert.equal(replayAfterAdvance.status, 200, replayAfterAdvanceText);
  assert.equal(
    (JSON.parse(replayAfterAdvanceText) as { contentRef: string }).contentRef,
    createdBody.contentRef,
  );
  assert.equal((await request(`/drawing-boards/versions/${createdBody.contentRef}`, "owner")).status, 200);
  assert.equal((await request(`/drawing-boards/versions/${createdBody.contentRef}`, "other")).status, 404);
  assert.equal((await request(`/drawing-boards/versions/${createdBody.contentRef}`, "admin")).status, 404);

  const wrongOwner = await request("/drawing-boards/versions", "other", {
    method: "POST", body: JSON.stringify({ ...body, clientRequestId: "drawing-request-other" }),
  });
  assert.equal(wrongOwner.status, 404);
  const wrongNode = await request("/drawing-boards/versions", "owner", {
    method: "POST", body: JSON.stringify({ ...body, nodeId: "other-node", clientRequestId: "drawing-request-node" }),
  });
  assert.equal(wrongNode.status, 404);
  const conflictingReplay = await request("/drawing-boards/versions", "owner", {
    method: "POST",
    body: JSON.stringify({
      ...body,
      document: { ...document, canvas: { ...document.canvas, background: "#000000" } },
    }),
  });
  assert.equal(conflictingReplay.status, 409);
  assert.equal((await queryOne<{ count: number }>(`
    SELECT COUNT(*)::int AS count FROM drawing_document_versions WHERE project_id = $1
  `, [projectId]))?.count, 1);
});

await test("新建画板将不可变版本与完整项目节点原子提交并保持幂等", async () => {
  const projectId = "drawing-create-project";
  const nodeId = "drawing-created-node";
  const project = await request("/projects", "owner", {
    method: "POST",
    body: JSON.stringify({
      id: projectId,
      name: "原子画板项目",
      flow: { schemaVersion: 5, nodes: [], edges: [] },
    }),
  });
  assert.equal(project.status, 200, await project.text());
  const upload = await request("/files", "owner", {
    method: "POST",
    body: JSON.stringify({ dataUrl: PNG_DATA_URL }),
  });
  const preview = await upload.json() as { url: string; error?: string };
  assert.equal(upload.status, 200, preview.error);
  const document = {
    version: 1,
    canvas: { width: 1024, height: 768, background: "#FFFFFF" },
    layers: [{ id: "layer-1", name: "图层 1", visible: true, locked: false, opacity: 1, objects: [] }],
  };
  const body = {
    clientRequestId: "drawing-create-request-0001",
    projectId,
    nodeId,
    position: { x: 320, y: 180 },
    previewImageRef: preview.url,
    document,
  };
  assert.equal((await request("/drawing-boards/create", "owner", {
    method: "POST", body: JSON.stringify({ ...body, clientRequestId: "drawing-missing-base-image", document: { ...document, baseImage: { url: "/api/files/missing-base.png", width: 100, height: 100 } } }),
  })).status, 403);
  const created = await request("/drawing-boards/create", "owner", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const createdText = await created.text();
  assert.equal(created.status, 201, createdText);
  const createdBody = JSON.parse(createdText) as { contentRef: string };
  const persisted = await queryOne<{ flow_json: string }>("SELECT flow_json FROM projects WHERE id = $1", [projectId]);
  const flow = JSON.parse(persisted!.flow_json) as { nodes: Array<{ id: string; position: { x: number; y: number }; data: Record<string, unknown> }> };
  const node = flow.nodes.find((candidate) => candidate.id === nodeId);
  assert.deepEqual(node?.position, body.position);
  assert.equal(node?.data.contentRef, createdBody.contentRef);
  assert.equal(node?.data.previewImageRef, preview.url);
  assert.equal((await request("/drawing-boards/create", "other", {
    method: "POST", body: JSON.stringify({ ...body, clientRequestId: "drawing-create-other" }),
  })).status, 404);
  const replay = await request("/drawing-boards/create", "owner", {
    method: "POST", body: JSON.stringify(body),
  });
  assert.equal(replay.status, 200, await replay.text());
  assert.equal((await queryOne<{ count: number }>(`
    SELECT COUNT(*)::int AS count FROM drawing_document_versions WHERE project_id = $1 AND node_id = $2
  `, [projectId, nodeId]))?.count, 1);
});

await test("历史分页固定在首次快照，期间新增记录不会推移游标造成缺口", async () => {
  for (const [id, startedAt] of [["snapshot-3", 3_000], ["snapshot-2", 2_000], ["snapshot-1", 1_000]] as const) {
    await query(`
      INSERT INTO generation_runs (
        id, owner_id, node_id, node_label, kind, requested_count, status, started_at, finished_at
      ) VALUES ($1, $2, 'node', '节点', 'ai-modify', 1, 'error', $3, $3)
    `, [id, users.owner.id, startedAt]);
    await query(`
      INSERT INTO generation_outputs (id, run_id, image, status, error, created_at)
      VALUES ($1, $2, '', 'error', '失败', $3)
    `, [`${id}-output`, id, startedAt]);
  }
  const first = await request("/history?limit=1&before=2500", "owner");
  assert.equal(first.status, 200);
  const firstPage = await first.json() as HistoryPage;
  assert.equal(firstPage.records[0].runId, "snapshot-2");
  assert.equal(firstPage.hasMore, true);
  assert.ok(firstPage.nextCursor);
  await query(`
    INSERT INTO generation_runs (
      id, owner_id, node_id, node_label, kind, requested_count, status, started_at, finished_at
    ) VALUES ('snapshot-new', $1, 'node', '节点', 'ai-modify', 1, 'error', 4000, 4000)
  `, [users.owner.id]);
  await query(`
    INSERT INTO generation_outputs (id, run_id, image, status, error, created_at)
    VALUES ('snapshot-new-output', 'snapshot-new', '', 'error', '失败', 4000)
  `);
  const second = await request(
    `/history?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
    "owner",
  );
  assert.equal(second.status, 200);
  assert.equal(((await second.json()) as HistoryPage).records[0].runId, "snapshot-1");
});

await test("运行任务完成并展开为多条输出时不会令下一页漏项或重复", async () => {
  for (const [id, startedAt, status] of [
    ["cursor-running", 7_000, "running"],
    ["cursor-second", 6_000, "error"],
    ["cursor-third", 5_000, "error"],
  ] as const) {
    await query(`
      INSERT INTO generation_runs (
        id, owner_id, node_id, node_label, kind, requested_count, status, started_at, finished_at,
        plan_json
      ) VALUES ($1, $2, 'node', '节点', 'ai-modify', 2, $3, $4, $4, $5)
    `, [id, users.owner.id, status, startedAt, status === "running" ? '{"steps":[]}' : null]);
    if (status === "error") {
      await query(`
        INSERT INTO generation_outputs (id, run_id, image, status, error, created_at)
        VALUES ($1, $2, '', 'error', '失败', $3)
      `, [`${id}-output`, id, startedAt]);
    }
  }

  const first = await request("/history?limit=2&before=7500", "owner");
  assert.equal(first.status, 200);
  const firstPage = await first.json() as HistoryPage;
  assert.deepEqual(firstPage.records.map((record) => record.runId), ["cursor-running", "cursor-second"]);
  assert.ok(firstPage.nextCursor);

  await query(`
    INSERT INTO generation_outputs (id, run_id, image, status, created_at) VALUES
      ('cursor-running-output-1', 'cursor-running', '/api/files/cursor-1.png', 'success', 7100),
      ('cursor-running-output-2', 'cursor-running', '/api/files/cursor-2.png', 'success', 7101)
  `);
  await query(
    "UPDATE generation_runs SET status = 'success', successful_count = 2, finished_at = 7101 WHERE id = 'cursor-running'",
  );

  const second = await request(
    `/history?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
    "owner",
  );
  assert.equal(second.status, 200);
  const secondPage = await second.json() as HistoryPage;
  assert.equal(secondPage.records[0].runId, "cursor-third");
  assert.equal(secondPage.records.some((record) => record.runId === "cursor-running"), false);
  assert.equal(secondPage.records.some((record) => record.runId === "cursor-second"), false);
});

await query("UPDATE users SET display_name = $1 WHERE id = $2", [
  "  =HYPERLINK(\"https://example.invalid\",\"打开\")",
  users.owner.id,
]);
await query(`
  INSERT INTO generation_runs (
    id, owner_id, project_id, node_id, node_label, kind, model,
    requested_count, successful_count, provider_requests, status, started_at, finished_at
  ) VALUES
    ('usage-owner-run', $1, '+PROJECT', '@NODE', '测试节点', 'ai-modify', '-MODEL', 1, 1, 1, 'success', 1, 2),
    ('usage-other-run', $2, 'other-project', 'other-node', '其他节点', 'ai-modify', 'safe-model', 1, 1, 1, 'success', 1, 2)
`, [users.owner.id, users.other.id]);
await query(`
  INSERT INTO usage_events (
    id, owner_id, run_id, project_id, node_id, model,
    successful_count, provider_requests, duration_ms, created_at
  ) VALUES
    ('usage-owner', $1, 'usage-owner-run', '+PROJECT', '@NODE', '-MODEL', 1, 1, 1, $3),
    ('usage-other', $2, 'usage-other-run', 'other-project', 'other-node', 'safe-model', 1, 1, 1, $3)
`, [users.owner.id, users.other.id, now]);

await test("消耗记录按用户隔离，管理员可查看全部且响应禁止缓存", async () => {
  const forbidden = await request(`/usage?userId=${users.other.id}`, "owner");
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.get("cache-control"), "no-store");

  const ownerResponse = await request("/usage?all=true", "owner");
  assert.equal(ownerResponse.status, 200);
  assert.equal(ownerResponse.headers.get("cache-control"), "no-store");
  const ownerRows = await ownerResponse.json() as Array<{ id: string }>;
  assert.deepEqual(ownerRows.map((row) => row.id), ["usage-owner"]);

  const adminResponse = await request("/usage?all=true", "admin");
  assert.equal(adminResponse.status, 200);
  assert.deepEqual(
    (await adminResponse.json() as Array<{ id: string }>).map((row) => row.id).sort(),
    ["usage-other", "usage-owner"],
  );
});

await test("CSV 导出阻断公式注入并设置安全下载响应头", async () => {
  const response = await request("/usage?all=true&format=csv", "admin");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /^text\/csv;\s*charset=utf-8/i);
  assert.match(response.headers.get("content-disposition") ?? "", /^attachment; filename="usage-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");

  const csvBytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual([...csvBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const csv = csvBytes.subarray(3).toString("utf8");
  assert.ok(csv.startsWith("记录ID,"));
  assert.match(csv, /"'  =HYPERLINK\(""https:\/\/example\.invalid"",""打开""\)"/);
  assert.match(csv, /,'\+PROJECT,'@NODE,'-MODEL,1,1,1,/);
  assert.match(csv, /\r\n/);
});

console.log(`\n通过 ${passed} 项`);
await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
await closeDatabaseForTests();
fs.rmSync(temp, { recursive: true, force: true });

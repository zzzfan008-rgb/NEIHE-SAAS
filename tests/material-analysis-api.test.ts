import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import sharp from "sharp";
import type { AddressInfo } from "node:net";
import { resetPostgresTestDatabase } from "./postgresTestDatabase";

console.log("材质分析 API 与共享面料测试");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "material-analysis-"));
process.env.DATA_DIR = temp;
process.env.SQLITE_IMPORT_FILE = "missing.db";
process.env.INITIAL_ADMIN_ACCOUNT_ID = "material-test-admin";
process.env.INITIAL_ADMIN_PASSWORD = "Initial1234";
await resetPostgresTestDatabase();
const { initializeDatabase, closeDatabaseForTests, query, queryOne } =
  await import("../server/lib/database");
const { runMaterialAnalysis } = await import(
  "../server/lib/materialAnalysisStore"
);
const { createSession, requireAuth, requirePasswordChanged, SESSION_COOKIE } =
  await import("../server/lib/auth");
const { materialAnalysesRouter } = await import(
  "../server/routes/materialAnalyses"
);
const { assetsRouter } = await import("../server/routes/assets");
const { filesRouter } = await import("../server/routes/files");
await initializeDatabase();

const sessions = new Map<string, string>();
const now = new Date().toISOString();
for (const [id, role] of [
  ["admin", "admin"],
  ["other-admin", "admin"],
  ["reader", "user"],
  ["quota-user", "user"],
] as const) {
  await query(
    `INSERT INTO users(id,account_id,display_name,role,password_hash,must_change_password,active,created_at,updated_at)
    VALUES ($1,$1,$1,$2,'test-only',0,1,$3,$3)`,
    [id, role, now],
  );
  sessions.set(id, (await createSession(id)).token);
}
const app = express();
app.use(express.json({ limit: "20mb" }));
app.use("/api", requireAuth, requirePasswordChanged);
app.use("/api/material-analyses", materialAnalysesRouter);
app.use("/api/assets", assetsRouter);
app.use("/api/files", filesRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const request = (
  path: string,
  method = "GET",
  body?: unknown,
  user = "admin",
) =>
  fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(sessions.has(user)
        ? { cookie: `${SESSION_COOKIE}=${sessions.get(user)}` }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

try {
  const unauthenticated = await request(
    "/api/material-analyses/models",
    "GET",
    undefined,
    "none",
  );
  assert.equal(unauthenticated.status, 401);
  const models = (await (
    await request("/api/material-analyses/models")
  ).json()) as {
    revision: number;
    models: Array<{ id: string; isDefault: boolean }>;
  };
  assert.equal(models.models.length, 1);
  assert.equal(models.models[0].isDefault, true);
  const forbiddenModels = await request(
    "/api/material-analyses/models",
    "PUT",
    { expectedRevision: models.revision, models: [] },
    "reader",
  );
  assert.equal(forbiddenModels.status, 403);
  const replaced = await request("/api/material-analyses/models", "PUT", {
    expectedRevision: models.revision,
    models: [
      {
        id: "gemini-default",
        label: "Gemini 默认",
        protocol: "gemini-generate-content",
        enabled: true,
        isDefault: true,
      },
      {
        id: "gemini-review",
        label: "Gemini 复核",
        protocol: "gemini-generate-content",
        enabled: true,
        isDefault: false,
      },
    ],
  });
  assert.equal(replaced.status, 200);
  const replacedModels = (await replaced.json()) as {
    revision: number;
    models: Array<{ id: string }>;
  };
  const retiredResponse = await request(
    "/api/material-analyses/models",
    "PUT",
    {
      expectedRevision: replacedModels.revision,
      models: [
        {
          id: "gemini-default",
          label: "Gemini 默认",
          protocol: "gemini-generate-content",
          enabled: true,
          isDefault: true,
        },
      ],
    },
  );
  assert.equal(retiredResponse.status, 200);
  const retiredModels = (await retiredResponse.json()) as {
    models: Array<{ id: string }>;
  };
  assert.equal(
    retiredModels.models.some((model) => model.id === "gemini-review"),
    false,
  );
  const stale = await request("/api/material-analyses/models", "PUT", {
    expectedRevision: models.revision,
    models: [
      {
        id: "gemini-default",
        label: "旧写入",
        protocol: "gemini-generate-content",
        enabled: true,
        isDefault: true,
      },
    ],
  });
  assert.equal(stale.status, 409);
  console.log("  ✓ 登录边界、管理员模型 allowlist 与 revision 冲突有效");

  const png = await sharp({
    create: { width: 100, height: 80, channels: 3, background: "#AABBCC" },
  })
    .png()
    .toBuffer();
  const createdResponse = await request("/api/material-analyses", "POST", {
    image: `data:image/png;base64,${png.toString("base64")}`,
    crop: { x: 0.1, y: 0.25, width: 0.5, height: 0.5 },
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()) as {
    id: string;
    revision: number;
    sourceImage: string;
    cropImage: string;
  };
  assert.notEqual(created.sourceImage, created.cropImage);
  assert.equal(
    (
      await request(
        `/api/material-analyses/${created.id}`,
        "GET",
        undefined,
        "reader",
      )
    ).status,
    404,
  );
  const crossOwnerFile = await request(
    created.sourceImage,
    "GET",
    undefined,
    "reader",
  );
  assert.equal(crossOwnerFile.status, 404, await crossOwnerFile.text());
  console.log("  ✓ 原图和分析记录保持 owner-private，裁片独立持久化");
  const unknownDraftResponse = await request("/api/material-analyses", "POST", {
    image: `data:image/png;base64,${png.toString("base64")}`,
    crop: { x: 0, y: 0, width: 1, height: 1 },
  });
  const unknownDraft = (await unknownDraftResponse.json()) as {
    id: string;
    revision: number;
  };
  process.env.APIYI_BASE_URL = "https://gateway.invalid";
  process.env.APIYI_API_KEY = "test-only";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("simulated connection reset");
  };
  try {
    await assert.rejects(
      () =>
        runMaterialAnalysis(
          "admin",
          unknownDraft.id,
          unknownDraft.revision,
          "gemini-default",
        ),
      /连接中断/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  const unknownStored = await queryOne<{ status: string }>(
    "SELECT status FROM material_analyses WHERE id=$1",
    [unknownDraft.id],
  );
  assert.equal(unknownStored?.status, "outcome_unknown");
  console.log(
    "  ✓ 网关传输结果未知保持 outcome_unknown，不降级为可盲目重试的失败",
  );
  await query(
    "UPDATE material_analyses SET status='analyzing',updated_at=$1 WHERE id=$2",
    [new Date(Date.now() - 16 * 60_000).toISOString(), created.id],
  );
  const recovered = (await (
    await request(`/api/material-analyses/${created.id}`)
  ).json()) as { status: string; error: string };
  assert.equal(recovered.status, "outcome_unknown");
  assert.match(recovered.error, /结果可能未知|未能确认结果/);
  console.log("  ✓ 过期 analyzing 租约转为显式结果未知，可由用户决定是否重试");
  const expiringResponse = await request("/api/material-analyses", "POST", {
    image: `data:image/png;base64,${png.toString("base64")}`,
    crop: { x: 0, y: 0, width: 1, height: 1 },
  });
  assert.equal(expiringResponse.status, 201);
  const expiring = (await expiringResponse.json()) as {
    id: string;
    sourceImage: string;
    cropImage: string;
  };
  const expiredAt = new Date(Date.now() - 1_000).toISOString();
  await query(
    "UPDATE material_analyses SET status='analyzing',updated_at=$1 WHERE id=$2",
    [new Date(Date.now() - 16 * 60_000).toISOString(), expiring.id],
  );
  await query("UPDATE files SET purge_after=$1 WHERE id=ANY($2::text[])", [
    expiredAt,
    [path.basename(expiring.sourceImage), path.basename(expiring.cropImage)],
  ]);
  assert.equal((await request("/api/material-analyses/models")).status, 200);
  assert.equal(
    (await request(`/api/material-analyses/${expiring.id}`)).status,
    404,
  );
  assert.equal(
    await queryOne("SELECT id FROM files WHERE id=ANY($1::text[]) LIMIT 1", [
      [path.basename(expiring.sourceImage), path.basename(expiring.cropImage)],
    ]),
    undefined,
  );
  console.log(
    "  ✓ 无客户端 GET 的陈旧 analyzing 租约也由定时清理恢复并按 TTL 删除",
  );
  await query(
    `INSERT INTO material_analyses(id,owner_id,status,source_image,crop_image,crop,created_at,updated_at)
    SELECT 'quota-' || value,'admin','draft','/api/files/quota-source-' || value,'/api/files/quota-crop-' || value,
      '{"x":0,"y":0,"width":1,"height":1}'::jsonb,$1,$1 FROM generate_series(1,19) value`,
    [new Date().toISOString()],
  );
  const overQuota = await request("/api/material-analyses", "POST", {
    image: `data:image/png;base64,${png.toString("base64")}`,
    crop: { x: 0, y: 0, width: 1, height: 1 },
  });
  assert.equal(overQuota.status, 429, await overQuota.text());
  await query("DELETE FROM material_analyses WHERE id LIKE 'quota-%'");
  console.log("  ✓ 每账号未入库草稿数量配额阻止无界存储");
  await query(
    `INSERT INTO material_analyses(id,owner_id,status,source_image,crop_image,crop,created_at,updated_at)
    SELECT 'quota-race-' || value,'quota-user','draft','/api/files/quota-race-source-' || value,'/api/files/quota-race-crop-' || value,
      '{"x":0,"y":0,"width":1,"height":1}'::jsonb,$1,$1 FROM generate_series(1,19) value`,
    [new Date().toISOString()],
  );
  const quotaRaceBody = {
    image: `data:image/png;base64,${png.toString("base64")}`,
    crop: { x: 0, y: 0, width: 1, height: 1 },
  };
  const quotaRaceResponses = await Promise.all([
    request("/api/material-analyses", "POST", quotaRaceBody, "quota-user"),
    request("/api/material-analyses", "POST", quotaRaceBody, "quota-user"),
  ]);
  assert.deepEqual(
    quotaRaceResponses.map((response) => response.status).sort(),
    [201, 429],
  );
  assert.equal(
    (
      await queryOne<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM material_analyses WHERE owner_id='quota-user' AND status <> 'saved'",
      )
    )?.count,
    20,
  );
  await query("DELETE FROM material_analyses WHERE owner_id='quota-user'");
  await query("DELETE FROM files WHERE owner_id='quota-user'");
  console.log("  ✓ 同账号并发创建由事务锁串行化，不能越过草稿数量配额");

  const suggestion = {
    materialDescription: "细密斜纹",
    observedAttributes: ["哑光"],
    uncertainAttributes: ["成分待确认"],
    colors: [{ hex: "#AABBCC", name: "灰蓝" }],
  };
  await query(
    "UPDATE material_analyses SET status='analyzed',model_id='gemini-default',suggestion=$1::jsonb,revision=revision+1 WHERE id=$2",
    [JSON.stringify(suggestion), created.id],
  );
  const ready = (await (
    await request(`/api/material-analyses/${created.id}`)
  ).json()) as { revision: number };
  const invalidSave = await request(
    `/api/material-analyses/${created.id}/save`,
    "POST",
    {
      expectedRevision: ready.revision,
      calibration: { name: "", materialDescription: "", colors: [] },
    },
  );
  assert.equal(invalidSave.status, 400);
  const savedResponse = await request(
    `/api/material-analyses/${created.id}/save`,
    "POST",
    {
      expectedRevision: ready.revision,
      calibration: {
        name: "斜纹灰蓝面料",
        materialDescription: "无法确定成分；可见细密斜纹",
        colors: [{ hex: "#AABBCC", name: "灰蓝" }],
      },
    },
  );
  assert.equal(savedResponse.status, 201);
  const saved = (await savedResponse.json()) as {
    assetId: string;
    analysis: { status: string; assetId: string };
  };
  assert.equal(saved.analysis.status, "saved");
  assert.equal(saved.analysis.assetId, saved.assetId);
  const asset = await queryOne<{
    scope: string;
    category: string;
    image: string;
    material_metadata: { analysisId: string; colors: Array<{ hex: string }> };
  }>("SELECT scope,category,image,material_metadata FROM assets WHERE id=$1", [
    saved.assetId,
  ]);
  assert.equal(asset?.scope, "shared");
  assert.equal(asset?.category, "fabric");
  assert.equal(asset?.image, created.cropImage);
  assert.equal(asset?.material_metadata.analysisId, created.id);
  assert.equal(asset?.material_metadata.colors[0].hex, "#AABBCC");
  assert.equal(
    (await request(created.cropImage, "GET", undefined, "reader")).status,
    200,
  );
  assert.equal(
    (await request(created.sourceImage, "GET", undefined, "reader")).status,
    404,
  );
  console.log("  ✓ 人工校准后仅裁片作为共享面料，原图仍不可被其他用户读取");

  const visibleAssets = (await (
    await request("/api/assets?category=fabric", "GET", undefined, "reader")
  ).json()) as Array<{
    id: string;
    material?: { analysisId: string };
    canManage: boolean;
  }>;
  assert.equal(
    visibleAssets.find((item) => item.id === saved.assetId)?.material
      ?.analysisId,
    created.id,
  );
  assert.equal(
    visibleAssets.find((item) => item.id === saved.assetId)?.canManage,
    false,
  );
  const adminAssets = (await (
    await request(
      "/api/assets?category=fabric",
      "GET",
      undefined,
      "other-admin",
    )
  ).json()) as Array<{ id: string; canManage: boolean }>;
  assert.equal(
    adminAssets.find((item) => item.id === saved.assetId)?.canManage,
    true,
  );
  const deniedMaterialEdit = await request(
    `/api/assets/${saved.assetId}`,
    "PATCH",
    {
      material: {
        name: "越权",
        materialDescription: "越权",
        colors: [{ hex: "#112233" }],
      },
    },
    "reader",
  );
  assert.equal(deniedMaterialEdit.status, 403);
  const adminMaterialEdit = await request(
    `/api/assets/${saved.assetId}`,
    "PATCH",
    {
      material: {
        name: "管理员复核面料",
        materialDescription: "管理员复核：斜纹",
        colors: [{ hex: "#112233", name: "复核色" }],
      },
    },
    "other-admin",
  );
  assert.equal(adminMaterialEdit.status, 200, await adminMaterialEdit.text());
  const editedAsset = await queryOne<{
    name: string;
    material_metadata: {
      analysisId: string;
      materialDescription: string;
      colors: Array<{ hex: string }>;
    };
  }>("SELECT name,material_metadata FROM assets WHERE id=$1", [saved.assetId]);
  assert.equal(editedAsset?.name, "管理员复核面料");
  assert.equal(editedAsset?.material_metadata.analysisId, created.id);
  assert.equal(
    editedAsset?.material_metadata.materialDescription,
    "管理员复核：斜纹",
  );
  assert.equal(editedAsset?.material_metadata.colors[0].hex, "#112233");
  console.log("  ✓ 创建者/管理员可编辑共享面料校准信息，普通读取者不能修改");
  const projectNow = new Date().toISOString();
  await query(
    `INSERT INTO projects(id,owner_id,name,flow_json,updated_at,created_at)
    VALUES ('material-reader-project','reader','面料引用项目','{"schemaVersion":12,"nodes":[],"edges":[]}'::jsonb::text,$1,$1)`,
    [projectNow],
  );
  await query(
    "INSERT INTO project_asset_refs(project_id,asset_id,created_at) VALUES ('material-reader-project',$1,$2)",
    [saved.assetId, projectNow],
  );
  const narrowed = await request(`/api/assets/${saved.assetId}`, "PATCH", {
    scope: "private",
  });
  assert.equal(narrowed.status, 409, await narrowed.text());
  await query(
    "DELETE FROM project_asset_refs WHERE project_id='material-reader-project' AND asset_id=$1",
    [saved.assetId],
  );
  assert.equal(
    (
      await request(
        `/api/assets/${saved.assetId}`,
        "DELETE",
        undefined,
        "other-admin",
      )
    ).status,
    200,
  );
  await query("UPDATE assets SET purge_after=$1 WHERE id=$2", [
    new Date(Date.now() - 1_000).toISOString(),
    saved.assetId,
  ]);
  assert.equal(
    (
      await request(
        "/api/assets?category=fabric",
        "GET",
        undefined,
        "other-admin",
      )
    ).status,
    200,
  );
  assert.equal(
    await queryOne("SELECT id FROM assets WHERE id=$1", [saved.assetId]),
    undefined,
  );
  assert.deepEqual(
    await queryOne<{ status: string; asset_id: string | null }>(
      "SELECT status,asset_id FROM material_analyses WHERE id=$1",
      [created.id],
    ),
    { status: "saved", asset_id: null },
  );
  console.log("  ✓ 共享面料可管理但不能破坏他人项目引用，过期清理保留分析快照");
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closeDatabaseForTests();
  fs.rmSync(temp, { recursive: true, force: true });
}

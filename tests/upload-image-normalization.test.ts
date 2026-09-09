import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express, { type Request } from "express";
import sharp from "sharp";
import type { AIProvider, NodeExecution } from "../src/types/workflow";
import { resetPostgresTestDatabase } from "./postgresTestDatabase";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-upload-normalization-"));
process.env.DATA_DIR = temp;
process.env.SQLITE_IMPORT_FILE = "missing.db";
process.env.INITIAL_ADMIN_ACCOUNT_ID = "normalization-admin";
process.env.INITIAL_ADMIN_PASSWORD = "Initial1234";

await resetPostgresTestDatabase();
const { closeDatabaseForTests, db, initializeDatabase, query, queryOne } = await import("../server/lib/database");
const { filesRouter } = await import("../server/routes/files");
const { projectsRouter, purgeExpiredProjects } = await import("../server/routes/projects");
const { normalizeImageRef, uploadsDir } = await import("../server/lib/fileStore");
const { executeStep, resolveImageRefs } = await import("../server/engine/runner");
const { validateImageDataUrl } = await import("../server/lib/imageValidation");
const {
  normalizeUploadImageDataUrl,
  UPLOAD_COMPRESSION_THRESHOLD_BYTES,
  UPLOAD_MAX_LONG_EDGE,
  PROVIDER_TARGET_BYTES,
} = await import("../server/lib/uploadImageNormalization");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
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

function dataUrl(mime: string, buffer: Buffer): string {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function editableMask(width: number, height: number): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      pixels[(y * width + x) * 4 + 3] = x < Math.floor(width / 2) ? 0 : 255;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

async function startFilesServer(ownerId: string) {
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use((req, _res, next) => {
    const id = req.headers["x-test-owner"] === "missing" ? "missing-owner" : ownerId;
    (req as Request & { authUser: unknown }).authUser = {
      id, accountId: id, displayName: id, role: "admin", mustChangePassword: false,
    };
    next();
  });
  app.use("/api/files", filesRouter);
  app.use("/api/projects", projectsRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}

console.log("用户上传图片标准化回归测试");
await initializeDatabase();

await test("不超过 7 MiB 的 JPEG、PNG、WebP 与 GIF 保留原始字节和格式", async () => {
  const jpeg = await sharp({ create: { width: 120, height: 80, channels: 3, background: "red" } })
    .jpeg().toBuffer();
  const opaquePng = await sharp({ create: { width: 90, height: 70, channels: 3, background: "green" } })
    .png().toBuffer();
  const webp = await sharp({ create: { width: 80, height: 60, channels: 3, background: "blue" } })
    .webp().toBuffer();
  const frames = Buffer.alloc(2 * 4 * 3);
  for (let index = 0; index < 4; index += 1) frames[index * 3] = 255;
  for (let index = 4; index < 8; index += 1) frames[index * 3 + 2] = 255;
  const gif = await sharp(frames, { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } })
    .gif({ delay: [100, 100], loop: 0 }).toBuffer();

  for (const [mime, buffer] of [
    ["image/jpeg", jpeg], ["image/png", opaquePng], ["image/webp", webp], ["image/gif", gif],
  ] as const) {
    const normalized = await normalizeUploadImageDataUrl(dataUrl(mime, buffer));
    assert.equal(normalized.mimeType, mime);
    assert.equal(normalized.byteLength, buffer.byteLength);
    assert.deepEqual(normalized.buffer, buffer);
  }
});

await test("7 MiB 以下的透明和不透明 PNG 都不重新编码", async () => {
  const transparent = await sharp({
    create: { width: 64, height: 48, channels: 4, background: { r: 10, g: 150, b: 80, alpha: 0.5 } },
  }).png().toBuffer();
  const opaqueAlpha = await sharp({
    create: { width: 64, height: 48, channels: 4, background: { r: 10, g: 150, b: 80, alpha: 1 } },
  }).png().toBuffer();

  const preserved = await normalizeUploadImageDataUrl(dataUrl("image/png", transparent));
  assert.equal(preserved.mimeType, "image/png");
  assert.deepEqual(preserved.buffer, transparent);

  const opaque = await normalizeUploadImageDataUrl(dataUrl("image/png", opaqueAlpha));
  assert.equal(opaque.mimeType, "image/png");
  assert.deepEqual(opaque.buffer, opaqueAlpha);
});

await test("7 MiB 以下保留 EXIF 和超过 4096 的原始像素", async () => {
  const oriented = await sharp({ create: { width: 300, height: 500, channels: 3, background: "navy" } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const normalizedOriented = await normalizeUploadImageDataUrl(dataUrl("image/jpeg", oriented));
  assert.deepEqual([normalizedOriented.width, normalizedOriented.height], [500, 300]);
  assert.equal((await sharp(normalizedOriented.buffer).metadata()).orientation, 6);
  assert.deepEqual(normalizedOriented.buffer, oriented);

  const large = await sharp({ create: { width: 5000, height: 1000, channels: 3, background: "white" } })
    .jpeg().toBuffer();
  const normalizedLarge = await normalizeUploadImageDataUrl(dataUrl("image/jpeg", large));
  assert.equal(Math.max(normalizedLarge.width, normalizedLarge.height), 5000);
  assert.deepEqual(normalizedLarge.buffer, large);
});

await test("超过 7 MiB 才压缩并将结果控制在 7 MiB 内", async () => {
  const width = 1700;
  const height = 1500;
  const noisy = await sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 }).toBuffer();
  assert.ok(noisy.byteLength > 7 * 1024 * 1024);
  const normalized = await normalizeUploadImageDataUrl(dataUrl("image/png", noisy));
  assert.equal(UPLOAD_COMPRESSION_THRESHOLD_BYTES, 7 * 1024 * 1024);
  assert.ok(normalized.byteLength <= UPLOAD_COMPRESSION_THRESHOLD_BYTES);
  assert.notDeepEqual(normalized.buffer, noisy);
  assert.ok(normalized.width <= width && normalized.height <= height);
});

await test("超过 40MP 的输入在解码门禁拒绝", async () => {
  const oversized = await sharp({
    create: { width: 6400, height: 6300, channels: 3, background: "white" },
  }).jpeg({ quality: 20 }).toBuffer();
  await assert.rejects(
    () => normalizeUploadImageDataUrl(dataUrl("image/jpeg", oversized)),
    /图片像素过大/,
  );
});

await test("上传接口仅在标准化与数据库写入都成功后返回 URL", async () => {
  const admin = await queryOne<{ id: string }>(
    "SELECT id FROM users WHERE account_id = 'normalization-admin'",
  );
  assert.ok(admin);
  const server = await startFilesServer(admin.id);
  try {
    const broken = dataUrl("image/png", Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
    ]));
    const rejected = await fetch(`${server.baseUrl}/api/files`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: broken }),
    });
    assert.equal(rejected.status, 400);
    assert.equal((await queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM files"))?.count, 0);
    assert.deepEqual(fs.readdirSync(uploadsDir()), []);

    const source = await sharp({ create: { width: 96, height: 64, channels: 3, background: "#336699" } })
      .webp().toBuffer();
    const accepted = await fetch(`${server.baseUrl}/api/files`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: dataUrl("image/webp", source) }),
    });
    assert.equal(accepted.status, 200);
    const body = await accepted.json() as {
      id: string; url: string; mimeType: string; width: number; height: number; byteLength: number; normalized: boolean;
    };
    assert.equal(body.normalized, true);
    assert.equal(body.mimeType, "image/webp");
    assert.deepEqual(fs.readFileSync(path.join(uploadsDir(), body.id)), source);
    assert.deepEqual([body.width, body.height], [96, 64]);
    assert.equal(fs.statSync(path.join(uploadsDir(), body.id)).size, body.byteLength);
    assert.deepEqual(await queryOne<Record<string, unknown>>(`
      SELECT mime_type, width, height, byte_length, normalized FROM files WHERE id = $1
    `, [body.id]), {
      mime_type: body.mimeType, width: body.width, height: body.height,
      byte_length: body.byteLength, normalized: true,
    });

    const [providerReady] = await resolveImageRefs([body.url]);
    const providerImage = validateImageDataUrl(providerReady);
    assert.equal(providerImage.mime, "image/jpeg");
    assert.ok(providerImage.buffer.byteLength <= PROVIDER_TARGET_BYTES);
    assert.deepEqual(fs.readFileSync(path.join(uploadsDir(), body.id)), source);

    const maskBuffer = await editableMask(96, 64);
    const maskDataUrl = dataUrl("image/png", maskBuffer);
    const uploadMask = async (
      value: string,
      binding: { projectId?: string; nodeId?: string; sourceRef?: string } = {},
    ) => fetch(`${server.baseUrl}/api/files/mask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dataUrl: value,
        sourceRef: binding.sourceRef ?? body.url,
        projectId: binding.projectId ?? "mask-project",
        nodeId: binding.nodeId ?? "mask-node",
      }),
    });
    const acceptedMask = await uploadMask(maskDataUrl);
    assert.equal(acceptedMask.status, 200);
    const maskBody = await acceptedMask.json() as {
      id: string; url: string; mimeType: string; width: number; height: number;
      byteLength: number; preserved: boolean;
    };
    assert.equal(maskBody.preserved, true);
    assert.equal(maskBody.mimeType, "image/png");
    assert.deepEqual([maskBody.width, maskBody.height], [96, 64]);
    const storedMask = fs.readFileSync(path.join(uploadsDir(), maskBody.id));
    assert.deepEqual(storedMask, maskBuffer, "蒙版不得缩放、重编码或改写 Alpha");
    assert.equal(
      createHash("sha256").update(storedMask).digest("hex"),
      createHash("sha256").update(maskBuffer).digest("hex"),
    );
    assert.deepEqual(
      validateImageDataUrl(await normalizeImageRef(maskBody.url)).buffer,
      maskBuffer,
      "Worker 解引用后交给 Provider 的蒙版仍须保持原始 PNG 字节",
    );
    assert.deepEqual(await queryOne<Record<string, unknown>>(`
      SELECT owner_id, source_type, project_id, node_id, mime_type,
             width, height, byte_length, normalized, purge_after IS NOT NULL AS expiring
      FROM files WHERE id = $1
    `, [maskBody.id]), {
      owner_id: admin.id,
      source_type: "mask-draft",
      project_id: "mask-project",
      node_id: "mask-node",
      mime_type: "image/png",
      width: 96,
      height: 64,
      byte_length: maskBuffer.byteLength,
      normalized: false,
      expiring: true,
    });

    const jpegMask = await sharp(maskBuffer).flatten().jpeg().toBuffer();
    const wrongSizeMask = await editableMask(48, 32);
    const opaqueMask = await sharp({
      create: { width: 96, height: 64, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    }).png().toBuffer();
    const transparentMask = await sharp({
      create: { width: 96, height: 64, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } },
    }).png().toBuffer();
    const oversizedMask = await editableMask(1024, 1024);
    assert.ok(oversizedMask.byteLength > 4 * 1024 * 1024, "超限蒙版夹具必须大于 4MiB");
    for (const rejectedMask of [
      dataUrl("image/jpeg", jpegMask),
      dataUrl("image/png", wrongSizeMask),
      dataUrl("image/png", opaqueMask),
      dataUrl("image/png", transparentMask),
      dataUrl("image/png", oversizedMask),
    ]) {
      const beforeRejectedFiles = fs.readdirSync(uploadsDir()).sort();
      const beforeRejectedRows = (await queryOne<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM files",
      ))?.count;
      const rejectedMaskResponse = await uploadMask(rejectedMask);
      assert.equal(rejectedMaskResponse.status, 400);
      assert.deepEqual(fs.readdirSync(uploadsDir()).sort(), beforeRejectedFiles);
      assert.equal((await queryOne<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM files",
      ))?.count, beforeRejectedRows);
    }
    const beforeUnauthorizedMaskFiles = fs.readdirSync(uploadsDir()).sort();
    const unauthorizedMask = await fetch(`${server.baseUrl}/api/files/mask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-owner": "missing" },
      body: JSON.stringify({
        dataUrl: maskDataUrl,
        sourceRef: body.url,
        projectId: "mask-project",
        nodeId: "mask-node",
      }),
    });
    assert.equal(unauthorizedMask.status, 403);
    assert.deepEqual(fs.readdirSync(uploadsDir()).sort(), beforeUnauthorizedMaskFiles);

    const beforeOwnerFailureFiles = fs.readdirSync(uploadsDir()).sort();
    const beforeOwnerFailureRows = (await queryOne<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM files",
    ))?.count;
    const ownerBlocker = await db().connect();
    let ownerFailureRequest: Promise<Response> | undefined;
    try {
      await ownerBlocker.query("BEGIN");
      await ownerBlocker.query("SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE", [admin.id]);
      ownerFailureRequest = uploadMask(maskDataUrl);
      await waitForDatabaseCondition("蒙版已落盘并等待 owner 锁", async () => (
        fs.readdirSync(uploadsDir()).length > beforeOwnerFailureFiles.length
      ));
      await ownerBlocker.query("UPDATE users SET active = 0 WHERE id = $1", [admin.id]);
      await ownerBlocker.query("COMMIT");
      const ownerFailure = await ownerFailureRequest;
      assert.equal(ownerFailure.status, 409, await ownerFailure.text());
      assert.deepEqual(fs.readdirSync(uploadsDir()).sort(), beforeOwnerFailureFiles);
      assert.equal((await queryOne<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM files",
      ))?.count, beforeOwnerFailureRows);
    } finally {
      try { await ownerBlocker.query("ROLLBACK"); } catch { /* transaction already ended */ }
      ownerBlocker.release();
      await query("UPDATE users SET active = 1 WHERE id = $1", [admin.id]);
      await ownerFailureRequest?.catch(() => undefined);
    }

    const beforeDatabaseFailureFiles = fs.readdirSync(uploadsDir()).sort();
    const beforeDatabaseFailureRows = (await queryOne<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM files",
    ))?.count;
    await query(`
      ALTER TABLE files
      ADD CONSTRAINT files_test_reject_mask_draft
      CHECK (source_type <> 'mask-draft') NOT VALID
    `);
    try {
      const databaseFailure = await uploadMask(maskDataUrl);
      assert.equal(databaseFailure.status, 500, await databaseFailure.text());
      assert.deepEqual(fs.readdirSync(uploadsDir()).sort(), beforeDatabaseFailureFiles);
      assert.equal((await queryOne<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM files",
      ))?.count, beforeDatabaseFailureRows);
    } finally {
      await query("ALTER TABLE files DROP CONSTRAINT IF EXISTS files_test_reject_mask_draft");
    }

    const maskFlow = (mask: string, maskNodeId = "mask-node") => ({
      schemaVersion: 2,
      nodes: [{
        id: "source-node",
        type: "image-input",
        position: { x: 0, y: 0 },
        data: { kind: "image-input", label: "原图", status: "idle", imageRole: "default", imageUrl: body.url },
      }, {
        id: maskNodeId,
        type: "mask-redraw",
        position: { x: 300, y: 0 },
        data: {
          kind: "mask-redraw", label: "局部重绘", status: "idle", prompt: "改成银色",
          modelId: "gpt-image-2", modelOptions: {}, outputImages: [], mask, maskSourceRef: body.url,
        },
      }],
      edges: [{ id: `source-${maskNodeId}`, source: "source-node", target: maskNodeId }],
    });
    const saveMaskProject = async (
      mask: string,
      projectId = "mask-project",
      maskNodeId = "mask-node",
    ) => fetch(`${server.baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: projectId, name: "蒙版项目", flow: maskFlow(mask, maskNodeId) }),
    });
    assert.equal((await saveMaskProject(maskBody.url, "other-mask-project")).status, 403);
    assert.equal((await saveMaskProject(maskBody.url)).status, 200);
    assert.deepEqual(await queryOne<Record<string, unknown>>(`
      SELECT source_type, purge_after FROM files WHERE id = $1
    `, [maskBody.id]), { source_type: "mask", purge_after: null });

    const copyMaskResponse = await fetch(`${server.baseUrl}/api/files/masks/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceProjectId: "mask-project",
        createTarget: true,
        masks: [{ fileId: maskBody.id, nodeId: "mask-node" }],
      }),
    });
    assert.equal(copyMaskResponse.status, 200);
    const copiedMaskBody = await copyMaskResponse.json() as {
      targetProjectId: string;
      masks: Array<{ sourceUrl: string; targetUrl: string; nodeId: string }>;
    };
    assert.match(copiedMaskBody.targetProjectId, /^[A-Za-z0-9_-]{10}$/);
    assert.equal(copiedMaskBody.masks.length, 1);
    const copiedMask = copiedMaskBody.masks[0];
    const copiedMaskId = copiedMask.targetUrl.slice("/api/files/".length);
    assert.deepEqual(copiedMask, {
      sourceUrl: maskBody.url,
      targetUrl: copiedMask.targetUrl,
      nodeId: "mask-node",
    });
    assert.notEqual(copiedMaskId, maskBody.id);
    assert.deepEqual(
      fs.readFileSync(path.join(uploadsDir(), copiedMaskId)),
      fs.readFileSync(path.join(uploadsDir(), maskBody.id)),
      "项目身份变化必须复制蒙版字节，不能移动或重编码原文件",
    );
    assert.deepEqual(await queryOne<Record<string, unknown>>(`
      SELECT owner_id, source_type, project_id, node_id, mime_type,
             purge_after IS NOT NULL AS expiring
      FROM files WHERE id = $1
    `, [copiedMaskId]), {
      owner_id: admin.id,
      source_type: "mask-draft",
      project_id: copiedMaskBody.targetProjectId,
      node_id: "mask-node",
      mime_type: "image/png",
      expiring: true,
    });
    assert.equal(
      (await saveMaskProject(copiedMask.targetUrl, copiedMaskBody.targetProjectId)).status,
      200,
      "复制后的本机备份必须可以按新项目 ID 正式保存",
    );
    assert.deepEqual(await queryOne<Record<string, unknown>>(`
      SELECT source_type, purge_after FROM files WHERE id = $1
    `, [copiedMaskId]), { source_type: "mask", purge_after: null });
    const beforeUnavailableTargetFiles = fs.readdirSync(uploadsDir()).sort();
    const copyToUnavailable = async (targetProjectId: string) => fetch(
      `${server.baseUrl}/api/files/masks/copy`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceProjectId: "mask-project",
          targetProjectId,
          masks: [{ fileId: maskBody.id, nodeId: "mask-node" }],
        }),
      },
    );
    assert.equal((await copyToUnavailable(copiedMaskBody.targetProjectId)).status, 404);
    assert.equal((await copyToUnavailable("unused-target-project")).status, 404);
    const emptyProbe = await fetch(`${server.baseUrl}/api/files/masks/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceProjectId: "mask-project",
        targetProjectId: copiedMaskBody.targetProjectId,
        masks: [],
      }),
    });
    assert.equal(emptyProbe.status, 400);
    assert.deepEqual(fs.readdirSync(uploadsDir()).sort(), beforeUnavailableTargetFiles);

    const schemaMaximumMasks = Array.from({ length: 500 }, (_, index) => ({
      fileId: `missing-mask-${index}.png`,
      nodeId: `mask-node-${index}`,
    }));
    const maximumMaskCopy = await fetch(`${server.baseUrl}/api/files/masks/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceProjectId: "mask-project",
        createTarget: true,
        masks: schemaMaximumMasks,
      }),
    });
    assert.equal(maximumMaskCopy.status, 403, await maximumMaskCopy.text());
    const overMaximumMaskCopy = await fetch(`${server.baseUrl}/api/files/masks/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceProjectId: "mask-project",
        createTarget: true,
        masks: [...schemaMaximumMasks, { fileId: "missing-mask-500.png", nodeId: "mask-node-500" }],
      }),
    });
    assert.equal(overMaximumMaskCopy.status, 400);
    assert.deepEqual(fs.readdirSync(uploadsDir()).sort(), beforeUnavailableTargetFiles);

    const blankFlow = {
      schemaVersion: 2,
      nodes: [{
        id: "starter",
        type: "image-input",
        position: { x: 0, y: 0 },
        data: { kind: "image-input", label: "上传服装图", status: "idle", imageRole: "default" },
      }],
      edges: [],
    };
    const initialTargetId = "mask-sync-draft";
    const targetBootstrap = await fetch(`${server.baseUrl}/api/projects/initial-draft/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: initialTargetId, flow: blankFlow }),
    });
    assert.equal(targetBootstrap.status, 201);
    const copyToInitial = await fetch(`${server.baseUrl}/api/files/masks/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceProjectId: "mask-project",
        targetProjectId: initialTargetId,
        masks: [{ fileId: maskBody.id, nodeId: "mask-node" }],
      }),
    });
    assert.equal(copyToInitial.status, 200);
    const initialCopyBody = await copyToInitial.json() as {
      targetProjectId: string;
      masks: Array<{ targetUrl: string }>;
    };
    assert.equal(initialCopyBody.targetProjectId, initialTargetId);
    const initialMaskUrl = initialCopyBody.masks[0].targetUrl;
    const initialMaskId = initialMaskUrl.slice("/api/files/".length);
    const syncTarget = await fetch(`${server.baseUrl}/api/projects/initial-draft/${initialTargetId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 0,
        name: "待放弃的其他页签草稿",
        flow: maskFlow(initialMaskUrl),
      }),
    });
    assert.equal(syncTarget.status, 200);
    const syncTargetBody = await syncTarget.json() as { draft: { revision: number } };
    const abandonTarget = await fetch(`${server.baseUrl}/api/projects/initial-draft/${initialTargetId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true, expectedRevision: syncTargetBody.draft.revision }),
    });
    assert.equal(abandonTarget.status, 200);
    assert.equal((await queryOne<{ deleted: boolean }>(`
      SELECT deleted_at IS NOT NULL AS deleted FROM files WHERE id = $1
    `, [initialMaskId]))?.deleted, true);

    const recoverStaleMask = await fetch(`${server.baseUrl}/api/files/masks/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceProjectId: initialTargetId,
        createTarget: true,
        masks: [{ fileId: initialMaskId, nodeId: "mask-node" }],
      }),
    });
    assert.equal(recoverStaleMask.status, 200);
    const recoveredMaskBody = await recoverStaleMask.json() as {
      targetProjectId: string;
      masks: Array<{ targetUrl: string }>;
    };
    const recoveredBootstrap = await fetch(`${server.baseUrl}/api/projects/initial-draft/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: recoveredMaskBody.targetProjectId,
        name: "从其他页签恢复",
        flow: maskFlow(recoveredMaskBody.masks[0].targetUrl),
      }),
    });
    assert.equal(recoveredBootstrap.status, 201);
    const cleanupRecovered = await fetch(
      `${server.baseUrl}/api/projects/initial-draft/${recoveredMaskBody.targetProjectId}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, expectedRevision: 0 }),
      },
    );
    assert.equal(cleanupRecovered.status, 200);

    const secondMaskResponse = await uploadMask(maskDataUrl);
    assert.equal(secondMaskResponse.status, 200);
    const secondMaskBody = await secondMaskResponse.json() as { id: string; url: string };
    const wrongNodeSave = await saveMaskProject(secondMaskBody.url, "mask-project", "wrong-mask-node");
    assert.equal(wrongNodeSave.status, 403, await wrongNodeSave.text());
    assert.deepEqual(await queryOne<Record<string, unknown>>(`
      SELECT source_type, purge_after IS NOT NULL AS expiring
      FROM files WHERE id = $1
    `, [secondMaskBody.id]), { source_type: "mask-draft", expiring: true });
    const projectAfterWrongNode = await queryOne<{ flow_json: string }>(
      "SELECT flow_json FROM projects WHERE id = 'mask-project'",
    );
    assert.equal(
      (JSON.parse(projectAfterWrongNode?.flow_json ?? "{}") as { nodes?: Array<{ data?: { mask?: string } }> })
        .nodes?.some((node) => node.data?.mask === maskBody.url),
      true,
      "错 node_id 的认领失败必须回滚项目与已有蒙版",
    );

    const fileShareBlocker = await db().connect();
    let blockedSave: Promise<Response> | undefined;
    try {
      await fileShareBlocker.query("BEGIN");
      await fileShareBlocker.query("SELECT id FROM files WHERE id = $1 FOR SHARE", [body.id]);
      blockedSave = saveMaskProject(secondMaskBody.url);
      await waitForDatabaseCondition("项目保存直接等待文件强锁", async () => {
        const waiting = await queryOne<{ count: number }>(`
          SELECT COUNT(*)::int AS count
          FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
            AND query LIKE '%SELECT f.id, f.owner_id%'
        `);
        return (waiting?.count ?? 0) > 0;
      });
      await fileShareBlocker.query("COMMIT");
      assert.equal((await blockedSave).status, 200);
    } finally {
      try { await fileShareBlocker.query("ROLLBACK"); } catch { /* transaction already ended */ }
      fileShareBlocker.release();
      await blockedSave?.catch(() => undefined);
    }
    assert.equal((await queryOne<{ expiring: boolean }>(`
      SELECT purge_after IS NOT NULL AS expiring FROM files WHERE id = $1
    `, [maskBody.id]))?.expiring, true, "被替换的旧蒙版必须进入延迟回收");
    assert.deepEqual(await queryOne<Record<string, unknown>>(`
      SELECT source_type, purge_after FROM files WHERE id = $1
    `, [secondMaskBody.id]), { source_type: "mask", purge_after: null });
    await query("UPDATE files SET purge_after = $1 WHERE id = $2", [
      new Date(Date.now() - 1_000).toISOString(), maskBody.id,
    ]);
    await query(`
      INSERT INTO generation_runs (
        id, owner_id, project_id, node_id, node_label, kind,
        requested_count, status, started_at, plan_json, run_type, updated_at
      ) VALUES ($1, $2, 'mask-project', 'mask-node', '局部重绘', 'mask-redraw',
        1, 'queued', $3, $4, 'workflow', $3)
    `, [
      "active-mask-retention-run", admin.id, Date.now(),
      JSON.stringify({ steps: [{ nodeId: "mask-node", params: { mask: maskBody.url } }] }),
    ]);
    await purgeExpiredProjects();
    assert.equal(fs.existsSync(path.join(uploadsDir(), maskBody.id)), true);
    assert.ok(await queryOne("SELECT id FROM files WHERE id = $1", [maskBody.id]));
    await query(`
      UPDATE generation_runs
      SET status = 'failed', finished_at = $1, updated_at = $1
      WHERE id = 'active-mask-retention-run'
    `, [Date.now()]);
    await purgeExpiredProjects();
    assert.equal(fs.existsSync(path.join(uploadsDir(), maskBody.id)), false);
    assert.equal(await queryOne("SELECT id FROM files WHERE id = $1", [maskBody.id]), undefined);

    const beforeFiles = fs.readdirSync(uploadsDir()).sort();
    const ownerUnavailable = await fetch(`${server.baseUrl}/api/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-owner": "missing" },
      body: JSON.stringify({ dataUrl: dataUrl("image/webp", source) }),
    });
    assert.equal(ownerUnavailable.status, 409);
    assert.deepEqual(fs.readdirSync(uploadsDir()).sort(), beforeFiles);
  } finally {
    await server.close();
  }
});

await test("Provider 调用前会标准化旧素材请求副本，失败时不会发起付费调用", async () => {
  const admin = await queryOne<{ id: string }>(
    "SELECT id FROM users WHERE account_id = 'normalization-admin'",
  );
  assert.ok(admin);

  const legacyId = "legacy-runtime-input.webp";
  const legacyBuffer = await sharp({
    create: { width: 5000, height: 1000, channels: 3, background: "#735b42" },
  }).webp({ quality: 96 }).toBuffer();
  fs.writeFileSync(path.join(uploadsDir(), legacyId), legacyBuffer);
  await query(`
    INSERT INTO files (id, owner_id, source_type, created_at) VALUES ($1, $2, 'legacy', $3)
  `, [legacyId, admin.id, new Date().toISOString()]);

  const [prepared] = await resolveImageRefs([`/api/files/${legacyId}`]);
  const preparedImage = validateImageDataUrl(prepared);
  const preparedMetadata = await sharp(preparedImage.buffer).metadata();
  assert.equal(preparedImage.mime, "image/jpeg");
  assert.equal(Math.max(preparedMetadata.width ?? 0, preparedMetadata.height ?? 0), UPLOAD_MAX_LONG_EDGE);
  assert.ok(preparedImage.buffer.byteLength <= PROVIDER_TARGET_BYTES);
  assert.deepEqual(fs.readFileSync(path.join(uploadsDir(), legacyId)), legacyBuffer, "运行时适配不能改写原素材");
  await assert.rejects(
    () => resolveImageRefs([`/api/files/nested/${legacyId}`]),
    /invalid local image reference/,
  );

  let paidCalls = 0;
  let receivedReference = "";
  const provider: AIProvider = {
    id: "normalization-gate-test",
    async generate() {
      paidCalls += 1;
      return { images: [prepared], model: "normalization-gate-test" };
    },
    async edit(request) {
      paidCalls += 1;
      receivedReference = request.referenceImages?.[0] ?? "";
      return { images: [prepared], model: "normalization-gate-test" };
    },
  };
  const step: NodeExecution = {
    nodeId: "normalization-gate",
    kind: "print-extract",
    inputImages: [`/api/files/${legacyId}`],
    params: { prompt: "提取主图案" },
  };
  await executeStep(step, step.inputImages, () => provider);
  assert.equal(paidCalls, 1);
  assert.equal(validateImageDataUrl(receivedReference).mime, "image/jpeg");

  const brokenId = "legacy-broken-input.png";
  const brokenBuffer = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
  ]);
  fs.writeFileSync(path.join(uploadsDir(), brokenId), brokenBuffer);
  await query(`
    INSERT INTO files (id, owner_id, source_type, created_at) VALUES ($1, $2, 'legacy', $3)
  `, [brokenId, admin.id, new Date().toISOString()]);
  const brokenStep: NodeExecution = {
    ...step,
    nodeId: "normalization-gate-broken",
    inputImages: [`/api/files/${brokenId}`],
  };
  await assert.rejects(
    () => executeStep(brokenStep, brokenStep.inputImages, () => provider),
    /无法完成标准化处理|无法读取图片|corrupt|invalid/i,
  );
  assert.equal(paidCalls, 1, "素材标准化失败时不得调用 Provider");
});

await test("前端未拿到 normalized:true 时不会把图片写入节点", () => {
  const source = fs.readFileSync(new URL("../src/components/nodes/ImageInputNode.tsx", import.meta.url), "utf8");
  assert.match(source, /fetch\("\/api\/assets"/);
  assert.match(source, /category: "reference"[\s\S]*scope: "private"[\s\S]*image: dataUrl/);
  assert.match(source, /data\.normalized !== true[\s\S]*服务端未完成素材标准化/);
  assert.match(source, /const upload = await uploadFile\(file\)[\s\S]*assignImageInputInTab\(target, id, upload\.url\)/);
});

await closeDatabaseForTests();
fs.rmSync(temp, { recursive: true, force: true });
console.log(`通过 ${passed} 项上传图片标准化测试`);

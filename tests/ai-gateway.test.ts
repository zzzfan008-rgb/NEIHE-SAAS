import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import sharp from "sharp";
import { resetPostgresTestDatabase } from "./postgresTestDatabase";
import { currentAiGateway, withAiGateway } from "../server/providers/gatewayContext";
import type { NodeExecution } from "../src/types/workflow";
import { ProviderError } from "../server/providers/base";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "garment-ai-gateway-"));
process.env.DATA_DIR = temp;
process.env.SQLITE_IMPORT_FILE = "missing.db";
process.env.INITIAL_ADMIN_ACCOUNT_ID = "gateway-admin";
process.env.INITIAL_ADMIN_PASSWORD = "TestPassword1234";
process.env.APIYI_BASE_URL = "https://apiyi.example";
process.env.APIYI_API_KEY = "apiyi-test-only";
process.env.TUZI_BASE_URL = "https://tuzi.example";
process.env.TUZI_API_KEY = "";
await resetPostgresTestDatabase();
const db = await import("../server/lib/database");
await db.initializeDatabase();
const auth = await import("../server/lib/auth");
const { aiGatewayRouter, captureAiGateway } = await import("../server/routes/aiGateway");
const { readAiGatewaySelection, switchAiGateway } = await import("../server/lib/aiGatewayStore");
const queue = await import("../server/engine/runQueue");
const admin = (await db.queryOne<{ id: string }>("SELECT id FROM users WHERE account_id = 'gateway-admin'"))!;
await db.query("UPDATE users SET must_change_password = 0 WHERE id = $1", [admin.id]);
const now = new Date().toISOString();
await db.query(`INSERT INTO users(id,account_id,display_name,role,password_hash,active,must_change_password,created_at,updated_at)
  VALUES ('gateway-user','gateway-user','成员','user','test-only',1,0,$1,$1),
    ('gateway-password','gateway-password','管理员','admin','test-only',1,1,$1,$1)`, [now]);
const cookies = new Map<string, string>();
for (const id of [admin.id, "gateway-user", "gateway-password"]) cookies.set(id, `gc_session=${(await auth.createSession(id)).token}`);
const app = express();
app.use(express.json());
app.use(auth.requireAuth, auth.requirePasswordChanged);
app.use("/api/ai-gateway", aiGatewayRouter);
app.get("/capture", captureAiGateway, (_req, res) => { res.json({ gateway: currentAiGateway() }); });
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function request(id?: string, body?: unknown, pathname = "/api/ai-gateway") {
  return fetch(base + pathname, { method: body ? "PUT" : "GET", headers: {
    ...(id ? { Cookie: cookies.get(id)! } : {}), "Content-Type": "application/json",
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
try {
  console.log("全局供应商权限、持久化及队列回归");
  assert.deepEqual(await readAiGatewaySelection(), { activeGateway: "apiyi", revision: 0 });
  assert.equal((await request()).status, 401);
  assert.equal((await request("gateway-password", { activeGateway: "tuzi", revision: 0 })).status, 403);
  assert.equal((await request("gateway-user", { activeGateway: "tuzi", revision: 0 })).status, 403);
  assert.equal((await request(admin.id, { activeGateway: "tuzi", revision: 0 })).status, 409);
  process.env.TUZI_API_KEY = "tuzi-test-only";
  assert.equal((await request(admin.id, { activeGateway: "bad", revision: 0 })).status, 400);
  const changed = await request(admin.id, { activeGateway: "tuzi", revision: 0 });
  assert.equal(changed.status, 200);
  const visible = await changed.text();
  assert.ok(!visible.includes("test-only") && !visible.includes("https:"));
  assert.equal((await request(admin.id, { activeGateway: "apiyi", revision: 0 })).status, 409);
  assert.equal((await (await request("gateway-user")).json()).activeGateway, "tuzi");
  assert.equal((await (await request("gateway-user", undefined, "/capture?provider=apiyi")).json()).gateway, "tuzi");
  await db.closeDatabaseForTests(); await db.initializeDatabase();
  assert.deepEqual(await readAiGatewaySelection(), { activeGateway: "tuzi", revision: 1 });
  console.log("  ✓ 未登录、普通用户和强制改密账户不能切换；CAS、防伪造、重启持久化及无密钥泄露");

  await switchAiGateway("apiyi", 1);
  const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#ffffff" } }).png().toBuffer();
  const dataUrl = `data:image/png;base64,${image.toString("base64")}`;
  const step: NodeExecution = { nodeId: "provider-test", kind: "print-extract", inputImages: [dataUrl], params: { prompt: "提取印花", modelId: "gpt-image-2.5-flare", modelOptions: { size: "1024x1024", quality: "medium" } } };
  const context = { userId: admin.id, nodeId: step.nodeId, nodeLabel: "供应商测试", kind: step.kind, requestedCount: 1, clientRequestId: "gateway-old" };
  const original = await queue.enqueueGenerationRun({ steps: [step] }, admin.id, context);
  await switchAiGateway("tuzi", 2);
  const replayed = await queue.enqueueGenerationRun({ steps: [step] }, admin.id, context);
  assert.equal(replayed.id, original.id);
  const newer = await queue.enqueueGenerationRun({ steps: [step] }, admin.id, { ...context, clientRequestId: "gateway-new" });
  assert.equal((await db.queryOne<{ gateway_id: string }>("SELECT gateway_id FROM generation_runs WHERE id = $1", [original.id]))?.gateway_id, "apiyi");
  assert.equal((await db.queryOne<{ gateway_id: string }>("SELECT gateway_id FROM generation_runs WHERE id = $1", [newer.id]))?.gateway_id, "tuzi");
  const selected: string[] = [];
  let time = Date.now() + 1000;
  let first = true;
  const resolveProvider = (id: string) => ({ id, async generate() { throw new Error("unexpected generate"); }, async edit() {
    selected.push(currentAiGateway());
    if (first) { first = false; throw new ProviderError("网络中断", 503, id, "gateway_unavailable"); }
    return { images: [dataUrl], model: id };
  } });
  await queue.processNextGenerationJob("gateway-worker", { resolveProvider, now: () => time, retryDelaysMs: [1] });
  for (let i = 0; i < 3; i++) { time += 10_000; await queue.processNextGenerationJob("gateway-worker", { resolveProvider, now: () => time, retryDelaysMs: [1] }); }
  assert.equal(selected.filter((gateway) => gateway === "apiyi").length, 2);
  assert.equal(selected.filter((gateway) => gateway === "tuzi").length, 1);
  const rows = await db.query<{ status: string }>("SELECT status FROM generation_runs WHERE id = ANY($1)", [[original.id, newer.id]]);
  assert.ok(rows.every((row) => row.status === "succeeded"));
  assert.equal(currentAiGateway(), "apiyi");
  const before = (await db.queryOne<{ count: string }>("SELECT count(*)::text AS count FROM generation_runs"))!.count;
  await assert.rejects(() => queue.enqueueGenerationRun({ steps: [{ ...step, params: { ...step.params, modelId: "flux-2-pro" } }] }, admin.id, { ...context, clientRequestId: "unsupported" }), /暂无该型号/);
  assert.equal((await db.queryOne<{ count: string }>("SELECT count(*)::text AS count FROM generation_runs"))!.count, before);
  await withAiGateway("apiyi", () => queue.enqueueGenerationRun({ steps: [step] }, admin.id, { ...context, clientRequestId: "captured-old" }));
  assert.equal((await db.queryOne<{ gateway_id: string }>("SELECT gateway_id FROM generation_runs WHERE client_request_id = 'captured-old'"))!.gateway_id, "apiyi");
  console.log("  ✓ 全局切换只影响新任务；幂等重放、自动重试、提交时快照及异步请求隔离");
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db.closeDatabaseForTests();
  fs.rmSync(temp, { recursive: true, force: true });
}

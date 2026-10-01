import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthenticatedRequest } from "../server/lib/auth";
import { resetPostgresTestDatabase } from "./postgresTestDatabase";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-lifecycle-"));
process.env.SQLITE_IMPORT_FILE = "missing.db";
process.env.INITIAL_ADMIN_ACCOUNT_ID = "lifecycle-admin";
process.env.INITIAL_ADMIN_PASSWORD = "Initial1234";
await resetPostgresTestDatabase();
const db = await import("../server/lib/database");
await db.initializeDatabase();
const { createOrResolveImageConversation, createImageConversationRound, applyImageConversationPlan, getImageConversation } = await import("../server/lib/imageConversationStore");
const { recoverExpiredGenerationJobs } = await import("../server/engine/runQueue");
const { reconcileImageConversation } = await import("../server/engine/imageConversationReconciliation");
const { projectsRouter, purgeExpiredProjects } = await import("../server/routes/projects");
const now = new Date().toISOString();
const ownerId = "lifecycle-owner";
const projectId = "lifecycle-project";
await db.query(`INSERT INTO users (id,account_id,display_name,role,password_hash,active,created_at,updated_at)
  VALUES ($1,$1,'Owner','user','test-only',1,$2,$2)`, [ownerId, now]);
await db.query(`INSERT INTO projects (id,owner_id,name,flow_json,created_at,updated_at)
  VALUES ($1,$2,'Lifecycle','{}',$3,$3)`, [projectId, ownerId, now]);
await db.query(`INSERT INTO files (id,owner_id,source_type,project_id,mime_type,purge_after,created_at)
  VALUES ('base.png',$1,'upload',$2,'image/png',NULL,$3),
    ('mask.png',$1,'mask-draft',$2,'image/png','2000-01-01',$3),
    ('unused.png',$1,'mask-draft',$2,'image/png','2000-01-01',$3)`, [ownerId, projectId, now]);
await db.query(`INSERT INTO assets (id,owner_id,scope,name,category,image,created_at)
  VALUES ('origin',$1,'private','Origin','reference','/api/files/base.png',$2),
    ('reference',$1,'private','Reference','reference','/api/files/base.png',$2),
    ('unused',$1,'private','Unused','reference','/api/files/base.png',$2)`, [ownerId, now]);
await db.query(`INSERT INTO project_asset_refs (project_id,asset_id,created_at)
  SELECT $1,id,$2 FROM assets WHERE owner_id=$3`, [projectId, now, ownerId]);
const conversation = await createOrResolveImageConversation({ ownerId, projectId, sourceRef: "asset/origin", sourceKind: "asset" });
const common = { ownerId, projectId, conversationId: conversation.id, sourceResultId: null,
  prompt: "保持服装", parameters: { modelId: "gpt-image-2.5-sunburst", quality: "medium", outputCount: 1, size: "2K" } };
await createImageConversationRound({ ...common, clientRequestId: "reference-round", mode: "fusion",
  inputManifest: [{ role: "base", ordinal: 0, sourceRef: "asset/origin" }, { role: "reference", ordinal: 1, sourceRef: "asset/reference" }] });
await createImageConversationRound({ ...common, clientRequestId: "mask-round", mode: "mask", maskRef: "/api/files/mask.png",
  inputManifest: [{ role: "base", ordinal: 0, sourceRef: "/api/files/base.png" }] });

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as AuthenticatedRequest).authUser = { id: ownerId, accountId: ownerId, displayName: "Owner", role: "user", mustChangePassword: false };
  next();
});
app.use("/projects", projectsRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/projects`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ id: projectId, name: "Saved", flow: { nodes: [], edges: [] } }) });
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual((await db.query<{ asset_id: string }>("SELECT asset_id FROM project_asset_refs WHERE project_id=$1 ORDER BY asset_id", [projectId])).map(r => r.asset_id), ["origin", "reference"]);
  await purgeExpiredProjects();
  assert.ok(await db.queryOne("SELECT id FROM files WHERE id='mask.png'"), "submitted expired mask survives GC");
  assert.equal(await db.queryOne("SELECT id FROM files WHERE id='unused.png'"), undefined, "unreferenced mask remains collectible");
  // Persisted reference inputs must still pass authorization after a blank save.
  const queued = await applyImageConversationPlan({ ...common, clientRequestId: "queued-round", mode: "fusion",
    inputManifest: [{ role: "base", ordinal: 0, sourceRef: "asset/origin" }, { role: "reference", ordinal: 1, sourceRef: "asset/reference" }],
    plan: { kind: "ready", outputCount: 1, intents: [{ ordinal: 1, label: "方案", instruction: "修改", requirements: {} }] }, enqueue: true });
  const attempt = await db.queryOne<{ generation_run_id: string }>("SELECT generation_run_id FROM image_conversation_attempts WHERE round_id=$1", [queued.round.id]);
  assert.ok(attempt);
  await db.query("UPDATE generation_jobs SET status='running',worker_id='dead-worker',attempt_started_at=1,lease_expires_at=1 WHERE run_id=$1", [attempt.generation_run_id]);
  await db.query("UPDATE generation_runs SET status='running' WHERE id=$1", [attempt.generation_run_id]);
  assert.equal(await recoverExpiredGenerationJobs(), 1);
  let restored = await getImageConversation(ownerId, projectId, conversation.id);
  assert.equal(restored?.rounds.find(r => r.id === queued.round.id)?.status, "outcome_unknown");
  assert.equal((await db.queryOne<{ status: string }>("SELECT status FROM image_conversation_outputs WHERE round_id=$1", [queued.round.id]))?.status, "unknown");
  // Crash between durable completion and sync must be repaired even without an expired lease.
  await db.query("UPDATE generation_runs SET status='failed',error='confirmed failure' WHERE id=$1", [attempt.generation_run_id]);
  assert.equal(await recoverExpiredGenerationJobs(), 0);
  await reconcileImageConversation(ownerId, projectId, conversation.id);
  restored = await getImageConversation(ownerId, projectId, conversation.id);
  assert.equal(restored?.rounds.find(r => r.id === queued.round.id)?.status, "failed");
  assert.equal((await db.queryOne<{ status: string }>("SELECT status FROM image_conversation_outputs WHERE round_id=$1", [queued.round.id]))?.status, "failed");
  await db.query("UPDATE generation_runs SET status='outcome_unknown',error=NULL WHERE id=$1", [attempt.generation_run_id]);
  await reconcileImageConversation("another-owner", projectId, conversation.id);
  assert.equal((await db.queryOne<{ status: string }>("SELECT status FROM image_conversation_attempts WHERE round_id=$1", [queued.round.id]))?.status, "failed", "read repair is owner scoped");
  await reconcileImageConversation(ownerId, projectId, conversation.id);
  assert.equal((await db.queryOne<{ status: string }>("SELECT status FROM image_conversation_outputs WHERE round_id=$1", [queued.round.id]))?.status, "unknown", "null provider error still produces a valid unknown card");
  await db.query("UPDATE generation_runs SET status='succeeded' WHERE id=$1", [attempt.generation_run_id]);
  await db.query(`INSERT INTO generation_outputs (id,run_id,image,prompt,status,created_at)
    VALUES ('recovered-output',$1,'/api/files/base.png','recovered','success',$2)`, [attempt.generation_run_id, Date.now()]);
  await Promise.all([reconcileImageConversation(ownerId, projectId, conversation.id), reconcileImageConversation(ownerId, projectId, conversation.id)]);
  const outputs = await db.query<{ status: string }>("SELECT status FROM image_conversation_outputs WHERE round_id=$1", [queued.round.id]);
  assert.deepEqual(outputs.map(r => r.status), ["ready"], "read repair is idempotent and removes resolved unknown placeholder");
  console.log("image-conversation-lifecycle: crash recovery, asset references and mask GC passed");
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await db.closeDatabaseForTests();
}

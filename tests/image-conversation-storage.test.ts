import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPostgresTestDatabase } from "./postgresTestDatabase";
import {
  createImageConversationRound,
  createOrResolveImageConversation,
  getImageConversation,
  linkImageConversationOutput,
  resolveImageConversation,
} from "../server/lib/imageConversationStore";
import { migrateImageConversations } from "../server/lib/imageConversationMigration";
import { reserveImageConversationRequest } from "../server/lib/imageConversationRequests";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-image-conversation-storage-"));
process.env.DATA_DIR = temp;
process.env.SQLITE_IMPORT_FILE = "missing.db";
process.env.INITIAL_ADMIN_ACCOUNT_ID = "image-conversation-storage-admin";
process.env.INITIAL_ADMIN_PASSWORD = "Initial1234";

await resetPostgresTestDatabase();
const database = await import("../server/lib/database");
await database.initializeDatabase();

const ownerId = "conversation-owner";
const otherOwnerId = "conversation-other";
const projectA = "conversation-project-a";
const projectB = "conversation-project-b";
const otherProject = "conversation-project-other";
const sourceA = "/api/files/conversation-source-a.png";
const sourceB = "/api/files/conversation-source-b.png";
const assetId = "conversation-asset-1";
const assetSource = `asset/${assetId}`;
const now = new Date().toISOString();

await database.query(`
  INSERT INTO users (id, account_id, display_name, role, password_hash, active, created_at, updated_at)
  VALUES
    ($1, $2, 'Conversation Owner', 'user', 'test-only', 1, $5, $5),
    ($3, $4, 'Conversation Other', 'user', 'test-only', 1, $5, $5)
`, [ownerId, ownerId, otherOwnerId, otherOwnerId, now]);
for (const [id, owner] of [[projectA, ownerId], [projectB, ownerId], [otherProject, otherOwnerId]] as const) {
  await database.query(`
    INSERT INTO projects (id, owner_id, name, flow_json, updated_at, created_at)
    VALUES ($1, $2, $3, '{}', $4, $4)
  `, [id, owner, id, now]);
}
await database.query(`
  INSERT INTO files (id, owner_id, source_type, project_id, created_at)
  VALUES ('conversation-source-a.png', $1, 'upload', NULL, $2),
         ('conversation-source-b.png', $1, 'upload', NULL, $2)
`, [ownerId, now]);
await database.query(`
  INSERT INTO files (id, owner_id, source_type, project_id, created_at)
  VALUES ('conversation-other.png', $1, 'upload', NULL, $2)
`, [otherOwnerId, now]);
await database.query(`
  INSERT INTO assets (id, owner_id, scope, name, category, image, created_at)
  VALUES ($1, $2, 'private', 'Conversation asset', 'reference', $3, $4)
`, [assetId, ownerId, sourceB, now]);
await database.query(`
  INSERT INTO project_asset_refs (project_id, asset_id, created_at)
  VALUES ($1, $2, $3)
`, [projectA, assetId, now]);

function inputManifest(sourceRef = sourceA) {
  return [{ role: "base", ordinal: 0, sourceRef }];
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

await test("migration is registered and remains idempotent after database reinitialization", async () => {
  const migration = await database.queryOne<{ version: number; name: string }>(
    "SELECT version, name FROM schema_migrations WHERE version = 24",
  );
  assert.deepEqual(migration, { version: 24, name: "image_conversations" });
  for (const table of [
    "image_conversations",
    "image_conversation_sources",
    "image_conversation_rounds",
    "image_conversation_intents",
    "image_conversation_attempts",
    "image_conversation_outputs",
    "image_conversation_clarifications",
  ]) {
    const row = await database.queryOne<{ exists: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS exists",
      [table],
    );
    assert.equal(row?.exists, true, `missing table ${table}`);
  }
  assert.equal(typeof migrateImageConversations, "function");
  await database.closeDatabaseForTests();
  await database.initializeDatabase();
  const duplicateRows = await database.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM schema_migrations WHERE version = 24",
  );
  assert.equal(duplicateRows[0]?.count, "1");
});

await test("same-project source resolution is shared while replacement and cross-project copies are isolated", async () => {
  const first = await createOrResolveImageConversation({
    ownerId,
    projectId: projectA,
    sourceRef: sourceA,
    sourceKind: "file",
  });
  const sameSource = await createOrResolveImageConversation({
    ownerId,
    projectId: projectA,
    sourceRef: sourceA,
    sourceKind: "file",
  });
  assert.equal(sameSource.id, first.id);

  const startedNew = await createOrResolveImageConversation({
    ownerId,
    projectId: projectA,
    sourceRef: sourceA,
    sourceKind: "file",
    startNew: true,
  });
  assert.notEqual(startedNew.id, first.id);
  assert.equal((await resolveImageConversation(ownerId, projectA, sourceA))?.id, startedNew.id);

  const replacement = await createOrResolveImageConversation({
    ownerId,
    projectId: projectA,
    sourceRef: sourceB,
    sourceKind: "file",
  });
  assert.notEqual(replacement.id, first.id);

  const crossProject = await createOrResolveImageConversation({
    ownerId,
    projectId: projectB,
    sourceRef: sourceA,
    sourceKind: "file",
  });
  assert.notEqual(crossProject.id, first.id);
  assert.equal((await getImageConversation(ownerId, projectA, first.id))?.projectId, projectA);
  assert.equal((await getImageConversation(ownerId, projectB, crossProject.id))?.projectId, projectB);
});

await test("round snapshots and concrete output relations survive a fresh read", async () => {
  const conversation = await createOrResolveImageConversation({
    ownerId,
    projectId: projectA,
    sourceRef: sourceA,
    sourceKind: "file",
  });
  const round = await createImageConversationRound({
    ownerId,
    projectId: projectA,
    conversationId: conversation.id,
    clientRequestId: "conversation-round-1",
    mode: "single",
    sourceResultId: null,
    inputManifest: inputManifest(),
    prompt: "保持背景，把袖子缩短",
    parameters: { modelId: "gpt-image-2.5-sunburst", quality: "medium", outputCount: 1, size: "2K" },
    effectiveRequirements: { background: "unchanged" },
    incrementalRequirements: { sleeve: "shorter" },
    status: "draft",
  });
  const replay = await createImageConversationRound({
    ownerId,
    projectId: projectA,
    conversationId: conversation.id,
    clientRequestId: "conversation-round-1",
    mode: "single",
    sourceResultId: null,
    inputManifest: inputManifest(),
    prompt: "保持背景，把袖子缩短",
    parameters: { modelId: "gpt-image-2.5-sunburst", quality: "medium", outputCount: 1, size: "2K" },
    effectiveRequirements: { background: "unchanged" },
    incrementalRequirements: { sleeve: "shorter" },
    status: "draft",
  });
  assert.equal(replay.id, round.id);

  await database.query(`
    INSERT INTO generation_runs (
      id, owner_id, project_id, node_id, node_label, kind, status, started_at, run_type, updated_at
    ) VALUES ('conversation-run-1', $1, $2, 'conversation-node', '对话修改', 'ai-modify', 'succeeded', $3, 'direct', $3)
  `, [ownerId, projectA, Date.now()]);
  await database.query(`
    INSERT INTO generation_outputs (id, run_id, image, prompt, status, created_at)
    VALUES ('conversation-output-1', 'conversation-run-1', $1, '保持背景，把袖子缩短', 'success', $2)
  `, [sourceB, Date.now()]);
  const output = await linkImageConversationOutput({
    ownerId,
    projectId: projectA,
    conversationId: conversation.id,
    roundId: round.id,
    intentId: null,
    generationOutputId: "conversation-output-1",
    status: "ready",
    imageRef: sourceB,
  });
  assert.equal(output.status, "ready");

  const loaded = await getImageConversation(ownerId, projectA, conversation.id);
  assert.equal(loaded?.rounds.length, 1);
  assert.deepEqual(loaded?.rounds[0]?.inputManifest, inputManifest());
  assert.deepEqual(loaded?.rounds[0]?.effectiveRequirements, { background: "unchanged" });
  assert.deepEqual(loaded?.rounds[0]?.incrementalRequirements, { sleeve: "shorter" });
  assert.equal(loaded?.outputs[0]?.generationOutputId, "conversation-output-1");
  const outputSourceConversation = await resolveImageConversation(
    ownerId,
    projectA,
    "generation-output/conversation-output-1",
  );
  assert.equal(outputSourceConversation?.id, conversation.id);
});

await test("asset input snapshots resolve an authorized preview after a fresh read", async () => {
  const conversation = await createOrResolveImageConversation({
    ownerId,
    projectId: projectA,
    sourceRef: assetSource,
    sourceKind: "asset",
  });
  await createImageConversationRound({
    ownerId,
    projectId: projectA,
    conversationId: conversation.id,
    clientRequestId: "conversation-asset-round-1",
    mode: "single",
    sourceResultId: null,
    inputManifest: inputManifest(assetSource),
    prompt: "保留素材纹理",
    parameters: { modelId: "gpt-image-2.5-sunburst", quality: "medium", outputCount: 1, size: "2K" },
    status: "draft",
  });
  const loaded = await getImageConversation(ownerId, projectA, conversation.id);
  assert.equal(loaded?.sourcePreviews[assetSource], sourceB);
});

await test("source ownership and guessed conversation identifiers do not disclose history", async () => {
  await assert.rejects(
    () => createOrResolveImageConversation({
      ownerId: otherOwnerId,
      projectId: otherProject,
      sourceRef: sourceA,
      sourceKind: "file",
    }),
    /image source is not accessible/,
  );
  assert.equal(await getImageConversation(otherOwnerId, projectA, "not-owned-conversation"), undefined);
  assert.equal(await getImageConversation(otherOwnerId, projectA, "conversation-does-not-exist"), undefined);
  assert.equal(
    await database.queryOne<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM image_conversations WHERE owner_id = $1",
      [otherOwnerId],
    ).then((row) => row?.count),
    "0",
  );
});

await test("project deletion cascades conversation history without exposing a delete API", async () => {
  const conversation = await createOrResolveImageConversation({
    ownerId,
    projectId: projectB,
    sourceRef: sourceA,
    sourceKind: "file",
  });
  await database.query("DELETE FROM projects WHERE id = $1", [projectB]);
  assert.equal(await getImageConversation(ownerId, projectB, conversation.id), undefined);
  const rows = await database.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM image_conversation_sources WHERE conversation_id = $1",
    [conversation.id],
  );
  assert.equal(rows[0]?.count, "0");
});

await test("stale planning reservations are reclaimed instead of blocking the conversation", async () => {
  const conversation = await createOrResolveImageConversation({
    ownerId, projectId: projectA, sourceRef: sourceA, sourceKind: "file",
  });
  // Simulate a worker that reserved but died before settling: backdate the pending row past the TTL.
  await database.query(`
    INSERT INTO image_conversation_requests (owner_id, project_id, conversation_id, client_request_id, fingerprint, created_at)
    VALUES ($1, $2, $3, $4, 'stale', now() - interval '10 minutes')
  `, [ownerId, projectA, conversation.id, "stale-request"]);
  const fresh = await reserveImageConversationRequest(
    { ownerId, projectId: projectA, conversationId: conversation.id, clientRequestId: "fresh-request" },
    { prompt: "test" },
  );
  assert.equal(fresh.kind, "reserved", "过期的孤儿预约不应阻塞新请求");
  // The same clientRequestId can also be re-reserved once its stale row is reclaimed.
  await database.query(`
    UPDATE image_conversation_requests SET created_at = now() - interval '10 minutes' WHERE client_request_id = 'fresh-request'
  `);
  const reReserved = await reserveImageConversationRequest(
    { ownerId, projectId: projectA, conversationId: conversation.id, clientRequestId: "fresh-request" },
    { prompt: "test" },
  );
  assert.equal(reReserved.kind, "reserved");
});

console.log(`image-conversation-storage: ${passed} passed`);

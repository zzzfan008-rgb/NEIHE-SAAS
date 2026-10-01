import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPostgresTestDatabase } from "./postgresTestDatabase";
import {
  applyImageConversationPlan,
  createOrResolveImageConversation,
  getImageConversation,
  retryImageConversationIntent,
} from "../server/lib/imageConversationStore";
import { reconcileImageConversationRun } from "../server/engine/imageConversationReconciliation";
import { normalizeImageConversationSize } from "../server/engine/imageConversationExecution";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-image-conversation-queue-"));
process.env.DATA_DIR = temp;
process.env.SQLITE_IMPORT_FILE = "missing.db";
process.env.INITIAL_ADMIN_ACCOUNT_ID = "image-conversation-queue-admin";
process.env.INITIAL_ADMIN_PASSWORD = "Initial1234";

await resetPostgresTestDatabase();
const database = await import("../server/lib/database");
await database.initializeDatabase();

assert.equal(normalizeImageConversationSize("2K", "16:9"), "2048x1152");
assert.equal(normalizeImageConversationSize("4K", "1:1"), "2880x2880");
assert.equal(normalizeImageConversationSize("4K", "9:16"), "2160x3840");
assert.equal(normalizeImageConversationSize("4K", "not-a-ratio"), "2880x2880");

const ownerId = "conversation-queue-owner";
const projectId = "conversation-queue-project";
const sourceRef = "/api/files/conversation-queue-source.png";
const concurrentSourceRef = "/api/files/conversation-queue-concurrent.png";
const now = new Date().toISOString();
await database.query(`
  INSERT INTO users (id, account_id, display_name, role, password_hash, active, created_at, updated_at)
  VALUES ($1, $2, 'Queue Owner', 'user', 'test-only', 1, $3, $3)
`, [ownerId, ownerId, now]);
await database.query(`
  INSERT INTO projects (id, owner_id, name, flow_json, updated_at, created_at)
  VALUES ($1, $2, 'Queue Project', '{}', $3, $3)
`, [projectId, ownerId, now]);
await database.query(`
  INSERT INTO files (id, owner_id, source_type, created_at)
  VALUES ('conversation-queue-source.png', $1, 'upload', $2),
         ('conversation-queue-concurrent.png', $1, 'upload', $2)
`, [ownerId, now]);

const conversation = await createOrResolveImageConversation({
  ownerId,
  projectId,
  sourceRef,
  sourceKind: "file",
});

function plan(count: number) {
  return {
    kind: "ready" as const,
    outputCount: count,
    intents: Array.from({ length: count }, (_, index) => ({
      ordinal: index + 1,
      label: `方案${index + 1}`,
      instruction: `生成方案${index + 1}`,
      requirements: { variant: index + 1 },
    })),
  };
}

const queued = await applyImageConversationPlan({
  ownerId,
  projectId,
  conversationId: conversation.id,
  clientRequestId: "queue-round-1",
  mode: "single",
  sourceResultId: null,
  inputManifest: [{ role: "base", ordinal: 0, sourceRef }],
  prompt: "生成五个方案",
  parameters: { modelId: "gpt-image-2.5-sunburst", quality: "medium", outputCount: 1, size: "2K" },
  plan: plan(5),
  enqueue: true,
});
assert.equal(queued.round.status, "queued");
assert.equal(queued.round.intents.length, 5);
assert.ok(queued.round.intents.every((intent) => intent.status === "queued"));
assert.equal((await database.queryOne<{ count: string }>(
  "SELECT COUNT(*)::text AS count FROM generation_runs WHERE owner_id = $1 AND project_id = $2",
  [ownerId, projectId],
))?.count, "5");
assert.equal((await database.queryOne<{ count: string }>(
  "SELECT COUNT(*)::text AS count FROM image_conversation_attempts WHERE round_id = $1",
  [queued.round.id],
))?.count, "5");

const beforeRollback = await database.queryOne<{ count: string }>(
  "SELECT COUNT(*)::text AS count FROM image_conversation_rounds WHERE conversation_id = $1",
  [conversation.id],
);
await assert.rejects(
  () => applyImageConversationPlan({
    ownerId,
    projectId,
    conversationId: conversation.id,
    clientRequestId: "queue-round-invalid-model",
    mode: "single",
    sourceResultId: null,
    inputManifest: [{ role: "base", ordinal: 0, sourceRef }],
    prompt: "不应落库",
    parameters: { modelId: "not-a-real-model", quality: "medium", outputCount: 1 },
    plan: plan(1),
    enqueue: true,
  }),
  /selected image model is invalid/,
);
assert.equal((await database.queryOne<{ count: string }>(
  "SELECT COUNT(*)::text AS count FROM image_conversation_rounds WHERE conversation_id = $1",
  [conversation.id],
))?.count, beforeRollback?.count);

const concurrentResults = await Promise.all([
  createOrResolveImageConversation({
    ownerId,
    projectId,
    sourceRef: concurrentSourceRef,
    sourceKind: "file",
  }).then((concurrentConversation) => applyImageConversationPlan({
    ownerId,
    projectId,
    conversationId: concurrentConversation.id,
    clientRequestId: "queue-round-concurrent",
    mode: "single",
    sourceResultId: null,
    inputManifest: [{ role: "base", ordinal: 0, sourceRef: concurrentSourceRef }],
    prompt: "并发提交",
    parameters: { modelId: "gpt-image-2.5-sunburst", quality: "medium", outputCount: 1, size: "2K" },
    plan: plan(3),
    enqueue: true,
  })),
  createOrResolveImageConversation({
    ownerId,
    projectId,
    sourceRef: concurrentSourceRef,
    sourceKind: "file",
  }).then((concurrentConversation) => applyImageConversationPlan({
    ownerId,
    projectId,
    conversationId: concurrentConversation.id,
    clientRequestId: "queue-round-concurrent",
    mode: "single",
    sourceResultId: null,
    inputManifest: [{ role: "base", ordinal: 0, sourceRef: concurrentSourceRef }],
    prompt: "并发提交",
    parameters: { modelId: "gpt-image-2.5-sunburst", quality: "medium", outputCount: 1, size: "2K" },
    plan: plan(3),
    enqueue: true,
  })),
]);
assert.equal(concurrentResults[0].round.id, concurrentResults[1].round.id);
assert.equal((await database.queryOne<{ count: string }>(
  "SELECT COUNT(*)::text AS count FROM generation_runs WHERE owner_id = $1 AND project_id = $2",
  [ownerId, projectId],
))?.count, "8");
await assert.rejects(
  () => applyImageConversationPlan({
    ownerId,
    projectId,
    conversationId: conversation.id,
    clientRequestId: "queue-round-concurrent",
    mode: "single",
    sourceResultId: null,
    inputManifest: [{ role: "base", ordinal: 0, sourceRef }],
    prompt: "语义不同",
    parameters: { modelId: "gpt-image-2.5-sunburst", quality: "medium", outputCount: 1, size: "2K" },
    plan: plan(3),
    enqueue: true,
  }),
  /conflicts/,
);

const runRows = await database.query<{ id: string; ordinal: number }>(`
  SELECT run.id, intent.ordinal
  FROM generation_runs run
  JOIN image_conversation_attempts attempt ON attempt.generation_run_id = run.id
  JOIN image_conversation_intents intent ON intent.id = attempt.intent_id
  WHERE run.project_id = $1 AND attempt.round_id = $2
  ORDER BY intent.ordinal
`, [projectId, queued.round.id]);
for (const [index, row] of runRows.entries()) {
  if (index < 3) {
    await database.query(
      "UPDATE generation_runs SET status = 'succeeded', successful_count = 1, error = NULL, finished_at = $2 WHERE id = $1",
      [row.id, Date.now()],
    );
    await database.query(`
      INSERT INTO generation_outputs (id, run_id, image, prompt, status, created_at)
      VALUES ($1, $2, $3, $4, 'success', $5)
    `, [`queue-output-${index}`, row.id, sourceRef, `生成方案${row.ordinal}`, Date.now()]);
  } else {
    await database.query(
      "UPDATE generation_runs SET status = 'failed', error = $2, finished_at = $3 WHERE id = $1",
      [row.id, `方案${row.ordinal}失败`, Date.now()],
    );
  }
  await reconcileImageConversationRun(row.id);
}
const loaded = await getImageConversation(ownerId, projectId, conversation.id);
const loadedRound = loaded?.rounds.find((round) => round.id === queued.round.id);
assert.equal(loadedRound?.status, "partial");
assert.equal(loadedRound?.intents.filter((intent) => intent.status === "succeeded").length, 3);
assert.equal(loadedRound?.intents.filter((intent) => intent.status === "failed").length, 2);
assert.equal(loaded?.outputs.filter((output) => output.status === "ready").length, 3);
assert.equal(loaded?.outputs.filter((output) => output.status === "failed").length, 2);
const outputCountBeforeReplay = loaded?.outputs.length;
await reconcileImageConversationRun(runRows[0]!.id);
assert.equal((await getImageConversation(ownerId, projectId, conversation.id))?.outputs.length, outputCountBeforeReplay);

const sourceOutputId = "queue-output-0";
const contextPlan = await applyImageConversationPlan({
  ownerId,
  projectId,
  conversationId: conversation.id,
  clientRequestId: "queue-round-context-1",
  mode: "single",
  sourceResultId: sourceOutputId,
  inputManifest: [{ role: "base", ordinal: 0, sourceRef: `generation-output/${sourceOutputId}` }],
  prompt: "在上一个方案基础上继续修改",
  parameters: { modelId: "gpt-image-2.5-sunburst", quality: "medium", outputCount: 1, size: "2K" },
  plan: {
    kind: "ready",
    outputCount: 1,
    intents: [{ ordinal: 1, label: "继承上下文", instruction: "继续修改", requirements: { sleeve: "shorter" } }],
  },
  enqueue: true,
});
assert.deepEqual(contextPlan.round.effectiveRequirements, { variant: 1 });
const contextRun = await database.queryOne<{ id: string }>(`
  SELECT generation_run_id AS id
  FROM image_conversation_attempts
  WHERE round_id = $1
`, [contextPlan.round.id]);
const contextStep = await database.queryOne<{ step_json: string }>(`
  SELECT step_json
  FROM generation_run_steps
  WHERE run_id = $1
`, [contextRun?.id]);
const contextStepJson = JSON.parse(contextStep?.step_json ?? "{}");
assert.match(contextStepJson.params.prompt, /variant/);
assert.match(contextStepJson.params.prompt, /sleeve/);
await database.query(
  "UPDATE generation_runs SET status = 'succeeded', successful_count = 1, finished_at = $2 WHERE id = $1",
  [contextRun?.id, Date.now()],
);
await database.query(`
  INSERT INTO generation_outputs (id, run_id, image, prompt, status, created_at)
  VALUES ('queue-context-output', $1, $2, $3, 'success', $4)
`, [contextRun?.id, sourceRef, "继续修改", Date.now()]);
await reconcileImageConversationRun(contextRun!.id);

const failedIntents = (await getImageConversation(ownerId, projectId, conversation.id))?.rounds
  .find((round) => round.id === queued.round.id)?.intents
  .filter((intent) => intent.status === "failed") ?? [];
assert.equal(failedIntents.length, 2);
const failedIntent = failedIntents[0]!;
const retry = await retryImageConversationIntent({
  ownerId,
  projectId,
  conversationId: conversation.id,
  intentId: failedIntent.id,
  clientRequestId: "queue-intent-retry-1",
});
assert.equal(retry.replayed, false);
assert.equal(retry.attemptNumber, 2);
assert.equal(retry.round.status, "queued");
assert.equal((await database.queryOne<{ count: string }>(
  "SELECT COUNT(*)::text AS count FROM generation_runs WHERE owner_id = $1 AND project_id = $2",
  [ownerId, projectId],
))?.count, "10");
const retryReplay = await retryImageConversationIntent({
  ownerId,
  projectId,
  conversationId: conversation.id,
  intentId: failedIntent.id,
  clientRequestId: "queue-intent-retry-1",
});
assert.equal(retryReplay.replayed, true);
assert.equal(retryReplay.attemptId, retry.attemptId);
await database.query(
  "UPDATE generation_runs SET status = 'succeeded', successful_count = 1, error = NULL, finished_at = $2 WHERE id = $1",
  [retry.generationRunId, Date.now()],
);
await database.query(`
  INSERT INTO generation_outputs (id, run_id, image, prompt, status, created_at)
  VALUES ('queue-retry-output', $1, $2, $3, 'success', $4)
`, [retry.generationRunId, sourceRef, failedIntent.instruction, Date.now()]);
await reconcileImageConversationRun(retry.generationRunId);
const retried = await getImageConversation(ownerId, projectId, conversation.id);
const retriedRound = retried?.rounds.find((round) => round.id === queued.round.id);
assert.equal(retriedRound?.status, "partial");
assert.equal(retriedRound?.intents.find((intent) => intent.id === failedIntent.id)?.status, "succeeded");
assert.equal(retried?.outputs.filter((output) => output.intentId === failedIntent.id).length, 2);

const retrySecond = await retryImageConversationIntent({
  ownerId,
  projectId,
  conversationId: conversation.id,
  intentId: failedIntents[1]!.id,
  clientRequestId: "queue-intent-retry-2",
});
assert.equal(retrySecond.replayed, false);
assert.equal(retrySecond.attemptNumber, 2);
assert.equal((await database.queryOne<{ count: string }>(
  "SELECT COUNT(*)::text AS count FROM generation_runs WHERE owner_id = $1 AND project_id = $2",
  [ownerId, projectId],
))?.count, "11");

await database.query(
  "UPDATE generation_runs SET status = 'outcome_unknown', error = '需要核对', finished_at = $2 WHERE id = $1",
  [retrySecond.generationRunId, Date.now()],
);
await reconcileImageConversationRun(retrySecond.generationRunId);
const unknown = await getImageConversation(ownerId, projectId, conversation.id);
assert.equal(unknown?.rounds.find((round) => round.id === queued.round.id)?.status, "outcome_unknown");
assert.ok(unknown?.outputs.some((output) => output.status === "unknown"));
const unknownIntent = unknown?.rounds.find((round) => round.id === queued.round.id)?.intents
  .find((intent) => intent.id === failedIntents[1]!.id);
assert.ok(unknownIntent);
await assert.rejects(
  () => retryImageConversationIntent({
    ownerId,
    projectId,
    conversationId: conversation.id,
    intentId: unknownIntent!.id,
    clientRequestId: "queue-unknown-retry",
  }),
  /结果待确认/,
);

console.log("image-conversation-queue: durable intent queue, rollback, concurrency and reconciliation passed");
await database.closeDatabaseForTests();

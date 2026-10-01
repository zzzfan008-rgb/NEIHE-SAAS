import type { PoolClient } from "pg";
import { nanoid } from "nanoid";
import type {
  ImageConversationAttemptStatus,
  ImageConversationIntentStatus,
  ImageConversationOutputStatus,
  ImageConversationRoundStatus,
} from "../lib/imageConversationStore";
import { query, queryOne, transaction } from "../lib/database";

interface AttemptRow {
  id: string;
  intent_id: string;
  round_id: string;
  conversation_id: string;
  owner_id: string;
  project_id: string;
  status: ImageConversationAttemptStatus;
  generation_run_id: string | null;
}

export async function reconcileImageConversationRun(runId: string): Promise<void> {
  await transaction(async (client) => {
    // Serialize sibling completions before reading attempts, so the last writer
    // aggregates every committed status rather than overwriting a terminal round.
    await client.query(`
      SELECT c.id FROM image_conversations c
      JOIN image_conversation_attempts a ON a.conversation_id = c.id
      WHERE a.generation_run_id = $1 FOR UPDATE OF c
    `, [runId]);
    await client.query(`
      SELECT r.id FROM image_conversation_rounds r
      JOIN image_conversation_attempts a ON a.round_id = r.id
      WHERE a.generation_run_id = $1 FOR UPDATE OF r
    `, [runId]);
    const attempt = await queryOne<AttemptRow>(`
      SELECT id, intent_id, round_id, conversation_id, owner_id, project_id, status, generation_run_id
      FROM image_conversation_attempts
      WHERE generation_run_id = $1
      FOR UPDATE
    `, [runId], client);
    if (!attempt) return;
    const run = await queryOne<{ status: string; error: string | null; model: string | null }>(`
      SELECT status, error, model FROM generation_runs WHERE id = $1 FOR SHARE
    `, [runId], client);
    if (!run) return;
    const attemptStatus = mapAttemptStatus(run.status);
    await client.query(
      "UPDATE image_conversation_attempts SET status = $2, error = $3, updated_at = $4 WHERE id = $1",
      [attempt.id, attemptStatus, run.error, new Date().toISOString()],
    );
    const outputs = await query<{
      id: string;
      image: string;
      prompt: string | null;
      status: "success" | "error";
      error: string | null;
    }>(`
      SELECT id, image, prompt, status, error
      FROM generation_outputs WHERE run_id = $1 ORDER BY created_at, id
    `, [runId], client);
    for (const output of outputs) {
      const outputStatus: ImageConversationOutputStatus = output.status === "success" ? "ready" : "failed";
      await client.query(`
        INSERT INTO image_conversation_outputs (
          id, round_id, conversation_id, intent_id, owner_id, project_id,
          generation_output_id, image_ref, status, prompt, error, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (generation_output_id) DO UPDATE SET
          status = excluded.status, image_ref = excluded.image_ref,
          prompt = excluded.prompt, error = excluded.error
      `, [
        nanoid(16), attempt.round_id, attempt.conversation_id, attempt.intent_id,
        attempt.owner_id, attempt.project_id, output.id, output.image || null,
        outputStatus, output.prompt, output.error, new Date().toISOString(),
      ]);
      if (output.status === "success" && output.image) {
        await client.query(`
          INSERT INTO image_conversation_sources (
            id, conversation_id, owner_id, project_id, source_ref, source_kind, relation, created_at
          ) VALUES ($1, $2, $3, $4, $5, 'generation-output', 'generated-output', $6)
          ON CONFLICT (conversation_id, source_ref) DO NOTHING
        `, [
          nanoid(16), attempt.conversation_id, attempt.owner_id, attempt.project_id,
          `generation-output/${output.id}`, new Date().toISOString(),
        ]);
      }
    }
    if (attemptStatus !== "outcome_unknown" && outputs.length > 0) {
      await client.query("DELETE FROM image_conversation_outputs WHERE id = $1 AND generation_output_id IS NULL", [`ic-${attempt.id}`]);
    }
    if (attemptStatus === "outcome_unknown" || (outputs.length === 0 && attemptStatus === "failed")) {
      const outputStatus: ImageConversationOutputStatus = attemptStatus === "failed" ? "failed" : "unknown";
      await client.query(`
        INSERT INTO image_conversation_outputs (
          id, round_id, conversation_id, intent_id, owner_id, project_id,
          generation_output_id, image_ref, status, prompt, error, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, $7, NULL, $8, $9)
        ON CONFLICT (id) DO UPDATE SET status = excluded.status, error = excluded.error
      `, [
        `ic-${attempt.id}`, attempt.round_id, attempt.conversation_id, attempt.intent_id,
        attempt.owner_id, attempt.project_id, outputStatus, run.error ?? (outputStatus === "unknown" ? "生成结果未知，请核对状态" : "生成失败"), new Date().toISOString(),
      ]);
    }
    await updateConversationStatuses(client, attempt.round_id, attempt.conversation_id, attempt.owner_id, attempt.project_id);
  });
}

/** Read repair after authorization; never submits another provider request. */
export async function reconcileImageConversation(
  ownerId: string, projectId: string, conversationId: string,
): Promise<void> {
  const attempts = await query<{ generation_run_id: string }>(`
    SELECT generation_run_id FROM image_conversation_attempts
    WHERE owner_id = $1 AND project_id = $2 AND conversation_id = $3
      AND generation_run_id IS NOT NULL ORDER BY generation_run_id
  `, [ownerId, projectId, conversationId]);
  for (const attempt of attempts) await reconcileImageConversationRun(attempt.generation_run_id);
}

async function updateConversationStatuses(
  client: PoolClient,
  roundId: string,
  conversationId: string,
  ownerId: string,
  projectId: string,
): Promise<void> {
  const attempts = await query<{ intent_id: string; status: ImageConversationAttemptStatus }>(`
    SELECT latest.intent_id, latest.status
    FROM (
      SELECT DISTINCT ON (intent_id) intent_id, status
      FROM image_conversation_attempts
      WHERE round_id = $1 AND conversation_id = $2 AND owner_id = $3 AND project_id = $4
      ORDER BY intent_id, attempt_number DESC
    ) latest
  `, [roundId, conversationId, ownerId, projectId], client);
  const statuses = attempts.map((row) => row.status);
  for (const row of attempts) {
    const intentStatus: ImageConversationIntentStatus = row.status;
    await client.query(
      "UPDATE image_conversation_intents SET status = $2, updated_at = $3 WHERE id = $1",
      [row.intent_id, intentStatus, new Date().toISOString()],
    );
  }
  const roundStatus = deriveRoundStatus(statuses);
  await client.query(
    "UPDATE image_conversation_rounds SET status = $2, updated_at = $3 WHERE id = $1",
    [roundId, roundStatus, new Date().toISOString()],
  );
  await client.query(
    "UPDATE image_conversations SET updated_at = $2 WHERE id = $1",
    [conversationId, new Date().toISOString()],
  );
}

function mapAttemptStatus(status: string): ImageConversationAttemptStatus {
  if (status === "queued" || status === "retry_wait") return "queued";
  if (status === "running" || status === "cancel_requested") return "running";
  if (status === "succeeded" || status === "success") return "succeeded";
  if (status === "outcome_unknown") return "outcome_unknown";
  return "failed";
}

function deriveRoundStatus(statuses: ImageConversationAttemptStatus[]): ImageConversationRoundStatus {
  if (statuses.some((status) => status === "outcome_unknown")) return "outcome_unknown";
  if (statuses.some((status) => status === "running")) return "running";
  if (statuses.some((status) => status === "queued")) return "queued";
  if (statuses.some((status) => status === "failed") && statuses.some((status) => status === "succeeded")) return "partial";
  if (statuses.every((status) => status === "succeeded")) return "succeeded";
  return "failed";
}

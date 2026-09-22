import os from "node:os";
import type { PoolClient } from "pg";
import { nanoid } from "nanoid";
import type { ExecutionPlan, NodeExecution } from "../../src/types/workflow";
import { isImageModelId } from "../../src/types/imageModels";
import { imagesForSourceHandle } from "../../src/lib/workflowPorts";
import { config } from "../config";
import { db, query, queryOne, transaction } from "../lib/database";
import {
  deleteStoredImage,
  persistMediaRefWithReceipt,
  type PersistedImageReceipt,
} from "../lib/fileStore";
import { recordGenerationRequest, type GenerationRecordContext } from "../lib/generationRecords";
import type { SceneAnalyzer } from "../lib/sceneAnalysis";
import type { TryOnCandidateSelector } from "../lib/tryOnCandidateSelection";
import { ACTIVE_RUN_LIMIT } from "../lib/generationLimits";
import { lockActiveOwner } from "../lib/ownerMutation";
import { createExecutionInputFingerprint } from "../lib/executionInputFingerprint";
import { getProvider } from "../providers";
import {
  AcceptedVideoTaskPersistenceError,
  type ApiYiVideoTask,
} from "../providers/apiyiVideo";
import {
  ProviderError,
  publicProviderErrorMessage,
  sanitizedProviderDiagnostic,
} from "../providers/base";
import {
  executeStep,
  normalizedRequestedCountForStep,
  type ExecuteStepOptions,
  type ProviderResolver,
  type RunEvent,
  type StepResult,
} from "./runner";
import { reconcileImageConversationRun } from "./imageConversationReconciliation";

export type DurableRunStatus =
  | "queued"
  | "running"
  | "retry_wait"
  | "cancel_requested"
  | "cancelled"
  | "succeeded"
  | "failed"
  | "outcome_unknown";

const TERMINAL_RUN_STATUSES = new Set<DurableRunStatus>([
  "cancelled",
  "succeeded",
  "failed",
  "outcome_unknown",
]);
const DEFAULT_LEASE_MS = 45_000;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_RETRY_DELAYS_MS = [5_000, 30_000] as const;
export const MAX_AUTOMATIC_RETRIES = 2;
const CANCELLED_AFTER_START_WARNING = "取消请求未能中止已经开始的上游调用，结果已按实际返回保存";
const OUTCOME_UNKNOWN_GUIDANCE = "系统已达到最多 2 次自动重试（最多 3 次上游请求）；请核对 API易消耗记录后再决定是否手动提交，避免重复扣费";
export const DURABLE_RUN_EVENT_BATCH_SIZE = 500;
export const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export { ACTIVE_RUN_LIMIT } from "../lib/generationLimits";

export class GenerationRequestConflictError extends Error {
  constructor() {
    super("clientRequestId 已用于另一份生成请求，请重新提交");
    this.name = "GenerationRequestConflictError";
  }
}

export class ActiveRunLimitError extends Error {
  constructor() {
    super(`活动任务已达到 ${ACTIVE_RUN_LIMIT} 条上限，请等待现有任务结束后再试`);
    this.name = "ActiveRunLimitError";
  }
}

export class GenerationOwnerUnavailableError extends Error {
  constructor() {
    super("账号已停用或删除，不能创建新的生成任务");
    this.name = "GenerationOwnerUnavailableError";
  }
}

export async function assertGenerationOwnerActive(
  client: PoolClient,
  ownerId: string,
): Promise<void> {
  if (!await lockActiveOwner(client, ownerId)) {
    throw new GenerationOwnerUnavailableError();
  }
}

interface DurableRunRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  node_id: string;
  status: DurableRunStatus | "success" | "error";
  target_step_id: string | null;
  started_at: number;
  finished_at: number | null;
}

interface ClaimedJob {
  id: string;
  runId: string;
  stepId: string;
  nodeId: string;
  stepIndex: number;
  step: NodeExecution;
  retryCount: number;
  startedAt: number;
  idempotencyKey: string;
  videoTask?: ApiYiVideoTask;
}

interface JobLockRow {
  id: string;
  run_id: string;
  step_id: string;
  status: DurableRunStatus;
  retry_count: number;
  attempt_started_at: number | null;
  worker_id: string | null;
  node_id: string;
  step_index: number;
  step_json: string;
  step_started_at: number | null;
  target_step_id: string | null;
  idempotency_key: string;
  provider_task_id: string | null;
  provider_model: string | null;
}

export interface ProcessGenerationJobOptions {
  resolveProvider?: ProviderResolver;
  sceneAnalyzer?: SceneAnalyzer;
  promptEnhancer?: ExecuteStepOptions["promptEnhancer"];
  candidateSelector?: TryOnCandidateSelector;
  now?: () => number;
  retryDelaysMs?: readonly number[];
  random?: () => number;
  leaseMs?: number;
  heartbeatMs?: number;
}

export class CancelledBeforeProviderCall extends Error {
  constructor() {
    super("任务已在上游调用开始前取消");
    this.name = "CancelledBeforeProviderCall";
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status as DurableRunStatus) || status === "success" || status === "error";
}

async function lockRun(client: PoolClient, runId: string): Promise<DurableRunRow | undefined> {
  return (await client.query<DurableRunRow>(
    `SELECT id, owner_id, project_id, node_id, status, target_step_id, started_at, finished_at
     FROM generation_runs WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [runId],
  )).rows[0];
}

export async function appendRunEvent(
  client: PoolClient,
  runId: string,
  event: RunEvent,
  createdAt: number,
): Promise<RunEvent> {
  const seqRow = (await client.query<{ seq: number }>(`
    UPDATE generation_runs
    SET next_event_seq = next_event_seq + 1
    WHERE id = $1
    RETURNING next_event_seq::int AS seq
  `, [runId])).rows[0];
  if (!seqRow) throw new Error("generation run disappeared while appending an event");
  const sequenced = { ...event, seq: seqRow.seq } as RunEvent;
  await client.query(`
    INSERT INTO generation_run_events (run_id, seq, payload_json, created_at)
    VALUES ($1, $2, $3, $4)
  `, [runId, sequenced.seq, JSON.stringify(sequenced), createdAt]);
  return sequenced;
}

async function insertGenerationRun(
  client: PoolClient,
  plan: ExecutionPlan,
  ownerId: string,
  context: GenerationRecordContext,
  runType: "workflow" | "direct" = "workflow",
): Promise<{ id: string }> {
  if (!ownerId.trim() || context.userId !== ownerId) throw new Error("run owner is invalid");
  if (plan.steps.length === 0) throw new Error("execution plan has no steps");
  await assertGenerationOwnerActive(client, ownerId);
  const clientRequestId = context.clientRequestId?.trim() || undefined;
  if (clientRequestId && !CLIENT_REQUEST_ID_PATTERN.test(clientRequestId)) {
    throw new Error("clientRequestId must contain only letters, digits, underscore or hyphen");
  }
  const runId = nanoid(10);
  const createdAt = Date.now();
  const requestedTargetIndex = plan.steps.findIndex((step) => step.nodeId === context.nodeId);
  const targetIndex = requestedTargetIndex >= 0 ? requestedTargetIndex : plan.steps.length - 1;
  const stepIds = plan.steps.map(() => nanoid(12));
  const targetStep = plan.steps[targetIndex] ?? plan.steps.at(-1)!;
  const targetStepId = stepIds[targetIndex] ?? stepIds.at(-1)!;
  const initialModel = isImageModelId(targetStep.params.modelId) ? targetStep.params.modelId : null;
  const planJson = JSON.stringify(plan);
  const requestFingerprint = clientRequestId
    ? createExecutionInputFingerprint({
        runType,
        projectId: context.projectId,
        nodeId: context.nodeId,
        plan,
      })
    : null;

  // 同一用户的新任务串行通过容量门禁；幂等重放先返回旧 Run，不占新名额。
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`generation-run-owner:${ownerId}`],
  );
  if (clientRequestId) {
    const existing = (await client.query<{ id: string; request_fingerprint: string | null }>(`
      SELECT id, request_fingerprint FROM generation_runs
      WHERE owner_id = $1 AND client_request_id = $2
    `, [ownerId, clientRequestId])).rows[0];
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        throw new GenerationRequestConflictError();
      }
      return { id: existing.id };
    }
  }
  const activeCount = (await client.query<{ count: number }>(`
    SELECT COUNT(*)::int AS count FROM generation_runs
    WHERE owner_id = $1
      AND deleted_at IS NULL
      AND plan_json IS NOT NULL
      AND status IN ('queued','running','retry_wait','cancel_requested')
  `, [ownerId])).rows[0]?.count ?? 0;
  if (activeCount >= ACTIVE_RUN_LIMIT) throw new ActiveRunLimitError();

  const inserted = await client.query<{ id: string }>(`
      INSERT INTO generation_runs (
        id, owner_id, project_id, project_name, node_id, node_label, kind, prompt,
        parameters_json, reference_images_json, model, requested_count, status,
        started_at, plan_json, target_step_id, run_type, updated_at,
        client_request_id, request_fingerprint
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'queued',
        $13, $14, $15, $16, $13, $17, $18
      )
      ON CONFLICT (owner_id, client_request_id)
        WHERE client_request_id IS NOT NULL
      DO NOTHING
      RETURNING id
    `, [
      runId, ownerId, context.projectId ?? null, context.projectName ?? null,
      context.nodeId, context.nodeLabel, context.kind, context.prompt ?? null,
      JSON.stringify(context.parameters ?? {}), JSON.stringify(context.referenceImages ?? targetStep.inputImages ?? []),
      initialModel, context.requestedCount, createdAt, planJson, targetStepId, runType,
      clientRequestId ?? null, requestFingerprint,
    ]);

  if (inserted.rowCount === 0) {
    const existing = (await client.query<{ id: string; request_fingerprint: string | null }>(`
      SELECT id, request_fingerprint FROM generation_runs
      WHERE owner_id = $1 AND client_request_id = $2
    `, [ownerId, clientRequestId])).rows[0];
    if (!existing || existing.request_fingerprint !== requestFingerprint) {
      throw new GenerationRequestConflictError();
    }
    return { id: existing.id };
  }

  for (const [index, step] of plan.steps.entries()) {
    const stepId = stepIds[index];
    const model = isImageModelId(step.params.modelId) ? step.params.modelId : null;
    await client.query(`
        INSERT INTO generation_run_steps (
          id, run_id, step_index, node_id, kind, step_json, status, model
        ) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7)
      `, [stepId, runId, index, step.nodeId, step.kind, JSON.stringify(step), model]);
    await client.query(`
        INSERT INTO generation_jobs (
          id, run_id, step_id, idempotency_key, status, retry_count, available_at,
          run_started_at, step_index, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 'queued', 0, $5, $5, $6, $5, $5)
      `, [nanoid(12), runId, stepId, `${runId}:${stepId}`, createdAt, index]);
    await appendRunEvent(client, runId, {
      type: "node-status", nodeId: step.nodeId, status: "queued", startedAt: createdAt,
    }, createdAt);
  }
  return { id: runId };
}

export async function enqueueGenerationRunInTransaction(
  client: PoolClient,
  plan: ExecutionPlan,
  ownerId: string,
  context: GenerationRecordContext,
  runType: "workflow" | "direct" = "workflow",
): Promise<{ id: string }> {
  return insertGenerationRun(client, plan, ownerId, context, runType);
}

export async function enqueueGenerationRun(
  plan: ExecutionPlan,
  ownerId: string,
  context: GenerationRecordContext,
  runType: "workflow" | "direct" = "workflow",
): Promise<{ id: string }> {
  return transaction((client) => insertGenerationRun(client, plan, ownerId, context, runType));
}

export const CLAIM_NEXT_JOB_SQL = `
  SELECT j.id, j.run_id, j.step_id, j.status, j.retry_count, j.attempt_started_at, j.worker_id,
    j.idempotency_key, j.provider_task_id, j.provider_model,
    s.node_id, s.step_index, s.step_json, s.started_at AS step_started_at, r.target_step_id
  FROM generation_jobs j
  JOIN generation_run_steps s ON s.id = j.step_id
  JOIN generation_runs r ON r.id = j.run_id
  WHERE j.status IN ('queued','retry_wait')
    AND j.available_at <= $1
    AND r.deleted_at IS NULL
    AND r.status IN ('queued','running','retry_wait')
    AND NOT EXISTS (
      SELECT 1 FROM generation_jobs previous
      WHERE previous.run_id = j.run_id
        AND previous.step_index < j.step_index
        AND previous.status <> 'succeeded'
    )
  ORDER BY j.available_at, j.run_started_at, j.step_index, j.id
  FOR UPDATE OF j SKIP LOCKED
  LIMIT 1
`;

export async function claimNextJob(
  workerId: string,
  now: number,
  leaseMs: number,
): Promise<ClaimedJob | undefined> {
  return transaction(async (client) => {
    const row = (await client.query<JobLockRow>(CLAIM_NEXT_JOB_SQL, [now])).rows[0];
    if (!row) return undefined;
    const run = await lockRun(client, row.run_id);
    if (!run || isTerminalRunStatus(run.status) || run.status === "cancel_requested") return undefined;
    const step = parseJson<NodeExecution | undefined>(row.step_json, undefined);
    if (!step) throw new Error("generation step payload is invalid");
    if (row.step_id === row.target_step_id && step.kind === "fabric-recolor") {
      await client.query(`
        UPDATE generation_runs SET requested_count = $1
        WHERE id = $2 AND requested_count <> $1
      `, [normalizedRequestedCountForStep(step.kind, step.params), row.run_id]);
    }
    await client.query(`
      UPDATE generation_jobs SET status = 'running', worker_id = $1, lease_expires_at = $2,
        attempt_started_at = NULL, updated_at = $3 WHERE id = $4
    `, [workerId, now + leaseMs, now, row.id]);
    await client.query(`
      UPDATE generation_run_steps SET status = 'running', started_at = COALESCE(started_at, $1), error = NULL
      WHERE id = $2
    `, [now, row.step_id]);
    await client.query(
      "UPDATE generation_runs SET status = 'running', updated_at = $1 WHERE id = $2",
      [now, row.run_id],
    );
    await appendRunEvent(client, row.run_id, {
      type: "node-status", nodeId: row.node_id, status: "running", startedAt: now,
    }, now);
    return {
      id: row.id,
      runId: row.run_id,
      stepId: row.step_id,
      nodeId: row.node_id,
      stepIndex: row.step_index,
      step,
      retryCount: row.retry_count,
      startedAt: now,
      idempotencyKey: row.idempotency_key,
      videoTask: row.provider_task_id && row.provider_model
        ? { id: row.provider_task_id, model: row.provider_model as ApiYiVideoTask["model"] }
        : undefined,
    };
  });
}

interface StepInputPayload {
  images: string[];
  referenceRoles?: string[];
}

async function inputImagesForStep(runId: string, step: NodeExecution): Promise<StepInputPayload> {
  if (!step.upstream?.length) return { images: step.inputImages };
  const rows = await query<{ node_id: string; output_images_json: string }>(`
    SELECT node_id, output_images_json FROM generation_run_steps
    WHERE run_id = $1 AND status = 'succeeded'
  `, [runId]);
  const outputs = new Map(rows.map((row) => [row.node_id, parseJson<string[]>(row.output_images_json, [])]));
  const selfImages = step.kind === "background-extract"
    && typeof step.params.imageUrl === "string" && step.params.imageUrl.trim()
    ? [step.params.imageUrl]
    : [];
  const images: string[] = [...selfImages];
  const referenceRoles: string[] = selfImages.map(() => "references");
  for (const upstream of step.upstream) {
    const runtimeImages = outputs.get(upstream.nodeId);
    const resolvedImages = runtimeImages
      ? imagesForSourceHandle(runtimeImages, upstream.sourceHandle)
      : upstream.images;
    images.push(...resolvedImages);
    referenceRoles.push(...resolvedImages.map(() => upstream.targetHandle ?? ""));
  }
  return { images, referenceRoles };
}

async function markAttemptStarted(
  job: ClaimedJob,
  workerId: string,
  now: number,
  leaseMs: number,
): Promise<void> {
  await transaction(async (client) => {
    const row = (await client.query<{ status: DurableRunStatus; worker_id: string | null }>(`
      SELECT j.status, j.worker_id FROM generation_jobs j
      JOIN generation_runs r ON r.id = j.run_id
      WHERE j.id = $1 AND r.deleted_at IS NULL
      FOR UPDATE OF j
    `,
      [job.id],
    )).rows[0];
    if (!row || row.worker_id !== workerId) throw new Error("generation job lease was lost");
    if (row.status === "cancel_requested") throw new CancelledBeforeProviderCall();
    if (row.status !== "running") throw new Error(`generation job is ${row.status}`);
    await client.query(`
      UPDATE generation_jobs SET attempt_started_at = COALESCE(attempt_started_at, $1),
        lease_expires_at = $2, updated_at = $1 WHERE id = $3
    `, [now, now + leaseMs, job.id]);
    await client.query(`
      UPDATE generation_run_steps SET provider_requests = provider_requests + 1 WHERE id = $1
    `, [job.stepId]);
  });
}

async function markVideoTaskAccepted(
  job: ClaimedJob,
  workerId: string,
  task: ApiYiVideoTask,
  now: number,
  leaseMs: number,
): Promise<void> {
  await transaction(async (client) => {
    const row = (await client.query<{
      status: DurableRunStatus;
      worker_id: string | null;
      provider_task_id: string | null;
      provider_model: string | null;
    }>(`
      SELECT status, worker_id, provider_task_id, provider_model
      FROM generation_jobs WHERE id = $1 FOR UPDATE
    `, [job.id])).rows[0];
    if (!row || row.worker_id !== workerId || row.status !== "running") {
      throw new Error("generation job lease was lost before provider task persistence");
    }
    if (
      (row.provider_task_id && row.provider_task_id !== task.id)
      || (row.provider_model && row.provider_model !== task.model)
    ) {
      throw new Error("generation job provider task changed unexpectedly");
    }
    await client.query(`
      UPDATE generation_jobs
      SET provider_task_id = $1, provider_model = $2, lease_expires_at = $3, updated_at = $4
      WHERE id = $5
    `, [task.id, task.model, now + leaseMs, now, job.id]);
  });
}

async function assertJobOwnedForCompletion(job: ClaimedJob, workerId: string): Promise<void> {
  const row = await queryOne<{ status: DurableRunStatus; worker_id: string | null }>(`
    SELECT j.status, j.worker_id FROM generation_jobs j
    JOIN generation_runs r ON r.id = j.run_id
    WHERE j.id = $1 AND r.deleted_at IS NULL
  `,
    [job.id],
  );
  if (
    !row ||
    row.worker_id !== workerId ||
    (row.status !== "running" && row.status !== "cancel_requested")
  ) {
    throw new Error("generation job lease was lost before image persistence");
  }
}

async function persistStepImages(
  images: string[],
  job: ClaimedJob,
): Promise<PersistedImageReceipt[]> {
  const persisted: PersistedImageReceipt[] = [];
  try {
    for (const [index, image] of images.entries()) {
      persisted.push(await persistMediaRefWithReceipt(image, `${job.runId}:${job.stepId}:${index}`));
    }
    return persisted;
  } catch (error) {
    for (const receipt of persisted) {
      if (receipt.created) deleteStoredImage(receipt.id);
    }
    throw error;
  }
}

async function compensatePersistedImages(
  persisted: PersistedImageReceipt[],
  job: ClaimedJob,
  workerId: string,
): Promise<void> {
  const owner = await queryOne<{ status: DurableRunStatus; worker_id: string | null }>(
    "SELECT status, worker_id FROM generation_jobs WHERE id = $1",
    [job.id],
  ).catch(() => undefined);
  if (
    owner &&
    owner.worker_id !== workerId &&
    (owner.status === "running" || owner.status === "cancel_requested")
  ) {
    return;
  }
  for (const receipt of persisted) {
    if (!receipt.created) continue;
    const registered = await queryOne<{ id: string }>("SELECT id FROM files WHERE id = $1", [receipt.id])
      .catch(() => ({ id: receipt.id }));
    if (!registered) deleteStoredImage(receipt.id);
  }
}

async function compensateUnregisteredImage(receipt: PersistedImageReceipt): Promise<void> {
  if (!receipt.created) return;
  const registered = await queryOne<{ id: string }>("SELECT id FROM files WHERE id = $1", [receipt.id])
    .catch(() => ({ id: receipt.id }));
  if (!registered) deleteStoredImage(receipt.id);
}

async function checkpointStyling(job:ClaimedJob,workerId:string,ordinal:number,image:string,prompt:string,model:string):Promise<string> {
  // Worker-scoped staging prevents a successor from reusing a file that this worker may compensate.
  const receipt=await persistMediaRefWithReceipt(image,`${job.runId}:${job.stepId}:styling:${ordinal}:${workerId}`);
  try {
    await transaction(async client=>{
      const locked=await queryOne<{worker_id:string;status:string}>('SELECT worker_id,status FROM generation_jobs WHERE id=$1 FOR UPDATE',[job.id],client);
      if(!locked||locked.worker_id!==workerId||!['running','cancel_requested'].includes(locked.status)) throw new Error('generation job lease was lost');
      const run=await lockRun(client,job.runId);
      if(!run||isTerminalRunStatus(run.status)) throw new Error('generation run unavailable');
      const now=Date.now();
      await client.query('INSERT INTO styling_checkpoints(step_id,ordinal,image,prompt,model,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(step_id,ordinal) DO NOTHING',[job.stepId,ordinal,receipt.url,prompt,model,now]);
      await client.query("INSERT INTO files(id,owner_id,source_type,project_id,node_id,run_id,created_at) VALUES($1,$2,'generated',$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING",[receipt.id,run.owner_id,run.project_id,job.nodeId,run.id,new Date(now).toISOString()]);
      const rows=await query<{image:string;prompt:string}>('SELECT image,prompt FROM styling_checkpoints WHERE step_id=$1 ORDER BY ordinal',[job.stepId],client);
      const meta={styling:{completed:rows.length,total:Number(job.step.params.batchSize)}};
      await client.query('UPDATE generation_run_steps SET output_images_json=$2,prompts_json=$3,model=$4,execution_meta_json=$5 WHERE id=$1',[job.stepId,JSON.stringify(rows.map(r=>r.image)),JSON.stringify(rows.map(r=>r.prompt)),model,JSON.stringify(meta)]);
      await client.query('UPDATE generation_jobs SET attempt_started_at=NULL WHERE id=$1',[job.id]);
      await client.query("INSERT INTO generation_outputs(id,run_id,image,prompt,status,created_at) VALUES($1,$2,$3,$4,'success',$5)",[nanoid(12),run.id,receipt.url,prompt,now]);
      await client.query('UPDATE generation_runs SET successful_count=$2,model=$3,updated_at=$4 WHERE id=$1',[run.id,rows.length,model,now]);
      await appendRunEvent(client,run.id,{type:'node-status',nodeId:job.nodeId,status:'running',images:rows.map(r=>r.image),prompts:rows.map(r=>r.prompt),model,executionMeta:meta},now);
    });
  } catch (error) {
    await compensateUnregisteredImage(receipt);
    throw error;
  }
  return receipt.url;
}

async function finalizeSuccessfulRun(
  client: PoolClient,
  run: DurableRunRow,
  finishedAt: number,
  cancellationWarning?: string,
): Promise<void> {
  const target = run.target_step_id
      ? (await client.query<{
        output_images_json: string; prompts_json: string; provider_output_sizes_json: string;
        failures_json: string; model: string | null; error: string | null;
      }>(`
        SELECT output_images_json, prompts_json, provider_output_sizes_json, failures_json, model, error
        FROM generation_run_steps WHERE id = $1
      `, [run.target_step_id])).rows[0]
    : undefined;
  const images = parseJson<string[]>(target?.output_images_json ?? "[]", []);
  const prompts = parseJson<string[]>(target?.prompts_json ?? "[]", []);
  const providerOutputSizes = parseJson<Array<string | null>>(target?.provider_output_sizes_json ?? "[]", []);
  const failures = parseJson<Array<{ prompt?: string; error: string }>>(target?.failures_json ?? "[]", []);
  const aggregate = (await client.query<{ provider_requests: number; model: string | null }>(`
    SELECT COALESCE(SUM(provider_requests), 0)::int AS provider_requests,
      (ARRAY_AGG(model ORDER BY step_index DESC) FILTER (WHERE model IS NOT NULL))[1] AS model
    FROM generation_run_steps WHERE run_id = $1
  `, [run.id])).rows[0];
  await client.query("DELETE FROM generation_outputs WHERE run_id = $1", [run.id]);
  for (const [index, image] of images.entries()) {
    await client.query(`
      INSERT INTO generation_outputs (
        id, run_id, image, prompt, provider_output_size, status, error, created_at
      ) VALUES ($1, $2, $3, $4, $5, 'success', NULL, $6)
    `, [
      nanoid(12), run.id, image, prompts[index] ?? null,
      providerOutputSizes[index] ?? null, finishedAt + index,
    ]);
  }
  for (const [index, failure] of failures.entries()) {
    await client.query(`
      INSERT INTO generation_outputs (id, run_id, image, prompt, status, error, created_at)
      VALUES ($1, $2, '', $3, 'error', $4, $5)
    `, [nanoid(12), run.id, failure.prompt ?? null, failure.error, finishedAt + images.length + index]);
  }
  const warning = cancellationWarning ?? target?.error ?? (failures.length ? `${failures.length} 个生成任务失败` : null);
  const model = target?.model ?? aggregate?.model ?? null;
  const providerRequests = aggregate?.provider_requests ?? 0;
  await client.query(`
    UPDATE generation_runs SET status = 'succeeded', successful_count = $1, provider_requests = $2,
      model = $3, error = $4, finished_at = $5, updated_at = $5 WHERE id = $6
  `, [images.length, providerRequests, model, warning, finishedAt, run.id]);
  if (images.length > 0) {
    await client.query(`
      INSERT INTO usage_events (
        id, owner_id, run_id, project_id, node_id, model, successful_count,
        provider_requests, duration_ms, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (run_id) DO UPDATE SET
        model = excluded.model, successful_count = excluded.successful_count,
        provider_requests = excluded.provider_requests, duration_ms = excluded.duration_ms,
        created_at = excluded.created_at
    `, [
      nanoid(12), run.owner_id, run.id, run.project_id, run.node_id, model, images.length,
      providerRequests, Math.max(0, finishedAt - run.started_at), new Date(finishedAt).toISOString(),
    ]);
  }
  await appendRunEvent(client, run.id, { type: "done" }, finishedAt);
}

async function finalizeCancelledTargetRun(
  client: PoolClient,
  run: DurableRunRow,
  targetNodeId: string,
  message: string,
  finishedAt: number,
): Promise<void> {
  const aggregate = (await client.query<{ provider_requests: number; model: string | null }>(`
    SELECT COALESCE(SUM(provider_requests), 0)::int AS provider_requests,
      (ARRAY_AGG(model ORDER BY step_index DESC) FILTER (WHERE model IS NOT NULL))[1] AS model
    FROM generation_run_steps WHERE run_id = $1
  `, [run.id])).rows[0];
  await client.query("DELETE FROM generation_outputs WHERE run_id = $1", [run.id]);
  await client.query(`
    UPDATE generation_runs SET status = 'cancelled', successful_count = 0, provider_requests = $1,
      model = $2, error = $3, finished_at = $4, updated_at = $4 WHERE id = $5
  `, [aggregate?.provider_requests ?? 0, aggregate?.model ?? null, message, finishedAt, run.id]);
  await appendRunEvent(client, run.id, {
    type: "node-status", nodeId: targetNodeId, status: "cancelled", error: message, finishedAt,
  }, finishedAt);
  await appendRunEvent(client, run.id, { type: "done" }, finishedAt);
}

async function completeJobSuccess(
  job: ClaimedJob,
  workerId: string,
  result: StepResult,
  persistedImages: PersistedImageReceipt[],
  finishedAt: number,
): Promise<void> {
  const allImageUrls = persistedImages.map((image) => image.url);
  const selectedIndex = result.candidateSelection?.selectedIndex;
  const visibleImages = selectedIndex === undefined
    ? allImageUrls
    : selectedIndex === null || !allImageUrls[selectedIndex]
      ? []
      : [allImageUrls[selectedIndex]];
  const visiblePrompts = selectedIndex === undefined
    ? result.prompts
    : selectedIndex === null
      ? []
      : result.prompts?.[selectedIndex] ? [result.prompts[selectedIndex]] : undefined;
  const visibleOutputSizes = selectedIndex === undefined
    ? result.providerOutputSizes
    : selectedIndex === null
      ? []
      : result.providerOutputSizes?.[selectedIndex] !== undefined
        ? [result.providerOutputSizes[selectedIndex]]
        : undefined;
  if (result.candidateSelection && visibleImages.length !== 1) {
    throw new Error("候选择优结果与持久化图片不一致");
  }
  await transaction(async (client) => {
    const locked = (await client.query<{ status: DurableRunStatus; worker_id: string | null }>(
      "SELECT status, worker_id FROM generation_jobs WHERE id = $1 FOR UPDATE",
      [job.id],
    )).rows[0];
    if (
      !locked ||
      locked.worker_id !== workerId ||
      (locked.status !== "running" && locked.status !== "cancel_requested")
    ) {
      throw new Error("generation job lease was lost before completion");
    }
    const run = await lockRun(client, job.runId);
    if (!run) throw new Error("generation run disappeared");
    const cancellationWarning = locked.status === "cancel_requested" ? CANCELLED_AFTER_START_WARNING : undefined;
    await client.query(`
      UPDATE generation_jobs SET status = 'succeeded', worker_id = NULL, lease_expires_at = NULL,
        updated_at = $1, last_error = NULL WHERE id = $2
    `, [finishedAt, job.id]);
    await client.query(`
      UPDATE generation_run_steps SET status = 'succeeded', model = $1, output_images_json = $2,
        prompts_json = $3, provider_output_sizes_json = $4, failures_json = $5,
        execution_meta_json = $6, error = $7, finished_at = $8
      WHERE id = $9
    `, [
      result.model ?? null, JSON.stringify(visibleImages), JSON.stringify(visiblePrompts ?? []),
      JSON.stringify(visibleOutputSizes ?? []), JSON.stringify(result.failures ?? []),
      JSON.stringify(result.executionMeta ?? {}), cancellationWarning ?? result.warning ?? null, finishedAt, job.stepId,
    ]);
    for (const image of persistedImages) {
      if (!image.url.startsWith("/api/files/")) continue;
      await client.query(`
        INSERT INTO files (id, owner_id, source_type, project_id, node_id, run_id, created_at)
        VALUES ($1, $2, 'generated', $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING
      `, [image.id, run.owner_id, run.project_id, job.nodeId, run.id, new Date(finishedAt).toISOString()]);
    }
    const partialWarning = result.failures?.length ? `${result.failures.length} 个生成任务失败` : undefined;
    await appendRunEvent(client, run.id, {
      type: "node-status",
      nodeId: job.nodeId,
      status: "success",
      images: visibleImages,
      model: result.model,
      prompts: visiblePrompts,
      providerOutputSizes: visibleOutputSizes,
      failures: result.failures,
      executionMeta: result.executionMeta,
      error: cancellationWarning ?? result.warning ?? partialWarning,
      startedAt: job.startedAt,
      finishedAt,
    }, finishedAt);

    if (cancellationWarning) {
      await client.query(`
        UPDATE generation_jobs SET status = 'cancelled', worker_id = NULL, lease_expires_at = NULL, updated_at = $1
        WHERE run_id = $2 AND status IN ('queued','retry_wait','cancel_requested')
      `, [finishedAt, run.id]);
      await client.query(`
        UPDATE generation_run_steps SET status = 'cancelled', finished_at = $1, error = '用户取消了后续步骤'
        WHERE run_id = $2 AND status IN ('queued','retry_wait','cancel_requested')
      `, [finishedAt, run.id]);
    }

    const active = (await client.query<{ count: number }>(`
      SELECT COUNT(*)::int AS count FROM generation_jobs
      WHERE run_id = $1 AND status IN ('queued','running','retry_wait','cancel_requested')
    `, [run.id])).rows[0]?.count ?? 0;
    if (active === 0) {
      const target = run.target_step_id
        ? (await client.query<{ status: DurableRunStatus; node_id: string; error: string | null }>(`
            SELECT status, node_id, error FROM generation_run_steps WHERE id = $1
          `, [run.target_step_id])).rows[0]
        : undefined;
      if (target?.status === "cancelled") {
        await finalizeCancelledTargetRun(
          client,
          run,
          target.node_id,
          target.error ?? "用户取消了目标步骤",
          finishedAt,
        );
      } else if (target?.status === "succeeded" || !target) {
        await finalizeSuccessfulRun(client, run, finishedAt, cancellationWarning);
      } else {
        throw new Error(`generation target step ended as ${target.status}`);
      }
    } else {
      await client.query("UPDATE generation_runs SET status = 'running', updated_at = $1 WHERE id = $2", [finishedAt, run.id]);
    }
  });
}

function isRetryableProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError && (
    error.category === "image_safety" ||
    error.status === 429 ||
    (error.status === 503 && error.category === "gateway_unavailable")
  );
}

function outcomeUnknownMessage(message: string): string {
  return message.includes("API易消耗记录") ? message : `${message}；${OUTCOME_UNKNOWN_GUIDANCE}`;
}

async function scheduleAutomaticRetry(
  client: PoolClient,
  row: JobLockRow,
  message: string,
  now: number,
  options: Pick<ProcessGenerationJobOptions, "retryDelaysMs" | "random">,
): Promise<boolean> {
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const maxRetries = Math.min(retryDelays.length, MAX_AUTOMATIC_RETRIES);
  if (row.retry_count >= maxRetries) return false;

  const retryNumber = row.retry_count + 1;
  const baseDelay = retryDelays[row.retry_count] ?? DEFAULT_RETRY_DELAYS_MS[row.retry_count] ?? 0;
  const jitter = Math.floor((options.random?.() ?? Math.random()) * 1_000);
  const availableAt = now + Math.max(0, baseDelay) + jitter;
  console.warn("[generation-job-retry]", JSON.stringify({
    runId: row.run_id, nodeId: row.node_id, retryCount: retryNumber,
    delayMs: Math.max(0, baseDelay) + jitter, exhausted: false,
  }));
  await lockRun(client, row.run_id);
  await client.query(`
    UPDATE generation_jobs SET status = 'retry_wait', retry_count = $1, available_at = $2,
      worker_id = NULL, lease_expires_at = NULL, attempt_started_at = NULL, last_error = $3, updated_at = $4
    WHERE id = $5
  `, [retryNumber, availableAt, message, now, row.id]);
  await client.query(`
    UPDATE generation_run_steps SET status = 'retry_wait', error = $1 WHERE id = $2
  `, [message, row.step_id]);
  await client.query("UPDATE generation_runs SET status = 'retry_wait', error = $1, updated_at = $2 WHERE id = $3", [
    message, now, row.run_id,
  ]);
  await appendRunEvent(client, row.run_id, {
    type: "node-status", nodeId: row.node_id, status: "retry_wait", error: message,
    startedAt: row.step_started_at ?? undefined,
  }, now);
  return true;
}

async function terminateRun(
  client: PoolClient,
  row: JobLockRow,
  status: "failed" | "outcome_unknown" | "cancelled",
  message: string,
  finishedAt: number,
): Promise<void> {
  const run = await lockRun(client, row.run_id);
  if (!run || isTerminalRunStatus(run.status)) return;
  await client.query(`
    UPDATE generation_jobs SET status = $1, worker_id = NULL, lease_expires_at = NULL,
      last_error = $2, updated_at = $3 WHERE id = $4
  `, [status, message, finishedAt, row.id]);
  await client.query(`
    UPDATE generation_run_steps SET status = $1, error = $2, finished_at = $3 WHERE id = $4
  `, [status, message, finishedAt, row.step_id]);
  await client.query(`
    UPDATE generation_jobs SET status = 'cancelled', worker_id = NULL, lease_expires_at = NULL,
      last_error = $1, updated_at = $2
    WHERE run_id = $3 AND id <> $4 AND status IN ('queued','retry_wait','cancel_requested')
  `, ["上游步骤未完成，后续任务已停止", finishedAt, row.run_id, row.id]);
  await client.query(`
    UPDATE generation_run_steps SET status = 'cancelled', error = $1, finished_at = $2
    WHERE run_id = $3 AND id <> $4 AND status IN ('queued','retry_wait','cancel_requested')
  `, ["上游步骤未完成，后续任务已停止", finishedAt, row.run_id, row.step_id]);
  const aggregate = (await client.query<{ provider_requests: number; model: string | null }>(`
    SELECT COALESCE(SUM(provider_requests), 0)::int AS provider_requests,
      (ARRAY_AGG(model ORDER BY step_index DESC) FILTER (WHERE model IS NOT NULL))[1] AS model
    FROM generation_run_steps WHERE run_id = $1
  `, [row.run_id])).rows[0];
  await client.query(`
    UPDATE generation_runs SET status = $1, error = $2, provider_requests = $3,
      model = COALESCE($4, model), finished_at = $5, updated_at = $5 WHERE id = $6
  `, [status, message, aggregate?.provider_requests ?? 0, aggregate?.model ?? null, finishedAt, row.run_id]);
  const stylingRows=await query<{image:string;prompt:string}>('SELECT image,prompt FROM styling_checkpoints WHERE step_id=$1 ORDER BY ordinal',[row.step_id],client);
  if(!stylingRows.length) await client.query("DELETE FROM generation_outputs WHERE run_id = $1", [row.run_id]);
  else {
    await client.query('UPDATE generation_runs SET successful_count=$2 WHERE id=$1',[row.run_id,stylingRows.length]);
    await client.query(`INSERT INTO usage_events(id,owner_id,run_id,project_id,node_id,model,successful_count,provider_requests,duration_ms,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(run_id) DO UPDATE SET successful_count=excluded.successful_count,provider_requests=excluded.provider_requests`,
      [nanoid(12),run.owner_id,run.id,run.project_id,run.node_id,aggregate?.model??null,stylingRows.length,aggregate?.provider_requests??0,Math.max(0,finishedAt-run.started_at),new Date(finishedAt).toISOString()]);
  }
  if (status === "failed") {
    await client.query(`
      INSERT INTO generation_outputs (id, run_id, image, status, error, created_at)
      VALUES ($1, $2, '', 'error', $3, $4)
    `, [nanoid(12), row.run_id, message, finishedAt]);
  }
  const clientStatus = status === "failed" ? "error" : status;
  await appendRunEvent(client, row.run_id, {
    type: "node-status", nodeId: row.node_id, status: clientStatus, error: message,
    ...(stylingRows.length?{images:stylingRows.map(r=>r.image),prompts:stylingRows.map(r=>r.prompt),executionMeta:{styling:{completed:stylingRows.length,total:Number(parseJson<NodeExecution>(row.step_json,{params:{}} as NodeExecution).params.batchSize)}}}:{}),
    startedAt: row.step_started_at ?? undefined, finishedAt,
  } as RunEvent, finishedAt);
  if (status === "failed") {
    await appendRunEvent(client, row.run_id, {
      type: "run-error", nodeId: row.node_id, error: message, finishedAt,
    }, finishedAt);
  } else {
    await appendRunEvent(client, row.run_id, { type: "done" }, finishedAt);
  }
}

async function handleJobError(
  job: ClaimedJob,
  workerId: string,
  error: unknown,
  options: ProcessGenerationJobOptions,
): Promise<void> {
  const now = options.now?.() ?? Date.now();
  const message = error instanceof CancelledBeforeProviderCall
    ? error.message
    : error instanceof ProviderError
      ? publicProviderErrorMessage(error)
      : error instanceof Error ? error.message : String(error);
  if (error instanceof ProviderError) {
    console.error("[ai-provider-worker-failure]", JSON.stringify({
      runId: job.runId, nodeId: job.nodeId, providerId: error.providerId, status: error.status ?? null,
      category: error.category, retryCount: job.retryCount, diagnostic: sanitizedProviderDiagnostic(error) ?? error.message,
    }));
  }
  await transaction(async (client) => {
    const row = (await client.query<JobLockRow>(`
      SELECT j.id, j.run_id, j.step_id, j.status, j.retry_count, j.attempt_started_at, j.worker_id,
        j.idempotency_key, j.provider_task_id, j.provider_model,
        s.node_id, s.step_index, s.step_json, s.started_at AS step_started_at, r.target_step_id
      FROM generation_jobs j JOIN generation_run_steps s ON s.id = j.step_id
      JOIN generation_runs r ON r.id = j.run_id
      WHERE j.id = $1 AND r.deleted_at IS NULL FOR UPDATE OF j
    `, [job.id])).rows[0];
    if (!row || (row.worker_id !== workerId && row.status !== "cancel_requested")) return;
    if (error instanceof CancelledBeforeProviderCall) {
      await terminateRun(client, row, "cancelled", message, now);
      return;
    }
    if (row.status === "cancel_requested") {
      await terminateRun(client, row, "cancelled", "用户取消了任务，系统未继续重试", now);
      return;
    }
    if (error instanceof AcceptedVideoTaskPersistenceError) {
      await terminateRun(client, row, "outcome_unknown", message, now);
      return;
    }
    const failedStep = parseJson<NodeExecution | undefined>(row.step_json, undefined);
    if(failedStep?.kind==='ai-styling') {
      // An uncertain paid call, including a failed checkpoint commit, cannot be replayed.
      const uncertain=error instanceof ProviderError?error.category==='outcome_unknown':row.attempt_started_at!==null;
      await terminateRun(client,row,uncertain?'outcome_unknown':'failed',uncertain?'搭配结果未知，已暂停后续请求，未自动重试':message,now);
      return;
    }
    const gpt25 = String(failedStep?.params.modelId ?? "").startsWith("gpt-image-2.5-")
      || error instanceof ProviderError && Boolean(error.providerId?.startsWith("gpt-image-2.5-"));
    if (gpt25 && error instanceof ProviderError && error.category === "outcome_unknown") {
      await terminateRun(client, row, "outcome_unknown",
        "GPT Image 2.5 请求超时或连接中断，结果未知；未自动重试。请先核对 API易消耗记录，避免重复扣费", now);
      return;
    }
    const automaticallyRetryable = isRetryableProviderError(error) || (
      error instanceof ProviderError && error.category === "outcome_unknown"
    );
    if (automaticallyRetryable && await scheduleAutomaticRetry(client, row, message, now, options)) {
      return;
    }
    if (automaticallyRetryable) {
      console.warn("[generation-job-retry]", JSON.stringify({
        runId: row.run_id, nodeId: row.node_id, retryCount: row.retry_count,
        delayMs: null, exhausted: true,
      }));
    }
    if (error instanceof ProviderError && error.category === "outcome_unknown") {
      await terminateRun(client, row, "outcome_unknown", outcomeUnknownMessage(message), now);
      return;
    }
    await terminateRun(client, row, "failed", message, now);
  });
}

export async function recoverExpiredGenerationJobs(now = Date.now()): Promise<number> {
  const recovered = await transaction(async (client) => {
    const rows = (await client.query<JobLockRow>(`
      SELECT j.id, j.run_id, j.step_id, j.status, j.retry_count, j.attempt_started_at, j.worker_id,
        j.idempotency_key, j.provider_task_id, j.provider_model,
        s.node_id, s.step_index, s.step_json, s.started_at AS step_started_at, r.target_step_id
      FROM generation_jobs j JOIN generation_run_steps s ON s.id = j.step_id
      JOIN generation_runs r ON r.id = j.run_id
      WHERE j.status IN ('running','cancel_requested')
        AND j.lease_expires_at < $1
        AND r.deleted_at IS NULL
      ORDER BY j.lease_expires_at ASC FOR UPDATE OF j SKIP LOCKED LIMIT 50
    `, [now])).rows;
    for (const row of rows) {
      if (row.attempt_started_at !== null) {
        const step = parseJson<NodeExecution | undefined>(row.step_json, undefined);
        if(step?.kind==='ai-styling') {
          await terminateRun(client,row,'outcome_unknown','搭配请求后 Worker 中断，已保留成功方案并停止后续请求',now);
          continue;
        }
        if (step?.kind === "video-generate" && !row.provider_task_id) {
          await terminateRun(
            client,
            row,
            "outcome_unknown",
            outcomeUnknownMessage("Worker 在视频任务受理状态落库前中断，系统已禁止自动重提"),
            now,
          );
          continue;
        }
        const modelId = step?.params.modelId === "gemini-3.1-flash-image-preview"
          ? "gemini-3.1-flash-image" : step?.params.modelId;
        // 缺省或无效图片模型由 runner 回退到 2.5；恢复不能重放可能已计费的请求。
        if (step?.kind !== "video-generate" && (
          !isImageModelId(modelId) || modelId.startsWith("gpt-image-2.5-")
        )) {
          await terminateRun(client, row, "outcome_unknown",
            outcomeUnknownMessage("Worker 在 GPT Image 2.5 调用后中断，系统已禁止自动重提"), now);
          continue;
        }
        if (row.status !== "cancel_requested" && await scheduleAutomaticRetry(
          client,
          row,
          "Worker 在上游调用开始后中断，结果可能已经生成；系统将按上限自动重试，可能产生重复扣费",
          now,
          {},
        )) {
          continue;
        }
        await terminateRun(
          client, row, "outcome_unknown",
          outcomeUnknownMessage("Worker 在上游调用开始后中断，结果可能已经生成"), now,
        );
        continue;
      }
      if (row.status === "cancel_requested") {
        await terminateRun(client, row, "cancelled", "任务已在上游调用开始前取消", now);
        continue;
      }
      await lockRun(client, row.run_id);
      await client.query(`
        UPDATE generation_jobs SET status = 'queued', worker_id = NULL, lease_expires_at = NULL,
          available_at = $1, updated_at = $1 WHERE id = $2
      `, [now, row.id]);
      await client.query("UPDATE generation_run_steps SET status = 'queued', error = NULL WHERE id = $1", [row.step_id]);
      await client.query("UPDATE generation_runs SET status = 'queued', error = NULL, updated_at = $1 WHERE id = $2", [now, row.run_id]);
      await appendRunEvent(client, row.run_id, {
        type: "node-status", nodeId: row.node_id, status: "queued",
        error: "Worker 租约过期，任务已安全重新排队",
      }, now);
    }
    return rows.length;
  });
  // Include previous recovery commits whose process died before reconciliation.
  const pending = await query<{ generation_run_id: string }>(`
    SELECT a.generation_run_id FROM image_conversation_attempts a
    JOIN generation_runs r ON r.id = a.generation_run_id
    WHERE a.status <> CASE
      WHEN r.status IN ('queued', 'retry_wait') THEN 'queued'
      WHEN r.status IN ('running', 'cancel_requested') THEN 'running'
      WHEN r.status IN ('succeeded', 'success') THEN 'succeeded'
      WHEN r.status = 'outcome_unknown' THEN 'outcome_unknown'
      ELSE 'failed' END
    ORDER BY a.generation_run_id
  `);
  for (const attempt of pending) await reconcileImageConversationRun(attempt.generation_run_id);
  return recovered;
}

export async function processNextGenerationJob(
  workerId: string,
  options: ProcessGenerationJobOptions = {},
): Promise<boolean> {
  const now = options.now?.() ?? Date.now();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  await recoverExpiredGenerationJobs(now);
  const job = await claimNextJob(workerId, now, leaseMs);
  if (!job) return false;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const heartbeat = setInterval(() => {
    const heartbeatNow = options.now?.() ?? Date.now();
    void db().query(`
      UPDATE generation_jobs SET lease_expires_at = $1, updated_at = $2
      WHERE id = $3 AND worker_id = $4 AND status IN ('running','cancel_requested')
    `, [heartbeatNow + leaseMs, heartbeatNow, job.id, workerId]).catch((error) => {
      console.error("[garment-canvas] generation lease heartbeat failed", error);
    });
  }, heartbeatMs);
  heartbeat.unref();
  try {
    const input = await inputImagesForStep(job.runId, job.step);
    const result = await executeStep(
      job.step,
      input.images,
      options.resolveProvider ?? getProvider,
      {
        runId: job.runId,
        stylingCompleted: job.step.kind==='ai-styling'?await query<{image:string;prompt:string;model:string|null}>('SELECT image,prompt,model FROM styling_checkpoints WHERE step_id=$1 ORDER BY ordinal',[job.stepId]):undefined,
        onStylingCheckpoint: job.step.kind==='ai-styling'?(ordinal,image,prompt,model)=>checkpointStyling(job,workerId,ordinal,image,prompt,model):undefined,
        referenceRoles: input.referenceRoles,
        onSceneRequestPrepared: async request => {
          await transaction(async client => {
            const owned = (await client.query(`
              SELECT id FROM generation_jobs WHERE id = $1 AND worker_id = $2
                AND status = 'running' FOR UPDATE
            `, [job.id, workerId])).rows[0];
            if (!owned) throw new Error("generation job lease was lost before request recording");
            await recordGenerationRequest(job.runId, job.nodeId, request, client);
            await appendRunEvent(client, job.runId, {
              type: "node-status", nodeId: job.nodeId, status: "running",
              executionMeta: { sceneRequest: request },
            }, options.now?.() ?? Date.now());
          });
        },
        sceneAnalyzer: options.sceneAnalyzer,
        promptEnhancer: options.promptEnhancer,
        candidateSelector: options.candidateSelector,
        videoTask: job.videoTask,
        videoIdempotencyKey: job.idempotencyKey,
        onVideoTaskAccepted: async (task) => {
          await markVideoTaskAccepted(
            job,
            workerId,
            task,
            options.now?.() ?? Date.now(),
            leaseMs,
          );
        },
        beforeProviderCall: async () => {
          await markAttemptStarted(job, workerId, options.now?.() ?? Date.now(), leaseMs);
        },
      },
    );
    await assertJobOwnedForCompletion(job, workerId);
    const persistedImages = await persistStepImages(result.images, job);
    try {
      await completeJobSuccess(job, workerId, result, persistedImages, options.now?.() ?? Date.now());
    } catch (error) {
      await compensatePersistedImages(persistedImages, job, workerId);
      throw error;
    }
  } catch (error) {
    await handleJobError(job, workerId, error, options);
  } finally {
    clearInterval(heartbeat);
    await reconcileImageConversationRun(job.runId).catch((error) => {
      console.error("[garment-canvas] image conversation reconciliation failed", error);
    });
  }
  return true;
}

export function startGenerationWorker(): () => void {
  const workerId = `${os.hostname()}:${process.pid}:${nanoid(6)}`;
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      while (!stopped && await processNextGenerationJob(workerId)) {
        // Drain immediately available work before returning to the poll interval.
      }
    } catch (error) {
      console.error("[garment-canvas] generation worker failed", error);
    } finally {
      busy = false;
    }
  };
  const pollMs = config.generationWorkerPollMs();
  const timer = setInterval(() => void tick(), pollMs);
  timer.unref();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export async function getDurableRunForUser(
  runId: string,
  ownerId: string,
): Promise<{ id: string; status: string; finished: boolean } | undefined> {
  const row = await queryOne<{ id: string; status: string }>(`
    SELECT id, status FROM generation_runs
    WHERE id = $1 AND owner_id = $2 AND plan_json IS NOT NULL AND deleted_at IS NULL
  `, [runId, ownerId]);
  return row ? { id: row.id, status: row.status, finished: isTerminalRunStatus(row.status) } : undefined;
}

export async function readDurableRunEvents(
  runId: string,
  ownerId: string,
  afterSeq: number,
): Promise<RunEvent[] | undefined> {
  const run = await queryOne<{ id: string }>(`
    SELECT id FROM generation_runs
    WHERE id = $1 AND owner_id = $2 AND plan_json IS NOT NULL AND deleted_at IS NULL
  `, [runId, ownerId]);
  if (!run) return undefined;
  const rows = await query<{ seq: number; payload_json: string }>(`
    SELECT seq, payload_json FROM generation_run_events
    WHERE run_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3
  `, [runId, afterSeq, DURABLE_RUN_EVENT_BATCH_SIZE]);
  return rows.map((row) => ({ ...parseJson<RunEvent>(row.payload_json, { type: "done" }), seq: row.seq }));
}

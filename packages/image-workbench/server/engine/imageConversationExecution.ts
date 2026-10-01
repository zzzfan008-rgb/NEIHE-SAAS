import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { nanoid } from "nanoid";
import type { ExecutionPlan, NodeExecution, NodeKind } from "../../src/types/workflow";
import {
  imageModelOptionsError,
  isImageModelId,
  isModelAllowedForNode,
  type ImageModelOptions,
  type ImageModelId,
} from "../../src/types/imageModels";
import type {
  ConversationImageInput,
  ImageConversationMode,
  ImageConversationParameters,
} from "../../src/types/imageConversation";
import { validateImageConversationParameters } from "../../src/lib/imageConversationRules";
import { enqueueGenerationRunInTransaction } from "./runQueue";
import { assertImageReferencesAccessible } from "../lib/imageReferenceAccess";
import { query, queryOne } from "../lib/database";
import type { ImageConversationAttemptStatus } from "../lib/imageConversationStore";

export class ImageConversationExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageConversationExecutionError";
  }
}

export class ImageConversationExecutionConflictError extends ImageConversationExecutionError {
  constructor(message: string) {
    super(message);
    this.name = "ImageConversationExecutionConflictError";
  }
}

interface ConversationRoundQueueRow {
  id: string;
  conversation_id: string;
  owner_id: string;
  project_id: string;
  client_request_id: string;
  mode: ImageConversationMode;
  source_result_id: string | null;
  input_manifest: unknown;
  prompt: string;
  parameters: unknown;
  effective_requirements: unknown;
  mask_ref: string | null;
}

interface ConversationIntentQueueRow {
  id: string;
  round_id: string;
  conversation_id: string;
  owner_id: string;
  project_id: string;
  ordinal: number;
  label: string;
  instruction: string;
  requirements: unknown;
  status: string;
}

export async function enqueueImageConversationRoundInTransaction(
  client: PoolClient,
  ownerId: string,
  projectId: string,
  conversationId: string,
  roundId: string,
): Promise<Array<{ intentId: string; attemptId: string; generationRunId: string }>> {
  const round = await queryOne<ConversationRoundQueueRow>(`
    SELECT id, conversation_id, owner_id, project_id, client_request_id, mode,
      source_result_id, input_manifest, prompt, parameters, effective_requirements, mask_ref
    FROM image_conversation_rounds
    WHERE id = $1 AND owner_id = $2 AND project_id = $3 AND conversation_id = $4
    FOR UPDATE
  `, [roundId, ownerId, projectId, conversationId], client);
  if (!round) throw new ImageConversationExecutionError("image conversation round not found");
  const intents = await query<ConversationIntentQueueRow>(`
    SELECT id, round_id, conversation_id, owner_id, project_id, ordinal, label,
      instruction, requirements, status
    FROM image_conversation_intents
    WHERE round_id = $1 AND owner_id = $2 AND project_id = $3
    ORDER BY ordinal
    FOR UPDATE
  `, [roundId, ownerId, projectId], client);
  if (intents.length === 0) throw new ImageConversationExecutionError("planned round has no intents");
  const project = await queryOne<{ name: string }>(
    "SELECT name FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL FOR SHARE",
    [projectId, ownerId],
    client,
  );
  if (!project) throw new ImageConversationExecutionError("image conversation project is unavailable");
  const parameters = parseRecord(round.parameters);
  validateImageConversationParameters(
    round.mode,
    parameters as unknown as ImageConversationParameters,
  );
  const inputManifest = parseInputManifest(round.input_manifest);
  const resolvedInputs = await resolveConversationInputs(client, ownerId, projectId, inputManifest);
  await assertImageReferencesAccessible(
    { inputImages: resolvedInputs, mask: round.mask_ref },
    ownerId,
    client,
  );
  const nodeKind = round.mode === "mask" ? "mask-redraw" : "ai-modify";
  const modelId = requireModel(parameters.modelId, nodeKind);
  const modelOptions = buildModelOptions(parameters, modelId);
  const optionError = imageModelOptionsError(modelId, modelOptions);
  if (optionError) throw new ImageConversationExecutionError(`model parameters are incompatible: ${optionError}`);
  const activeRound = await queryOne<{ id: string }>(`
    SELECT id
    FROM image_conversation_rounds
    WHERE conversation_id = $1 AND owner_id = $2 AND project_id = $3
      AND id <> $4 AND status IN ('queued', 'running', 'outcome_unknown')
    LIMIT 1
  `, [conversationId, ownerId, projectId, round.id], client);
  if (activeRound) {
    throw new ImageConversationExecutionConflictError("image conversation already has an active generation round");
  }
  const planResults: Array<{ intentId: string; attemptId: string; generationRunId: string }> = [];
  for (const intent of intents) {
    const existing = await queryOne<{ id: string; generation_run_id: string | null; status: string }>(`
      SELECT id, generation_run_id, status
      FROM image_conversation_attempts
      WHERE intent_id = $1 AND owner_id = $2
      ORDER BY attempt_number DESC LIMIT 1
      FOR SHARE
    `, [intent.id, ownerId], client);
    if (existing?.generation_run_id) {
      planResults.push({ intentId: intent.id, attemptId: existing.id, generationRunId: existing.generation_run_id });
      continue;
    }
    const nodeId = `image-conversation-${intent.id}`;
    const step = buildNodeExecution(
      round,
      intent,
      nodeId,
      nodeKind,
      modelId,
      modelOptions,
      resolvedInputs,
    );
    const plan: ExecutionPlan = { steps: [step] };
    const generationRequestId = stableGenerationRequestId(round.id, intent.id);
    const run = await enqueueGenerationRunInTransaction(client, plan, ownerId, {
      userId: ownerId,
      clientRequestId: generationRequestId,
      projectId,
      projectName: project.name,
      nodeId,
      nodeLabel: `对话修改·${intent.label}`,
      kind: "image-conversation",
      prompt: intent.instruction,
      parameters: step.params,
      referenceImages: resolvedInputs,
      requestedCount: 1,
    }, "direct");
    const attemptId = nanoid(16);
    await client.query(`
      INSERT INTO image_conversation_attempts (
        id, intent_id, round_id, conversation_id, owner_id, project_id,
        attempt_number, client_request_id, generation_run_id, status,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, 'queued', $9, $9)
      ON CONFLICT (owner_id, client_request_id) DO NOTHING
    `, [
      attemptId, intent.id, round.id, round.conversation_id, ownerId, projectId,
      generationRequestId, run.id, new Date().toISOString(),
    ]);
    const attempt = await queryOne<{ id: string; generation_run_id: string | null }>(`
      SELECT id, generation_run_id FROM image_conversation_attempts
      WHERE owner_id = $1 AND client_request_id = $2
    `, [ownerId, generationRequestId], client);
    if (!attempt?.generation_run_id) throw new ImageConversationExecutionError("image conversation attempt could not be created");
    await client.query(
      "UPDATE image_conversation_intents SET status = 'queued', updated_at = $2 WHERE id = $1",
      [intent.id, new Date().toISOString()],
    );
    planResults.push({ intentId: intent.id, attemptId: attempt.id, generationRunId: attempt.generation_run_id });
  }
  await client.query(
    "UPDATE image_conversation_rounds SET status = 'queued', updated_at = $2 WHERE id = $1",
    [round.id, new Date().toISOString()],
  );
  return planResults;
}

export interface RetryImageConversationIntentResult {
  intentId: string;
  roundId: string;
  attemptId: string;
  attemptNumber: number;
  generationRunId: string;
  replayed: boolean;
}

export async function enqueueImageConversationIntentRetryInTransaction(
  client: PoolClient,
  ownerId: string,
  projectId: string,
  conversationId: string,
  intentId: string,
  clientRequestId: string,
): Promise<RetryImageConversationIntentResult> {
  const existing = await queryOne<{
    id: string;
    intent_id: string;
    round_id: string;
    attempt_number: number;
    generation_run_id: string | null;
    status: string;
  }>(`
    SELECT id, intent_id, round_id, attempt_number, generation_run_id, status
    FROM image_conversation_attempts
    WHERE owner_id = $1 AND client_request_id = $2
    FOR SHARE
  `, [ownerId, clientRequestId], client);
  if (existing) {
    if (existing.intent_id !== intentId || !existing.generation_run_id) {
      throw new ImageConversationExecutionConflictError("retry request conflicts with an existing attempt");
    }
    return {
      intentId,
      roundId: existing.round_id,
      attemptId: existing.id,
      attemptNumber: existing.attempt_number,
      generationRunId: existing.generation_run_id,
      replayed: true,
    };
  }

  const round = await queryOne<ConversationRoundQueueRow>(`
    SELECT round.id, round.conversation_id, round.owner_id, round.project_id,
      round.client_request_id, round.mode, round.source_result_id,
      round.input_manifest, round.prompt, round.parameters,
      round.effective_requirements, round.mask_ref
    FROM image_conversation_rounds round
    JOIN image_conversation_intents intent ON intent.round_id = round.id
    WHERE intent.id = $1 AND intent.conversation_id = $2
      AND intent.owner_id = $3 AND intent.project_id = $4
      AND round.conversation_id = $2 AND round.owner_id = $3 AND round.project_id = $4
    FOR UPDATE OF round
  `, [intentId, conversationId, ownerId, projectId], client);
  if (!round) throw new ImageConversationExecutionError("image conversation intent not found");
  const intent = await queryOne<ConversationIntentQueueRow>(`
    SELECT id, round_id, conversation_id, owner_id, project_id, ordinal, label,
      instruction, requirements, status
    FROM image_conversation_intents
    WHERE id = $1 AND round_id = $2 AND owner_id = $3 AND project_id = $4
    FOR UPDATE
  `, [intentId, round.id, ownerId, projectId], client);
  if (!intent) throw new ImageConversationExecutionError("image conversation intent not found");
  const latest = await queryOne<{
    id: string;
    attempt_number: number;
    status: ImageConversationAttemptStatus;
  }>(`
    SELECT id, attempt_number, status
    FROM image_conversation_attempts
    WHERE intent_id = $1 AND owner_id = $2
    ORDER BY attempt_number DESC
    LIMIT 1
    FOR UPDATE
  `, [intentId, ownerId], client);
  if (!latest) throw new ImageConversationExecutionError("image conversation intent has no completed attempt");
  if (latest.status === "outcome_unknown") {
    throw new ImageConversationExecutionConflictError("结果待确认，核对后才能重试");
  }
  if (latest.status !== "failed") {
    throw new ImageConversationExecutionConflictError("only a failed image conversation intent can be retried");
  }
  const activeRound = await queryOne<{ id: string }>(`
    SELECT id
    FROM image_conversation_rounds
    WHERE conversation_id = $1 AND owner_id = $2 AND project_id = $3
      AND status IN ('queued', 'running', 'outcome_unknown')
    LIMIT 1
  `, [conversationId, ownerId, projectId], client);
  if (activeRound) {
    throw new ImageConversationExecutionConflictError("image conversation already has an active generation round");
  }

  const parameters = parseRecord(round.parameters);
  const inputManifest = parseInputManifest(round.input_manifest);
  const resolvedInputs = await resolveConversationInputs(client, ownerId, projectId, inputManifest);
  await assertImageReferencesAccessible(
    { inputImages: resolvedInputs, mask: round.mask_ref },
    ownerId,
    client,
  );
  const nodeKind = round.mode === "mask" ? "mask-redraw" : "ai-modify";
  const modelId = requireModel(parameters.modelId, nodeKind);
  const modelOptions = buildModelOptions(parameters, modelId);
  const optionError = imageModelOptionsError(modelId, modelOptions);
  if (optionError) throw new ImageConversationExecutionError(`model parameters are incompatible: ${optionError}`);
  const attemptNumber = latest.attempt_number + 1;
  const nodeId = `image-conversation-${intent.id}`;
  const step = buildNodeExecution(round, intent, nodeId, nodeKind, modelId, modelOptions, resolvedInputs);
  const run = await enqueueGenerationRunInTransaction(
    client,
    { steps: [step] },
    ownerId,
    {
      userId: ownerId,
      clientRequestId: stableRetryGenerationRequestId(round.id, intent.id, attemptNumber),
      projectId,
      projectName: (await queryOne<{ name: string }>(
        "SELECT name FROM projects WHERE id = $1 AND owner_id = $2 FOR SHARE",
        [projectId, ownerId],
        client,
      ))?.name,
      nodeId,
      nodeLabel: `对话修改·${intent.label}·重试${attemptNumber}`,
      kind: "image-conversation",
      prompt: intent.instruction,
      parameters: step.params,
      referenceImages: resolvedInputs,
      requestedCount: 1,
    },
    "direct",
  );
  const attemptId = nanoid(16);
  const now = new Date().toISOString();
  await client.query(`
    INSERT INTO image_conversation_attempts (
      id, intent_id, round_id, conversation_id, owner_id, project_id,
      attempt_number, client_request_id, generation_run_id, retry_of_attempt_id,
      status, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'queued', $11, $11)
  `, [
    attemptId, intent.id, round.id, conversationId, ownerId, projectId,
    attemptNumber, clientRequestId, run.id, latest.id, now,
  ]);
  await client.query(
    "UPDATE image_conversation_intents SET status = 'queued', updated_at = $2 WHERE id = $1",
    [intent.id, now],
  );
  await client.query(
    "UPDATE image_conversation_rounds SET status = 'queued', updated_at = $2 WHERE id = $1",
    [round.id, now],
  );
  return {
    intentId: intent.id,
    roundId: round.id,
    attemptId,
    attemptNumber,
    generationRunId: run.id,
    replayed: false,
  };
}

function buildNodeExecution(
  round: ConversationRoundQueueRow,
  intent: ConversationIntentQueueRow,
  nodeId: string,
  nodeKind: NodeKind,
  modelId: ImageModelId,
  modelOptions: ImageModelOptions,
  resolvedInputs: string[],
): NodeExecution {
  const parameters = parseRecord(round.parameters);
  const inheritedRequirements = parseRecord(round.effective_requirements);
  const intentRequirements = parseRecord(intent.requirements);
  const params: Record<string, unknown> = {
    modelId,
    modelOptions,
    prompt: buildConversationExecutionPrompt(intent.instruction, inheritedRequirements, intentRequirements),
    batchSize: 1,
    aspectRatio: typeof parameters.aspectRatio === "string" ? parameters.aspectRatio : "1:1",
    conversationSourceResultId: round.source_result_id,
    conversationIntentId: intent.id,
    conversationMode: round.mode,
  };
  if (nodeKind === "mask-redraw") {
    if (!round.mask_ref) throw new ImageConversationExecutionError("mask mode requires a saved mask");
    params.mask = round.mask_ref;
    params.maskSourceRef = resolvedInputs[0];
    params.repairFocus = "custom";
    params.executionMode = "repair";
  }
  return {
    nodeId,
    kind: nodeKind,
    inputImages: resolvedInputs,
    params,
  } as NodeExecution;
}

function buildConversationExecutionPrompt(
  instruction: string,
  inheritedRequirements: Record<string, unknown>,
  intentRequirements: Record<string, unknown>,
): string {
  if (Object.keys(inheritedRequirements).length === 0 && Object.keys(intentRequirements).length === 0) {
    return instruction;
  }
  return `${instruction}\n结构化约束（必须遵守；currentIntent 在冲突时覆盖 inherited）：${JSON.stringify({
    inherited: inheritedRequirements,
    currentIntent: intentRequirements,
  })}`;
}

function requireModel(value: unknown, nodeKind: NodeKind): ImageModelId {
  if (!isImageModelId(value)) throw new ImageConversationExecutionError("selected image model is invalid");
  if (!isModelAllowedForNode(value, nodeKind)) {
    throw new ImageConversationExecutionError(`selected image model is not allowed for ${nodeKind}`);
  }
  return value;
}

function buildModelOptions(parameters: Record<string, unknown>, modelId: ImageModelId): ImageModelOptions {
  const options: ImageModelOptions = {};
  if (typeof parameters.quality === "string") options.quality = parameters.quality as ImageModelOptions["quality"];
  if (typeof parameters.size === "string") {
    options.size = modelId.startsWith("gpt-image-2.5-")
      ? normalizeImageConversationSize(parameters.size, typeof parameters.aspectRatio === "string" ? parameters.aspectRatio : "1:1")
      : normalizeSize(parameters.size);
  }
  if (typeof parameters.imageSize === "string") options.imageSize = parameters.imageSize;
  if (typeof parameters.resolution === "string") options.resolution = parameters.resolution;
  if (typeof parameters.aspectRatio === "string" && (modelId.startsWith("gemini") || modelId === "grok-imagine-image")) {
    options.aspectRatio = parameters.aspectRatio;
  }
  if (modelId === "flux-2-pro") {
    if (typeof parameters.width === "number") options.width = parameters.width;
    if (typeof parameters.height === "number") options.height = parameters.height;
    if (parameters.outputFormat === "jpeg" || parameters.outputFormat === "png" || parameters.outputFormat === "webp") {
      options.outputFormat = parameters.outputFormat;
    }
  }
  return options;
}

function normalizeSize(value: string): string {
  if (value === "2K") return "2048x2048";
  if (value === "4K") return "3840x3840";
  return value;
}

const GPT_IMAGE_25_RESOLUTION_MAP: Record<string, Record<string, string>> = {
  "2K": {
    "1:1": "2048x2048",
    "2:3": "1360x2048",
    "3:2": "2048x1360",
    "3:4": "1536x2048",
    "4:3": "2048x1536",
    "4:5": "1632x2048",
    "5:4": "2048x1632",
    "9:16": "1152x2048",
    "16:9": "2048x1152",
    "21:9": "2016x864",
  },
  "4K": {
    "1:1": "2880x2880",
    "2:3": "2352x3520",
    "3:2": "3520x2352",
    "3:4": "2480x3312",
    "4:3": "3312x2480",
    "4:5": "2560x3200",
    "5:4": "3200x2560",
    "9:16": "2160x3840",
    "16:9": "3840x2160",
    "21:9": "3696x1584",
  },
};

export function normalizeImageConversationSize(value: string, aspectRatio = "1:1"): string {
  return GPT_IMAGE_25_RESOLUTION_MAP[value]?.[aspectRatio]
    ?? GPT_IMAGE_25_RESOLUTION_MAP[value]?.["1:1"]
    ?? normalizeSize(value);
}

async function resolveConversationInputs(
  client: PoolClient,
  ownerId: string,
  projectId: string,
  manifest: ConversationImageInput[],
): Promise<string[]> {
  const resolved: string[] = [];
  for (const input of manifest) {
    const local = /^\/api\/files\/[A-Za-z0-9_-]{1,128}\.(?:png|jpe?g|webp|gif)$/.test(input.sourceRef);
    if (local) {
      resolved.push(input.sourceRef);
      continue;
    }
    const assetMatch = /^asset\/([A-Za-z0-9_-]{1,128})$/.exec(input.sourceRef);
    if (assetMatch) {
      const asset = await queryOne<{ image: string }>(`
        SELECT image FROM assets
        WHERE id = $1 AND deleted_at IS NULL
          AND (scope IN ('global','shared') OR owner_id = $2)
          AND (
            scope IN ('global','shared') OR EXISTS (
              SELECT 1 FROM project_asset_refs refs WHERE refs.asset_id = assets.id AND refs.project_id = $3
            )
          )
        FOR SHARE
      `, [assetMatch[1], ownerId, projectId], client);
      if (!asset?.image) throw new ImageConversationExecutionError("conversation asset source is unavailable");
      resolved.push(asset.image);
      continue;
    }
    const outputMatch = /^generation-output\/([A-Za-z0-9_-]{1,128})$/.exec(input.sourceRef);
    if (outputMatch) {
      const output = await queryOne<{ image: string }>(`
        SELECT output.image
        FROM generation_outputs output
        JOIN generation_runs run ON run.id = output.run_id
        WHERE output.id = $1 AND output.status = 'success'
          AND run.owner_id = $2 AND run.project_id = $3 AND run.deleted_at IS NULL
        FOR SHARE OF run
      `, [outputMatch[1], ownerId, projectId], client);
      if (!output?.image) throw new ImageConversationExecutionError("conversation output source is unavailable");
      resolved.push(output.image);
      continue;
    }
    throw new ImageConversationExecutionError("conversation input source is invalid");
  }
  return resolved;
}

function parseInputManifest(value: unknown): ConversationImageInput[] {
  if (!Array.isArray(value)) throw new ImageConversationExecutionError("conversation input manifest is invalid");
  return value as ConversationImageInput[];
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return parseRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stableGenerationRequestId(roundId: string, intentId: string): string {
  return `ic-${createHash("sha256").update(`${roundId}:${intentId}`).digest("hex").slice(0, 48)}`;
}

function stableRetryGenerationRequestId(roundId: string, intentId: string, attemptNumber: number): string {
  return `ic-${createHash("sha256").update(`${roundId}:${intentId}:retry:${attemptNumber}`).digest("hex").slice(0, 48)}`;
}

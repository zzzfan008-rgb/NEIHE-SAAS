import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import type { PoolClient } from "pg";
import {
  validateInputManifest,
  validateImageConversationParameters,
} from "../../src/lib/imageConversationRules";
import type {
  ConversationImageInput,
  ImageConversationClarification,
  ImageConversationClarificationResponse,
  ImageConversationContext,
  ImageConversationMode,
  ImageConversationParameters,
  ImageConversationPlan,
} from "../../src/types/imageConversation";
import { isLocalImageReference } from "./imageValidation";
import { lockActiveOwner } from "./ownerMutation";
import { query, queryOne, transaction } from "./database";
import { reconcileImageConversation } from "../engine/imageConversationReconciliation";
import {
  enqueueImageConversationIntentRetryInTransaction,
  enqueueImageConversationRoundInTransaction,
} from "../engine/imageConversationExecution";

export type ImageConversationSourceKind = "file" | "generation-output" | "asset";
export type ImageConversationRoundStatus =
  | "draft"
  | "clarification_required"
  | "queued"
  | "running"
  | "partial"
  | "succeeded"
  | "failed"
  | "outcome_unknown";
export type ImageConversationIntentStatus =
  | "pending"
  | "clarification_required"
  | "rejected"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "outcome_unknown";
export type ImageConversationAttemptStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "outcome_unknown";
export type ImageConversationOutputStatus = "pending" | "ready" | "failed" | "unknown";

export interface ImageConversationRecord {
  id: string;
  ownerId: string;
  projectId: string;
  sourceRef: string;
  sourceKind: ImageConversationSourceKind;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  sourcePreviews: Record<string, string>;
  rounds: ImageConversationRoundRecord[];
  outputs: ImageConversationOutputRecord[];
}

export interface ImageConversationRoundRecord {
  id: string;
  conversationId: string;
  ownerId: string;
  projectId: string;
  ordinal: number;
  clientRequestId: string;
  mode: ImageConversationMode;
  sourceResultId: string | null;
  inputManifest: ConversationImageInput[];
  prompt: string;
  parameters: Record<string, unknown>;
  effectiveRequirements: Record<string, unknown>;
  incrementalRequirements: Record<string, unknown>;
  maskRef: string | null;
  status: ImageConversationRoundStatus;
  createdAt: string;
  updatedAt: string;
  intents: ImageConversationIntentRecord[];
  clarification: ImageConversationClarification | null;
}

export interface ImageConversationIntentRecord {
  id: string;
  roundId: string;
  conversationId: string;
  ordinal: number;
  label: string;
  instruction: string;
  requirements: Record<string, unknown>;
  status: ImageConversationIntentStatus;
  createdAt: string;
  updatedAt: string;
  attempts: ImageConversationAttemptRecord[];
}

export interface ImageConversationAttemptRecord {
  id: string;
  intentId: string;
  roundId: string;
  conversationId: string;
  attemptNumber: number;
  clientRequestId: string;
  generationRunId: string | null;
  retryOfAttemptId: string | null;
  status: ImageConversationAttemptStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImageConversationOutputRecord {
  id: string;
  roundId: string;
  conversationId: string;
  intentId: string | null;
  ownerId: string;
  projectId: string;
  generationOutputId: string | null;
  imageRef: string | null;
  status: ImageConversationOutputStatus;
  prompt: string | null;
  error: string | null;
  createdAt: string;
}

export interface CreateImageConversationInput {
  ownerId: string;
  projectId: string;
  sourceRef: string;
  sourceKind?: ImageConversationSourceKind;
  /** Explicitly starts an independent conversation even when this source already has history. */
  startNew?: boolean;
}

export interface CreateImageConversationRoundInput {
  ownerId: string;
  projectId: string;
  conversationId: string;
  clientRequestId: string;
  mode: ImageConversationMode;
  sourceResultId: string | null;
  inputManifest: ConversationImageInput[];
  prompt: string;
  parameters: Record<string, unknown>;
  effectiveRequirements?: Record<string, unknown>;
  incrementalRequirements?: Record<string, unknown>;
  maskRef?: string | null;
  status?: ImageConversationRoundStatus;
  plan?: ImageConversationPlan;
  enqueue?: boolean;
}

export interface ApplyImageConversationPlanInput extends Omit<CreateImageConversationRoundInput, "plan"> {
  plan: ImageConversationPlan;
  clarificationRoundId?: string;
  clarificationAnswer?: string;
}

export interface ApplyImageConversationPlanResult {
  round: ImageConversationRoundRecord;
  replayed: boolean;
}

export interface RetryImageConversationIntentInput {
  ownerId: string;
  projectId: string;
  conversationId: string;
  intentId: string;
  clientRequestId: string;
}

export interface RetryImageConversationIntentResult {
  round: ImageConversationRoundRecord;
  attemptId: string;
  attemptNumber: number;
  generationRunId: string;
  replayed: boolean;
}

export interface LinkImageConversationOutputInput {
  ownerId: string;
  projectId: string;
  conversationId: string;
  roundId: string;
  intentId: string | null;
  generationOutputId: string;
  status: ImageConversationOutputStatus;
  imageRef?: string | null;
  prompt?: string | null;
  error?: string | null;
}

export class ImageConversationAccessError extends Error {
  constructor(message = "image source is not accessible") {
    super(message);
    this.name = "ImageConversationAccessError";
  }
}

export class ImageConversationConflictError extends Error {
  constructor(message = "image conversation request conflicts with an existing request") {
    super(message);
    this.name = "ImageConversationConflictError";
  }
}

export class ImageConversationValidationError extends Error {
  constructor(message = "invalid image conversation input") {
    super(message);
    this.name = "ImageConversationValidationError";
  }
}

interface ConversationRow {
  id: string;
  owner_id: string;
  project_id: string;
  source_ref: string;
  source_kind: ImageConversationSourceKind;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
}

interface RoundRow {
  id: string;
  conversation_id: string;
  owner_id: string;
  project_id: string;
  ordinal: number;
  client_request_id: string;
  mode: ImageConversationMode;
  source_result_id: string | null;
  input_manifest: unknown;
  prompt: string;
  parameters: unknown;
  effective_requirements: unknown;
  incremental_requirements: unknown;
  mask_ref: string | null;
  status: ImageConversationRoundStatus;
  created_at: string;
  updated_at: string;
  request_fingerprint: string;
}

interface IntentRow {
  id: string;
  round_id: string;
  conversation_id: string;
  ordinal: number;
  label: string;
  instruction: string;
  requirements: unknown;
  status: ImageConversationIntentStatus;
  created_at: string;
  updated_at: string;
}

interface AttemptRow {
  id: string;
  intent_id: string;
  round_id: string;
  conversation_id: string;
  attempt_number: number;
  client_request_id: string;
  generation_run_id: string | null;
  retry_of_attempt_id: string | null;
  status: ImageConversationAttemptStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface OutputRow {
  id: string;
  round_id: string;
  conversation_id: string;
  intent_id: string | null;
  owner_id: string;
  project_id: string;
  generation_output_id: string | null;
  image_ref: string | null;
  status: ImageConversationOutputStatus;
  prompt: string | null;
  error: string | null;
  created_at: string;
}

interface ClarificationRow {
  id: string;
  round_id: string;
  conversation_id: string;
  owner_id: string;
  project_id: string;
  question: string;
  reason: "count_mismatch" | "ambiguous_requirement";
  requested_count: number | null;
  specified_intent_count: number | null;
  status: "open" | "resolved";
  responses: unknown;
  created_at: string;
  updated_at: string;
}

const LOCAL_SOURCE_PATTERN = /^\/api\/files\/[A-Za-z0-9_-]{1,128}\.(?:png|jpe?g|webp|gif)$/;
const OUTPUT_SOURCE_PATTERN = /^generation-output\/([A-Za-z0-9_-]{1,128})$/;
const ASSET_SOURCE_PATTERN = /^asset\/([A-Za-z0-9_-]{1,128})$/;

export async function resolveImageConversation(
  ownerId: string,
  projectId: string,
  sourceRef: string,
): Promise<ImageConversationRecord | undefined> {
  return transaction(async (client) => {
    const row = await findConversation(client, ownerId, projectId, { sourceRef });
    return row ? mapConversation(row) : undefined;
  });
}

export async function createOrResolveImageConversation(
  input: CreateImageConversationInput,
): Promise<ImageConversationRecord> {
  const source = normalizeSource(input.sourceRef, input.sourceKind);
  return transaction(async (client) => {
    if (!await lockActiveOwner(client, input.ownerId)) {
      throw new ImageConversationAccessError();
    }
    await assertProjectAccess(client, input.ownerId, input.projectId);
    await assertSourceAccess(client, input.ownerId, input.projectId, source.sourceRef, source.sourceKind);

    if (!input.startNew) {
      const existing = await findConversation(client, input.ownerId, input.projectId, {
        sourceRef: source.sourceRef,
        lock: true,
      });
      if (existing) return mapConversation(existing);
    }

    const id = nanoid(16);
    const now = new Date().toISOString();
    await client.query(`
      INSERT INTO image_conversations (
        id, owner_id, project_id, source_ref, source_kind, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $6)
    `, [id, input.ownerId, input.projectId, source.sourceRef, source.sourceKind, now]);
    const conversation = await findConversation(client, input.ownerId, input.projectId, {
      conversationId: id,
      lock: true,
    });
    if (!conversation) throw new Error("image conversation could not be created");
    await client.query(`
      INSERT INTO image_conversation_sources (
        id, conversation_id, owner_id, project_id, source_ref, source_kind, relation, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'origin', $7)
    `, [nanoid(16), conversation.id, input.ownerId, input.projectId, source.sourceRef, source.sourceKind, now]);
    return mapConversation(conversation);
  });
}

export async function getImageConversation(
  ownerId: string,
  projectId: string,
  conversationId: string,
): Promise<ImageConversationRecord | undefined> {
  const accessible = await transaction(async (client) => {
    if (!await queryOne("SELECT id FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL", [projectId, ownerId], client)) return false;
    return Boolean(await findConversation(client, ownerId, projectId, { conversationId }));
  });
  if (!accessible) return undefined;
  // Repair only after authorization, outside the read transaction/its locks.
  await reconcileImageConversation(ownerId, projectId, conversationId);
  return transaction(async (client) => {
    if (!await queryOne("SELECT id FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL FOR SHARE", [projectId, ownerId], client)) return undefined;
    const conversation = await findConversation(client, ownerId, projectId, { conversationId });
    if (!conversation) return undefined;
    const rounds = await query<RoundRow>(`
      SELECT id, conversation_id, owner_id, project_id, ordinal, client_request_id,
        mode, source_result_id, input_manifest, prompt, parameters,
        effective_requirements, incremental_requirements, mask_ref, status,
        created_at, updated_at, request_fingerprint
      FROM image_conversation_rounds
      WHERE owner_id = $1 AND project_id = $2 AND conversation_id = $3
      ORDER BY ordinal
    `, [ownerId, projectId, conversationId], client);
    const intents = await query<IntentRow>(`
      SELECT id, round_id, conversation_id, ordinal, label, instruction, requirements,
        status, created_at, updated_at
      FROM image_conversation_intents
      WHERE owner_id = $1 AND project_id = $2 AND conversation_id = $3
      ORDER BY round_id, ordinal
    `, [ownerId, projectId, conversationId], client);
    const attempts = await query<AttemptRow>(`
      SELECT id, intent_id, round_id, conversation_id, attempt_number, client_request_id,
        generation_run_id, retry_of_attempt_id, status, error, created_at, updated_at
      FROM image_conversation_attempts
      WHERE owner_id = $1 AND project_id = $2 AND conversation_id = $3
      ORDER BY round_id, attempt_number
    `, [ownerId, projectId, conversationId], client);
    const outputs = await query<OutputRow>(`
      SELECT id, round_id, conversation_id, intent_id, owner_id, project_id,
        generation_output_id, image_ref, status, prompt, error, created_at
      FROM image_conversation_outputs
      WHERE owner_id = $1 AND project_id = $2 AND conversation_id = $3
      ORDER BY created_at, id
    `, [ownerId, projectId, conversationId], client);
    const clarifications = await query<ClarificationRow>(`
      SELECT id, round_id, conversation_id, owner_id, project_id, question, reason,
        requested_count, specified_intent_count, status, responses, created_at, updated_at
      FROM image_conversation_clarifications
      WHERE owner_id = $1 AND project_id = $2 AND conversation_id = $3
      ORDER BY created_at, id
    `, [ownerId, projectId, conversationId], client);
    const sourcePreviews = await resolveConversationSourcePreviews(
      client,
      ownerId,
      projectId,
      conversation,
      rounds,
      outputs,
    );
    return mapConversation(conversation, rounds, intents, attempts, outputs, clarifications, sourcePreviews);
  });
}

async function resolveConversationSourcePreviews(
  client: PoolClient,
  ownerId: string,
  projectId: string,
  conversation: ConversationRow,
  roundRows: RoundRow[],
  outputRows: OutputRow[],
): Promise<Record<string, string>> {
  const previews: Record<string, string> = {};
  const assetIds = new Set<string>();

  const collectSourceRef = (sourceRef: unknown): void => {
    if (typeof sourceRef !== "string" || !sourceRef.trim()) return;
    if (isLocalImageReference(sourceRef)) {
      previews[sourceRef] = sourceRef;
      return;
    }
    const assetMatch = ASSET_SOURCE_PATTERN.exec(sourceRef);
    if (assetMatch) assetIds.add(assetMatch[1]);
  };

  collectSourceRef(conversation.source_ref);
  for (const round of roundRows) {
    const inputs = parseJson<ConversationImageInput[]>(round.input_manifest, []);
    for (const input of inputs) collectSourceRef(input.sourceRef);
    collectSourceRef(round.mask_ref);
  }
  for (const output of outputRows) {
    if (output.generation_output_id && output.image_ref && isLocalImageReference(output.image_ref)) {
      previews[`generation-output/${output.generation_output_id}`] = output.image_ref;
    }
  }

  for (const assetId of assetIds) {
    const asset = await queryOne<{ image: string }>(`
      SELECT a.image
      FROM assets a
      WHERE a.id = $1 AND a.deleted_at IS NULL
        AND (a.scope IN ('global','shared') OR a.owner_id = $2)
        AND (
          a.scope IN ('global','shared')
          OR EXISTS (
            SELECT 1 FROM project_asset_refs refs
            WHERE refs.asset_id = a.id AND refs.project_id = $3
          )
        )
    `, [assetId, ownerId, projectId], client);
    if (asset && isLocalImageReference(asset.image)) {
      previews[`asset/${assetId}`] = asset.image;
    }
  }

  return previews;
}

export async function getImageConversationRound(
  ownerId: string,
  projectId: string,
  conversationId: string,
  roundId: string,
): Promise<ImageConversationRoundRecord | undefined> {
  const conversation = await getImageConversation(ownerId, projectId, conversationId);
  return conversation?.rounds.find((round) => round.id === roundId);
}

export async function getImageConversationClarification(
  ownerId: string,
  projectId: string,
  conversationId: string,
  roundId: string,
): Promise<ImageConversationClarification | undefined> {
  const round = await getImageConversationRound(ownerId, projectId, conversationId, roundId);
  return round?.clarification ?? undefined;
}

/**
 * Resolve the branch context for a concrete generated result. The client may
 * select a result, but it cannot authorise or invent the requirements that
 * belong to that result; those are reconstructed from the persisted round
 * and intent snapshot.
 */
export async function resolveImageConversationContext(
  ownerId: string,
  projectId: string,
  conversationId: string,
  sourceResultId: string | null,
  inputManifest?: ConversationImageInput[],
): Promise<ImageConversationContext> {
  if (!sourceResultId) {
    return { effectiveRequirements: {}, appliedRelativeActions: [] };
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sourceResultId)) {
    throw new ImageConversationAccessError();
  }
  const sourceRef = `generation-output/${sourceResultId}`;
  if (inputManifest && inputManifest[0]?.sourceRef !== sourceRef) {
    throw new ImageConversationValidationError("source result must be the base image");
  }
  return transaction(async (client) => {
    const row = await queryOne<{
      round_effective_requirements: unknown;
      intent_requirements: unknown;
      status: ImageConversationOutputStatus;
    }>(`
      SELECT output.status,
        round.effective_requirements AS round_effective_requirements,
        intent.requirements AS intent_requirements
      FROM image_conversation_outputs output
      JOIN image_conversation_rounds round ON round.id = output.round_id
      LEFT JOIN image_conversation_intents intent ON intent.id = output.intent_id
      WHERE output.generation_output_id = $1
        AND output.owner_id = $2 AND output.project_id = $3
        AND output.conversation_id = $4
      FOR SHARE OF output
    `, [sourceResultId, ownerId, projectId, conversationId], client);
    if (!row || row.status !== "ready") throw new ImageConversationAccessError();
    return {
      sourceResultId,
      effectiveRequirements: {
        ...parseJson<Record<string, unknown>>(row.round_effective_requirements, {}),
        ...parseJson<Record<string, unknown>>(row.intent_requirements, {}),
      },
      appliedRelativeActions: [],
    };
  });
}

export function imageConversationClarificationFingerprint(answer: string): string {
  return createHash("sha256").update(answer.trim()).digest("hex");
}

/** Every resource is checked before invoking the paid planner; enqueue checks again. */
export async function authorizeImageConversationPlanning(
  input: Pick<CreateImageConversationRoundInput, "ownerId" | "projectId" | "conversationId" | "mode" | "inputManifest" | "prompt" | "parameters" | "sourceResultId" | "maskRef">,
): Promise<void> {
  const manifest = validateInputManifest(input.mode, input.inputManifest);
  await transaction(async (client) => {
    if (!await lockActiveOwner(client, input.ownerId)) throw new ImageConversationAccessError();
    await assertProjectAccess(client, input.ownerId, input.projectId);
    if (!await findConversation(client, input.ownerId, input.projectId, { conversationId: input.conversationId })) throw new ImageConversationAccessError();
    for (const image of manifest) {
      const source = normalizeSource(image.sourceRef);
      await assertSourceAccess(client, input.ownerId, input.projectId, source.sourceRef, source.sourceKind);
    }
    if (input.maskRef != null) {
      if (!isLocalImageReference(input.maskRef)) throw new ImageConversationAccessError();
      await assertSourceAccess(client, input.ownerId, input.projectId, input.maskRef, "file");
    }
  });
}

export async function createImageConversationRound(
  input: CreateImageConversationRoundInput,
): Promise<ImageConversationRoundRecord> {
  if (!input.clientRequestId.trim() || input.clientRequestId.length > 200) {
    throw new Error("clientRequestId is required");
  }
  if (!input.prompt.trim()) throw new Error("conversation prompt is required");
  if (!Array.isArray(input.inputManifest)) throw new Error("conversation input manifest is required");
  const inputManifest = validateInputManifest(input.mode, input.inputManifest);
  const parameters = { ...input.parameters };
  validateImageConversationParameters(input.mode, parameters as unknown as ImageConversationParameters);

  const fingerprint = requestFingerprint({
    mode: input.mode,
    sourceResultId: input.sourceResultId,
    inputManifest,
    prompt: input.prompt,
    parameters,
    effectiveRequirements: input.effectiveRequirements ?? {},
    incrementalRequirements: input.incrementalRequirements ?? {},
    maskRef: input.maskRef ?? null,
  });
  const storedParameters = input.plan?.kind === "ready"
    ? { ...parameters, outputCount: input.plan.outputCount }
    : parameters;
  return transaction(async (client) => {
    if (!await lockActiveOwner(client, input.ownerId)) throw new ImageConversationAccessError();
    await assertProjectAccess(client, input.ownerId, input.projectId);
    const conversation = await findConversation(client, input.ownerId, input.projectId, {
      conversationId: input.conversationId,
      lock: true,
    });
    if (!conversation) throw new ImageConversationAccessError();
    for (const image of inputManifest) {
      const source = normalizeSource(image.sourceRef);
      await assertSourceAccess(client, input.ownerId, input.projectId, source.sourceRef, source.sourceKind);
    }
    if (input.maskRef !== undefined && input.maskRef !== null) {
      if (!isLocalImageReference(input.maskRef)) throw new ImageConversationValidationError("invalid mask reference");
      await assertSourceAccess(client, input.ownerId, input.projectId, input.maskRef, "file");
    }
    const existing = await queryOne<RoundRow>(`
      SELECT id, conversation_id, owner_id, project_id, ordinal, client_request_id,
        mode, source_result_id, input_manifest, prompt, parameters,
        effective_requirements, incremental_requirements, mask_ref, status,
        created_at, updated_at, request_fingerprint
      FROM image_conversation_rounds
      WHERE owner_id = $1 AND client_request_id = $2
      FOR SHARE
    `, [input.ownerId, input.clientRequestId], client);
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) throw new ImageConversationConflictError();
      return mapRound(existing);
    }
    const ordinalRow = await queryOne<{ next_ordinal: number }>(`
      SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ordinal
      FROM image_conversation_rounds
      WHERE conversation_id = $1
    `, [conversation.id], client);
    const id = nanoid(16);
    const now = new Date().toISOString();
    await client.query(`
      INSERT INTO image_conversation_rounds (
        id, conversation_id, owner_id, project_id, ordinal, client_request_id,
        mode, source_result_id, input_manifest, prompt, parameters,
        effective_requirements, incremental_requirements, mask_ref, status,
        created_at, updated_at, request_fingerprint
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb,
        $12::jsonb, $13::jsonb, $14, $15, $16, $16, $17
      )
    `, [
      id, conversation.id, input.ownerId, input.projectId, ordinalRow?.next_ordinal ?? 1,
      input.clientRequestId, input.mode, input.sourceResultId,
      JSON.stringify(inputManifest), input.prompt.trim(), JSON.stringify(storedParameters),
      JSON.stringify(input.effectiveRequirements ?? {}), JSON.stringify(input.incrementalRequirements ?? {}),
      input.maskRef ?? null, input.status ?? "draft", now, fingerprint,
    ]);
    const created = await queryOne<RoundRow>(`
      SELECT id, conversation_id, owner_id, project_id, ordinal, client_request_id,
        mode, source_result_id, input_manifest, prompt, parameters,
        effective_requirements, incremental_requirements, mask_ref, status,
        created_at, updated_at, request_fingerprint
      FROM image_conversation_rounds WHERE id = $1
    `, [id], client);
    if (!created) throw new Error("image conversation round could not be created");
    await client.query(
      "UPDATE image_conversations SET updated_at = $2 WHERE id = $1",
      [conversation.id, now],
    );
    const intents = await query<IntentRow>(`
      SELECT id, round_id, conversation_id, ordinal, label, instruction, requirements,
        status, created_at, updated_at
      FROM image_conversation_intents WHERE round_id = $1 ORDER BY ordinal
    `, [id], client);
    let clarification: ImageConversationClarification | null = null;
    if (input.plan?.kind === "ready") {
      await insertPlanIntents(client, created, input.plan, now);
      const planned = await query<IntentRow>(`
        SELECT id, round_id, conversation_id, ordinal, label, instruction, requirements,
          status, created_at, updated_at
        FROM image_conversation_intents WHERE round_id = $1 ORDER BY ordinal
      `, [id], client);
      if (input.enqueue) {
        await enqueueImageConversationRoundInTransaction(
          client,
          input.ownerId,
          input.projectId,
          input.conversationId,
          id,
        );
      }
      const responseRow = input.enqueue
        ? await findRoundForUpdate(client, input.ownerId, input.projectId, input.conversationId, id)
        : created;
      const responseIntents = input.enqueue
        ? await query<IntentRow>(`
            SELECT id, round_id, conversation_id, ordinal, label, instruction, requirements,
              status, created_at, updated_at
            FROM image_conversation_intents WHERE round_id = $1 ORDER BY ordinal
          `, [id], client)
        : planned;
      return mapRound(responseRow ?? created, responseIntents.map((row) => mapIntent(row, [])), null);
    }
    if (input.plan?.kind === "clarification") {
      clarification = await insertClarification(client, created, input.plan, now);
    }
    return mapRound(created, intents.map((row) => mapIntent(row, [])), clarification);
  });
}

export async function applyImageConversationPlan(
  input: ApplyImageConversationPlanInput,
): Promise<ApplyImageConversationPlanResult> {
  if (input.plan.kind === "rejected") {
    throw new ImageConversationValidationError(input.plan.message);
  }
  validateImageConversationParameters(
    input.mode,
    input.parameters as unknown as ImageConversationParameters,
  );
  const context = await resolveImageConversationContext(
    input.ownerId,
    input.projectId,
    input.conversationId,
    input.sourceResultId,
    input.inputManifest,
  );
  const incrementalRequirements = incrementalRequirementsForPlan(input.plan);
  if (!input.clarificationRoundId) {
    const round = await createImageConversationRound({
      ...input,
      effectiveRequirements: context.effectiveRequirements,
      incrementalRequirements,
      status: input.plan.kind === "clarification" ? "clarification_required" : "draft",
    });
    return { round, replayed: false };
  }
  const answer = input.clarificationAnswer?.trim();
  if (!answer) throw new ImageConversationValidationError("clarification answer is required");
  if (!input.clientRequestId.trim() || input.clientRequestId.length > 200) {
    throw new ImageConversationValidationError("clientRequestId is required");
  }
  const clarificationRoundId = input.clarificationRoundId;
  const fingerprint = imageConversationClarificationFingerprint(answer);
  const result = await transaction(async (client) => {
    if (!await lockActiveOwner(client, input.ownerId)) throw new ImageConversationAccessError();
    await assertProjectAccess(client, input.ownerId, input.projectId);
    const conversation = await findConversation(client, input.ownerId, input.projectId, {
      conversationId: input.conversationId,
      lock: true,
    });
    if (!conversation) throw new ImageConversationAccessError();
    const round = await findRoundForUpdate(client, input.ownerId, input.projectId, input.conversationId, clarificationRoundId);
    if (!round) throw new ImageConversationAccessError();
    const clarification = await queryOne<ClarificationRow>(`
      SELECT id, round_id, conversation_id, owner_id, project_id, question, reason,
        requested_count, specified_intent_count, status, responses, created_at, updated_at
      FROM image_conversation_clarifications
      WHERE round_id = $1 AND owner_id = $2 AND project_id = $3
      FOR UPDATE
    `, [round.id, input.ownerId, input.projectId], client);
    if (!clarification) throw new ImageConversationAccessError();
    const responses = parseClarificationResponses(clarification.responses);
    const duplicate = responses.find((response) => response.clientRequestId === input.clientRequestId);
    if (duplicate && duplicate.fingerprint !== fingerprint) throw new ImageConversationConflictError();
    if (duplicate || responses.some((response) => response.fingerprint === fingerprint &&
      (response.question === clarification.question || (!response.question && clarification.status === "resolved")))) {
      return { roundId: round.id, replayed: true };
    }
    if (clarification.status === "resolved") {
      throw new ImageConversationConflictError("clarification has already been resolved");
    }
    const now = new Date().toISOString();
    const response: ImageConversationClarificationResponse = {
      clientRequestId: input.clientRequestId,
      question: clarification.question,
      answer,
      fingerprint,
      submittedAt: now,
    };
    const nextResponses = [...responses, response];
    if (input.plan.kind === "ready") {
      await insertPlanIntents(client, round, input.plan, now);
      await client.query(`
        UPDATE image_conversation_rounds
        SET parameters = $2::jsonb, effective_requirements = $3::jsonb,
          incremental_requirements = $4::jsonb, status = 'draft', updated_at = $5
        WHERE id = $1
      `, [
        round.id,
        JSON.stringify({ ...parseJson<Record<string, unknown>>(round.parameters, {}), outputCount: input.plan.outputCount }),
        JSON.stringify(context.effectiveRequirements),
        JSON.stringify(incrementalRequirements),
        now,
      ]);
      await client.query(`
        UPDATE image_conversation_clarifications
        SET status = 'resolved', responses = $2::jsonb, updated_at = $3
        WHERE id = $1
      `, [clarification.id, JSON.stringify(nextResponses), now]);
      if (input.enqueue) {
        await enqueueImageConversationRoundInTransaction(
          client,
          input.ownerId,
          input.projectId,
          input.conversationId,
          round.id,
        );
      }
    } else if (input.plan.kind === "clarification") {
      await client.query(`
        UPDATE image_conversation_clarifications
        SET question = $2, reason = $3, requested_count = $4,
          specified_intent_count = $5, responses = $6::jsonb, updated_at = $7
        WHERE id = $1
      `, [
        clarification.id,
        input.plan.question,
        input.plan.reason,
        input.plan.requestedCount ?? null,
        input.plan.specifiedIntentCount ?? null,
        JSON.stringify(nextResponses),
        now,
      ]);
    } else {
      throw new ImageConversationValidationError("invalid image conversation plan");
    }
    await client.query(
      "UPDATE image_conversations SET updated_at = $2 WHERE id = $1",
      [conversation.id, now],
    );
    return { roundId: round.id, replayed: false };
  });
  const round = await getImageConversationRound(input.ownerId, input.projectId, input.conversationId, result.roundId);
  if (!round) throw new Error("planned image conversation round could not be read");
  return { round, replayed: result.replayed };
}

export async function retryImageConversationIntent(
  input: RetryImageConversationIntentInput,
): Promise<RetryImageConversationIntentResult> {
  const clientRequestId = input.clientRequestId.trim();
  if (!clientRequestId || clientRequestId.length > 200) {
    throw new ImageConversationValidationError("clientRequestId is required");
  }
  const result = await transaction(async (client) => {
    if (!await lockActiveOwner(client, input.ownerId)) throw new ImageConversationAccessError();
    await assertProjectAccess(client, input.ownerId, input.projectId);
    const conversation = await findConversation(client, input.ownerId, input.projectId, {
      conversationId: input.conversationId,
      lock: true,
    });
    if (!conversation) throw new ImageConversationAccessError();
    const retry = await enqueueImageConversationIntentRetryInTransaction(
      client,
      input.ownerId,
      input.projectId,
      input.conversationId,
      input.intentId,
      clientRequestId,
    );
    await client.query(
      "UPDATE image_conversations SET updated_at = $2 WHERE id = $1",
      [conversation.id, new Date().toISOString()],
    );
    return retry;
  });
  const round = await getImageConversationRound(
    input.ownerId,
    input.projectId,
    input.conversationId,
    result.roundId,
  );
  if (!round) throw new Error("retried image conversation round could not be read");
  return {
    round,
    attemptId: result.attemptId,
    attemptNumber: result.attemptNumber,
    generationRunId: result.generationRunId,
    replayed: result.replayed,
  };
}

function incrementalRequirementsForPlan(
  plan: Exclude<ImageConversationPlan, { kind: "rejected" }>,
): Record<string, unknown> {
  if (plan.kind !== "ready") return {};
  if (plan.intents.length === 1) return { ...plan.intents[0]!.requirements };
  return {
    byIntent: plan.intents.map((intent) => ({
      ordinal: intent.ordinal,
      requirements: { ...intent.requirements },
    })),
  };
}

export async function linkImageConversationOutput(
  input: LinkImageConversationOutputInput,
): Promise<ImageConversationOutputRecord> {
  return transaction(async (client) => {
    if (!await lockActiveOwner(client, input.ownerId)) throw new ImageConversationAccessError();
    const conversation = await findConversation(client, input.ownerId, input.projectId, {
      conversationId: input.conversationId,
      lock: true,
    });
    if (!conversation) throw new ImageConversationAccessError();
    const round = await queryOne<{ id: string }>(`
      SELECT id FROM image_conversation_rounds
      WHERE id = $1 AND conversation_id = $2 AND owner_id = $3 AND project_id = $4
    `, [input.roundId, input.conversationId, input.ownerId, input.projectId], client);
    if (!round) throw new ImageConversationAccessError();
    if (input.intentId !== null) {
      const intent = await queryOne<{ id: string }>(`
        SELECT id FROM image_conversation_intents
        WHERE id = $1 AND round_id = $2 AND conversation_id = $3
          AND owner_id = $4 AND project_id = $5
      `, [input.intentId, input.roundId, input.conversationId, input.ownerId, input.projectId], client);
      if (!intent) throw new ImageConversationAccessError();
    }
    const generationOutput = await queryOne<{
      id: string; image: string; prompt: string | null; status: "success" | "error";
    }>(`
      SELECT output.id, output.image, output.prompt, output.status
      FROM generation_outputs output
      JOIN generation_runs run ON run.id = output.run_id
      WHERE output.id = $1 AND run.owner_id = $2 AND run.project_id = $3
        AND run.deleted_at IS NULL
    `, [input.generationOutputId, input.ownerId, input.projectId], client);
    if (!generationOutput) throw new ImageConversationAccessError();
    if (input.status === "ready" && generationOutput.status !== "success") {
      throw new Error("only successful generation outputs can be marked ready");
    }
    const existing = await queryOne<OutputRow>(`
      SELECT id, round_id, conversation_id, intent_id, owner_id, project_id,
        generation_output_id, image_ref, status, prompt, error, created_at
      FROM image_conversation_outputs
      WHERE generation_output_id = $1
      FOR SHARE
    `, [input.generationOutputId], client);
    if (existing) {
      if (existing.conversation_id !== input.conversationId) throw new ImageConversationConflictError();
      if (generationOutput.status === "success" && generationOutput.image) {
        await client.query(`
          INSERT INTO image_conversation_sources (
            id, conversation_id, owner_id, project_id, source_ref, source_kind, relation, created_at
          ) VALUES ($1, $2, $3, $4, $5, 'generation-output', 'generated-output', $6)
          ON CONFLICT (conversation_id, source_ref) DO NOTHING
        `, [
          nanoid(16), input.conversationId, input.ownerId, input.projectId,
          `generation-output/${input.generationOutputId}`, new Date().toISOString(),
        ]);
      }
      return mapOutput(existing);
    }
    const id = nanoid(16);
    const now = new Date().toISOString();
    await client.query(`
      INSERT INTO image_conversation_outputs (
        id, round_id, conversation_id, intent_id, owner_id, project_id,
        generation_output_id, image_ref, status, prompt, error, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [
      id, input.roundId, input.conversationId, input.intentId, input.ownerId, input.projectId,
      input.generationOutputId, input.imageRef ?? (generationOutput.image || null),
      input.status, input.prompt ?? generationOutput.prompt, input.error ?? null, now,
    ]);
    if (generationOutput.status === "success" && generationOutput.image) {
      await client.query(`
        INSERT INTO image_conversation_sources (
          id, conversation_id, owner_id, project_id, source_ref, source_kind, relation, created_at
        ) VALUES ($1, $2, $3, $4, $5, 'generation-output', 'generated-output', $6)
        ON CONFLICT (conversation_id, source_ref) DO NOTHING
      `, [
        nanoid(16), input.conversationId, input.ownerId, input.projectId,
        `generation-output/${input.generationOutputId}`, now,
      ]);
    }
    const output = await queryOne<OutputRow>(`
      SELECT id, round_id, conversation_id, intent_id, owner_id, project_id,
        generation_output_id, image_ref, status, prompt, error, created_at
      FROM image_conversation_outputs WHERE id = $1
    `, [id], client);
    if (!output) throw new Error("image conversation output could not be created");
    return mapOutput(output);
  });
}

async function assertProjectAccess(client: PoolClient, ownerId: string, projectId: string): Promise<void> {
  const project = await queryOne<{ id: string }>(`
    SELECT id FROM projects
    WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL
    FOR SHARE
  `, [projectId, ownerId], client);
  if (!project) throw new ImageConversationAccessError();
}

async function insertPlanIntents(
  client: PoolClient,
  round: RoundRow,
  plan: Extract<ImageConversationPlan, { kind: "ready" }>,
  now: string,
): Promise<void> {
  for (const intent of plan.intents) {
    await client.query(`
      INSERT INTO image_conversation_intents (
        id, round_id, conversation_id, owner_id, project_id, ordinal,
        label, instruction, requirements, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'pending', $10, $10)
    `, [
      nanoid(16), round.id, round.conversation_id, round.owner_id, round.project_id,
      intent.ordinal, intent.label, intent.instruction, JSON.stringify(intent.requirements), now,
    ]);
  }
}

async function insertClarification(
  client: PoolClient,
  round: RoundRow,
  plan: Extract<ImageConversationPlan, { kind: "clarification" }>,
  now: string,
): Promise<ImageConversationClarification> {
  const id = nanoid(16);
  await client.query(`
    INSERT INTO image_conversation_clarifications (
      id, round_id, conversation_id, owner_id, project_id, question, reason,
      requested_count, specified_intent_count, status, responses, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', '[]'::jsonb, $10, $10)
  `, [
    id, round.id, round.conversation_id, round.owner_id, round.project_id,
    plan.question, plan.reason, plan.requestedCount ?? null, plan.specifiedIntentCount ?? null, now,
  ]);
  const row = await queryOne<ClarificationRow>(`
    SELECT id, round_id, conversation_id, owner_id, project_id, question, reason,
      requested_count, specified_intent_count, status, responses, created_at, updated_at
    FROM image_conversation_clarifications WHERE id = $1
  `, [id], client);
  if (!row) throw new Error("image conversation clarification could not be created");
  return mapClarification(row);
}

async function findRoundForUpdate(
  client: PoolClient,
  ownerId: string,
  projectId: string,
  conversationId: string,
  roundId: string,
): Promise<RoundRow | undefined> {
  return queryOne<RoundRow>(`
    SELECT id, conversation_id, owner_id, project_id, ordinal, client_request_id,
      mode, source_result_id, input_manifest, prompt, parameters,
      effective_requirements, incremental_requirements, mask_ref, status,
      created_at, updated_at, request_fingerprint
    FROM image_conversation_rounds
    WHERE id = $1 AND owner_id = $2 AND project_id = $3 AND conversation_id = $4
    FOR UPDATE
  `, [roundId, ownerId, projectId, conversationId], client);
}

function parseClarificationResponses(value: unknown): ImageConversationClarificationResponse[] {
  const parsed = parseJson<unknown[]>(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (
      typeof record.clientRequestId !== "string" ||
      typeof record.answer !== "string" ||
      typeof record.fingerprint !== "string" ||
      typeof record.submittedAt !== "string"
    ) return [];
    return [{
      clientRequestId: record.clientRequestId,
      ...(typeof record.question === "string" ? { question: record.question } : {}),
      answer: record.answer,
      fingerprint: record.fingerprint,
      submittedAt: record.submittedAt,
    }];
  });
}

async function assertSourceAccess(
  client: PoolClient,
  ownerId: string,
  projectId: string,
  sourceRef: string,
  sourceKind: ImageConversationSourceKind,
): Promise<void> {
  if (sourceKind === "file") {
    if (!LOCAL_SOURCE_PATTERN.test(sourceRef) || !isLocalImageReference(sourceRef)) {
      throw new ImageConversationAccessError();
    }
    const file = await queryOne<{ owner_id: string | null; deleted_at: string | null }>(`
      SELECT f.owner_id, f.deleted_at
      FROM files f
      WHERE f.id = $1 AND f.deleted_at IS NULL
      FOR SHARE
    `, [sourceRef.slice("/api/files/".length)], client);
    if (!file) throw new ImageConversationAccessError();
    if (file.owner_id === null || file.owner_id === ownerId) return;
    const shared = await queryOne<{ id: string }>(`
      SELECT id FROM assets
      WHERE image = $1 AND deleted_at IS NULL AND scope IN ('global','shared')
      LIMIT 1 FOR SHARE
    `, [sourceRef], client);
    if (!shared) throw new ImageConversationAccessError();
    return;
  }

  const outputMatch = OUTPUT_SOURCE_PATTERN.exec(sourceRef);
  if (sourceKind === "generation-output" && outputMatch) {
    const output = await queryOne<{ id: string }>(`
      SELECT output.id
      FROM generation_outputs output
      JOIN generation_runs run ON run.id = output.run_id
      WHERE output.id = $1 AND output.status = 'success'
        AND run.owner_id = $2 AND run.project_id = $3 AND run.deleted_at IS NULL
      FOR SHARE OF run
    `, [outputMatch[1], ownerId, projectId], client);
    if (!output) throw new ImageConversationAccessError();
    return;
  }

  const assetMatch = ASSET_SOURCE_PATTERN.exec(sourceRef);
  if (sourceKind === "asset" && assetMatch) {
    const asset = await queryOne<{ id: string; image: string }>(`
      SELECT a.id, a.image
      FROM assets a
      WHERE a.id = $1 AND a.deleted_at IS NULL
        AND (a.scope IN ('global','shared') OR a.owner_id = $2)
        AND (
          a.scope IN ('global','shared')
          OR EXISTS (
            SELECT 1 FROM project_asset_refs refs
            WHERE refs.asset_id = a.id AND refs.project_id = $3
          )
        )
      FOR SHARE
    `, [assetMatch[1], ownerId, projectId], client);
    if (!asset || !isLocalImageReference(asset.image)) throw new ImageConversationAccessError();
    return;
  }

  throw new ImageConversationAccessError();
}

function normalizeSource(
  sourceRef: string,
  sourceKind?: ImageConversationSourceKind,
): { sourceRef: string; sourceKind: ImageConversationSourceKind } {
  if (typeof sourceRef !== "string" || sourceRef.trim() !== sourceRef || sourceRef.length === 0) {
    throw new ImageConversationValidationError("invalid image source reference");
  }
  const inferred: ImageConversationSourceKind | undefined = LOCAL_SOURCE_PATTERN.test(sourceRef)
    ? "file"
    : OUTPUT_SOURCE_PATTERN.test(sourceRef)
      ? "generation-output"
      : ASSET_SOURCE_PATTERN.test(sourceRef)
        ? "asset"
        : undefined;
  if (!inferred || (sourceKind !== undefined && sourceKind !== inferred)) {
    throw new ImageConversationValidationError("invalid image source reference");
  }
  return { sourceRef, sourceKind: inferred };
}


async function findConversation(
  client: PoolClient,
  ownerId: string,
  projectId: string,
  selector: { conversationId?: string; sourceRef?: string; lock?: boolean },
): Promise<ConversationRow | undefined> {
  const where = selector.conversationId
    ? "c.id = $3"
    : `(
        c.source_ref = $3
        OR EXISTS (
          SELECT 1 FROM image_conversation_sources source
          WHERE source.conversation_id = c.id
            AND source.owner_id = c.owner_id
            AND source.project_id = c.project_id
            AND source.source_ref = $3
        )
      )`;
  return queryOne<ConversationRow>(`
    SELECT c.id, c.owner_id, c.project_id, c.source_ref, c.source_kind,
      c.status, c.created_at, c.updated_at
    FROM image_conversations c
    WHERE c.owner_id = $1 AND c.project_id = $2 AND ${where}
    ORDER BY c.updated_at DESC, c.created_at DESC, c.id DESC
    ${selector.lock ? "FOR UPDATE" : ""}
  `, [ownerId, projectId, selector.conversationId ?? selector.sourceRef], client);
}

function mapConversation(
  row: ConversationRow,
  roundRows: RoundRow[] = [],
  intentRows: IntentRow[] = [],
  attemptRows: AttemptRow[] = [],
  outputRows: OutputRow[] = [],
  clarificationRows: ClarificationRow[] = [],
  sourcePreviews: Record<string, string> = {},
): ImageConversationRecord {
  const attemptsByIntent = new Map<string, ImageConversationAttemptRecord[]>();
  for (const row of attemptRows) {
    const attempt = mapAttempt(row);
    const list = attemptsByIntent.get(row.intent_id) ?? [];
    list.push(attempt);
    attemptsByIntent.set(row.intent_id, list);
  }
  const intentsByRound = new Map<string, ImageConversationIntentRecord[]>();
  for (const row of intentRows) {
    const intent = mapIntent(row, attemptsByIntent.get(row.id) ?? []);
    const list = intentsByRound.get(row.round_id) ?? [];
    list.push(intent);
    intentsByRound.set(row.round_id, list);
  }
  const clarificationByRound = new Map(
    clarificationRows.map((clarification) => [clarification.round_id, mapClarification(clarification)]),
  );
  return {
    ...mapConversationBase(row),
    sourcePreviews,
    rounds: roundRows.map((round) => mapRound(
      round,
      intentsByRound.get(round.id) ?? [],
      clarificationByRound.get(round.id) ?? null,
    )),
    outputs: outputRows.map(mapOutput),
  };
}

function mapConversationBase(row: ConversationRow): Omit<ImageConversationRecord, "rounds" | "outputs" | "sourcePreviews"> {
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    sourceRef: row.source_ref,
    sourceKind: row.source_kind,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRound(
  row: RoundRow,
  intents: ImageConversationIntentRecord[] = [],
  clarification: ImageConversationClarification | null = null,
): ImageConversationRoundRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    ordinal: row.ordinal,
    clientRequestId: row.client_request_id,
    mode: row.mode,
    sourceResultId: row.source_result_id,
    inputManifest: parseJson<ConversationImageInput[]>(row.input_manifest, []),
    prompt: row.prompt,
    parameters: parseJson<Record<string, unknown>>(row.parameters, {}),
    effectiveRequirements: parseJson<Record<string, unknown>>(row.effective_requirements, {}),
    incrementalRequirements: parseJson<Record<string, unknown>>(row.incremental_requirements, {}),
    maskRef: row.mask_ref,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    intents,
    clarification,
  };
}

function mapClarification(row: ClarificationRow): ImageConversationClarification {
  return {
    id: row.id,
    roundId: row.round_id,
    question: row.question,
    reason: row.reason,
    requestedCount: row.requested_count,
    specifiedIntentCount: row.specified_intent_count,
    status: row.status,
    responses: parseClarificationResponses(row.responses),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapIntent(row: IntentRow, attempts: ImageConversationAttemptRecord[]): ImageConversationIntentRecord {
  return {
    id: row.id,
    roundId: row.round_id,
    conversationId: row.conversation_id,
    ordinal: row.ordinal,
    label: row.label,
    instruction: row.instruction,
    requirements: parseJson<Record<string, unknown>>(row.requirements, {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attempts,
  };
}

function mapAttempt(row: AttemptRow): ImageConversationAttemptRecord {
  return {
    id: row.id,
    intentId: row.intent_id,
    roundId: row.round_id,
    conversationId: row.conversation_id,
    attemptNumber: row.attempt_number,
    clientRequestId: row.client_request_id,
    generationRunId: row.generation_run_id,
    retryOfAttemptId: row.retry_of_attempt_id,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOutput(row: OutputRow): ImageConversationOutputRecord {
  return {
    id: row.id,
    roundId: row.round_id,
    conversationId: row.conversation_id,
    intentId: row.intent_id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    generationOutputId: row.generation_output_id,
    imageRef: row.image_ref,
    status: row.status,
    prompt: row.prompt,
    error: row.error,
    createdAt: row.created_at,
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return (value as T) ?? fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function requestFingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

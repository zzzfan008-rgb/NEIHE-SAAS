import { Router, type Response, type ErrorRequestHandler } from "express";
import { requestUser } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import {
  ImageConversationExecutionError,
  ImageConversationExecutionConflictError,
} from "../engine/imageConversationExecution";
import {
  ImageConversationPlanner,
  ImageConversationPlannerError,
} from "../lib/imageConversationPlanner";
import { apiYiImageConversationPlannerModel } from "../providers/imageConversationPlanner";
import {
  applyImageConversationPlan,
  authorizeImageConversationPlanning,
  createImageConversationRound,
  createOrResolveImageConversation,
  getImageConversation,
  getImageConversationRound,
  ImageConversationAccessError,
  ImageConversationConflictError,
  ImageConversationValidationError,
  retryImageConversationIntent,
  resolveImageConversation,
  resolveImageConversationContext,
} from "../lib/imageConversationStore";
import { reconcileImageConversationRun } from "../engine/imageConversationReconciliation";
import { ActiveRunLimitError } from "../engine/runQueue";
import type {
  ConversationImageInput,
  ImageConversationMode,
  ImageConversationParameters,
} from "../../src/types/imageConversation";
import { validateImageConversationParameters } from "../../src/lib/imageConversationRules";
import { pendingImageConversationRequestIds, reserveImageConversationRequest, settleImageConversationRequest } from "../lib/imageConversationRequests";

export const imageConversationsRouter = Router();
const defaultPlanner = new ImageConversationPlanner(apiYiImageConversationPlannerModel);

imageConversationsRouter.get("/resolve", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const projectId = requiredQueryString(req.query.projectId);
  const sourceRef = requiredQueryString(req.query.sourceRef);
  if (!projectId || !sourceRef) {
    res.status(400).json({ error: "projectId and sourceRef are required" });
    return;
  }
  const conversation = await resolveImageConversation(user.id, projectId, sourceRef);
  if (!conversation) {
    res.status(404).json({ error: "image conversation not found" });
    return;
  }
  const hydrated = await getImageConversation(user.id, projectId, conversation.id);
  res.json(serializeConversation(hydrated ?? conversation));
}));

imageConversationsRouter.post("/", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const body = req.body as Record<string, unknown>;
  const projectId = requiredBodyString(body.projectId);
  const sourceRef = requiredBodyString(body.sourceRef);
  if (!projectId || !sourceRef) {
    res.status(400).json({ error: "projectId and sourceRef are required" });
    return;
  }
  try {
    const conversation = await createOrResolveImageConversation({
      ownerId: user.id,
      projectId,
      sourceRef,
      sourceKind: optionalSourceKind(body.sourceKind),
      startNew: body.startNew === true,
    });
    res.status(201).json(serializeConversation(conversation));
  } catch (error) {
    respondStoreError(res, error);
  }
}));

imageConversationsRouter.get("/:conversationId/rounds/:roundId", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const projectId = requiredQueryString(req.query.projectId);
  if (!projectId) {
    res.status(400).json({ error: "projectId is required" });
    return;
  }
  const round = await getImageConversationRound(
    user.id,
    projectId,
    req.params.conversationId,
    req.params.roundId,
  );
  if (!round) {
    res.status(404).json({ error: "image conversation round not found" });
    return;
  }
  res.json(serializeRound(round));
}));

imageConversationsRouter.get("/:conversationId", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const projectId = requiredQueryString(req.query.projectId);
  if (!projectId) {
    res.status(400).json({ error: "projectId is required" });
    return;
  }
  const conversation = await getImageConversation(user.id, projectId, req.params.conversationId);
  if (!conversation) {
    res.status(404).json({ error: "image conversation not found" });
    return;
  }
  res.json(serializeConversation(conversation));
}));

imageConversationsRouter.post("/:conversationId/rounds/:roundId/reconcile", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const projectId = requiredBodyString((req.body as Record<string, unknown>).projectId);
  if (!projectId) {
    res.status(400).json({ error: "projectId is required" });
    return;
  }
  const round = await getImageConversationRound(
    user.id,
    projectId,
    req.params.conversationId,
    req.params.roundId,
  );
  if (!round) {
    res.status(404).json({ error: "image conversation round not found" });
    return;
  }
  const runIds = round.intents.flatMap((intent) => intent.attempts)
    .map((attempt) => attempt.generationRunId)
    .filter((runId): runId is string => Boolean(runId));
  for (const runId of runIds) {
    await reconcileImageConversationRun(runId);
  }
  const refreshed = await getImageConversationRound(
    user.id,
    projectId,
    req.params.conversationId,
    req.params.roundId,
  );
  if (!refreshed) {
    res.status(404).json({ error: "image conversation round not found" });
    return;
  }
  res.json({ round: serializeRound(refreshed) });
}));

imageConversationsRouter.post("/:conversationId/rounds", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const body = req.body as Record<string, unknown>;
  const projectId = requiredBodyString(body.projectId);
  const clientRequestId = requiredBodyString(body.clientRequestId);
  const mode = body.mode;
  const inputManifest = body.inputManifest;
  const prompt = requiredBodyString(body.prompt);
  const parameters = recordBody(body.parameters);
  if (
    !projectId || !clientRequestId || !isConversationMode(mode) ||
    !Array.isArray(inputManifest) || !prompt || !parameters
  ) {
    res.status(400).json({ error: "projectId, clientRequestId, mode, inputManifest, prompt and parameters are required" });
    return;
  }
  try {
    const round = await createImageConversationRound({
      ownerId: user.id,
      projectId,
      conversationId: req.params.conversationId,
      clientRequestId,
      mode,
      sourceResultId: optionalNullableString(body.sourceResultId),
      inputManifest: inputManifest as ConversationImageInput[],
      prompt,
      parameters,
      effectiveRequirements: recordBody(body.effectiveRequirements) ?? {},
      incrementalRequirements: recordBody(body.incrementalRequirements) ?? {},
      maskRef: optionalNullableString(body.maskRef),
    });
    res.status(201).json(serializeRound(round));
  } catch (error) {
    respondStoreError(res, error);
  }
}));

imageConversationsRouter.post("/:conversationId/rounds/plan", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const body = req.body as Record<string, unknown>;
  const projectId = requiredBodyString(body.projectId);
  const clientRequestId = requiredBodyString(body.clientRequestId);
  let mode = body.mode as ImageConversationMode;
  let inputManifest = body.inputManifest;
  let prompt = requiredBodyString(body.prompt);
  let parameters = recordBody(body.parameters);
  const clarificationRoundId = optionalNullableString(body.clarificationRoundId);
  const clarificationAnswer = optionalNullableString(body.clarificationAnswer);
  if (
    !projectId || !clientRequestId || clientRequestId.length > 200 || !isConversationMode(mode) ||
    !Array.isArray(inputManifest) || !prompt || !parameters
  ) {
    res.status(400).json({ requestSettled: true, error: "projectId, clientRequestId, mode, inputManifest, prompt and parameters are required" });
    return;
  }
  if (clarificationRoundId && !clarificationAnswer) {
    res.status(400).json({ requestSettled: true, error: "clarificationAnswer is required" });
    return;
  }
  const identity = { ownerId: user.id, projectId, conversationId: req.params.conversationId, clientRequestId };
  let reserved = false;
  let applying = false;
  const finish = async (status: number, response: Record<string, unknown>) => {
    const settled = { ...response, requestSettled: true };
    if (reserved) await settleImageConversationRequest(identity, { status, body: settled });
    res.status(status).json(settled);
  };
  try {
    let sourceResultId = optionalNullableString(body.sourceResultId);
    let maskRef = optionalNullableString(body.maskRef);
    let clarificationHistory: Array<{ question: string; answer: string }> | undefined;
    const persisted = clarificationRoundId ? await getImageConversationRound(
      user.id, projectId, req.params.conversationId, clarificationRoundId,
    ) : undefined;
    if (clarificationRoundId) {
      if (!persisted?.clarification) throw new ImageConversationAccessError();
      mode = persisted.mode;
      inputManifest = persisted.inputManifest;
      prompt = persisted.prompt;
      parameters = persisted.parameters;
      sourceResultId = persisted.sourceResultId;
      maskRef = persisted.maskRef;
      clarificationHistory = [
        ...persisted.clarification.responses.map((response) => ({
          question: (response as typeof response & { question?: string }).question ?? "此前的澄清问题（旧记录未保存原问题）",
          answer: response.answer,
        })),
        { question: persisted.clarification.question, answer: clarificationAnswer! },
      ];
    }
    await authorizeImageConversationPlanning({
      ...identity, mode, inputManifest: inputManifest as ConversationImageInput[], prompt, parameters,
      sourceResultId, maskRef,
    });
    if (mode === "mask" && !maskRef) {
      throw new ImageConversationValidationError("mask reference is required for mask mode");
    }
    // A crash can occur after the round transaction commits but before its response
    // cache is settled. Recover that evidence without invoking the planner again.
    const pendingIds = await pendingImageConversationRequestIds(identity);
    if (pendingIds.length) {
      const history = await getImageConversation(user.id, projectId, req.params.conversationId);
      for (const pendingId of pendingIds) {
        const accepted = history?.rounds.find((round) => round.clientRequestId === pendingId ||
          round.clarification?.responses.some((response) => response.clientRequestId === pendingId));
        if (accepted) await settleImageConversationRequest({ ...identity, clientRequestId: pendingId }, {
          status: 200, body: { kind: "replayed", replayed: true, requestSettled: true, round: serializeRound(accepted) },
        });
      }
    }
    const reservation = await reserveImageConversationRequest(identity, body);
    if (reservation.kind === "settled") {
      res.status(reservation.status).json({ ...reservation.body, replayed: true });
      return;
    }
    if (reservation.kind === "pending") {
      res.status(409).json({ code: "request_in_progress", requestSettled: false, error: "Planning request is still pending" });
      return;
    }
    reserved = true;
    if (persisted) {
      const current = await getImageConversationRound(user.id, projectId, req.params.conversationId, persisted.id);
      if (current?.clarification?.updatedAt !== persisted.clarification?.updatedAt) {
        await finish(409, { code: "clarification_changed", error: "clarification changed while submitting; reload the current question" });
        return;
      }
    }
    if (persisted?.clarification?.status === "resolved") {
      await finish(409, { error: "clarification has already been resolved" });
      return;
    }
    validateImageConversationParameters(
      mode,
      parameters as unknown as ImageConversationParameters,
    );
    const sourceContext = await resolveImageConversationContext(
      user.id,
      projectId,
      req.params.conversationId,
      sourceResultId,
      inputManifest as ConversationImageInput[],
    );
    const planner = req.app.locals.imageConversationPlanner instanceof ImageConversationPlanner
      ? req.app.locals.imageConversationPlanner as ImageConversationPlanner
      : defaultPlanner;
    const plan = await planner.plan({
      mode,
      prompt,
      clarificationAnswer: clarificationAnswer ?? undefined,
      clarificationHistory,
      sourceResultId,
      inputManifest: inputManifest as ConversationImageInput[],
      parameters: parameters as unknown as ImageConversationParameters,
      effectiveRequirements: sourceContext.effectiveRequirements,
    });
    if (plan.kind === "rejected") {
      await finish(422, { kind: plan.kind, code: plan.code, message: plan.message });
      return;
    }
    applying = true;
    const result = await applyImageConversationPlan({
      ownerId: user.id,
      projectId,
      conversationId: req.params.conversationId,
      clientRequestId,
      mode,
      sourceResultId,
      inputManifest: inputManifest as ConversationImageInput[],
      prompt,
      parameters,
      effectiveRequirements: sourceContext.effectiveRequirements,
      incrementalRequirements: recordBody(body.incrementalRequirements) ?? {},
      maskRef,
      plan,
      clarificationRoundId: clarificationRoundId ?? undefined,
      clarificationAnswer: clarificationAnswer ?? undefined,
      enqueue: true,
    });
    await finish(result.replayed ? 200 : plan.kind === "clarification" ? 200 : 202, {
      kind: plan.kind,
      plan,
      replayed: result.replayed,
      round: serializeRound(result.round),
    });
  } catch (error) {
    if (error instanceof ImageConversationPlannerError) {
      await finish(error.code === "timeout" || error.code === "model_error" ? 502 : 422, {
        error: error.message,
        code: error.code,
      });
      return;
    }
    if (error instanceof ActiveRunLimitError) {
      // Enqueue rolled back the entire round; unlike a connection failure this is settled.
      await finish(429, { code: "active_run_limit", error: error.message });
      return;
    }
    if (error instanceof ImageConversationExecutionConflictError) {
      await finish(409, { error: error.message });
      return;
    }
    if (error instanceof ImageConversationExecutionError) {
      await finish(400, { error: error.message });
      return;
    }
    if (error instanceof ImageConversationAccessError) await finish(404, { error: "image conversation not found" });
    else if (error instanceof ImageConversationConflictError) await finish(409, { error: error.message });
    else if (error instanceof ImageConversationValidationError || (!applying && error instanceof Error &&
      /required|invalid|must be|between|mode|quality|size|source/i.test(error.message))) {
      await finish(400, { error: error.message });
    } else {
      // Applying may have committed before the connection failed. Never permit another paid call.
      res.status(503).json({ code: "request_in_progress", requestSettled: false, error: "Planning request requires recovery" });
    }
  }
}));

imageConversationsRouter.post("/:conversationId/intents/:intentId/retry", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const body = req.body as Record<string, unknown>;
  const projectId = requiredBodyString(body.projectId);
  const clientRequestId = requiredBodyString(body.clientRequestId);
  if (!projectId || !clientRequestId) {
    res.status(400).json({ error: "projectId and clientRequestId are required" });
    return;
  }
  try {
    const result = await retryImageConversationIntent({
      ownerId: user.id,
      projectId,
      conversationId: req.params.conversationId,
      intentId: req.params.intentId,
      clientRequestId,
    });
    res.status(result.replayed ? 200 : 202).json({
      replayed: result.replayed,
      attemptId: result.attemptId,
      attemptNumber: result.attemptNumber,
      generationRunId: result.generationRunId,
      round: serializeRound(result.round),
    });
  } catch (error) {
    if (error instanceof ImageConversationExecutionConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof ImageConversationExecutionError) {
      res.status(400).json({ error: error.message });
      return;
    }
    respondStoreError(res, error);
  }
}));

const imageConversationErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  try {
    respondStoreError(res, error);
  } catch (unhandled) {
    next(unhandled);
  }
};
imageConversationsRouter.use(imageConversationErrorHandler);

function respondStoreError(res: Response, error: unknown): void {
  if (error instanceof ImageConversationAccessError) {
    res.status(404).json({ error: "image conversation or source not found" });
    return;
  }
  if (error instanceof ImageConversationConflictError) {
    res.status(409).json({ error: error.message });
    return;
  }
  if (error instanceof ImageConversationValidationError) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof Error && /required|invalid|must be|between|mode|quality|size|source/i.test(error.message)) {
    res.status(400).json({ error: error.message });
    return;
  }
  throw error;
}

function serializeConversation(conversation: Awaited<ReturnType<typeof getImageConversation>>): unknown {
  if (!conversation) return conversation;
  return {
    id: conversation.id,
    ownerId: conversation.ownerId,
    projectId: conversation.projectId,
    sourceRef: conversation.sourceRef,
    sourceKind: conversation.sourceKind,
    status: conversation.status,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    sourcePreviews: conversation.sourcePreviews,
    rounds: conversation.rounds.map(serializeRound),
    outputs: conversation.outputs,
  };
}

function serializeRound(round: NonNullable<Awaited<ReturnType<typeof getImageConversationRound>>>): unknown {
  return {
    id: round.id,
    conversationId: round.conversationId,
    ownerId: round.ownerId,
    projectId: round.projectId,
    ordinal: round.ordinal,
    clientRequestId: round.clientRequestId,
    mode: round.mode,
    sourceResultId: round.sourceResultId,
    inputManifest: round.inputManifest,
    prompt: round.prompt,
    parameters: round.parameters,
    effectiveRequirements: round.effectiveRequirements,
    incrementalRequirements: round.incrementalRequirements,
    maskRef: round.maskRef,
    status: round.status,
    createdAt: round.createdAt,
    updatedAt: round.updatedAt,
    intents: round.intents,
    clarification: round.clarification,
  };
}

function requiredQueryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requiredBodyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNullableString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordBody(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalSourceKind(value: unknown): "file" | "generation-output" | "asset" | undefined {
  return value === "file" || value === "generation-output" || value === "asset" ? value : undefined;
}

function isConversationMode(value: unknown): value is ImageConversationMode {
  return value === "single" || value === "fusion" || value === "mask";
}

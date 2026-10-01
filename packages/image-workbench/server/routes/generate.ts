/**
 * POST /api/generate  { clientRequestId, modelId, kind?, request: ImageGenRequest, projectId? } → 202 { runId, status }
 * 请求事务入队后立即返回，由 PostgreSQL Worker 根据参考图选择生成或编辑。
 */
import { Router } from "express";
import {
  MASK_PIPELINE_VERSION,
  MAX_MASK_USER_REFERENCE_IMAGES,
  MAX_REFERENCE_IMAGES,
  MAX_VIRTUAL_TRY_ON_REFERENCE_IMAGES,
  NODE_SPECS,
  type ImageGenRequest,
  type NodeKind,
} from "../../src/types/workflow";
import { postProcessGeneratedOutputImages } from "../engine/runner";
import { EXACT_ASPECT_DIMENSIONS } from "../lib/imagePostProcessing";
import { requestUser } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import {
  ActiveRunLimitError,
  assertGenerationOwnerActive,
  CLIENT_REQUEST_ID_PATTERN,
  enqueueGenerationRunInTransaction,
  GenerationOwnerUnavailableError,
  GenerationRequestConflictError,
} from "../engine/runQueue";
import { queryOne, transaction } from "../lib/database";
import {
  assertImageReferencesAccessible,
  ImageReferenceAccessError,
} from "../lib/imageReferenceAccess";
import {
  defaultImageModelOptions,
  imageModelOptionsError,
  isImageModelId,
  isModelAllowedForNode,
  modelMaxReferenceImages,
} from "../../src/types/imageModels";

export const generateRouter = Router();

export type DirectGenerateKind = Exclude<NodeKind, "image-input" | "result" | "ai-styling">;

export type DirectGenerateValidation =
  | { ok: true; kind?: DirectGenerateKind }
  | { ok: false; error: string };

function isDirectGenerateKind(value: unknown): value is DirectGenerateKind {
  if (value === "ai-styling") return false;
  if (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(NODE_SPECS, value)) return false;
  return Boolean(NODE_SPECS[value as NodeKind].providerId);
}

/** Validate the node contract before starting or recording a direct generation. */
export function validateDirectGenerateRequest(
  kind: unknown,
  request: ImageGenRequest,
): DirectGenerateValidation {
  // Backward compatibility: legacy direct callers did not send a node kind.
  if (kind === undefined) return { ok: true };
  if (kind === "character-board") return { ok: false, error: "character-board uses uploaded input and a protected prompt; use /api/run-plan" };
  if (kind === "ai-styling") {
    return { ok: false, error: "ai-styling requires saved references and outfit analysis; use /api/run-plan" };
  }
  if (kind === "sketch-optimize") {
    return { ok: false, error: "sketch-optimize requires the protected node prompt; use /api/run-plan" };
  }
  if (kind === "background-extract" && request.referenceImages?.length !== 1) {
    return { ok: false, error: "background-extract requires exactly one image" };
  }
  if (!isDirectGenerateKind(kind)) {
    return { ok: false, error: "kind must identify a supported AI node" };
  }
  if (kind === "sketch-to-render" || kind === "ai-modify") {
    if (
      typeof request.aspectRatio !== "string"
      || !Object.prototype.hasOwnProperty.call(EXACT_ASPECT_DIMENSIONS, request.aspectRatio)
    ) {
      return {
        ok: false,
        error: `request.aspectRatio must be one of ${Object.keys(EXACT_ASPECT_DIMENSIONS).join(", ")}`,
      };
    }
  }
  if (
    (kind === "upscale" || kind === "virtual-try-on")
    && request.imageSize !== "2K" && request.imageSize !== "4K"
  ) {
    return { ok: false, error: "request.imageSize must be 2K or 4K" };
  }
  if (
    kind === "mask-redraw"
    && (request.referenceImages?.length ?? 0) > MAX_MASK_USER_REFERENCE_IMAGES
  ) {
    return {
      ok: false,
      error: `request.referenceImages must contain at most ${MAX_MASK_USER_REFERENCE_IMAGES} user images for mask-redraw`,
    };
  }
  return { ok: true, kind };
}

/** Keep the direct endpoint on the same business output guarantees as the DAG runner. */
export function postProcessDirectGenerateImages(
  kind: DirectGenerateKind | undefined,
  request: ImageGenRequest,
  images: string[],
  sourceImage = request.referenceImages?.[0],
): Promise<string[]> {
  if (!kind) return Promise.resolve(images);
  return postProcessGeneratedOutputImages(
    kind,
    request as unknown as Record<string, unknown>,
    images,
    sourceImage,
  );
}

generateRouter.post("/", asyncHandler(async (req, res) => {
  const {
    providerId, modelId: requestedModelId, request, projectId, nodeId, nodeLabel, kind, clientRequestId,
  } = req.body as {
    providerId?: string; modelId?: string;
    request?: ImageGenRequest;
    projectId?: string; nodeId?: string; nodeLabel?: string; kind?: string; clientRequestId?: string;
  };
  const modelId = requestedModelId ?? providerId;
  if (!modelId || !request?.prompt) {
    res.status(400).json({ error: "modelId and request.prompt are required" });
    return;
  }
  if (!isImageModelId(modelId)) {
    res.status(400).json({ error: "modelId must identify a supported API易 image model" });
    return;
  }
  const validation = validateDirectGenerateRequest(kind, request);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }
  const resolvedKind = validation.kind ?? (modelId === "gpt-image-2" ? "mask-redraw" : "sketch-to-render");
  if (!isModelAllowedForNode(modelId, resolvedKind)) {
    res.status(400).json({ error: `${modelId} is not allowed for ${resolvedKind}` });
    return;
  }
  const maskSourceRef = request.referenceImages?.[0];
  if (
    resolvedKind === "mask-redraw" &&
    (typeof maskSourceRef !== "string" || !maskSourceRef.trim() || typeof request.mask !== "string" || !request.mask.trim())
  ) {
    res.status(400).json({ error: "mask-redraw requires a source image and PNG mask" });
    return;
  }
  const maxReferences = Math.min(
    resolvedKind === "virtual-try-on" ? MAX_VIRTUAL_TRY_ON_REFERENCE_IMAGES : MAX_REFERENCE_IMAGES,
    modelMaxReferenceImages(modelId),
  );
  const maxUserReferences = resolvedKind === "mask-redraw"
    ? Math.min(MAX_MASK_USER_REFERENCE_IMAGES, Math.max(0, maxReferences - 1))
    : maxReferences;
  if (request.referenceImages && request.referenceImages.length > maxUserReferences) {
    const qualifier = resolvedKind === "mask-redraw" ? " user" : "";
    res.status(400).json({
      error: `referenceImages must contain at most ${maxUserReferences}${qualifier} images for ${modelId}`,
    });
    return;
  }
  const modelOptions = request.modelOptions ?? defaultImageModelOptions(modelId, request.aspectRatio);
  const optionsError = imageModelOptionsError(modelId, modelOptions);
  if (optionsError) {
    res.status(400).json({ error: `request.modelOptions ${optionsError}` });
    return;
  }
  if (projectId !== undefined && (typeof projectId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(projectId))) {
    res.status(400).json({ error: "projectId must contain only letters, digits, underscore or hyphen" });
    return;
  }
  if (typeof clientRequestId !== "string" || !CLIENT_REQUEST_ID_PATTERN.test(clientRequestId)) {
    res.status(400).json({ error: "clientRequestId is required" });
    return;
  }
  const requestedCount = Math.max(1, Math.min(8, Number(request.batchSize) || 1));
  const user = requestUser(req);
  const resolvedNodeId = nodeId ?? "direct-generate";
  const { maskMode: _legacyMaskMode, ...requestWithoutLegacyMaskMode } = request as ImageGenRequest & {
    maskMode?: unknown;
  };
  const resolvedRequest: ImageGenRequest = {
    ...requestWithoutLegacyMaskMode,
    modelOptions,
  };
  const plan = {
    steps: [{
      nodeId: resolvedNodeId,
      kind: resolvedKind,
      inputImages: request.referenceImages ?? [],
      params: {
        ...resolvedRequest,
        modelId,
        ...(resolvedKind === "mask-redraw" ? { maskSourceRef, maskPipelineVersion: MASK_PIPELINE_VERSION } : {}),
      },
    }],
  };
  try {
    const outcome = await transaction(async (client) => {
      // 与账号转移/删除统一 user → project → assets → files → run 的锁顺序。
      await assertGenerationOwnerActive(client, user.id);
      let serverProjectName: string | undefined;
      if (projectId) {
        const project = await queryOne<{ owner_id: string; name: string }>(`
          SELECT owner_id, name FROM projects
          WHERE id = $1 AND deleted_at IS NULL AND lifecycle = 'saved'
          FOR SHARE
        `, [projectId], client);
        if (!project) return { status: "not_found" as const };
        if (project.owner_id !== user.id) return { status: "forbidden" as const };
        serverProjectName = project.name;
      }
      await assertImageReferencesAccessible(plan, user.id, client);
      const run = await enqueueGenerationRunInTransaction(client, plan, user.id, {
        userId: user.id,
        clientRequestId,
        projectId,
        projectName: serverProjectName,
        nodeId: resolvedNodeId,
        nodeLabel: nodeLabel ?? "直接生成",
        kind: resolvedKind,
        prompt: request.prompt,
        parameters: plan.steps[0].params,
        referenceImages: request.referenceImages,
        requestedCount,
      }, "direct");
      return { status: "queued" as const, runId: run.id };
    });
    if (outcome.status === "not_found") {
      res.status(404).json({ error: "项目不存在或已删除" });
    } else if (outcome.status === "forbidden") {
      res.status(403).json({ error: "无权把直接生成任务写入此项目" });
    } else {
      res.status(202).json({ runId: outcome.runId, status: "queued" });
    }
  } catch (error) {
    if (error instanceof ImageReferenceAccessError) {
      res.status(403).json({ error: error.message });
      return;
    }
    if (error instanceof GenerationRequestConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof ActiveRunLimitError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof GenerationOwnerUnavailableError) {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
}));

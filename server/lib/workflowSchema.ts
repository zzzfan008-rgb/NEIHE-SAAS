import {
  WORKFLOW_SCHEMA_VERSION,
  MAX_REFERENCE_IMAGES,
  NODE_SPECS,
  type NodeKind,
  type PersistedWorkflow,
  type PersistedWorkflowEdge,
  type PersistedWorkflowNode,
  type WorkflowInputRole,
  type WorkflowNodeData,
  BATCH_SIZES,
} from "../../src/types/workflow";
import {
  createDocumentSnapshot,
  documentSnapshotToPersistedWorkflow,
} from "../../src/lib/documentSnapshot";
import { isLocalImageReference, validateImageDataUrl } from "./imageValidation";
import { isLocalMediaReference } from "./fileStore";
import {
  MASK_REDRAW_MODEL_ID,
  defaultImageModelOptions,
  getImageModelContract,
  imageModelOptionsError,
  isImageModelId,
  isModelAllowedForNode,
  normalizeImageModelOptions,
} from "../../src/types/imageModels";
import {
  connectionCompatibilityError,
  inputPortFor,
} from "../../src/lib/workflowPorts";
import { MASK_REPAIR_FOCUSES } from "../../src/lib/maskRepair";
import {
  SEEDANCE_MODEL_CAPABILITIES,
  SEEDANCE_OUTPUT_FORMATS,
  SEEDANCE_RATIOS,
  SEEDANCE_RESOLUTIONS,
  SEEDANCE_VIDEO_MODES,
  SEEDANCE_VIDEO_MODELS,
  isSeedanceVideoModel,
  normalizedSeedanceSettings,
  seedanceModeRequiresAdaptive,
} from "../../src/lib/seedance";

const NODE_KINDS: readonly NodeKind[] = [
  "outfit-reference",
  "ai-styling",
  "image-input",
  "text-input",
  "drawing-board",
  "color-palette",
  "stage-approval",
  "video-input",
  "audio-input",
  "video-generate",
  "sketch-to-render",
  "ai-modify",
  "fabric-recolor",
  "upscale",
  "print-extract",
  "print-mutate",
  "virtual-try-on",
  "mask-redraw",
  "result",
];
const STATUSES = [
  "idle", "queued", "running", "retry_wait", "cancel_requested",
  "success", "error", "outcome_unknown", "cancelled",
] as const;
const IMAGE_ROLES = ["default", "sketch", "garment", "fabric", "reference"] as const;
const ASPECT_RATIOS = ["1:1", "4:5", "3:4", "4:3", "2:3", "9:16", "16:9"] as const;
const IMAGE_SIZES = ["2K", "4K"] as const;
const VIRTUAL_TRY_ON_STAGES = ["standard", "scene-stabilize", "garment-refine"] as const;
const GARMENT_CATEGORIES = ["knit", "woven", "other"] as const;
const TRY_ON_QUALITY_MODES = ["fast", "balanced", "best"] as const;
const FABRIC_OPERATION_MODES = ["combined", "fabric", "color"] as const;
const COLOR_SWATCH_SOURCES = [
  "quick", "custom", "recent", "favorite", "eyedropper", "pantone", "brand",
] as const;
const WORKFLOW_INPUT_ROLES: readonly WorkflowInputRole[] = [
  "person", "scene", "outfit", "bag", "shoes", "hat", "ring", "earrings", "bracelet",
  "detail", "material", "baseline-candidate", "baseline", "palette", "prompt", "references",
  "first-frame", "last-frame", "source-video", "repair-source", "eyewear", "neckwear", "belt", "watch",
  "reference-image", "reference-video", "reference-audio",
];
const MASK_REPAIR_EXECUTION_MODES = ["repair", "bypass"] as const;
const BOARD_MIN_SIDE = 256;
const BOARD_MAX_SIDE = 4096;
export const MAX_WORKFLOW_NODES = 500;
const MAX_EDGES = 2_000;
const MAX_TEXT_LENGTH = 20_000;
const MAX_IMAGE_REFERENCE_LENGTH = 20_000;
const MAX_IMAGE_REFS = 100;
const MAX_AUTO_CONNECT_TARGETS = 16;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ASSET_REFERENCE = /^asset:\/\/[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MASK_DATA_URL_CONTRACT = (() => {
  const contract = getImageModelContract(MASK_REDRAW_MODEL_ID).edit.mask;
  if (!contract) throw new Error(`${MASK_REDRAW_MODEL_ID} 缺少蒙版契约`);
  return contract;
})();

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new WorkflowValidationError(`${path}: ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function stringValue(value: unknown, path: string, opts?: { nonEmpty?: boolean }): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (opts?.nonEmpty && value.trim().length === 0) fail(path, "must not be empty");
  if (value.length > MAX_TEXT_LENGTH) fail(path, `must be at most ${MAX_TEXT_LENGTH} characters`);
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, path);
}

interface ImageReferenceOptions {
  maxDataUrlBytes?: number;
  allowedDataUrlMimes?: readonly string[];
}

function imageReference(value: unknown, path: string, opts?: ImageReferenceOptions): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (value.trim().length === 0) fail(path, "must not be empty");
  const ref = value;
  if (ref.startsWith("data:")) {
    let mime = "";
    try {
      mime = validateImageDataUrl(ref, opts?.maxDataUrlBytes).mime;
    } catch (error) {
      fail(path, error instanceof Error ? error.message : "invalid image dataURL");
    }
    if (opts?.allowedDataUrlMimes && !opts.allowedDataUrlMimes.includes(mime)) {
      fail(path, `dataURL MIME must be one of: ${opts.allowedDataUrlMimes.join(", ")}`);
    }
    return ref;
  }
  if (ref.length > MAX_IMAGE_REFERENCE_LENGTH) {
    fail(path, `must be at most ${MAX_IMAGE_REFERENCE_LENGTH} characters`);
  }
  const isRemote = /^https?:\/\//i.test(ref);
  if (!isLocalImageReference(ref) && !isRemote && !ASSET_REFERENCE.test(ref)) {
    fail(path, "must be an image dataURL, local /api/files reference, http(s) URL, or asset:// reference");
  }
  return ref;
}

function optionalImageReference(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : imageReference(value, path);
}

function optionalMaskReference(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(path, "must be a string");
  if (value.startsWith("data:")) {
    return imageReference(value, path, {
      maxDataUrlBytes: MASK_DATA_URL_CONTRACT.maxBytes,
      allowedDataUrlMimes: MASK_DATA_URL_CONTRACT.mimeTypes,
    });
  }
  if (!isLocalImageReference(value) || !value.toLowerCase().endsWith(".png")) {
    fail(path, "must be an inline PNG dataURL or local /api/files/*.png reference");
  }
  return imageReference(value, path);
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number");
  return value;
}

function boundedInteger(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail(path, `must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function optionalNonNegativeInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  return boundedInteger(value, path, 0, Number.MAX_SAFE_INTEGER);
}

function oneOf<T extends string | number>(value: unknown, allowed: readonly T[], path: string): T {
  if (!allowed.includes(value as T)) fail(path, `must be one of: ${allowed.join(", ")}`);
  return value as T;
}

function stringArray(value: unknown, path: string, max = MAX_IMAGE_REFS): string[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length > max) fail(path, `must contain at most ${max} items`);
  return value.map((item, index) => stringValue(item, `${path}[${index}]`, { nonEmpty: true }));
}

function imageReferenceArray(value: unknown, path: string, max = MAX_IMAGE_REFS): string[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length > max) fail(path, `must contain at most ${max} items`);
  return value.map((item, index) => imageReference(item, `${path}[${index}]`));
}

function mediaReference(value: unknown, path: string): string {
  if (typeof value === "string" && isLocalMediaReference(value)) return value;
  return imageReference(value, path);
}

function seedanceRemoteMediaReference(value: unknown, path: string): string {
  const ref = stringValue(value, path, { nonEmpty: true });
  if (ref.length > MAX_IMAGE_REFERENCE_LENGTH) fail(path, `must be at most ${MAX_IMAGE_REFERENCE_LENGTH} characters`);
  if (!/^https:\/\//i.test(ref) && !ASSET_REFERENCE.test(ref) && !isLocalMediaReference(ref)) {
    fail(path, "must be a local media reference, HTTPS URL, or asset:// reference");
  }
  return ref;
}

function mediaReferenceArray(value: unknown, path: string, max = MAX_IMAGE_REFS): string[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length > max) fail(path, `must contain at most ${max} items`);
  return value.map((item, index) => mediaReference(item, `${path}[${index}]`));
}

function migratedModelFields(
  kind: NodeKind,
  raw: Record<string, unknown>,
  preferredAspectRatio = "1:1",
): Record<string, unknown> {
  const fallback = kind === "mask-redraw" || kind === "virtual-try-on"
    ? "gpt-image-2"
    : "gpt-image-2-vip";
  if (raw.modelId !== undefined) {
    const modelId = raw.modelId === "gemini-3.1-flash-image-preview"
      ? "gemini-3.1-flash-image" : raw.modelId;
    return {
      modelId,
      modelOptions: raw.modelOptions === undefined && isImageModelId(modelId)
        ? defaultImageModelOptions(modelId, preferredAspectRatio)
        : raw.modelOptions,
    };
  }
  return {
    modelId: fallback,
    modelOptions: defaultImageModelOptions(fallback, preferredAspectRatio),
  };
}

function migrateNodeData(kind: NodeKind, raw: Record<string, unknown>): Record<string, unknown> {
  // v0/v1 文件保留现有值，只补后来新增且运行时依赖的确定性默认字段。
  switch (kind) {
    case "outfit-reference":
      return { images: [], mainImage: null, ...raw };
    case "ai-styling":
      return { prompt: "", aspectRatio: "3:4", batchSize: 1, preserve: null,
        extras: { outerwear: false, shoes: false, bag: false, accessories: false, hat: false },
        outputImages: [], ...raw, ...migratedModelFields(kind, raw, "3:4") };
    case "image-input":
      return { imageRole: "default", ...raw };
    case "text-input":
      return { text: "", ...raw };
    case "drawing-board":
      return { boardVersion: 1, width: 1024, height: 1024, background: "#FFFFFF", ...raw };
    case "color-palette":
      return { paletteVersion: 1, swatches: [], ...raw };
    case "stage-approval":
      return { approvalKind: "scene-baseline", ...raw };
    case "video-input":
      return { ...raw };
    case "audio-input":
      return { ...raw };
    case "video-generate": {
      const { quality: _legacyQuality, ...videoData } = raw;
      const mode = raw.mode === "multi-image-video"
        ? "multimodal-reference"
        : raw.mode === "video-to-video"
          ? "video-edit"
          : SEEDANCE_VIDEO_MODES.includes(raw.mode as never) ? raw.mode : "text-to-video";
      const model = isSeedanceVideoModel(raw.videoModel)
        ? raw.videoModel
        : "doubao-seedance-2-5-260628";
      const ratio = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"].includes(String(raw.aspectRatio))
        ? raw.aspectRatio : "16:9";
      const resolution = raw.resolution === "480p"
        ? "480p"
        : raw.resolution === "1080p" || raw.resolution === "4k" ? "1080p" : "720p";
      const duration = raw.seconds === -1 || (
        Number.isSafeInteger(raw.seconds)
        && Number(raw.seconds) >= 4
        && Number(raw.seconds) <= SEEDANCE_MODEL_CAPABILITIES[model].maxDuration
      ) ? Number(raw.seconds) : 5;
      const normalized = normalizedSeedanceSettings({
        model,
        mode: mode as never,
        resolution,
        ratio: String(ratio),
        duration,
        outputFormat: raw.outputFormat === "mov" ? "mov" : "mp4",
      });
      return {
        ...videoData,
        mode: normalized.mode,
        prompt: typeof raw.prompt === "string" ? raw.prompt : "",
        videoModel: normalized.model,
        aspectRatio: normalized.ratio,
        resolution: normalized.resolution,
        seconds: normalized.duration,
        generateAudio: typeof raw.generateAudio === "boolean" ? raw.generateAudio : true,
        outputFormat: normalized.outputFormat,
        outputImages: Array.isArray(raw.outputImages) ? raw.outputImages : [],
      };
    }
    case "sketch-to-render":
      return {
        prompt: "", aspectRatio: "3:4", batchSize: 1, outputImages: [],
        ...raw, ...migratedModelFields(kind, raw, typeof raw.aspectRatio === "string" ? raw.aspectRatio : "3:4"),
      };
    case "ai-modify":
      return {
        prompt: "", aspectRatio: "1:1", batchSize: 1, outputImages: [],
        ...raw, ...migratedModelFields(kind, raw, typeof raw.aspectRatio === "string" ? raw.aspectRatio : "1:1"),
      };
    case "fabric-recolor":
      return { operationMode: "combined", colors: [], prompt: "", outputImages: [], ...raw, ...migratedModelFields(kind, raw) };
    case "upscale":
      return { imageSize: "2K", outputImages: [], ...raw, ...migratedModelFields(kind, raw) };
    case "print-extract":
      return { prompt: "", outputImages: [], savedAsAssets: [], ...raw, ...migratedModelFields(kind, raw) };
    case "print-mutate":
      return { prompt: "", count: 4, outputImages: [], ...raw, ...migratedModelFields(kind, raw) };
    case "virtual-try-on":
      return {
        workflowStage: "standard", prompt: "", imageSize: "2K", aspectRatio: "3:4", outputImages: [],
        promptEnhancement: false, qualityMode: "fast", safetyFallback: false, stylePresetId: "faithful",
        ...(raw.workflowStage === "scene-stabilize" ? { basisRevision: 0 } : {}),
        ...raw, ...migratedModelFields(kind, raw),
      };
    case "mask-redraw": {
      const { maskMode: _legacyMaskMode, ...migratedMaskData } = raw;
      return {
        prompt: "", outputImages: [], repairFocus: "custom", executionMode: "repair", ...migratedMaskData,
        ...migratedModelFields(kind, raw),
      };
    }
    case "result":
      return { images: [], ...raw };
  }
}

function validateModelSelection(kind: NodeKind, raw: Record<string, unknown>, path: string): void {
  if (!NODE_SPECS[kind].providerId || kind === "video-generate") return;
  if (!isImageModelId(raw.modelId)) fail(`${path}.modelId`, "must be a supported API易 image model");
  if (!isModelAllowedForNode(raw.modelId, kind)) {
    fail(`${path}.modelId`, `${raw.modelId} is not allowed for ${kind}`);
  }
  const inputOptions = raw.modelOptions;
  const normalizedOptions = normalizeImageModelOptions(raw.modelId, inputOptions);
  const supportedOptions =
    typeof inputOptions === "object" && inputOptions !== null && !Array.isArray(inputOptions)
      ? Object.fromEntries(
          Object.entries(inputOptions).filter(([key]) => (
            Object.hasOwn(normalizedOptions, key)
          )),
        )
      : inputOptions;
  const optionsError = imageModelOptionsError(raw.modelId, supportedOptions);
  if (optionsError) fail(`${path}.modelOptions`, optionsError);
}

function validateData(kind: NodeKind, rawValue: unknown, path: string): WorkflowNodeData {
  const input = record(rawValue, path);
  // 运行中与失败状态不能跨保存/模板持久化；成功结果本身可以保留。
  const runtimeStatus = input.status;
  const raw =
    runtimeStatus !== "idle" && runtimeStatus !== "success"
      ? { ...input, status: "idle", error: undefined }
      : input;
  if (raw.kind !== kind) fail(`${path}.kind`, `must equal node type ${kind}`);
  stringValue(raw.label, `${path}.label`, { nonEmpty: true });
  oneOf(raw.status, STATUSES, `${path}.status`);
  optionalString(raw.error, `${path}.error`);
  validateModelSelection(kind, raw, path);

  switch (kind) {
    case "outfit-reference": {
      const images = imageReferenceArray(raw.images, `${path}.images`, 8);
      if (raw.mainImage !== null) {
        const main = imageReference(raw.mainImage, `${path}.mainImage`);
        if (!images.includes(main)) fail(`${path}.mainImage`, "must belong to images");
      }
      if (images.length && raw.mainImage === null) fail(`${path}.mainImage`, "must select a main image");
      break;
    }
    case "ai-styling": {
      stringValue(raw.prompt, `${path}.prompt`);
      oneOf(raw.aspectRatio, ASPECT_RATIOS, `${path}.aspectRatio`);
      oneOf(raw.batchSize, [1, 2, 4] as const, `${path}.batchSize`);
      if (raw.preserve !== null) oneOf(raw.preserve, ["upper", "lower", "one-piece", "whole"] as const, `${path}.preserve`);
      const extras = record(raw.extras, `${path}.extras`);
      for (const key of ["outerwear", "shoes", "bag", "accessories", "hat"]) booleanValue(extras[key], `${path}.extras.${key}`);
      for (const key of ["analysisId", "referenceFingerprint", "resultNodeId"]) optionalString(raw[key], `${path}.${key}`);
      imageReferenceArray(raw.outputImages, `${path}.outputImages`, 4);
      break;
    }
    case "image-input":
      oneOf(raw.imageRole, IMAGE_ROLES, `${path}.imageRole`);
      optionalImageReference(raw.imageUrl, `${path}.imageUrl`);
      if (raw.autoConnectTargets !== undefined) {
        if (!Array.isArray(raw.autoConnectTargets) || raw.autoConnectTargets.length > MAX_AUTO_CONNECT_TARGETS) {
          fail(`${path}.autoConnectTargets`, `must be an array with at most ${MAX_AUTO_CONNECT_TARGETS} entries`);
        }
        const seenTargets = new Set<string>();
        raw.autoConnectTargets.forEach((value, index) => {
          const targetPath = `${path}.autoConnectTargets[${index}]`;
          const target = record(value, targetPath);
          const targetNodeId = stringValue(target.targetNodeId, `${targetPath}.targetNodeId`, { nonEmpty: true });
          if (!SAFE_ID.test(targetNodeId)) fail(`${targetPath}.targetNodeId`, "must be a valid node id");
          const targetHandle = oneOf(target.targetHandle, WORKFLOW_INPUT_ROLES, `${targetPath}.targetHandle`);
          const key = `${targetNodeId}\u0000${targetHandle}`;
          if (seenTargets.has(key)) fail(targetPath, "must not duplicate an automatic connection target");
          seenTargets.add(key);
        });
      }
      break;
    case "text-input":
      stringValue(raw.text, `${path}.text`);
      break;
    case "drawing-board":
      oneOf(raw.boardVersion, [1] as const, `${path}.boardVersion`);
      boundedInteger(raw.width, `${path}.width`, BOARD_MIN_SIDE, BOARD_MAX_SIDE);
      boundedInteger(raw.height, `${path}.height`, BOARD_MIN_SIDE, BOARD_MAX_SIDE);
      stringValue(raw.background, `${path}.background`, { nonEmpty: true });
      optionalString(raw.contentRef, `${path}.contentRef`);
      optionalImageReference(raw.previewImageRef, `${path}.previewImageRef`);
      optionalImageReference(raw.exportImageRef, `${path}.exportImageRef`);
      break;
    case "color-palette": {
      const paletteVersion = oneOf(raw.paletteVersion, [1, 2] as const, `${path}.paletteVersion`);
      if (!Array.isArray(raw.swatches) || raw.swatches.length < 1 || raw.swatches.length > 32) {
        fail(`${path}.swatches`, "must contain from 1 to 32 colors");
      }
      const identities = new Set<string>();
      raw.swatches.forEach((value, index) => {
        const swatchPath = `${path}.swatches[${index}]`;
        const swatch = record(value, swatchPath);
        stringValue(swatch.id, `${swatchPath}.id`, { nonEmpty: true });
        const color = stringValue(swatch.value, `${swatchPath}.value`, { nonEmpty: true });
        if (!/^#[0-9A-F]{6}$/.test(color)) fail(`${swatchPath}.value`, "must be canonical uppercase #RRGGBB");
        optionalString(swatch.name, `${swatchPath}.name`);
        const source = oneOf(swatch.source, COLOR_SWATCH_SOURCES, `${swatchPath}.source`);
        const expectsPantone = source === "pantone" || source === "brand";
        if (paletteVersion === 1 && expectsPantone) fail(`${swatchPath}.source`, "Pantone sources require paletteVersion 2");
        let identityKey = `hex:${color}`;
        if (expectsPantone) {
          const identity = record(swatch.pantone, `${swatchPath}.pantone`);
          const catalogId = stringValue(identity.catalogId, `${swatchPath}.pantone.catalogId`, { nonEmpty: true });
          if (!/^[0-9a-f]{64}$/.test(catalogId)) fail(`${swatchPath}.pantone.catalogId`, "must be a 64-character lowercase digest");
          for (const field of ["releaseId", "libraryKey", "code"] as const) {
            stringValue(identity[field], `${swatchPath}.pantone.${field}`, { nonEmpty: true });
          }
          identityKey = `pantone:${catalogId}`;
        } else if (swatch.pantone !== undefined) {
          fail(`${swatchPath}.pantone`, "ordinary colors must not carry Pantone identity");
        }
        if (identities.has(identityKey)) fail(swatchPath, "identity must be unique");
        identities.add(identityKey);
      });
      break;
    }
    case "stage-approval":
      oneOf(raw.approvalKind, ["scene-baseline"] as const, `${path}.approvalKind`);
      optionalString(raw.approvedSourceNodeId, `${path}.approvedSourceNodeId`);
      optionalImageReference(raw.approvedBaselineRef, `${path}.approvedBaselineRef`);
      optionalNonNegativeInteger(raw.approvedBasisRevision, `${path}.approvedBasisRevision`);
      optionalString(raw.approvedAt, `${path}.approvedAt`);
      break;
    case "video-input":
      if (raw.videoUrl !== undefined) mediaReference(raw.videoUrl, `${path}.videoUrl`);
      if (raw.mimeType !== undefined) oneOf(raw.mimeType, ["video/mp4", "video/webm", "video/quicktime"] as const, `${path}.mimeType`);
      break;
    case "audio-input":
      if (raw.audioUrl !== undefined) seedanceRemoteMediaReference(raw.audioUrl, `${path}.audioUrl`);
      if (raw.mimeType !== undefined) oneOf(raw.mimeType, ["audio/mpeg", "audio/wav", "audio/mp4", "audio/ogg"] as const, `${path}.mimeType`);
      break;
    case "video-generate":
      oneOf(raw.mode, SEEDANCE_VIDEO_MODES, `${path}.mode`);
      stringValue(raw.prompt, `${path}.prompt`);
      oneOf(raw.videoModel, SEEDANCE_VIDEO_MODELS, `${path}.videoModel`);
      oneOf(raw.aspectRatio, SEEDANCE_RATIOS, `${path}.aspectRatio`);
      oneOf(raw.resolution, SEEDANCE_RESOLUTIONS, `${path}.resolution`);
      if (raw.seconds !== -1) {
        boundedInteger(
          raw.seconds,
          `${path}.seconds`,
          4,
          SEEDANCE_MODEL_CAPABILITIES[raw.videoModel as typeof SEEDANCE_VIDEO_MODELS[number]].maxDuration,
        );
      }
      booleanValue(raw.generateAudio, `${path}.generateAudio`);
      oneOf(raw.outputFormat, SEEDANCE_OUTPUT_FORMATS, `${path}.outputFormat`);
      if (!SEEDANCE_MODEL_CAPABILITIES[raw.videoModel as typeof SEEDANCE_VIDEO_MODELS[number]].supports1080p && raw.resolution === "1080p") {
        fail(`${path}.resolution`, "1080p is only supported by Seedance 2.5 and 2.0 standard");
      }
      if (!SEEDANCE_MODEL_CAPABILITIES[raw.videoModel as typeof SEEDANCE_VIDEO_MODELS[number]].supportsMov && raw.outputFormat !== "mp4") {
        fail(`${path}.outputFormat`, "mov is only supported by Seedance 2.5");
      }
      if ((raw.mode === "video-edit" || raw.mode === "video-extend") && raw.videoModel !== "doubao-seedance-2-5-260628") {
        fail(`${path}.mode`, "video edit and extension require Seedance 2.5");
      }
      if (seedanceModeRequiresAdaptive(
        raw.videoModel as typeof SEEDANCE_VIDEO_MODELS[number],
        raw.mode as typeof SEEDANCE_VIDEO_MODES[number],
      ) && raw.aspectRatio !== "adaptive") {
        fail(`${path}.aspectRatio`, "must be adaptive for this Seedance 2.5 task type");
      }
      if (raw.mode === "video-edit" && raw.seconds !== -1) {
        fail(`${path}.seconds`, "must be -1 for Seedance 2.5 video editing");
      }
      mediaReferenceArray(raw.outputImages, `${path}.outputImages`);
      break;
    case "sketch-to-render":
    case "ai-modify":
      stringValue(raw.prompt, `${path}.prompt`);
      oneOf(raw.aspectRatio, ASPECT_RATIOS, `${path}.aspectRatio`);
      oneOf(raw.batchSize, BATCH_SIZES, `${path}.batchSize`);
      imageReferenceArray(raw.outputImages, `${path}.outputImages`);
      break;
    case "fabric-recolor": {
      oneOf(raw.operationMode, FABRIC_OPERATION_MODES, `${path}.operationMode`);
      const colors = stringArray(raw.colors, `${path}.colors`, 8);
      for (let i = 0; i < colors.length; i++) {
        if (!/^#[0-9a-fA-F]{6}$/.test(colors[i])) fail(`${path}.colors[${i}]`, "must be #RRGGBB");
      }
      stringValue(raw.prompt, `${path}.prompt`);
      optionalImageReference(raw.fabricImageUrl, `${path}.fabricImageUrl`);
      imageReferenceArray(raw.outputImages, `${path}.outputImages`);
      break;
    }
    case "upscale":
      oneOf(raw.imageSize, IMAGE_SIZES, `${path}.imageSize`);
      imageReferenceArray(raw.outputImages, `${path}.outputImages`);
      break;
    case "print-extract":
      stringValue(raw.prompt, `${path}.prompt`);
      imageReferenceArray(raw.outputImages, `${path}.outputImages`);
      imageReferenceArray(raw.savedAsAssets, `${path}.savedAsAssets`);
      break;
    case "print-mutate":
      stringValue(raw.prompt, `${path}.prompt`);
      if (!Number.isInteger(raw.count) || (raw.count as number) < 1 || (raw.count as number) > 8) {
        fail(`${path}.count`, "must be an integer from 1 to 8");
      }
      imageReferenceArray(raw.outputImages, `${path}.outputImages`);
      break;
    case "virtual-try-on":
      oneOf(raw.workflowStage, VIRTUAL_TRY_ON_STAGES, `${path}.workflowStage`);
      stringValue(raw.prompt, `${path}.prompt`);
      oneOf(raw.imageSize, IMAGE_SIZES, `${path}.imageSize`);
      oneOf(raw.aspectRatio, ["1:1", "4:5", "3:4", "2:3", "9:16", "16:9"] as const, `${path}.aspectRatio`);
      if (raw.garmentCategory !== undefined) {
        oneOf(raw.garmentCategory, GARMENT_CATEGORIES, `${path}.garmentCategory`);
      }
      optionalString(raw.materialSpec, `${path}.materialSpec`);
      optionalString(raw.constructionSpec, `${path}.constructionSpec`);
      booleanValue(raw.promptEnhancement, `${path}.promptEnhancement`);
      oneOf(raw.qualityMode, TRY_ON_QUALITY_MODES, `${path}.qualityMode`);
      booleanValue(raw.safetyFallback, `${path}.safetyFallback`);
      stringValue(raw.stylePresetId, `${path}.stylePresetId`, { nonEmpty: true });
      optionalString(raw.stylePresetName, `${path}.stylePresetName`);
      optionalString(raw.stylePrompt, `${path}.stylePrompt`);
      optionalImageReference(raw.styleReferenceImage, `${path}.styleReferenceImage`);
      optionalNonNegativeInteger(raw.basisRevision, `${path}.basisRevision`);
      if (raw.workflowStage === "scene-stabilize" && raw.basisRevision === undefined) {
        fail(`${path}.basisRevision`, "is required for scene-stabilize");
      }
      if (raw.workflowStage === "scene-stabilize" && raw.modelId !== "gemini-3.1-flash-image") {
        fail(`${path}.modelId`, "scene-stabilize must use gemini-3.1-flash-image");
      }
      if (raw.workflowStage === "garment-refine" && raw.modelId !== "gpt-image-2" && raw.modelId !== "gpt-image-2.5-sunburst") {
        fail(`${path}.modelId`, "garment-refine must use gpt-image-2");
      }
      imageReferenceArray(raw.outputImages, `${path}.outputImages`);
      break;
    case "mask-redraw":
      oneOf(raw.repairFocus, MASK_REPAIR_FOCUSES, `${path}.repairFocus`);
      oneOf(raw.executionMode, MASK_REPAIR_EXECUTION_MODES, `${path}.executionMode`);
      stringValue(raw.prompt, `${path}.prompt`);
      optionalMaskReference(raw.mask, `${path}.mask`);
      optionalImageReference(raw.maskSourceRef, `${path}.maskSourceRef`);
      imageReferenceArray(raw.outputImages, `${path}.outputImages`);
      break;
    case "result":
      mediaReferenceArray(raw.images, `${path}.images`);
      optionalString(raw.note, `${path}.note`);
      break;
  }
  if (kind === "mask-redraw" && Object.hasOwn(raw, "maskMode")) {
    const { maskMode: _legacyMaskMode, ...normalized } = raw;
    return normalized as unknown as WorkflowNodeData;
  }
  return raw as unknown as WorkflowNodeData;
}

function validateNode(value: unknown, index: number, migrateLegacy: boolean): PersistedWorkflowNode {
  const path = `flow.nodes[${index}]`;
  const raw = record(value, path);
  const id = stringValue(raw.id, `${path}.id`, { nonEmpty: true });
  if (!SAFE_ID.test(id)) fail(`${path}.id`, "must contain only letters, digits, underscore or hyphen");
  const type = oneOf(raw.type, NODE_KINDS, `${path}.type`);
  const position = record(raw.position, `${path}.position`);
  finiteNumber(position.x, `${path}.position.x`);
  finiteNumber(position.y, `${path}.position.y`);
  const initialData = record(raw.data, `${path}.data`);
  const data = validateData(
    type,
    migrateLegacy ? migrateNodeData(type, initialData) : initialData,
    `${path}.data`,
  );
  return { ...raw, id, type, position: { ...position, x: position.x as number, y: position.y as number }, data } as PersistedWorkflowNode;
}

function validateEdge(value: unknown, index: number): PersistedWorkflowEdge {
  const path = `flow.edges[${index}]`;
  const raw = record(value, path);
  const id = stringValue(raw.id, `${path}.id`, { nonEmpty: true });
  const source = stringValue(raw.source, `${path}.source`, { nonEmpty: true });
  const target = stringValue(raw.target, `${path}.target`, { nonEmpty: true });
  if (!SAFE_ID.test(id)) fail(`${path}.id`, "must contain only letters, digits, underscore or hyphen");
  if (!SAFE_ID.test(source)) fail(`${path}.source`, "must be a valid node id");
  if (!SAFE_ID.test(target)) fail(`${path}.target`, "must be a valid node id");
  if (source === target) fail(path, "source and target must be different nodes");
  if (raw.sourceHandle !== undefined && raw.sourceHandle !== null) stringValue(raw.sourceHandle, `${path}.sourceHandle`);
  if (raw.targetHandle !== undefined && raw.targetHandle !== null) {
    oneOf(raw.targetHandle, WORKFLOW_INPUT_ROLES, `${path}.targetHandle`);
  }
  return { ...raw, id, source, target } as PersistedWorkflowEdge;
}

function migrateMaskRepairEdges(nodeValues: unknown[], edgeValues: unknown[]): unknown[] {
  const maskNodeIds = new Set(nodeValues.flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const node = value as Record<string, unknown>;
    return node.type === "mask-redraw" && typeof node.id === "string" ? [node.id] : [];
  }));
  const claimedSource = new Set<string>();
  return edgeValues.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const edge = value as Record<string, unknown>;
    if (typeof edge.target !== "string" || !maskNodeIds.has(edge.target)) return value;
    if (!claimedSource.has(edge.target)) {
      claimedSource.add(edge.target);
      return { ...edge, targetHandle: "repair-source" };
    }
    return { ...edge, targetHandle: "references" };
  });
}

/**
 * Recover staged try-on nodes saved by a stale v3 browser bundle.
 *
 * The staged template already carries unambiguous role handles and fixed
 * models. Older clients preserve those edges/model IDs but omit workflowStage,
 * and a previously migrated copy may already contain the generic `standard`
 * default. Only upgrade when both signals agree, so ordinary try-on nodes keep
 * their original behavior.
 */
function recoverStagedTryOnNode(
  value: unknown,
  incomingRoles: ReadonlyMap<string, ReadonlySet<string>>,
): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const node = value as Record<string, unknown>;
  if (node.type !== "virtual-try-on" || typeof node.id !== "string") return value;
  if (typeof node.data !== "object" || node.data === null || Array.isArray(node.data)) return value;
  const data = node.data as Record<string, unknown>;
  if (data.workflowStage !== undefined && data.workflowStage !== "standard") return value;
  const roles = incomingRoles.get(node.id);
  if (!roles) return value;

  const inferred = (data.modelId === "gemini-3.1-flash-image-preview" || data.modelId === "gemini-3.1-flash-image")
    && roles.has("person") && roles.has("scene") && roles.has("outfit")
    ? "scene-stabilize"
    : (data.modelId === MASK_REDRAW_MODEL_ID || data.modelId === "gpt-image-2") && roles.has("baseline") && roles.has("outfit")
      ? "garment-refine"
      : undefined;
  return inferred ? { ...node, data: { ...data, workflowStage: inferred } } : value;
}

function migrateLegacyDualModelAccessorySlot(
  nodeValues: unknown[],
  edgeValues: unknown[],
): { nodes: unknown[]; edges: unknown[] } {
  const nodeRecords = nodeValues.filter((node): node is Record<string, unknown> => (
    typeof node === "object" && node !== null && !Array.isArray(node)
  ));
  const structure = nodeRecords.find((node) => node.id === "structure");
  const structureData = structure && typeof structure.data === "object" && structure.data !== null && !Array.isArray(structure.data)
    ? structure.data as Record<string, unknown>
    : undefined;
  if (
    !structureData
    || !nodeRecords.some((node) => node.id === "accessory")
    || !nodeRecords.some((node) => node.id === "person")
    || !nodeRecords.some((node) => node.id === "scene")
    || !nodeRecords.some((node) => node.id === "outfit")
    || !nodeRecords.some((node) => node.id === "stabilize")
    || !nodeRecords.some((node) => node.id === "refine")
  ) return { nodes: nodeValues, edges: edgeValues };

  const nodes = nodeValues.map((node) => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return node;
    const record = node as Record<string, unknown>;
    if (typeof record.data !== "object" || record.data === null || Array.isArray(record.data)) return node;
    const data = record.data as Record<string, unknown>;
    if (record.id === "accessory") {
      return { ...record, data: { ...data, label: "鞋履参考图（可选）", imageRole: "reference" } };
    }
    if (record.id === "structure") {
      return { ...record, data: { ...data, label: "包袋参考图（可选）", imageRole: "reference" } };
    }
    return node;
  });
  const accessoryNodes = [
    { id: "hat", label: "帽子参考图（可选）", y: 780 },
    { id: "ring", label: "戒指参考图（可选）", y: 1040 },
    { id: "earrings", label: "耳环参考图（可选）", y: 1300 },
    { id: "bracelet", label: "手镯参考图（可选）", y: 1560 },
  ] as const;
  for (const accessoryNode of accessoryNodes) {
    if (nodeRecords.some((node) => node.id === accessoryNode.id)) continue;
    nodes.push({
      id: accessoryNode.id,
      type: "image-input",
      position: { x: 0, y: accessoryNode.y },
      data: {
        kind: "image-input",
        label: accessoryNode.label,
        status: "idle",
        imageRole: "reference",
      },
    });
  }
  if (!nodeRecords.some((node) => node.id === "garment-detail")) {
    nodes.push({
      id: "garment-detail",
      type: "image-input",
      position: { x: 720, y: 260 },
      data: {
        kind: "image-input",
        label: "服装局部结构参考（可选）",
        status: "idle",
        imageRole: "garment",
      },
    });
  }

  const accessoryRoles = new Map<string, string>([
    ["accessory", "shoes"],
    ["structure", "bag"],
    ["hat", "hat"],
    ["ring", "ring"],
    ["earrings", "earrings"],
    ["bracelet", "bracelet"],
  ]);
  const seenAccessorySources = new Set<string>();
  const edges = edgeValues.flatMap((edgeValue): unknown[] => {
    if (typeof edgeValue !== "object" || edgeValue === null || Array.isArray(edgeValue)) return [edgeValue];
    const edge = edgeValue as Record<string, unknown>;
    if (edge.source === "structure" && edge.target === "refine") return [];
    if (edge.source === "garment-detail" && edge.target === "stabilize") return [];
    if (typeof edge.source === "string" && edge.target === "stabilize" && accessoryRoles.has(edge.source)) {
      if (seenAccessorySources.has(edge.source)) return [];
      seenAccessorySources.add(edge.source);
      return [{ ...edge, targetHandle: accessoryRoles.get(edge.source) }];
    }
    return [edgeValue];
  });
  const edgeIds = new Set(edges.flatMap((edge) => (
    typeof edge === "object" && edge !== null && !Array.isArray(edge) && typeof (edge as Record<string, unknown>).id === "string"
      ? [(edge as Record<string, unknown>).id as string]
      : []
  )));
  for (const [source, targetHandle] of accessoryRoles) {
    if (seenAccessorySources.has(source)) continue;
    const id = `${source}-stabilize`;
    if (edgeIds.has(id)) continue;
    edges.push({ id, source, target: "stabilize", targetHandle });
  }
  if (!edgeIds.has("garment-detail-refine")) {
    edges.push({
      id: "garment-detail-refine", source: "garment-detail", target: "refine", targetHandle: "detail",
    });
  }
  return { nodes, edges };
}

function normalizeLegacyEdgeHandles(edgeValues: unknown[]): unknown[] {
  return edgeValues.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const edge = value as Record<string, unknown>;
    const targetHandle = typeof edge.targetHandle === "string" && WORKFLOW_INPUT_ROLES.includes(edge.targetHandle as WorkflowInputRole)
      ? edge.targetHandle
      : null;
    const sourceHandle = typeof edge.sourceHandle === "string" && (
      ["image", "text", "colors", "video", "audio"].includes(edge.sourceHandle) || /^image:\d+$/.test(edge.sourceHandle)
    )
      ? edge.sourceHandle
      : null;
    return { ...edge, sourceHandle, targetHandle };
  });
}

function migrateLegacyVideoEdges(nodeValues: unknown[], edgeValues: unknown[]): unknown[] {
  const legacyMultimodalIds = new Set(nodeValues.flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const node = value as Record<string, unknown>;
    if (node.type !== "video-generate" || typeof node.id !== "string") return [];
    const data = typeof node.data === "object" && node.data !== null && !Array.isArray(node.data)
      ? node.data as Record<string, unknown>
      : undefined;
    return data?.mode === "multi-image-video" ? [node.id] : [];
  }));
  return edgeValues.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const edge = value as Record<string, unknown>;
    if (!legacyMultimodalIds.has(String(edge.target))) return value;
    return edge.targetHandle === "first-frame" || edge.targetHandle === "last-frame"
      ? { ...edge, targetHandle: "reference-image" }
      : value;
  });
}

function stableMigrationId(prefix: string, seed: string): string {
  let hash = 2_166_136_261;
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  const safeSeed = seed.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 72);
  return `${prefix}_${safeSeed}_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function migrateV4StageApprovals(
  nodeValues: unknown[],
  edgeValues: unknown[],
): { nodes: unknown[]; edges: unknown[] } {
  const nodes = nodeValues.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const node = value as Record<string, unknown>;
    if (typeof node.data !== "object" || node.data === null || Array.isArray(node.data)) return value;
    const data = node.data as Record<string, unknown>;
    if (node.type === "fabric-recolor") return { ...node, data: { operationMode: "combined", ...data } };
    if (node.type === "virtual-try-on" && data.workflowStage === "scene-stabilize") {
      return { ...node, data: { basisRevision: 0, ...data } };
    }
    return value;
  });
  const byId = new Map(nodes.flatMap((value) => (
    typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as Record<string, unknown>).id === "string"
      ? [[(value as Record<string, unknown>).id as string, value as Record<string, unknown>] as const]
      : []
  )));
  const edges = [...edgeValues];
  const insertedNodes: unknown[] = [];

  for (const [refineId, refineNode] of byId) {
    if (refineNode.type !== "virtual-try-on") continue;
    if (typeof refineNode.data !== "object" || refineNode.data === null || Array.isArray(refineNode.data)) continue;
    const refineData = refineNode.data as Record<string, unknown>;
    if (refineData.workflowStage !== "garment-refine") continue;
    const baselineIndexes = edges.flatMap((edge, index) => (
      typeof edge === "object" && edge !== null && !Array.isArray(edge)
      && (edge as Record<string, unknown>).target === refineId
      && (edge as Record<string, unknown>).targetHandle === "baseline"
        ? [index]
        : []
    ));
    const {
      approvedBaselineRef: legacyApprovedRef,
      approvedAt: legacyApprovedAt,
      ...nextRefineData
    } = refineData;
    refineNode.data = nextRefineData;
    if (baselineIndexes.length !== 1) continue;

    const edgeIndex = baselineIndexes[0];
    const legacyEdge = edges[edgeIndex] as Record<string, unknown>;
    if (typeof legacyEdge.source !== "string" || typeof legacyEdge.id !== "string") continue;
    const sourceNode = byId.get(legacyEdge.source);
    if (!sourceNode || sourceNode.type === "stage-approval") continue;
    const approvalId = stableMigrationId("stage_approval", refineId);
    const candidateEdgeId = stableMigrationId("baseline_candidate", legacyEdge.id);
    if (byId.has(approvalId)) fail("flow.nodes", `migration id collision: ${approvalId}`);
    const sourcePosition = typeof sourceNode.position === "object" && sourceNode.position !== null
      ? sourceNode.position as Record<string, unknown>
      : {};
    const refinePosition = typeof refineNode.position === "object" && refineNode.position !== null
      ? refineNode.position as Record<string, unknown>
      : {};
    const sourceData = typeof sourceNode.data === "object" && sourceNode.data !== null
      ? sourceNode.data as Record<string, unknown>
      : {};
    const sourceOutputs = Array.isArray(sourceData.outputImages) ? sourceData.outputImages : [];
    const validApprovedRef = typeof legacyApprovedRef === "string" && sourceOutputs.includes(legacyApprovedRef)
      ? legacyApprovedRef
      : undefined;
    const approvalNode = {
      id: approvalId,
      type: "stage-approval",
      position: {
        x: ((typeof sourcePosition.x === "number" ? sourcePosition.x : 0) + (typeof refinePosition.x === "number" ? refinePosition.x : 0)) / 2,
        y: ((typeof sourcePosition.y === "number" ? sourcePosition.y : 0) + (typeof refinePosition.y === "number" ? refinePosition.y : 0)) / 2,
      },
      data: {
        kind: "stage-approval",
        label: "确认第一轮基准",
        status: "idle",
        approvalKind: "scene-baseline",
        ...(validApprovedRef ? {
          approvedSourceNodeId: legacyEdge.source,
          approvedBaselineRef: validApprovedRef,
          approvedBasisRevision: typeof sourceData.basisRevision === "number" ? sourceData.basisRevision : 0,
          ...(typeof legacyApprovedAt === "string" ? { approvedAt: legacyApprovedAt } : {}),
        } : {}),
      },
    };
    insertedNodes.push(approvalNode);
    byId.set(approvalId, approvalNode);
    edges[edgeIndex] = {
      ...legacyEdge,
      source: approvalId,
      sourceHandle: "image",
      targetHandle: "baseline",
    };
    edges.push({
      id: candidateEdgeId,
      source: legacyEdge.source,
      sourceHandle: legacyEdge.sourceHandle ?? null,
      target: approvalId,
      targetHandle: "baseline-candidate",
    });
  }
  return { nodes: [...nodes, ...insertedNodes], edges };
}

/** Validate untrusted JSON and migrate supported unversioned/v0-v11 formats to v12. */
export function validateAndMigrateFlow(value: unknown): PersistedWorkflow {
  const raw = record(value, "flow");
  const version = raw.schemaVersion;
  const migrateLegacy = version === undefined || (
    typeof version === "number" && Number.isInteger(version) && version >= 0 && version < WORKFLOW_SCHEMA_VERSION
  );
  if (!migrateLegacy && version !== WORKFLOW_SCHEMA_VERSION) {
    fail("flow.schemaVersion", `unsupported version ${String(version)}; current version is ${WORKFLOW_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(raw.nodes)) fail("flow.nodes", "must be an array");
  if (!Array.isArray(raw.edges)) fail("flow.edges", "must be an array");
  const legacyAccessories = migrateLegacy
    ? migrateLegacyDualModelAccessorySlot(raw.nodes, raw.edges)
    : { nodes: raw.nodes, edges: raw.edges };
  const normalizedLegacy = migrateLegacy
    ? {
        nodes: legacyAccessories.nodes,
        edges: migrateLegacyVideoEdges(
          legacyAccessories.nodes,
          normalizeLegacyEdgeHandles(legacyAccessories.edges),
        ),
      }
    : legacyAccessories;

  const legacyIncomingRoles = new Map<string, Set<string>>();
  for (const edgeValue of normalizedLegacy.edges) {
    if (typeof edgeValue !== "object" || edgeValue === null || Array.isArray(edgeValue)) continue;
    const edge = edgeValue as Record<string, unknown>;
    if (typeof edge.target !== "string" || typeof edge.targetHandle !== "string") continue;
    const roles = legacyIncomingRoles.get(edge.target) ?? new Set<string>();
    roles.add(edge.targetHandle);
    legacyIncomingRoles.set(edge.target, roles);
  }
  const recoveredLegacyNodes = normalizedLegacy.nodes.map((node) => (
    migrateLegacy ? recoverStagedTryOnNode(node, legacyIncomingRoles) : node
  ));
  const approvalUpgraded = migrateLegacy
    ? migrateV4StageApprovals(recoveredLegacyNodes, normalizedLegacy.edges)
    : { nodes: recoveredLegacyNodes, edges: normalizedLegacy.edges };
  const upgraded = migrateLegacy
    ? { ...approvalUpgraded, edges: migrateMaskRepairEdges(approvalUpgraded.nodes, approvalUpgraded.edges) }
    : approvalUpgraded;
  if (upgraded.nodes.length > MAX_WORKFLOW_NODES) {
    fail("flow.nodes", `must contain at most ${MAX_WORKFLOW_NODES} nodes`);
  }
  if (upgraded.edges.length > MAX_EDGES) fail("flow.edges", `must contain at most ${MAX_EDGES} edges`);

  const nodes = upgraded.nodes.map((node, index) => validateNode(node, index, migrateLegacy));
  const validatedEdges = upgraded.edges.map(validateEdge);
  const stagedNodeIds = new Set(nodes.flatMap((node) => (
    node.data.kind === "virtual-try-on" && node.data.workflowStage !== "standard" ? [node.id] : []
  )));
  const typedStagedPairs = new Set(validatedEdges.flatMap((edge) => (
    stagedNodeIds.has(edge.target) && edge.targetHandle
      ? [`${edge.source}\u0000${edge.target}`]
      : []
  )));
  // A stale canvas could add a second source→stage edge without a role handle.
  // When the same pair already has a correctly typed edge, the untyped copy is
  // unambiguously redundant and safe to discard during load/save migration.
  const edges = validatedEdges.filter((edge) => !(
    stagedNodeIds.has(edge.target)
    && !edge.targetHandle
    && typedStagedPairs.has(`${edge.source}\u0000${edge.target}`)
  ));
  const nodeIds = new Set<string>();
  const nodesById = new Map<string, PersistedWorkflowNode>();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) fail("flow.nodes", `duplicate node id: ${node.id}`);
    nodeIds.add(node.id);
    nodesById.set(node.id, node);
  }
  const edgeIds = new Set<string>();
  const acceptedEdges: PersistedWorkflowEdge[] = [];
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) fail("flow.edges", `duplicate edge id: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source)) fail("flow.edges", `edge ${edge.id} source not found: ${edge.source}`);
    if (!nodeIds.has(edge.target)) fail("flow.edges", `edge ${edge.id} target not found: ${edge.target}`);
    const sourceNode = nodesById.get(edge.source)!;
    const targetNode = nodesById.get(edge.target)!;
    const compatibilityError = connectionCompatibilityError({
      source: sourceNode,
      target: targetNode,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      existingEdges: acceptedEdges,
      // The persisted contract keeps the historical eighth mask reference
      // readable. Interactive connection validation and execution still use 7.
      maxSources: targetNode.data.kind === "mask-redraw" ? MAX_REFERENCE_IMAGES : undefined,
    });
    if (compatibilityError) fail("flow.edges", `edge ${edge.id}: ${compatibilityError}`);
    if (
      targetNode.data.kind === "virtual-try-on"
      && targetNode.data.workflowStage === "garment-refine"
      && edge.targetHandle === "baseline"
      && sourceNode.data.kind !== "stage-approval"
    ) {
      fail("flow.edges", `edge ${edge.id}: 已确认第一轮基准必须来自独立确认节点`);
    }
    if (
      sourceNode.data.kind === "image-input"
      && sourceNode.data.imageUrl?.startsWith("asset://")
      && targetNode.data.kind !== "video-generate"
    ) {
      fail("flow.edges", `edge ${edge.id}: asset:// 图片素材只能连接 Seedance 视频节点`);
    }
    acceptedEdges.push(edge);
  }
  for (const node of nodes) {
    const incomingEdges = edges.filter((edge) => edge.target === node.id);
    const incomingImageCount = incomingEdges.filter((edge) => (
      inputPortFor(node.data, edge.targetHandle)?.valueKind === "image"
    )).length;
    // v2 曾允许蒙版节点保存 8 路输入。持久化层继续容忍这类历史文档，
    // 但新建连线和运行前检查仍按 7 张用户参考图限制，提示用户移除一张后再运行。
    const persistedInputLimit = node.type === "mask-redraw"
      ? MAX_REFERENCE_IMAGES
      : NODE_SPECS[node.type].inputs;
    if (incomingImageCount > persistedInputLimit) {
      fail(
        "flow.edges",
        `node ${node.id} accepts at most ${persistedInputLimit} incoming image connections`,
      );
    }
    if (
      NODE_SPECS[node.type].providerId
      && node.type !== "virtual-try-on"
      && node.type !== "video-generate"
      && incomingImageCount > MAX_REFERENCE_IMAGES
    ) {
      fail("flow.edges", `node ${node.id} accepts at most ${MAX_REFERENCE_IMAGES} reference images`);
    }
  }
  return documentSnapshotToPersistedWorkflow(createDocumentSnapshot({
    projectName: "",
    nodes,
    edges,
  }));
}

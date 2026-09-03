import {
  WORKFLOW_SCHEMA_VERSION,
  MAX_REFERENCE_IMAGES,
  NODE_SPECS,
  type NodeKind,
  type PersistedWorkflow,
  type PersistedWorkflowEdge,
  type PersistedWorkflowNode,
  type WorkflowNodeData,
  BATCH_SIZES,
} from "../../src/types/workflow";
import {
  createDocumentSnapshot,
  documentSnapshotToPersistedWorkflow,
} from "../../src/lib/documentSnapshot";
import { isLocalImageReference, validateImageDataUrl } from "./imageValidation";
import {
  DEFAULT_GENERATION_MODEL_ID,
  MASK_REDRAW_MODEL_ID,
  defaultImageModelOptions,
  getImageModelContract,
  imageModelOptionsError,
  isImageModelId,
  isModelAllowedForNode,
  normalizeImageModelOptions,
} from "../../src/types/imageModels";

const NODE_KINDS: readonly NodeKind[] = [
  "image-input",
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
const ASPECT_RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9"] as const;
const IMAGE_SIZES = ["2K", "4K"] as const;
const VIRTUAL_TRY_ON_STAGES = ["standard", "scene-stabilize", "garment-refine"] as const;
const GARMENT_CATEGORIES = ["knit", "woven", "other"] as const;
export const MAX_WORKFLOW_NODES = 500;
const MAX_EDGES = 2_000;
const MAX_TEXT_LENGTH = 20_000;
const MAX_IMAGE_REFERENCE_LENGTH = 20_000;
const MAX_IMAGE_REFS = 100;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
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
  if (!isLocalImageReference(ref) && !isRemote) {
    fail(path, "must be an image dataURL, local /api/files reference, or http(s) URL");
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

function migratedModelFields(
  kind: NodeKind,
  raw: Record<string, unknown>,
  preferredAspectRatio = "1:1",
): Record<string, unknown> {
  const requested = isImageModelId(raw.modelId) && isModelAllowedForNode(raw.modelId, kind)
    ? raw.modelId
    : kind === "mask-redraw" || kind === "virtual-try-on"
      ? MASK_REDRAW_MODEL_ID
      : DEFAULT_GENERATION_MODEL_ID;
  return {
    modelId: requested,
    modelOptions: normalizeImageModelOptions(requested, raw.modelOptions, preferredAspectRatio),
  };
}

function migrateNodeData(kind: NodeKind, raw: Record<string, unknown>): Record<string, unknown> {
  // v0/v1 文件保留现有值，只补后来新增且运行时依赖的确定性默认字段。
  switch (kind) {
    case "image-input":
      return { imageRole: "default", ...raw };
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
      return { colors: [], prompt: "", outputImages: [], ...raw, ...migratedModelFields(kind, raw) };
    case "upscale":
      return { imageSize: "2K", outputImages: [], ...raw, ...migratedModelFields(kind, raw) };
    case "print-extract":
      return { prompt: "", outputImages: [], savedAsAssets: [], ...raw, ...migratedModelFields(kind, raw) };
    case "print-mutate":
      return { prompt: "", count: 4, outputImages: [], ...raw, ...migratedModelFields(kind, raw) };
    case "virtual-try-on":
      return {
        workflowStage: "standard", prompt: "", imageSize: "2K", outputImages: [],
        ...raw, ...migratedModelFields(kind, raw),
      };
    case "mask-redraw": {
      const { maskMode: _legacyMaskMode, ...migratedMaskData } = raw;
      return {
        prompt: "", outputImages: [], ...migratedMaskData,
        modelId: MASK_REDRAW_MODEL_ID,
        modelOptions: defaultImageModelOptions(MASK_REDRAW_MODEL_ID),
      };
    }
    case "result":
      return { images: [], ...raw };
  }
}

function validateModelSelection(kind: NodeKind, raw: Record<string, unknown>, path: string): void {
  if (!NODE_SPECS[kind].providerId) return;
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
    case "image-input":
      oneOf(raw.imageRole, IMAGE_ROLES, `${path}.imageRole`);
      optionalImageReference(raw.imageUrl, `${path}.imageUrl`);
      break;
    case "sketch-to-render":
    case "ai-modify":
      stringValue(raw.prompt, `${path}.prompt`);
      oneOf(raw.aspectRatio, ASPECT_RATIOS, `${path}.aspectRatio`);
      oneOf(raw.batchSize, BATCH_SIZES, `${path}.batchSize`);
      imageReferenceArray(raw.outputImages, `${path}.outputImages`);
      break;
    case "fabric-recolor": {
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
      if (raw.garmentCategory !== undefined) {
        oneOf(raw.garmentCategory, GARMENT_CATEGORIES, `${path}.garmentCategory`);
      }
      optionalString(raw.materialSpec, `${path}.materialSpec`);
      optionalString(raw.constructionSpec, `${path}.constructionSpec`);
      optionalImageReference(raw.approvedBaselineRef, `${path}.approvedBaselineRef`);
      if (raw.workflowStage === "scene-stabilize" && raw.modelId !== "gemini-3.1-flash-image-preview") {
        fail(`${path}.modelId`, "scene-stabilize must use gemini-3.1-flash-image-preview");
      }
      if (raw.workflowStage === "garment-refine" && raw.modelId !== "gpt-image-2") {
        fail(`${path}.modelId`, "garment-refine must use gpt-image-2");
      }
      imageReferenceArray(raw.outputImages, `${path}.outputImages`);
      break;
    case "mask-redraw":
      stringValue(raw.prompt, `${path}.prompt`);
      optionalMaskReference(raw.mask, `${path}.mask`);
      optionalImageReference(raw.maskSourceRef, `${path}.maskSourceRef`);
      imageReferenceArray(raw.outputImages, `${path}.outputImages`);
      break;
    case "result":
      imageReferenceArray(raw.images, `${path}.images`);
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
  if (raw.sourceHandle !== undefined && raw.sourceHandle !== null) stringValue(raw.sourceHandle, `${path}.sourceHandle`);
  if (raw.targetHandle !== undefined && raw.targetHandle !== null) stringValue(raw.targetHandle, `${path}.targetHandle`);
  return { ...raw, id, source, target } as PersistedWorkflowEdge;
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

  const inferred = data.modelId === "gemini-3.1-flash-image-preview"
    && roles.has("person") && roles.has("scene") && roles.has("outfit")
    ? "scene-stabilize"
    : data.modelId === MASK_REDRAW_MODEL_ID && roles.has("baseline") && roles.has("outfit")
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

/** Validate untrusted JSON and migrate legacy unversioned/v0/v1/v2/v3 formats to v4. */
export function validateAndMigrateFlow(value: unknown): PersistedWorkflow {
  const raw = record(value, "flow");
  const version = raw.schemaVersion;
  const migrateLegacy = version === undefined || version === 0 || version === 1 || version === 2 || version === 3;
  if (!migrateLegacy && version !== WORKFLOW_SCHEMA_VERSION) {
    fail("flow.schemaVersion", `unsupported version ${String(version)}; current version is ${WORKFLOW_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(raw.nodes)) fail("flow.nodes", "must be an array");
  if (!Array.isArray(raw.edges)) fail("flow.edges", "must be an array");
  const upgraded = migrateLegacyDualModelAccessorySlot(raw.nodes, raw.edges);
  if (upgraded.nodes.length > MAX_WORKFLOW_NODES) {
    fail("flow.nodes", `must contain at most ${MAX_WORKFLOW_NODES} nodes`);
  }
  if (upgraded.edges.length > MAX_EDGES) fail("flow.edges", `must contain at most ${MAX_EDGES} edges`);

  const incomingRoles = new Map<string, Set<string>>();
  for (const edgeValue of upgraded.edges) {
    if (typeof edgeValue !== "object" || edgeValue === null || Array.isArray(edgeValue)) continue;
    const edge = edgeValue as Record<string, unknown>;
    if (typeof edge.target !== "string" || typeof edge.targetHandle !== "string") continue;
    const roles = incomingRoles.get(edge.target) ?? new Set<string>();
    roles.add(edge.targetHandle);
    incomingRoles.set(edge.target, roles);
  }

  const nodes = upgraded.nodes.map((node, index) => validateNode(
    recoverStagedTryOnNode(node, incomingRoles),
    index,
    migrateLegacy,
  ));
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
  for (const node of nodes) {
    if (nodeIds.has(node.id)) fail("flow.nodes", `duplicate node id: ${node.id}`);
    nodeIds.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) fail("flow.edges", `duplicate edge id: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source)) fail("flow.edges", `edge ${edge.id} source not found: ${edge.source}`);
    if (!nodeIds.has(edge.target)) fail("flow.edges", `edge ${edge.id} target not found: ${edge.target}`);
  }
  for (const node of nodes) {
    const incomingCount = edges.filter((edge) => edge.target === node.id).length;
    // v2 曾允许蒙版节点保存 8 路输入。持久化层继续容忍这类历史文档，
    // 但新建连线和运行前检查仍按 7 张用户参考图限制，提示用户移除一张后再运行。
    const persistedInputLimit = node.type === "mask-redraw"
      ? MAX_REFERENCE_IMAGES
      : NODE_SPECS[node.type].inputs;
    if (incomingCount > persistedInputLimit) {
      fail(
        "flow.edges",
        `node ${node.id} accepts at most ${persistedInputLimit} incoming image connections`,
      );
    }
    if (
      NODE_SPECS[node.type].providerId
      && node.type !== "virtual-try-on"
      && incomingCount > MAX_REFERENCE_IMAGES
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

import {
  MASK_REDRAW_MODEL_ID,
  isImageModelId,
  isModelAllowedForNode,
  normalizeImageModelOptions,
  type GenerationImageModelId,
  type ImageModelOptions,
  type VirtualTryOnModelId,
} from "../types/imageModels";
import {
  WORKFLOW_SCHEMA_VERSION,
  type BatchSize,
  type ColorSwatch,
  type NodeKind,
  type PersistedWorkflow,
  type SeedanceOutputFormat,
  type SeedanceVideoModelId,
  type VideoAspectRatio,
  type VideoGenerationMode,
  type VideoResolution,
  type WorkflowInputRole,
  type WorkflowNodeData,
} from "../types/workflow";

interface GenerationModelDocumentFields {
  modelId: GenerationImageModelId;
  modelOptions: ImageModelOptions;
}

export type DocumentNodeData =
  | { kind: "outfit-reference"; label: string; images: string[]; mainImage: string | null }
  | ({ kind: "ai-styling"; label: string; prompt: string; aspectRatio: string; batchSize: 1 | 2 | 4;
      preserve: import("../types/styling").StylingPreserve | null;
      extras: import("../types/styling").StylingExtras;
      analysisId?: string; referenceFingerprint?: string; resultNodeId?: string; outputImages: string[];
    } & GenerationModelDocumentFields)
  | {
      kind: "image-input";
      label: string;
      imageRole: "default" | "sketch" | "garment" | "fabric" | "reference";
      imageUrl?: string;
      autoConnectTargets?: Array<{
        targetNodeId: string;
        targetHandle: WorkflowInputRole;
      }>;
    }
  | {
      kind: "text-input";
      label: string;
      text: string;
    }
  | {
      kind: "drawing-board";
      label: string;
      boardVersion: 1;
      width: number;
      height: number;
      background: string;
      contentRef?: string;
      previewImageRef?: string;
      exportImageRef?: string;
    }
  | {
      kind: "color-palette";
      label: string;
      paletteVersion: 1 | 2;
      swatches: ColorSwatch[];
    }
  | {
      kind: "stage-approval";
      label: string;
      approvalKind: "scene-baseline";
      approvedSourceNodeId?: string;
      approvedBaselineRef?: string;
      approvedBasisRevision?: number;
      approvedAt?: string;
    }
  | {
      kind: "video-input";
      label: string;
      videoUrl?: string;
      mimeType?: "video/mp4" | "video/webm" | "video/quicktime";
    }
  | {
      kind: "audio-input";
      label: string;
      audioUrl?: string;
      mimeType?: "audio/mpeg" | "audio/wav" | "audio/mp4" | "audio/ogg";
    }
  | {
      kind: "video-generate";
      label: string;
      mode: VideoGenerationMode;
      prompt: string;
      videoModel: SeedanceVideoModelId;
      aspectRatio: VideoAspectRatio;
      resolution: VideoResolution;
      seconds: number;
      generateAudio: boolean;
      outputFormat: SeedanceOutputFormat;
      outputImages: string[];
    }
  | ({
      kind: "sketch-to-render";
      label: string;
      prompt: string;
      aspectRatio: string;
      batchSize: BatchSize;
      outputImages: string[];
    } & GenerationModelDocumentFields)
  | ({
      kind: "ai-modify";
      label: string;
      prompt: string;
      aspectRatio: string;
      batchSize: BatchSize;
      outputImages: string[];
    } & GenerationModelDocumentFields)
  | ({
      kind: "fabric-recolor";
      label: string;
      operationMode: "combined" | "fabric" | "color";
      colors: string[];
      prompt: string;
      fabricImageUrl?: string;
      outputImages: string[];
    } & GenerationModelDocumentFields)
  | ({
      kind: "upscale";
      label: string;
      imageSize: "2K" | "4K";
      outputImages: string[];
    } & GenerationModelDocumentFields)
  | ({
      kind: "print-extract";
      label: string;
      prompt: string;
      outputImages: string[];
      savedAsAssets: string[];
    } & GenerationModelDocumentFields)
  | ({
      kind: "print-mutate";
      label: string;
      prompt: string;
      count: number;
      outputImages: string[];
    } & GenerationModelDocumentFields)
  | {
      kind: "virtual-try-on";
      label: string;
      workflowStage: "standard" | "scene-stabilize" | "garment-refine";
      prompt: string;
      imageSize: "2K" | "4K";
      aspectRatio: "1:1" | "4:5" | "3:4" | "2:3" | "9:16" | "16:9";
      garmentCategory?: "knit" | "woven" | "other";
      materialSpec?: string;
      constructionSpec?: string;
      promptEnhancement: boolean;
      qualityMode: "fast" | "balanced" | "best";
      safetyFallback: boolean;
      stylePresetId: string;
      stylePresetName?: string;
      stylePrompt?: string;
      styleReferenceImage?: string;
      basisRevision?: number;
      outputImages: string[];
      modelId: VirtualTryOnModelId;
      modelOptions: ImageModelOptions;
    }
  | {
      kind: "mask-redraw";
      label: string;
      repairFocus: "custom" | "upper-garment" | "pants" | "accessories" | "logo-text";
      executionMode: "repair" | "bypass";
      prompt: string;
      mask?: string;
      maskSourceRef?: string;
      outputImages: string[];
      modelId: typeof MASK_REDRAW_MODEL_ID;
      modelOptions: ImageModelOptions;
    }
  | {
      kind: "result";
      label: string;
      images: string[];
      note?: string;
    };

export interface DocumentNode {
  id: string;
  type: NodeKind;
  position: { x: number; y: number };
  data: DocumentNodeData;
}

export interface DocumentEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: WorkflowInputRole | null;
}

export interface DocumentSnapshot {
  projectName: string;
  nodes: DocumentNode[];
  edges: DocumentEdge[];
}

interface NodeLike {
  id: string;
  type?: string;
  position: { x: number; y: number };
  resizeDocumentPosition?: { x: number; y: number };
  data: WorkflowNodeData;
}

interface EdgeLike {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

const WORKFLOW_INPUT_ROLES: readonly WorkflowInputRole[] = [
  "person", "scene", "outfit", "bag", "shoes", "hat", "ring", "earrings", "bracelet",
  "detail", "material", "baseline-candidate", "baseline", "palette", "prompt", "references",
  "first-frame", "last-frame", "source-video", "repair-source", "eyewear", "neckwear", "belt", "watch",
  "reference-image", "reference-video", "reference-audio",
];

function documentTargetHandle(value: string | null | undefined): WorkflowInputRole | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return WORKFLOW_INPUT_ROLES.includes(value as WorkflowInputRole) ? value as WorkflowInputRole : null;
}

function optionalString<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : { [key]: value } as Record<K, string>;
}

function optionalNumber<K extends string>(key: K, value: number | undefined): Partial<Record<K, number>> {
  return value === undefined ? {} : { [key]: value } as Record<K, number>;
}

function generationModelFields(
  kind: Exclude<NodeKind, "image-input" | "virtual-try-on" | "mask-redraw" | "result">,
  modelIdValue: unknown,
  modelOptionsValue: unknown,
  preferredAspectRatio = "1:1",
): GenerationModelDocumentFields {
  const modelId = isImageModelId(modelIdValue) && isModelAllowedForNode(modelIdValue, kind)
    ? modelIdValue as GenerationImageModelId
    : "gpt-image-2-vip";
  return {
    modelId,
    modelOptions: normalizeImageModelOptions(modelId, modelOptionsValue, preferredAspectRatio),
  };
}

function gptDocumentQuality(modelId: unknown, modelOptions: unknown): ImageModelOptions["quality"] {
  const quality = normalizeImageModelOptions(MASK_REDRAW_MODEL_ID, modelOptions).quality;
  // 服务端也会先序列化旧文档；模型替换和质量映射必须一起完成，且只映射一次。
  return modelId === "gpt-image-2"
    ? quality === "low" ? "low" : quality === "high" ? "max" : "high"
    : quality;
}

function virtualTryOnModelFields(
  modelIdValue: unknown,
  modelOptionsValue: unknown,
  imageSize: "2K" | "4K",
): { modelId: VirtualTryOnModelId; modelOptions: ImageModelOptions } {
  const modelId: VirtualTryOnModelId =
    modelIdValue === "gemini-3.1-flash-image" || modelIdValue === "gemini-3.1-flash-image-preview"
      ? "gemini-3.1-flash-image"
      : MASK_REDRAW_MODEL_ID;
  const quality = gptDocumentQuality(modelIdValue, modelOptionsValue);
  return {
    modelId,
    modelOptions: modelId === "gemini-3.1-flash-image"
      ? normalizeImageModelOptions(modelId, { ...(
          typeof modelOptionsValue === "object" && modelOptionsValue !== null
            ? modelOptionsValue as ImageModelOptions
            : {}
        ), imageSize })
      : quality ? { quality } : {},
  };
}

function createDocumentNodeData(data: WorkflowNodeData): DocumentNodeData {
  switch (data.kind) {
    case "outfit-reference":
      return { kind: data.kind, label: data.label, images: [...data.images], mainImage: data.mainImage };
    case "ai-styling":
      return { kind: data.kind, label: data.label, prompt: data.prompt, aspectRatio: data.aspectRatio,
        batchSize: data.batchSize, preserve: data.preserve,
        extras: { outerwear: data.extras.outerwear, shoes: data.extras.shoes, bag: data.extras.bag, accessories: data.extras.accessories, hat: data.extras.hat },
        ...optionalString("analysisId", data.analysisId), ...optionalString("referenceFingerprint", data.referenceFingerprint),
        ...optionalString("resultNodeId", data.resultNodeId), outputImages: [...data.outputImages],
        ...generationModelFields(data.kind, data.modelId, data.modelOptions, data.aspectRatio) };
    case "image-input":
      return {
        kind: data.kind,
        label: data.label,
        imageRole: data.imageRole,
        ...optionalString("imageUrl", data.imageUrl),
        ...(data.autoConnectTargets
          ? { autoConnectTargets: data.autoConnectTargets.map((target) => ({ ...target })) }
          : {}),
      };
    case "text-input":
      return { kind: data.kind, label: data.label, text: data.text };
    case "drawing-board":
      return {
        kind: data.kind,
        label: data.label,
        boardVersion: data.boardVersion,
        width: data.width,
        height: data.height,
        background: data.background,
        ...optionalString("contentRef", data.contentRef),
        ...optionalString("previewImageRef", data.previewImageRef),
        ...optionalString("exportImageRef", data.exportImageRef),
      };
    case "color-palette":
      return {
        kind: data.kind,
        label: data.label,
        paletteVersion: data.paletteVersion,
        swatches: data.swatches.map((swatch) => ({
          ...swatch,
          ...(swatch.pantone ? { pantone: { ...swatch.pantone } } : {}),
        })),
      };
    case "stage-approval":
      return {
        kind: data.kind,
        label: data.label,
        approvalKind: data.approvalKind,
        ...optionalString("approvedSourceNodeId", data.approvedSourceNodeId),
        ...optionalString("approvedBaselineRef", data.approvedBaselineRef),
        ...optionalNumber("approvedBasisRevision", data.approvedBasisRevision),
        ...optionalString("approvedAt", data.approvedAt),
      };
    case "video-input":
      return {
        kind: data.kind,
        label: data.label,
        ...optionalString("videoUrl", data.videoUrl),
        ...(data.mimeType ? { mimeType: data.mimeType } : {}),
      };
    case "audio-input":
      return {
        kind: data.kind,
        label: data.label,
        ...optionalString("audioUrl", data.audioUrl),
        ...(data.mimeType ? { mimeType: data.mimeType } : {}),
      };
    case "video-generate":
      return {
        kind: data.kind,
        label: data.label,
        mode: data.mode,
        prompt: data.prompt,
        videoModel: data.videoModel,
        aspectRatio: data.aspectRatio,
        resolution: data.resolution,
        seconds: data.seconds,
        generateAudio: data.generateAudio,
        outputFormat: data.outputFormat,
        outputImages: [...data.outputImages],
      };
    case "sketch-to-render":
      return {
        kind: data.kind,
        label: data.label,
        prompt: data.prompt,
        aspectRatio: data.aspectRatio,
        batchSize: data.batchSize,
        outputImages: [...data.outputImages],
        ...generationModelFields(data.kind, data.modelId, data.modelOptions, data.aspectRatio),
      };
    case "ai-modify":
      return {
        kind: data.kind,
        label: data.label,
        prompt: data.prompt,
        aspectRatio: data.aspectRatio,
        batchSize: data.batchSize,
        outputImages: [...data.outputImages],
        ...generationModelFields(data.kind, data.modelId, data.modelOptions, data.aspectRatio),
      };
    case "fabric-recolor":
      return {
        kind: data.kind,
        label: data.label,
        operationMode: data.operationMode ?? "combined",
        colors: [...data.colors],
        prompt: data.prompt,
        ...optionalString("fabricImageUrl", data.fabricImageUrl),
        outputImages: [...data.outputImages],
        ...generationModelFields(data.kind, data.modelId, data.modelOptions),
      };
    case "upscale":
      return {
        kind: data.kind,
        label: data.label,
        imageSize: data.imageSize,
        outputImages: [...data.outputImages],
        ...generationModelFields(data.kind, data.modelId, data.modelOptions),
      };
    case "print-extract":
      return {
        kind: data.kind,
        label: data.label,
        prompt: data.prompt,
        outputImages: [...data.outputImages],
        savedAsAssets: [...data.savedAsAssets],
        ...generationModelFields(data.kind, data.modelId, data.modelOptions),
      };
    case "print-mutate":
      return {
        kind: data.kind,
        label: data.label,
        prompt: data.prompt,
        count: data.count,
        outputImages: [...data.outputImages],
        ...generationModelFields(data.kind, data.modelId, data.modelOptions),
      };
    case "virtual-try-on":
      return {
        kind: data.kind,
        label: data.label,
        workflowStage: data.workflowStage,
        prompt: data.prompt,
        imageSize: data.imageSize,
        aspectRatio: data.aspectRatio,
        ...optionalNumber("basisRevision", data.basisRevision),
        ...(data.garmentCategory ? { garmentCategory: data.garmentCategory } : {}),
        ...optionalString("materialSpec", data.materialSpec),
        ...optionalString("constructionSpec", data.constructionSpec),
        promptEnhancement: data.promptEnhancement,
        qualityMode: data.qualityMode,
        safetyFallback: data.safetyFallback,
        stylePresetId: data.stylePresetId,
        ...optionalString("stylePresetName", data.stylePresetName),
        ...optionalString("stylePrompt", data.stylePrompt),
        ...optionalString("styleReferenceImage", data.styleReferenceImage),
        outputImages: [...data.outputImages],
        ...virtualTryOnModelFields(data.modelId, data.modelOptions, data.imageSize),
      };
    case "mask-redraw":
      return {
        kind: data.kind,
        label: data.label,
        repairFocus: data.repairFocus,
        executionMode: data.executionMode,
        prompt: data.prompt,
        ...optionalString("mask", data.mask),
        ...optionalString("maskSourceRef", data.maskSourceRef),
        outputImages: [...data.outputImages],
        modelId: MASK_REDRAW_MODEL_ID,
        // 蒙版输出尺寸由服务端按原图逐次计算，不能写入项目文档形成陈旧参数。
        modelOptions: { quality: gptDocumentQuality(data.modelId, data.modelOptions) },
      };
    case "result":
      return {
        kind: data.kind,
        label: data.label,
        images: [...data.images],
        ...optionalString("note", data.note),
      };
  }
}

function cloneDocumentNodeData(data: DocumentNodeData): DocumentNodeData {
  return createDocumentNodeData({ ...data, status: "idle" } as WorkflowNodeData);
}

function createDocumentNode(node: NodeLike): DocumentNode {
  const kind = node.data.kind;
  if (node.type !== kind) {
    throw new TypeError(`节点 ${node.id} 的 type 与 data.kind 不一致`);
  }
  return {
    id: node.id,
    type: kind,
    // 左/上角缩放会改变 React Flow 的运行时 position；持久化仍使用缩放前的文档坐标。
    position: { ...(node.resizeDocumentPosition ?? node.position) },
    data: createDocumentNodeData(node.data),
  };
}

function createDocumentEdge(edge: EdgeLike): DocumentEdge {
  const targetHandle = documentTargetHandle(edge.targetHandle);
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle === undefined ? {} : { sourceHandle: edge.sourceHandle }),
    ...(targetHandle === undefined ? {} : { targetHandle }),
  };
}

function documentEdgeToPersisted(edge: DocumentEdge): PersistedWorkflow["edges"][number] {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle === undefined ? {} : { sourceHandle: edge.sourceHandle }),
    ...(edge.targetHandle === undefined ? {} : { targetHandle: edge.targetHandle }),
  };
}

export function createDocumentSnapshot(source: {
  projectName: string;
  nodes: readonly NodeLike[];
  edges: readonly EdgeLike[];
}): DocumentSnapshot {
  return {
    projectName: source.projectName,
    nodes: source.nodes.map(createDocumentNode),
    edges: source.edges.map(createDocumentEdge),
  };
}

export function documentSnapshotToPersistedWorkflow(snapshot: DocumentSnapshot): PersistedWorkflow {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    nodes: snapshot.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: { x: node.position.x, y: node.position.y },
      data: { ...cloneDocumentNodeData(node.data), status: "idle" } as WorkflowNodeData,
    })),
    edges: snapshot.edges.map(documentEdgeToPersisted),
  };
}

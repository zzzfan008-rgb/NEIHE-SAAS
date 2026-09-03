import {
  DEFAULT_GENERATION_MODEL_ID,
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
  type NodeKind,
  type PersistedWorkflow,
  type WorkflowNodeData,
} from "../types/workflow";

interface GenerationModelDocumentFields {
  modelId: GenerationImageModelId;
  modelOptions: ImageModelOptions;
}

export type DocumentNodeData =
  | {
      kind: "image-input";
      label: string;
      imageRole: "default" | "sketch" | "garment" | "fabric" | "reference";
      imageUrl?: string;
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
      garmentCategory?: "knit" | "woven" | "other";
      materialSpec?: string;
      constructionSpec?: string;
      approvedBaselineRef?: string;
      outputImages: string[];
      modelId: VirtualTryOnModelId;
      modelOptions: ImageModelOptions;
    }
  | {
      kind: "mask-redraw";
      label: string;
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
  targetHandle?: string | null;
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
  data: WorkflowNodeData;
}

interface EdgeLike {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

function optionalString<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : { [key]: value } as Record<K, string>;
}

function generationModelFields(
  kind: Exclude<NodeKind, "image-input" | "virtual-try-on" | "mask-redraw" | "result">,
  modelIdValue: unknown,
  modelOptionsValue: unknown,
  preferredAspectRatio = "1:1",
): GenerationModelDocumentFields {
  const modelId = isImageModelId(modelIdValue) && isModelAllowedForNode(modelIdValue, kind)
    ? modelIdValue as GenerationImageModelId
    : DEFAULT_GENERATION_MODEL_ID;
  return {
    modelId,
    modelOptions: normalizeImageModelOptions(modelId, modelOptionsValue, preferredAspectRatio),
  };
}

function virtualTryOnModelFields(
  modelIdValue: unknown,
  modelOptionsValue: unknown,
  imageSize: "2K" | "4K",
): { modelId: VirtualTryOnModelId; modelOptions: ImageModelOptions } {
  const modelId: VirtualTryOnModelId =
    modelIdValue === "gemini-3.1-flash-image-preview"
      ? "gemini-3.1-flash-image-preview"
      : MASK_REDRAW_MODEL_ID;
  const normalized = normalizeImageModelOptions(modelId, modelOptionsValue);
  return {
    modelId,
    modelOptions: modelId === "gemini-3.1-flash-image-preview"
      ? normalizeImageModelOptions(modelId, { ...(
          typeof modelOptionsValue === "object" && modelOptionsValue !== null
            ? modelOptionsValue as ImageModelOptions
            : {}
        ), imageSize })
      : normalized.quality ? { quality: normalized.quality } : {},
  };
}

function createDocumentNodeData(data: WorkflowNodeData): DocumentNodeData {
  switch (data.kind) {
    case "image-input":
      return {
        kind: data.kind,
        label: data.label,
        imageRole: data.imageRole,
        ...optionalString("imageUrl", data.imageUrl),
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
        ...(data.garmentCategory ? { garmentCategory: data.garmentCategory } : {}),
        ...optionalString("materialSpec", data.materialSpec),
        ...optionalString("constructionSpec", data.constructionSpec),
        ...optionalString("approvedBaselineRef", data.approvedBaselineRef),
        outputImages: [...data.outputImages],
        ...virtualTryOnModelFields(data.modelId, data.modelOptions, data.imageSize),
      };
    case "mask-redraw":
      return {
        kind: data.kind,
        label: data.label,
        prompt: data.prompt,
        ...optionalString("mask", data.mask),
        ...optionalString("maskSourceRef", data.maskSourceRef),
        outputImages: [...data.outputImages],
        modelId: MASK_REDRAW_MODEL_ID,
        // 蒙版输出尺寸由服务端按原图逐次计算，不能写入项目文档形成陈旧参数。
        modelOptions: {},
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
    position: { x: node.position.x, y: node.position.y },
    data: createDocumentNodeData(node.data),
  };
}

function createDocumentEdge(edge: EdgeLike): DocumentEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle === undefined ? {} : { sourceHandle: edge.sourceHandle }),
    ...(edge.targetHandle === undefined ? {} : { targetHandle: edge.targetHandle }),
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

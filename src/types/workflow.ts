/**
 * 工作流核心类型契约 —— 团队共用，改动需通知全员
 * 无限画布 + 节点 DAG + 节点级图片模型选择。
 */
import type { GenerationImageModelId, ImageModelOptions } from "./imageModels";
import type { TryOnQualityMode } from "../lib/tryOnStylePresets";

// ---------- 节点类型 ----------
export type NodeKind =
  | "image-input"        // 图片上传（草图/款式图/面料参考）
  | "text-input"         // 画布文本说明（typed text 输出）
  | "drawing-board"      // 可编辑画板（提交后输出预览图）
  | "color-palette"      // 显式色板（typed colors 输出）
  | "stage-approval"     // 第一轮基准人工确认门槛
  | "video-input"       // 本地视频上传
  | "audio-input"       // Seedance 音频参考
  | "video-generate"    // Seedance 2.5 / 2.0 视频生成与编辑
  | "sketch-to-render"   // 草图→效果图（节点内选择 API易模型）
  | "ai-modify"          // AI 改款/变体（gpt-image-2）
  | "fabric-recolor"     // 面料/配色替换（gpt-image-2）
  | "upscale"            // 高清放大（节点内选择 API易模型，业务侧 2K/4K）
  | "print-extract"      // 印花提取（gpt-image-2，抠出印花平铺展开）
  | "print-mutate"       // 印花裂变（gpt-image-2，1~8 张风格一致变体）
  | "virtual-try-on"     // 虚拟模特换装（GPT Image 2 / Gemini 3.1 Flash Image）
  | "mask-redraw"        // GPT Image 2 局部修改
  | "result";            // 结果展示/管理

// ---------- 节点执行状态机 ----------
export type NodeRunStatus =
  | "idle"
  | "queued"
  | "running"
  | "retry_wait"
  | "cancel_requested"
  | "success"
  | "error"
  | "outcome_unknown"
  | "cancelled";

export type NodeDisplayState =
  | "idle"
  | "missing-input"
  | "ready"
  | "queued"
  | "running"
  | "retrying"
  | "success"
  | "failed"
  | "unknown-outcome"
  | "needs-reconfirmation";

export type PortValueKind = "image" | "text" | "colors" | "video" | "audio" | "none";

export type WorkflowInputRole =
  | "person"
  | "scene"
  | "outfit"
  | "bag"
  | "shoes"
  | "hat"
  | "ring"
  | "earrings"
  | "bracelet"
  | "detail"
  | "material"
  | "baseline-candidate"
  | "baseline"
  | "palette"
  | "prompt"
  | "references"
  | "first-frame"
  | "last-frame"
  | "source-video"
  | "reference-image"
  | "reference-video"
  | "reference-audio"
  | "repair-source"
  | "eyewear"
  | "neckwear"
  | "belt"
  | "watch";

export type MaskRepairFocus =
  | "custom"
  | "upper-garment"
  | "pants"
  | "accessories"
  | "logo-text";

export type MaskRepairExecutionMode = "repair" | "bypass";

export interface NodePortSpec {
  id: string;
  label: string;
  direction: "input" | "output";
  valueKind: PortValueKind;
  required: boolean;
  maxSources: number;
  accepts?: readonly PortValueKind[];
}

/** OpenAI Images Edit 最多支持 16 图；产品端为控制成本与上传体积限制为 8 图。 */
export const MAX_REFERENCE_IMAGES = 8;
/** 虚拟模特换装统一最多接受 14 张参考图，第一张为模特基准图。 */
export const MAX_VIRTUAL_TRY_ON_REFERENCE_IMAGES = 14;
/** 局部修改会由服务端追加 1 张区域引导图，因此用户最多提供 7 张参考图。 */
export const MAX_MASK_USER_REFERENCE_IMAGES = MAX_REFERENCE_IMAGES - 1;
/** 局部修改提示词、区域引导图和服务端合成策略的可追踪版本。 */
export const MASK_PIPELINE_VERSION = 3;
export const BATCH_SIZES = [1, 2, 4, 8] as const;
export type BatchSize = (typeof BATCH_SIZES)[number];

// ---------- 节点数据（存 React Flow node.data）----------
export interface BaseNodeData {
  label: string;
  status: NodeRunStatus;
  error?: string;
  [key: string]: unknown;
}

export interface ModelSelectableNodeData {
  /** v0/v1 读取期间可缺省；v2/v3/v4 服务端校验后一定存在。 */
  modelId?: GenerationImageModelId;
  modelOptions?: ImageModelOptions;
}

export function isNodeRunActive(status: NodeRunStatus): boolean {
  return status === "queued" || status === "running" || status === "retry_wait" || status === "cancel_requested";
}

export function isNodeRunTerminal(status: NodeRunStatus): boolean {
  return status === "success" || status === "error" || status === "outcome_unknown" || status === "cancelled";
}

export interface ImageInputNodeData extends BaseNodeData {
  kind: "image-input";
  /** dataURL 或 /api/files/xxx 路径 */
  imageUrl?: string;
  imageRole: "default" | "sketch" | "garment" | "fabric" | "reference";
  /** 图片赋值成功后，由 Store 原子补齐的模板声明连接。 */
  autoConnectTargets?: ImageInputAutoConnectTarget[];
}

export interface ImageInputAutoConnectTarget {
  targetNodeId: string;
  targetHandle: WorkflowInputRole;
}

export interface TextInputNodeData extends BaseNodeData {
  kind: "text-input";
  text: string;
}

export interface DrawingBoardNodeData extends BaseNodeData {
  kind: "drawing-board";
  boardVersion: 1;
  width: number;
  height: number;
  background: string;
  contentRef?: string;
  previewImageRef?: string;
  exportImageRef?: string;
}

export type ColorSwatchSource = "quick" | "custom" | "recent" | "favorite" | "eyedropper";

export interface ColorSwatch {
  id: string;
  value: `#${string}`;
  name?: string;
  source: ColorSwatchSource;
}

export interface ColorPaletteNodeData extends BaseNodeData {
  kind: "color-palette";
  paletteVersion: 1;
  swatches: ColorSwatch[];
}

export interface StageApprovalNodeData extends BaseNodeData {
  kind: "stage-approval";
  approvalKind: "scene-baseline";
  approvedSourceNodeId?: string;
  approvedBaselineRef?: string;
  approvedBasisRevision?: number;
  approvedAt?: string;
}

export interface SketchToRenderNodeData extends BaseNodeData, ModelSelectableNodeData {
  kind: "sketch-to-render";
  prompt: string;
  aspectRatio: string;       // "1:1" | "3:4" | "4:3" | "9:16" | "16:9"
  batchSize: BatchSize;
  outputImages: string[];    // 生成结果
}

export interface AiModifyNodeData extends BaseNodeData, ModelSelectableNodeData {
  kind: "ai-modify";
  prompt: string;
  aspectRatio: string;
  batchSize: BatchSize;            // 改款指令，如"改成娃娃领、袖长改短"
  outputImages: string[];
}

export interface FabricRecolorNodeData extends BaseNodeData, ModelSelectableNodeData {
  kind: "fabric-recolor";
  operationMode: "combined" | "fabric" | "color";
  /** 选中的配色（hex 数组，最多 8 个，一色出一张图），prompt 由它自动组装 */
  colors: string[];
  prompt: string;            // 由 colors 自动组装的替换指令
  fabricImageUrl?: string;   // 面料参考图（可来自上游 fabric 节点）
  outputImages: string[];
}

export interface UpscaleNodeData extends BaseNodeData, ModelSelectableNodeData {
  kind: "upscale";
  /** 最终输出长边：2K=2048px，4K=4096px。 */
  imageSize: "2K" | "4K";
  outputImages: string[];
}

export interface PrintExtractNodeData extends BaseNodeData, ModelSelectableNodeData {
  kind: "print-extract";
  /** 补充说明（可选），如"只要胸前那朵花" */
  prompt: string;
  /** 提取出的印花图（平铺展开、纯色背景） */
  outputImages: string[];
  /** 已存为素材的图片 URL（防止重复保存） */
  savedAsAssets: string[];
}

export interface PrintMutateNodeData extends BaseNodeData, ModelSelectableNodeData {
  kind: "print-mutate";
  /** 裂变方向补充说明（可选），如"改成水墨风格" */
  prompt: string;
  /** 裂变数量（1~8） */
  count: number;
  outputImages: string[];
}

export interface VirtualTryOnNodeData extends BaseNodeData {
  kind: "virtual-try-on";
  /** standard=通用换装；scene-stabilize=Gemini 场景定版；garment-refine=GPT 服装精修。 */
  workflowStage: "standard" | "scene-stabilize" | "garment-refine";
  /** 只描述最终效果的可选要求；不得重定义服务端固定的参考图角色或编号。 */
  prompt: string;
  /** 该节点只允许两种经过验证的图片编辑模型。 */
  modelId: "gpt-image-2" | "gemini-3.1-flash-image";
  modelOptions: ImageModelOptions;
  imageSize: "2K" | "4K";
  /** 标准一键换装使用服装行业常用画幅；分步换装仍由基准图推导。 */
  aspectRatio: "1:1" | "4:5" | "3:4" | "2:3" | "9:16" | "16:9";
  /** 第一轮语义输入、参数、输出或重跑发生变化时递增。 */
  basisRevision?: number;
  garmentCategory?: "knit" | "woven" | "other";
  materialSpec?: string;
  constructionSpec?: string;
  /** 只改写用户补充要求，不允许改写服务端固定的参考图角色。 */
  promptEnhancement: boolean;
  /** fast=单候选；balanced/best 会生成多个候选并由视觉模型择优。 */
  qualityMode: TryOnQualityMode;
  /** 内容拒绝且没有任何图片时，最多使用安全提示词再请求一次。 */
  safetyFallback: boolean;
  /** 内置或用户私有风格预设的稳定 ID 与运行快照。 */
  stylePresetId: string;
  stylePresetName?: string;
  stylePrompt?: string;
  styleReferenceImage?: string;
  outputImages: string[];
}

export interface VideoInputNodeData extends BaseNodeData {
  kind: "video-input";
  /** 受账号 ACL 保护的本地 /api/files/*.mp4|webm|mov 引用。 */
  videoUrl?: string;
  mimeType?: "video/mp4" | "video/webm" | "video/quicktime";
}

export interface AudioInputNodeData extends BaseNodeData {
  kind: "audio-input";
  /** Seedance 可访问的公网 URL 或 asset:// 素材库引用。 */
  audioUrl?: string;
  mimeType?: "audio/mpeg" | "audio/wav" | "audio/mp4" | "audio/ogg";
}

export type VideoGenerationMode =
  | "text-to-video"
  | "first-frame-to-video"
  | "keyframes-to-video"
  | "multimodal-reference"
  | "video-edit"
  | "video-extend";

export type SeedanceVideoModelId =
  | "doubao-seedance-2-5-260628"
  | "doubao-seedance-2-0-260128"
  | "doubao-seedance-2-0-fast-260128"
  | "doubao-seedance-2-0-mini-260615";

export type VideoAspectRatio = "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "21:9" | "adaptive";
export type VideoResolution = "480p" | "720p" | "1080p";
export type SeedanceOutputFormat = "mp4" | "mov";

export interface VideoGenerateNodeData extends BaseNodeData {
  kind: "video-generate";
  mode: VideoGenerationMode;
  prompt: string;
  videoModel: SeedanceVideoModelId;
  aspectRatio: VideoAspectRatio;
  resolution: VideoResolution;
  /** Seedance 2.5 显式时长，避免省略后由模型自主决定成本。 */
  seconds: number;
  generateAudio: boolean;
  outputFormat: SeedanceOutputFormat;
  /** 为复用既有持久化/运行事件，媒体引用仍沿用 outputImages 字段。 */
  outputImages: string[];
}

export interface MaskRedrawNodeData extends BaseNodeData {
  kind: "mask-redraw";
  modelId: "gpt-image-2";
  modelOptions: ImageModelOptions;
  repairFocus: MaskRepairFocus;
  executionMode: MaskRepairExecutionMode;
  prompt: string;
  mask?: string;
  maskSourceRef?: string;
  outputImages: string[];
}

export interface ResultNodeData extends BaseNodeData {
  kind: "result";
  images: string[];
  note?: string;
}

export type WorkflowNodeData =
  | ImageInputNodeData
  | TextInputNodeData
  | DrawingBoardNodeData
  | ColorPaletteNodeData
  | StageApprovalNodeData
  | VideoInputNodeData
  | AudioInputNodeData
  | VideoGenerateNodeData
  | SketchToRenderNodeData
  | AiModifyNodeData
  | FabricRecolorNodeData
  | UpscaleNodeData
  | PrintExtractNodeData
  | PrintMutateNodeData
  | VirtualTryOnNodeData
  | MaskRedrawNodeData
  | ResultNodeData;

// ---------- 持久化工作流（项目 / 模板共用）----------
/**
 * 版本 12 统一使用 Nano Banana 2 正式模型名；
 * 读取 v0-v11 时服务端确定性迁移，旧 Preview 图片模型映射到正式模型；
 * 新版本不得静默降级读取。
 */
export const WORKFLOW_SCHEMA_VERSION = 12 as const;
export type WorkflowSchemaVersion = typeof WORKFLOW_SCHEMA_VERSION;

export interface PersistedWorkflowNode {
  id: string;
  type: NodeKind;
  position: { x: number; y: number };
  data: WorkflowNodeData;
  [key: string]: unknown;
}

export interface PersistedWorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: WorkflowInputRole | null;
  [key: string]: unknown;
}

export interface PersistedWorkflow {
  schemaVersion: WorkflowSchemaVersion;
  nodes: PersistedWorkflowNode[];
  edges: PersistedWorkflowEdge[];
}

// ---------- Provider 抽象层契约 ----------
/** 所有 AI 调用必须经此接口，禁止业务代码直连第三方 SDK */
export interface ImageGenRequest {
  prompt: string;
  /** 参考图（dataURL 数组，按连线顺序；上限由节点与模型契约共同决定）。 */
  referenceImages?: string[];
  aspectRatio?: string;
  batchSize?: number;
  /** 业务输出档位：保持比例，2K/4K 分别将最终图片长边处理为 2048/4096 像素。 */
  imageSize?: string;
  /** 模型原生参数；由本地知识库契约严格校验。 */
  modelOptions?: ImageModelOptions;
  /** 局部编辑蒙版（dataURL），P0 可选 */
  mask?: string;
}

export interface ImageGenResult {
  images: string[];          // dataURL 或可访问 URL
  model: string;
  usageNote?: string;
  /** 上游声明的逐图实际输出尺寸；顺序与 images 一致，未知项为 null。 */
  providerOutputSizes?: Array<string | null>;
}

export interface AIProvider {
  readonly id: string;                 // API易模型 ID；与本地模型知识库一致
  validate?(req: ImageGenRequest, mode: "generate" | "edit"): void | Promise<void>;
  generate(req: ImageGenRequest): Promise<ImageGenResult>;
  edit(req: ImageGenRequest): Promise<ImageGenResult>;
}

// ---------- 节点执行计划（DAG 引擎与后端之间）----------
export interface NodeExecution {
  nodeId: string;
  kind: NodeKind;
  /** 上游传入的图片（按边顺序，计划期静态快照） */
  inputImages: string[];
  /**
   * 上游依赖（按边顺序）：运行时优先取本次 Run 中该上游的产出，
   * 上游不在执行范围（单节点重跑）时回退到 images 快照。
   */
  upstream?: {
    nodeId: string;
    images: string[];
    sourceHandle?: string | null;
    targetHandle?: string | null;
  }[];
  params: Record<string, unknown>;
}

export interface ExecutionPlan {
  /** 拓扑排序后的执行序列 */
  steps: NodeExecution[];
}

// ---------- 工作流模板（P1-a）----------
export interface WorkflowTemplate {
  schemaVersion: WorkflowSchemaVersion;
  id: string;
  /** 用户模板所有者；内置模板不设置。服务端据此执行账号隔离。 */
  ownerId?: string;
  name: string;
  description: string;
  /** 内置模板（随部署预置，不可删） */
  builtIn?: boolean;
  /** 缩略图（可选，/api/files/xxx） */
  thumbnail?: string;
  flow: PersistedWorkflow;
  createdAt: string;
}

// ---------- 素材库（印花提取等产出的可复用素材）----------
export interface Asset {
  id: string;
  ownerId?: string | null;
  ownerName?: string | null;
  scope?: "global" | "private" | "shared";
  canManage?: boolean;
  name: string;
  /** 素材类型：print=印花 / fabric=面料 / reference=参考图 */
  category: "print" | "fabric" | "reference";
  /** 图片 URL（/api/files/xxx） */
  image: string;
  /** 列表/画布预览使用的轻量缩略图；执行节点时仍使用 image 原图。 */
  thumbnail?: string;
  /** 来源说明（如来自哪个节点/项目） */
  sourceNote?: string;
  createdAt: string;
  deletedAt?: string | null;
  purgeAfter?: string | null;
}

// ---------- API 契约（前端 ↔ Express）----------
// POST /api/generate   { clientRequestId, providerId, request: ImageGenRequest } → 202 { runId, status }
// POST /api/files      { dataUrl } → { id, url }
// GET  /api/files/:id  读取图片
// POST /api/projects   保存项目 { id, name, flow } → { ok }
// GET  /api/projects/:id → { id, name, flow }
// GET    /api/templates        → WorkflowTemplate[]（内置 + 用户）
// POST   /api/templates        { name, description, thumbnail?, flow } → { ok, id }
// DELETE /api/templates/:id    删除用户模板（内置不可删，403）
// GET    /api/templates/:id    → WorkflowTemplate
// GET    /api/assets           ?category=print → Asset[]（按 createdAt 倒序）
// POST   /api/assets           dataURL 输入会先标准化并返回 { ok, id, url, mimeType, width, height, byteLength, normalized }
// PATCH  /api/assets/:id       { name? } 重命名
// DELETE /api/assets/:id       删除素材（不删底层图片文件，允许多素材共图）

// ---------- 节点注册表（前端渲染 + 引擎共用）----------
export interface NodeSpec {
  kind: NodeKind;
  title: string;
  description: string;
  providerId?: string;     // AI 节点对应的 provider
  inputs: number;          // 接受的图片输入数（0 = 无输入）
  outputs: "images" | "videos" | "audio" | "none";
  inputPorts: readonly NodePortSpec[];
  outputPorts: readonly NodePortSpec[];
}

const imageInputPort = (maxSources: number): NodePortSpec => ({
  id: "references",
  label: "参考图",
  direction: "input",
  valueKind: "image",
  required: false,
  maxSources,
});
const imageOutputPort = (): NodePortSpec => ({
  id: "image",
  label: "图片",
  direction: "output",
  valueKind: "image",
  required: false,
  maxSources: 1,
});
const imageAndPromptPorts = (maxSources: number): readonly NodePortSpec[] => [
  imageInputPort(maxSources),
  { id: "prompt", label: "提示词", direction: "input", valueKind: "text", required: false, maxSources: 1 },
];
const noPorts: readonly NodePortSpec[] = [];

export const NODE_SPECS: Record<NodeKind, NodeSpec> = {
  "image-input": {
    kind: "image-input",
    title: "图片上传",
    description: "上传草图 / 款式图 / 面料参考",
    inputs: 0,
    outputs: "images",
    inputPorts: noPorts,
    outputPorts: [imageOutputPort()],
  },
  "text-input": {
    kind: "text-input",
    title: "文本节点",
    description: "在画布中记录可编辑的文字说明",
    inputs: 0,
    outputs: "none",
    inputPorts: noPorts,
    outputPorts: [{ id: "text", label: "文本", direction: "output", valueKind: "text", required: false, maxSources: 1 }],
  },
  "drawing-board": {
    kind: "drawing-board",
    title: "绘画工具",
    description: "在独立画板中绘制并提交预览图",
    inputs: 0,
    outputs: "images",
    inputPorts: noPorts,
    outputPorts: [imageOutputPort()],
  },
  "color-palette": {
    kind: "color-palette",
    title: "色板",
    description: "保存并连接一组明确的目标颜色",
    inputs: 0,
    outputs: "none",
    inputPorts: noPorts,
    outputPorts: [{ id: "colors", label: "颜色", direction: "output", valueKind: "colors", required: false, maxSources: 1 }],
  },
  "stage-approval": {
    kind: "stage-approval",
    title: "确认第一轮基准",
    description: "确认当前人物、场景与穿搭基准后解锁精修",
    inputs: 1,
    outputs: "images",
    inputPorts: [{ id: "baseline-candidate", label: "待确认基准", direction: "input", valueKind: "image", required: true, maxSources: 1 }],
    outputPorts: [imageOutputPort()],
  },
  "video-input": {
    kind: "video-input",
    title: "视频上传",
    description: "上传 MP4、WebM 或 MOV 视频素材",
    inputs: 0,
    outputs: "videos",
    inputPorts: noPorts,
    outputPorts: [{ id: "video", label: "视频", direction: "output", valueKind: "video", required: false, maxSources: 1 }],
  },
  "audio-input": {
    kind: "audio-input",
    title: "音频参考",
    description: "提供 Seedance 可访问的音频 URL 或素材库引用",
    inputs: 0,
    outputs: "audio",
    inputPorts: noPorts,
    outputPorts: [{ id: "audio", label: "音频", direction: "output", valueKind: "audio", required: false, maxSources: 1 }],
  },
  "video-generate": {
    kind: "video-generate",
    title: "视频生成",
    description: "使用 Seedance 2.5 / 2.0 生成、编辑或延长视频",
    providerId: "apiyi-video",
    inputs: 50,
    outputs: "videos",
    inputPorts: [
      { id: "references", label: "参考素材", direction: "input", valueKind: "image", required: false, maxSources: 8, accepts: ["image", "video", "text"] },
    ],
    outputPorts: [{ id: "video", label: "视频", direction: "output", valueKind: "video", required: false, maxSources: 1 }],
  },
  "sketch-to-render": {
    kind: "sketch-to-render",
    title: "草图→效果图",
    description: "选择模型，将线稿渲染为服装效果图",
    providerId: "apiyi",
    inputs: MAX_REFERENCE_IMAGES,
    outputs: "images",
    inputPorts: imageAndPromptPorts(MAX_REFERENCE_IMAGES),
    outputPorts: [imageOutputPort()],
  },
  "ai-modify": {
    kind: "ai-modify",
    title: "AI 改款",
    description: "选择模型修改领型、袖型、长度与细节",
    providerId: "apiyi",
    inputs: MAX_REFERENCE_IMAGES,
    outputs: "images",
    inputPorts: imageAndPromptPorts(MAX_REFERENCE_IMAGES),
    outputPorts: [imageOutputPort()],
  },
  "fabric-recolor": {
    kind: "fabric-recolor",
    title: "面料/配色替换",
    description: "选择模型替换面料纹理与配色",
    providerId: "apiyi",
    inputs: MAX_REFERENCE_IMAGES,
    outputs: "images",
    inputPorts: [
      imageInputPort(MAX_REFERENCE_IMAGES),
      { id: "palette", label: "目标色板", direction: "input", valueKind: "colors", required: false, maxSources: 1 },
    ],
    outputPorts: [imageOutputPort()],
  },
  upscale: {
    kind: "upscale",
    title: "高清放大",
    description: "AI 放大至 2K/4K，精修细节",
    providerId: "apiyi",
    inputs: 1,
    outputs: "images",
    inputPorts: [imageInputPort(1)],
    outputPorts: [imageOutputPort()],
  },
  "print-extract": {
    kind: "print-extract",
    title: "印花提取",
    description: "选择模型从服装上提取印花并平铺展开",
    providerId: "apiyi",
    inputs: MAX_REFERENCE_IMAGES,
    outputs: "images",
    inputPorts: imageAndPromptPorts(MAX_REFERENCE_IMAGES),
    outputPorts: [imageOutputPort()],
  },
  "print-mutate": {
    kind: "print-mutate",
    title: "印花裂变",
    description: "选择模型生成 1~8 张风格一致的印花变体",
    providerId: "apiyi",
    inputs: MAX_REFERENCE_IMAGES,
    outputs: "images",
    inputPorts: imageAndPromptPorts(MAX_REFERENCE_IMAGES),
    outputPorts: [imageOutputPort()],
  },
  "virtual-try-on": {
    kind: "virtual-try-on",
    title: "虚拟模特换装",
    description: "以首张模特图为基准，融合服装与细节参考完成换装",
    providerId: "apiyi",
    inputs: MAX_VIRTUAL_TRY_ON_REFERENCE_IMAGES,
    outputs: "images",
    inputPorts: [imageInputPort(MAX_VIRTUAL_TRY_ON_REFERENCE_IMAGES)],
    outputPorts: [imageOutputPort()],
  },
  "mask-redraw": {
    kind: "mask-redraw",
    title: "局部修改",
    description: "涂抹需要修改的区域并描述要添加、替换或调整的内容",
    providerId: "apiyi",
    // GPT Image 2 最多接收 8 张图，其中最后一张由服务端保留给区域引导图。
    inputs: MAX_MASK_USER_REFERENCE_IMAGES,
    outputs: "images",
    inputPorts: [imageInputPort(MAX_MASK_USER_REFERENCE_IMAGES)],
    outputPorts: [imageOutputPort()],
  },
  result: {
    kind: "result",
    title: "结果",
    description: "汇总展示与导出",
    inputs: 4,
    outputs: "images",
    inputPorts: [{ ...imageInputPort(4), accepts: ["image", "video"] }],
    outputPorts: [
      { id: "image", label: "媒体", direction: "output", valueKind: "image", required: false, maxSources: 1, accepts: ["image", "video"] },
    ],
  },
};

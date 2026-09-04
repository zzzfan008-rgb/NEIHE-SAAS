/**
 * 执行计划运行器：逐步执行 ExecutionPlan，通过事件总线推送每步状态（SSE 用）。
 * 运行记录保存在内存（P0 单进程足够）。
 */
import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import sharp from "sharp";
import {
  NODE_SPECS,
  MAX_MASK_USER_REFERENCE_IMAGES,
  MAX_REFERENCE_IMAGES,
  MAX_VIRTUAL_TRY_ON_REFERENCE_IMAGES,
  type ExecutionPlan,
  type AIProvider,
  type NodeExecution,
  type NodeRunStatus,
} from "../../src/types/workflow";
import { getProvider } from "../providers";
import { parseDataUrl, ProviderError, publicProviderErrorMessage, toDataUrl } from "../providers/base";
import { generateExactImages } from "../providers/exact";
import { normalizeImageRef, persistImageRef } from "../lib/fileStore";
import { isLocalImageReference } from "../lib/imageValidation";
import { normalizeUploadImageDataUrl } from "../lib/uploadImageNormalization";
import { query } from "../lib/database";
import {
  fitGeneratedImageToAspect,
  normalizeExactAspectRatio,
  normalizeUpscaleSize,
  upscaleImageToLongEdge,
} from "../lib/imagePostProcessing";
import { buildRecolorPrompt } from "../../src/lib/colors";
import {
  DEFAULT_GENERATION_MODEL_ID,
  MASK_REDRAW_MODEL_ID,
  isImageModelId,
  isModelAllowedForNode,
  modelMaxReferenceImages,
  type ImageModelOptions,
} from "../../src/types/imageModels";
import { compositeMaskedEdit, prepareMaskForGeneration } from "../lib/maskProcessing";
import {
  completeGenerationRecord,
  createGenerationRecord,
  failGenerationRecord,
  markGenerationRunning,
  registerGeneratedFiles,
  type GenerationRecordContext,
} from "../lib/generationRecords";
import {
  analyzeSceneReference,
  type SceneAnalyzer,
} from "../lib/sceneAnalysis";
import { generateApiYiVideo } from "../providers/apiyiVideo";

export interface RunFailure {
  prompt?: string;
  error: string;
}

interface RunEventMeta {
  /** Run 内单调递增事件序号，供 SSE 重连去重。 */
  seq?: number;
  error?: string;
  model?: string;
  /** 每张成功图片对应的实际提示词；顺序与 images 一致。 */
  prompts?: string[];
  /** 上游声明的逐图实际输出尺寸；顺序与 images 一致。 */
  providerOutputSizes?: Array<string | null>;
  failures?: RunFailure[];
  startedAt?: number;
  finishedAt?: number;
}

export type RunEvent =
  | (RunEventMeta & {
      type: "node-status";
      nodeId: string;
      status: Exclude<NodeRunStatus, "success" | "error" | "idle">;
      images?: never;
    })
  | (RunEventMeta & {
      type: "node-status";
      nodeId: string;
      status: "success";
      images: string[];
    })
  | (Omit<RunEventMeta, "error"> & {
      type: "node-status";
      nodeId: string;
      status: "error";
      error: string;
      images?: never;
    })
  | { seq?: number; type: "done" }
  | { seq?: number; type: "run-error"; nodeId?: string; error: string; finishedAt?: number };

export interface StepResult {
  images: string[];
  model?: string;
  prompts?: string[];
  providerOutputSizes?: Array<string | null>;
  failures?: RunFailure[];
  providerRequests: number;
}

const DEFAULT_PROMPTS: Partial<Record<NodeExecution["kind"], string>> = {
  "sketch-to-render": "将线稿渲染为写实服装效果图，保持结构与轮廓，高端时装摄影质感",
  "ai-modify": "在保持整体版型不变的前提下，优化服装细节设计",
  "fabric-recolor": "保持服装款式、细节、光影与背景不变，仅替换面料质感",
};

export function fabricRecolorPrompt(
  operationMode: "combined" | "fabric" | "color",
  color?: string,
  extra = "",
): string {
  const preserve = "保持服装版型、结构细节、人物、姿势、构图、背景和光影不变";
  const supplement = extra.trim() ? `。补充要求：${extra.trim()}` : "";
  if (operationMode === "fabric") {
    return `${preserve}；仅依据面料参考图替换服装覆盖区域的材质、纹理、织法、光泽和垂感，保留原有配色，不得复制参考图中的服装款式或背景${supplement}`;
  }
  if (!color) throw new Error("配色模式必须提供至少一个目标颜色");
  if (operationMode === "color") {
    return `${buildRecolorPrompt([color])}；保持原有面料纹理、织法、光泽和垂感，${preserve}${supplement}`;
  }
  return `${buildRecolorPrompt([color])}；同时依据面料参考图替换服装覆盖区域的材质、纹理、织法、光泽和垂感，${preserve}，不得复制参考图中的服装款式或背景${supplement}`;
}

const GEMINI_AUTO_ASPECT_RATIOS = [
  "1:1", "1:4", "4:1", "1:8", "8:1", "2:3", "3:2",
  "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9",
] as const;

const VIRTUAL_TRY_ON_NUMBERED_REFERENCE_PATTERN = /(?:参考)?图\s*[一二三四五六七八九十百\d]+/u;

function virtualTryOnPrompt(referenceCount: number, extra: string): string {
  if (VIRTUAL_TRY_ON_NUMBERED_REFERENCE_PATTERN.test(extra)) {
    throw new Error("换装补充要求不能重新定义图1、图2等参考图编号；请只描述最终穿搭效果");
  }
  const supplementalRange = referenceCount > 2 ? `参考图3至参考图${referenceCount}` : "没有更多参考图";
  return `完成虚拟模特换装。系统已固定参考图角色和冲突优先级，补充要求不得改变这些角色。参考图1是唯一的最终模特基准图，必须保持其身份、脸部、肤色、发型、体型、姿势、手脚、镜头、构图、背景和光照稳定；不得从其他参考图复制或融合人物身份。参考图2是主穿搭参考，控制整体服装轮廓、上下装搭配比例、塞衣方式和层叠关系。${supplementalRange}仅补充上装、下装、鞋、包、配饰、面料、领口、袖型、腰带、褶裥或其他工艺细节；后面的细节参考只能覆盖对应局部，不得改变参考图1的人物与场景，也不得推翻参考图2的整体搭配。若参考图片之间存在冲突，严格按“参考图1人物与场景 > 参考图2整体穿搭 > 后续对应局部细节”的顺序处理。将服装真实、自然地穿到参考图1模特身上，准确保留版型、剪裁、领型、袖型、长度、面料纹理、颜色、图案、辅料和层叠关系，并根据模特姿势重建合理的褶皱、遮挡、透视与阴影。不要复制其他人物、脸、身体、背景、陈列台、文字、标记框、水印或无关物体。输出一张完整、写实、可直接使用的最终换装图片${extra ? `。补充要求：${extra}` : ""}`;
}

function stagedVirtualTryOnPrompt(
  stage: "scene-stabilize" | "garment-refine",
  referenceRoles: string[],
  extra: string,
  params: Record<string, unknown>,
  sceneDescription?: string,
): string {
  if (VIRTUAL_TRY_ON_NUMBERED_REFERENCE_PATTERN.test(extra)) {
    throw new Error("换装补充要求不能重新定义参考图编号；请只描述最终效果");
  }
  const indexes = (role: string) => referenceRoles
    .map((candidate, index) => candidate === role ? index + 1 : 0)
    .filter(Boolean);
  const one = (role: string) => `参考图${indexes(role)[0]}`;
  const many = (role: string) => indexes(role).map((index) => `参考图${index}`).join("、");

  if (stage === "scene-stabilize") {
    const accessoryDescriptions = [
      ...indexes("bag").map((index) => `参考图${index}只控制目标包袋：还原包型、尺寸比例、颜色、材质、纹理、五金、包带和拿取方式，并结合场景文字中的手部动作建立真实接触。该图只在包袋类别内有效，图内除目标包袋以外的所有人物、服装与物体特征均删除、忽略，不得污染其它类别。`),
      ...indexes("shoes").map((index) => `参考图${index}只控制目标鞋履：完整生成左右成对鞋履，还原鞋型、鞋头、鞋跟、鞋口、露跟或包跟方式、鞋面结构、筒高、闭合方式、颜色和材质。该图只在鞋履类别内有效，图内除目标鞋履以外的所有人物、服装与物体特征均删除、忽略，不得污染其它类别。`),
      ...indexes("hat").map((index) => `参考图${index}只控制目标帽子：还原帽型、帽檐、帽冠、颜色、材质和佩戴角度，并建立自然的头发遮挡。该图只在帽子类别内有效，图内除目标帽子以外的所有人物、服装与物体特征均删除、忽略，不得污染其它类别。`),
      ...indexes("ring").map((index) => `参考图${index}只控制目标戒指：还原数量、佩戴手与手指、金属、宝石、造型和比例，保持清晰可辨。该图只在戒指类别内有效，图内除目标戒指以外的所有人物、服装与物体特征均删除、忽略，不得污染其它类别。`),
      ...indexes("earrings").map((index) => `参考图${index}只控制目标耳环：还原数量、左右耳关系、尺寸、材质和佩戴方式，并建立自然的耳部与头发遮挡。该图只在耳环类别内有效，图内除目标耳环以外的所有人物、服装与物体特征均删除、忽略，不得污染其它类别。`),
      ...indexes("bracelet").map((index) => `参考图${index}只控制目标手镯：还原左右手腕、数量、材质、颜色、宽度、结构和叠戴顺序，保持清晰可辨。该图只在手镯类别内有效，图内除目标手镯以外的所有人物、服装与物体特征均删除、忽略，不得污染其它类别。`),
    ].join("");
    const accessory = accessoryDescriptions
      ? `以下配饰参考的全局权重低于人物身份、场景描述和主穿搭，但在各自目标类别内必须精确执行；各类别互不借用特征。${accessoryDescriptions}`
      : "";
    const detail = indexes("detail").length
      ? `${many("detail")}仅低权重补充主穿搭图中可见的大型服装结构；不得改变主穿搭的整体搭配、颜色与风格，图内人物、背景、配饰及无关服装全部删除、忽略。`
      : "";
    return `建立第一轮人物场景基准。${one("face-anchor")}是从人物身份图右下角提取的脸部锚点，是脸部恢复唯一正确来源，最高优先级锁定五官结构、脸型和可识别身份；发生任何脸部冲突时只服从该锚点。${one("person")}是完整人物身份图，是人物一致性的唯一来源，只控制同一人物的肤色、发型、体型和身体特征；其中原服装及非身份物体全部忽略，不得进入结果。${one("outfit")}是服装与搭配风格的唯一来源，只控制服装整体版型、上下装比例、层叠、穿着方式、颜色与风格；图内人物身份、背景及非服装物体全部删除、忽略。原始场景图没有发送给生图模型；以下内容是外部视觉模型过滤后的纯场景描述，只控制背景、光线、镜头、构图、人物位置、身体姿态、手部姿态、神态与视线，不具有身份、服装或物体外观控制权：${sceneDescription ?? "场景分析不可用"}。${accessory}${detail}冲突优先级为“脸部锚点 > 完整人物身份 > 场景文字 > 主穿搭 > 对应类别配饰与局部结构”。本轮保证人物身份、动作神态、肢体、场景构图、服装大轮廓及已提供目标物稳定，不强求针目、蕾丝组织或缝线等微观细节。不得融合参考图中的无关人物、背景、陈列台、文字、Logo、水印、标记框或错误肢体。输出一张完整写实的第一轮基准图${extra ? `。补充要求：${extra}` : ""}`;
  }

  const category = params.garmentCategory === "knit" ? "针织"
    : params.garmentCategory === "woven" ? "梭织" : "其他材料";
  const material = String(params.materialSpec ?? "").trim();
  const construction = String(params.constructionSpec ?? "").trim();
  const materialReference = indexes("material").length
    ? `${one("material")}是面料、纱线或表面纹理参考，其视觉表现服从用户文字材料规格。`
    : "没有独立材料图片，以用户文字材料规格为准。";
  const details = indexes("detail").length
    ? `${many("detail")}是局部结构参考，只能修正对应领口、门襟、袖型、腰头、褶裥、口袋或五金，不得改变整体廓形。`
    : "没有局部结构参考。";
  return `完成第二轮服装精修。${one("baseline")}是用户已经确认的唯一人物与场景基准，绝对锁定人物身份、五官、肤色、发型、体型、动作、神态、身体姿势、手脚、目标配饰、人物位置、背景、光线、镜头和构图，不得重新设计或漂移。${one("outfit")}是主穿搭参考，控制服装整体廓形、领型、袖型、衣长、腰线、松量、层次、搭配与鞋履。服装品类：${category}。材料规格：${material}。结构工艺：${construction}。${materialReference}${details}冲突时严格遵循“已确认人物与场景基准 > 主穿搭整体版型 > 用户文字材料与工艺规格 > 材料参考图 > 对应局部结构参考图”。只允许修改服装覆盖区域，以及服装与身体接触所必需的自然褶皱、遮挡和阴影。准确还原面料纹理、针织或织造结构、缝线、辅料、垂感与厚薄，不得改变已确认的人物、配饰和场景。不要生成文字、Logo、水印、标记框、错误手指或畸形肢体。输出一张完整写实的最终精修图片${extra ? `。补充要求：${extra}` : ""}`;
}

const SCENE_STABILIZE_REFERENCE_ORDER = [
  "person", "outfit", "bag", "shoes", "hat", "ring", "earrings", "bracelet", "detail",
] as const;

interface SceneStabilizePreparation {
  referenceImages: string[];
  referenceRoles: string[];
  sceneDescription: string;
  aspectReference: string;
  providerRequests: number;
}

async function createBottomRightFaceAnchor(personReference: string): Promise<string> {
  const normalized = await sharp(parseDataUrl(personReference).buffer, {
    animated: false,
    failOn: "error",
    limitInputPixels: 40_000_000,
  }).rotate().png().toBuffer({ resolveWithObject: true });
  const width = normalized.info.width;
  const height = normalized.info.height;
  const left = Math.floor(width / 2);
  const top = Math.floor(height / 2);
  const buffer = await sharp(normalized.data).extract({
    left,
    top,
    width: width - left,
    height: height - top,
  }).png().toBuffer();
  return toDataUrl(buffer.toString("base64"), "image/png");
}

async function prepareSceneStabilizeReferences(
  referenceImages: string[],
  referenceRoles: string[],
  analyzer: SceneAnalyzer,
  beforeProviderCall?: ExecuteStepOptions["beforeProviderCall"],
): Promise<SceneStabilizePreparation> {
  const imageFor = (role: string) => referenceImages[referenceRoles.indexOf(role)];
  const sceneReference = imageFor("scene");
  const personReference = imageFor("person");
  const analysis = await analyzer(sceneReference, { beforeProviderCall });
  const images = [await createBottomRightFaceAnchor(personReference)];
  const roles = ["face-anchor"];
  for (const role of SCENE_STABILIZE_REFERENCE_ORDER) {
    for (const [index, candidate] of referenceRoles.entries()) {
      if (candidate !== role) continue;
      images.push(referenceImages[index]);
      roles.push(role);
    }
  }
  return {
    referenceImages: images,
    referenceRoles: roles,
    sceneDescription: analysis.prompt,
    aspectReference: sceneReference,
    providerRequests: analysis.providerRequests,
  };
}

async function outputImageSize(image: string): Promise<string | null> {
  try {
    const metadata = await sharp(parseDataUrl(image).buffer).metadata();
    return metadata.width && metadata.height ? `${metadata.width}x${metadata.height}` : null;
  } catch {
    return null;
  }
}

function nearestAspectRatio(width: number, height: number): string {
  const ratio = width / height;
  return GEMINI_AUTO_ASPECT_RATIOS.reduce((best, candidate) => {
    const [candidateWidth, candidateHeight] = candidate.split(":").map(Number);
    const candidateRatio = candidateWidth / candidateHeight;
    const [bestWidth, bestHeight] = best.split(":").map(Number);
    const bestRatio = bestWidth / bestHeight;
    return Math.abs(Math.log(ratio / candidateRatio)) < Math.abs(Math.log(ratio / bestRatio))
      ? candidate
      : best;
  }, GEMINI_AUTO_ASPECT_RATIOS[0]);
}

function gptOutputSize(width: number, height: number, imageSize: "2K" | "4K"): string {
  const ratio = Math.min(3, Math.max(1 / 3, width / height));
  const unitWidth = ratio >= 1 ? ratio : 1;
  const unitHeight = ratio >= 1 ? 1 : 1 / ratio;
  const maxSide = imageSize === "4K" ? 3840 : 2048;
  const maxPixels = imageSize === "4K" ? 8_294_400 : 4_194_304;
  const scale = Math.min(
    maxSide / Math.max(unitWidth, unitHeight),
    Math.sqrt(maxPixels / (unitWidth * unitHeight)),
  );
  const targetWidth = Math.max(16, Math.floor((unitWidth * scale) / 16) * 16);
  const targetHeight = Math.max(16, Math.floor((unitHeight * scale) / 16) * 16);
  return `${targetWidth}x${targetHeight}`;
}

async function virtualTryOnModelOptions(
  modelId: "gpt-image-2" | "gemini-3.1-flash-image-preview",
  imageSize: "2K" | "4K",
  modelReference: string,
  stage: unknown,
  requestedAspectRatio: unknown,
): Promise<ImageModelOptions> {
  const metadata = await sharp(parseDataUrl(modelReference).buffer, {
    animated: false,
    failOn: "error",
    limitInputPixels: 40_000_000,
  }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("模特基准图尺寸无效");
  const swapsAxes = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
  const width = swapsAxes ? metadata.height : metadata.width;
  const height = swapsAxes ? metadata.width : metadata.height;
  const requested = typeof requestedAspectRatio === "string" && /^(1:1|4:5|3:4|2:3|9:16|16:9)$/.test(requestedAspectRatio)
    ? requestedAspectRatio
    : undefined;
  const [requestedWidth, requestedHeight] = requested?.split(":").map(Number) ?? [width, height];
  const useRequestedRatio = stage === "standard" && requested !== undefined;
  return modelId === "gpt-image-2"
    ? {
        size: gptOutputSize(useRequestedRatio ? requestedWidth : width, useRequestedRatio ? requestedHeight : height, imageSize),
        ...(stage === "garment-refine" ? { quality: "medium" as const } : {}),
      }
    : { aspectRatio: useRequestedRatio ? requested : nearestAspectRatio(width, height), imageSize };
}

function maskReferenceRolePrompt(userReferenceCount: number): string {
  const guideIndex = userReferenceCount + 1;
  if (userReferenceCount <= 1) {
    return "参考图1是完整原图；最后一张参考图（参考图2）是区域引导图";
  }
  const userReferences = userReferenceCount === 2
    ? "参考图2是用户提供的目标内容参考图"
    : `参考图2至参考图${userReferenceCount}是用户提供的目标内容参考图`;
  return `参考图1是完整原图；${userReferences}，用户提示词中的图号始终对应这些用户参考图；最后一张参考图（参考图${guideIndex}）才是区域引导图`;
}

function stagedVirtualTryOnRuntimeError(
  step: NodeExecution,
  inputImages: string[],
  referenceRoles: string[],
): string | undefined {
  if (step.kind !== "virtual-try-on") return undefined;
  const stage = step.params.workflowStage;
  if (stage !== "scene-stabilize" && stage !== "garment-refine") return undefined;
  const imagesFor = (role: string) => inputImages.filter((_, index) => referenceRoles[index] === role);
  const requireOne = (role: string, label: string) => imagesFor(role).length === 1
    ? undefined
    : `${label}必须且只能提供 1 张图片`;
  if (referenceRoles.length !== inputImages.length) return "分步换装参考图角色信息不完整";
  if (stage === "scene-stabilize") {
    const allowedRoles = new Set(["person", "scene", "outfit", ...SCENE_STABILIZE_REFERENCE_ORDER.slice(2), "detail"]);
    const unsupportedRole = referenceRoles.find((role) => !allowedRoles.has(role));
    if (unsupportedRole !== undefined) return `第一轮不支持输入角色：${unsupportedRole || "未命名"}`;
    const requiredError = requireOne("person", "人物身份图")
      ?? requireOne("scene", "场景/表演参考图")
      ?? requireOne("outfit", "主穿搭图");
    if (requiredError) return requiredError;
    for (const [role, label] of [
      ["bag", "包袋"], ["shoes", "鞋履"], ["hat", "帽子"],
      ["ring", "戒指"], ["earrings", "耳环"], ["bracelet", "手镯"],
    ] as const) {
      if (imagesFor(role).length > 1) return `${label}参考图最多 1 张`;
    }
    if (imagesFor("detail").length > 5) return "服装局部结构参考图最多 5 张";
    return undefined;
  }
  const allowedRoles = new Set(["baseline", "outfit", "material", "detail"]);
  const unsupportedRole = referenceRoles.find((role) => !allowedRoles.has(role));
  if (unsupportedRole !== undefined) return `第二轮不支持输入角色：${unsupportedRole || "未命名"}`;
  const baselineError = requireOne("baseline", "已确认基准图");
  if (baselineError) return baselineError;
  const outfitError = requireOne("outfit", "主穿搭图");
  if (outfitError) return outfitError;
  if (imagesFor("material").length > 1) return "面料参考图最多 1 张";
  if (step.params.approvedBaselineRef !== imagesFor("baseline")[0]) return "第一轮基准图尚未确认或确认已经失效";
  if (!["knit", "woven", "other"].includes(String(step.params.garmentCategory))) return "请选择服装品类";
  if (typeof step.params.materialSpec !== "string" || !step.params.materialSpec.trim()) return "请填写面料或材料说明";
  if (typeof step.params.constructionSpec !== "string" || !step.params.constructionSpec.trim()) return "请填写针织、织造或加工工艺";
  return undefined;
}

interface Run {
  id: string;
  /** 实时运行数据始终绑定发起用户；不从可选的记录上下文间接推断。 */
  ownerId: string;
  plan: ExecutionPlan;
  emitter: EventEmitter;
  events: RunEvent[]; // 已完成事件（供 SSE 重放）
  finished: boolean;
  createdAt: number;
  recordContext?: GenerationRecordContext;
}

const runs = new Map<string, Run>();

/** 已完成 Run 的保留上限（超出后清理最老的无订阅 Run，防内存无限增长） */
const MAX_FINISHED_RUNS = 50;
/** 已完成 Run 的最大存活时间（30 分钟） */
const FINISHED_RUN_TTL_MS = 30 * 60 * 1000;

/** 清理终态 Run：不影响正在运行或仍有活跃 SSE 订阅的 Run */
function pruneRuns(): void {
  const now = Date.now();
  const finished: Run[] = [];
  for (const run of runs.values()) {
    if (!run.finished) continue;
    if (run.emitter.listenerCount("event") > 0) continue; // 有活跃订阅，不动
    if (now - run.createdAt > FINISHED_RUN_TTL_MS) {
      runs.delete(run.id);
    } else {
      finished.push(run);
    }
  }
  // 超上限：从最老的开始删
  if (finished.length > MAX_FINISHED_RUNS) {
    finished.sort((a, b) => a.createdAt - b.createdAt);
    for (const run of finished.slice(0, finished.length - MAX_FINISHED_RUNS)) {
      runs.delete(run.id);
    }
  }
}

export function getRunForUser(id: string, ownerId: string): Run | undefined {
  const run = runs.get(id);
  return run?.ownerId === ownerId ? run : undefined;
}

export async function createRun(
  plan: ExecutionPlan,
  ownerId: string,
  recordContext?: GenerationRecordContext,
): Promise<Run> {
  if (!ownerId.trim()) throw new Error("run ownerId is required");
  if (recordContext && recordContext.userId !== ownerId) {
    throw new Error("run ownerId must match recordContext.userId");
  }
  pruneRuns();
  const run: Run = {
    id: nanoid(10),
    ownerId,
    plan,
    emitter: new EventEmitter(),
    events: [],
    finished: false,
    createdAt: Date.now(),
    recordContext,
  };
  run.emitter.setMaxListeners(50);
  runs.set(run.id, run);
  if (recordContext) await createGenerationRecord(run.id, recordContext, run.createdAt);
  // 异步启动，调用方先拿到 runId 再订阅事件
  setImmediate(() => {
    executeRun(run).catch(async (err) => {
      const message = err instanceof ProviderError ? publicProviderErrorMessage(err) : err instanceof Error ? err.message : String(err);
      if (run.recordContext) await failGenerationRecord(run.id, message, Date.now());
      emit(run, { type: "run-error", error: message });
    });
  });
  return run;
}

function emit(run: Run, event: RunEvent): void {
  const sequenced = { ...event, seq: run.events.length + 1 };
  run.events.push(sequenced);
  run.emitter.emit("event", sequenced);
  if (sequenced.type === "done" || sequenced.type === "run-error") {
    run.finished = true;
    run.emitter.emit("finish");
  }
}

async function executeRun(run: Run): Promise<void> {
  /** 每个节点的产出图片（统一为 /api/files/:id 引用），供下游节点使用 */
  const outputs = new Map<string, string[]>();
  let providerRequests = 0;
  let model: string | undefined;
  let recordResult: Pick<StepResult, "images" | "prompts" | "providerOutputSizes" | "failures"> | undefined;

  if (run.recordContext) await markGenerationRunning(run.id, Date.now());

  const failRun = async (message: string, nodeId?: string, startedAt?: number): Promise<void> => {
    const finishedAt = Date.now();
    if (run.recordContext) await failGenerationRecord(run.id, message, finishedAt);
    if (nodeId) {
      emit(run, {
        type: "node-status",
        nodeId,
        status: "error",
        error: message,
        ...(startedAt !== undefined ? { startedAt } : {}),
        finishedAt,
      });
    }
    emit(run, { type: "run-error", ...(nodeId ? { nodeId } : {}), error: message, finishedAt });
  };

  for (const step of run.plan.steps) {
    // 运行时解析真实输入：优先本次 Run 上游产出，范围外上游回退到计划期快照
    const resolvedUpstreams = (step.upstream ?? []).map((upstream) => ({
      upstream,
      images: outputs.get(upstream.nodeId) ?? upstream.images,
    }));
    const inputImages = resolvedUpstreams.flatMap(({ images }) => images);
    const referenceRoles = resolvedUpstreams.flatMap(({ upstream, images }) =>
      images.map(() => upstream.targetHandle ?? ""),
    );

    const runtimeInputLimit = step.kind === "mask-redraw"
      ? MAX_MASK_USER_REFERENCE_IMAGES
      : step.kind === "virtual-try-on"
        ? MAX_VIRTUAL_TRY_ON_REFERENCE_IMAGES
        : MAX_REFERENCE_IMAGES;
    if (NODE_SPECS[step.kind].providerId && inputImages.length > runtimeInputLimit) {
      const message = `Node ${step.nodeId} accepts at most ${runtimeInputLimit}${step.kind === "mask-redraw" ? " user" : ""} reference images`;
      await failRun(message, step.nodeId);
      return;
    }

    // 运行时最终门禁：即使静态计划中的上游节点实际未产图，也绝不退化成无参考图付费生成。
    if (NODE_SPECS[step.kind].providerId && step.kind !== "sketch-to-render" && inputImages.length === 0) {
      const message = `Node ${step.nodeId} requires an upstream image`;
      await failRun(message, step.nodeId);
      return;
    }
    if (step.kind === "virtual-try-on" && inputImages.length < 2) {
      await failRun("虚拟模特换装需要图 1 模特基准图和至少一张服装参考图", step.nodeId);
      return;
    }
    const stagedError = stagedVirtualTryOnRuntimeError(step, inputImages, referenceRoles);
    if (stagedError) {
      await failRun(stagedError, step.nodeId);
      return;
    }

    const startedAt = Date.now();
    emit(run, { type: "node-status", nodeId: step.nodeId, status: "running", startedAt });
    try {
      const result = await executeStep(step, inputImages, getProvider, {
        runId: run.id,
        referenceRoles,
      });
      // 产出统一落盘为 /api/files/:id，避免 base64 大图驻留事件与内存
      const persisted = await persistOutputImages(result.images);
      if (run.recordContext) {
        await registerGeneratedFiles(run.recordContext, run.id, step.nodeId, persisted, Date.now());
      }
      outputs.set(step.nodeId, persisted);
      const finishedAt = Date.now();
      providerRequests += result.providerRequests;
      if (result.model) model = result.model;
      if (run.recordContext?.nodeId === step.nodeId) {
        recordResult = {
          images: persisted,
          prompts: result.prompts,
          providerOutputSizes: result.providerOutputSizes,
          failures: result.failures,
        };
      }
      const partialWarning = result.failures?.length
        ? `${result.failures.length} 个生成任务失败`
        : undefined;
      emit(run, {
        type: "node-status",
        nodeId: step.nodeId,
        status: "success",
        images: persisted,
        error: partialWarning,
        model: result.model,
        prompts: result.prompts,
        providerOutputSizes: result.providerOutputSizes,
        failures: result.failures,
        startedAt,
        finishedAt,
      });
    } catch (err) {
      const message = err instanceof ProviderError
        ? publicProviderErrorMessage(err)
        : err instanceof Error ? err.message : String(err);
      await failRun(message, step.nodeId, startedAt);
      return; // P0：单步失败即终止整个 run
    }
  }
  if (run.recordContext) {
    const finishedAt = Date.now();
    await completeGenerationRecord({
      runId: run.id,
      images: recordResult?.images ?? [],
      prompts: recordResult?.prompts,
      providerOutputSizes: recordResult?.providerOutputSizes,
      failures: recordResult?.failures,
      model,
      providerRequests,
      startedAt: run.createdAt,
      finishedAt,
    });
  }
  emit(run, { type: "done" });
}

/** 产出图片归一化：dataURL / 远程 URL → 落盘为 /api/files/:id；已是本地引用的原样保留 */
async function persistOutputImages(images: string[]): Promise<string[]> {
  return Promise.all(images.map((img) => persistImageRef(img)));
}

/** Apply business-side output guarantees only to nodes that expose size controls to users. */
export async function postProcessGeneratedOutputImages(
  kind: NodeExecution["kind"],
  params: Record<string, unknown>,
  images: string[],
): Promise<string[]> {
  if (kind !== "sketch-to-render" && kind !== "ai-modify" && kind !== "upscale") return images;
  const aspectRatio = normalizeExactAspectRatio(params.aspectRatio);
  const imageSize = normalizeUpscaleSize(params.imageSize);
  const processed: string[] = [];
  for (const image of images) {
    processed.push(
      kind === "upscale"
        ? await upscaleImageToLongEdge(image, imageSize)
        : await fitGeneratedImageToAspect(image, aspectRatio),
    );
  }
  return processed;
}

export type ProviderResolver = (id: string) => AIProvider;

export interface ExecuteStepOptions {
  runId?: string;
  beforeProviderCall?: (providerRequest: number) => void | Promise<void>;
  referenceRoles?: string[];
  sceneAnalyzer?: SceneAnalyzer;
}

export async function executeStep(
  step: NodeExecution,
  inputImages: string[],
  resolveProvider: ProviderResolver = getProvider,
  runIdOrOptions?: string | ExecuteStepOptions,
): Promise<StepResult> {
  const options: ExecuteStepOptions = typeof runIdOrOptions === "string"
    ? { runId: runIdOrOptions }
    : runIdOrOptions ?? {};
  switch (step.kind) {
    case "image-input": {
      const imageUrl = step.params.imageUrl as string | undefined;
      return { images: imageUrl ? [imageUrl] : [], providerRequests: 0 };
    }
    case "video-input": {
      const videoUrl = step.params.videoUrl as string | undefined;
      return { images: videoUrl ? [videoUrl] : [], providerRequests: 0 };
    }
    case "text-input":
    case "color-palette":
      return { images: [], providerRequests: 0 };
    case "drawing-board": {
      const previewImageRef = step.params.previewImageRef as string | undefined;
      return { images: previewImageRef ? [previewImageRef] : [], providerRequests: 0 };
    }
    case "stage-approval": {
      const approvedBaselineRef = step.params.approvedBaselineRef as string | undefined;
      return { images: approvedBaselineRef ? [approvedBaselineRef] : [], providerRequests: 0 };
    }
    case "result": {
      // 结果节点：汇总上游本次运行的真实产出
      return { images: inputImages, providerRequests: 0 };
    }
    case "video-generate": {
      const result = await generateApiYiVideo({
        mode: step.params.mode as never,
        prompt: String(step.params.prompt ?? ""),
        quality: step.params.quality === "standard" ? "standard" : "fast",
        aspectRatio: step.params.aspectRatio === "9:16" ? "9:16" : "16:9",
        resolution: step.params.resolution === "1080p" || step.params.resolution === "4k" ? step.params.resolution : "720p",
        seconds: step.params.seconds === 4 || step.params.seconds === 6 ? step.params.seconds : 8,
        references: inputImages,
        beforeProviderCall: options.beforeProviderCall,
      });
      return { images: [result.video], model: result.model, providerRequests: result.providerRequests, prompts: [String(step.params.prompt ?? "")] };
    }
    case "sketch-to-render":
    case "ai-modify":
    case "fabric-recolor":
    case "upscale":
    case "print-extract":
    case "print-mutate":
    case "virtual-try-on":
    case "mask-redraw": {
      const modelId = isImageModelId(step.params.modelId)
        ? step.params.modelId
        : step.kind === "mask-redraw" || step.kind === "virtual-try-on"
          ? MASK_REDRAW_MODEL_ID
          : DEFAULT_GENERATION_MODEL_ID;
      if (!isModelAllowedForNode(modelId, step.kind)) {
        throw new Error(`Model ${modelId} is not allowed for node ${step.nodeId}`);
      }
      const provider = resolveProvider(modelId);
      const modelOptions = step.params.modelOptions as ImageModelOptions | undefined;
      if (
        step.kind === "mask-redraw" &&
        (typeof step.params.maskSourceRef !== "string" || step.params.maskSourceRef !== inputImages[0])
      ) {
        throw new Error("蒙版对应的原图已变化，请重新绘制蒙版");
      }
      let referenceImages = await resolveImageRefs(inputImages);
      let referenceRoles = options.referenceRoles ?? [];
      let sceneDescription: string | undefined;
      let virtualTryOnAspectReference = referenceImages[0];
      let preliminaryProviderRequests = 0;

      const stagedError = stagedVirtualTryOnRuntimeError(step, inputImages, referenceRoles);
      if (stagedError) throw new Error(stagedError);

      // fabric-recolor 的面料参考图（可能不是边连入，而是节点参数）
      const fabricImageUrl = step.params.fabricImageUrl as string | undefined;
      if (step.kind === "fabric-recolor" && fabricImageUrl) {
        referenceImages.push(...(await resolveImageRefs([fabricImageUrl])));
      }
      const maxReferences = Math.min(
        step.kind === "virtual-try-on" ? MAX_VIRTUAL_TRY_ON_REFERENCE_IMAGES : MAX_REFERENCE_IMAGES,
        modelMaxReferenceImages(modelId),
      );
      const maxUserReferences = step.kind === "mask-redraw"
        ? Math.min(MAX_MASK_USER_REFERENCE_IMAGES, Math.max(0, maxReferences - 1))
        : maxReferences;
      if (referenceImages.length > maxUserReferences) {
        throw new Error(`Node ${step.nodeId} accepts at most ${maxUserReferences} user reference images for ${modelId}`);
      }

      if (step.kind === "virtual-try-on" && step.params.workflowStage === "scene-stabilize") {
        const prepared = await prepareSceneStabilizeReferences(
          referenceImages,
          referenceRoles,
          options.sceneAnalyzer ?? analyzeSceneReference,
          options.beforeProviderCall,
        );
        referenceImages = prepared.referenceImages;
        referenceRoles = prepared.referenceRoles;
        sceneDescription = prepared.sceneDescription;
        virtualTryOnAspectReference = prepared.aspectReference;
        preliminaryProviderRequests = prepared.providerRequests;
      }

      const extra = ((step.params.prompt as string) ?? "").trim();

      // 配色替换：每个颜色独立调用，保证一色一图；部分失败也保留成功结果。
      if (step.kind === "fabric-recolor") {
        const operationMode = step.params.operationMode === "fabric" || step.params.operationMode === "color"
          ? step.params.operationMode
          : "combined";
        const colors = Array.isArray(step.params.colors)
          ? step.params.colors.filter((value): value is string => typeof value === "string")
          : [];
        if (operationMode !== "fabric" && colors.length === 0) {
          throw new Error("配色替换必须选择颜色或连接色板");
        }
        if (operationMode !== "fabric" && colors.length > 0) {
          const images: string[] = [];
          const prompts: string[] = [];
          const providerOutputSizes: Array<string | null> = [];
          const failures: RunFailure[] = [];
          let model: string | undefined;
          let providerRequests = 0;
          let firstError: unknown;
          for (const color of colors) {
            const prompt = fabricRecolorPrompt(operationMode, color, extra);
            try {
              const result = await generateExactImages(
                provider,
                { prompt, referenceImages, modelOptions },
                1,
                { ...options, nodeId: step.nodeId },
              );
              providerRequests += result.providerRequests;
              model = result.model;
              for (const [index, image] of result.images.entries()) {
                images.push(image);
                prompts.push(prompt);
                providerOutputSizes.push(result.providerOutputSizes?.[index] ?? null);
              }
            } catch (err) {
              firstError ??= err;
              if (err instanceof ProviderError && err.category === "outcome_unknown") throw err;
              failures.push({
                prompt,
                error: err instanceof ProviderError
                  ? publicProviderErrorMessage(err)
                  : err instanceof Error ? err.message : String(err),
              });
              if (images.length > 0) break;
              if (err instanceof ProviderError && (
                err.status === 429 || err.status === 503 ||
                ["gateway_authentication", "invalid_request", "model_unavailable"].includes(err.category)
              )) throw err;
            }
          }
          if (images.length === 0) {
            throw firstError instanceof Error ? firstError : new Error(failures[0]?.error ?? "全部配色生成失败");
          }
          return {
            images,
            prompts,
            model,
            providerRequests,
            providerOutputSizes: providerOutputSizes.some((size) => size !== null)
              ? providerOutputSizes
              : undefined,
            failures: failures.length ? failures : undefined,
          };
        }
      }

      // 印花裂变：分批出图（单次最多 4 张）
      if (step.kind === "print-mutate") {
        const count = Math.max(1, Math.min(8, Number(step.params.count) || 4));
        const prompt =
          "基于这张印花图案生成风格一致的新变体：保持原有配色体系、艺术风格与笔触质感，重新编排元素的构图与组合方式，纯白背景，适合作为印花素材复用" +
          (extra ? `。补充要求：${extra}` : "");
        const result = await generateExactImages(
          provider,
          { prompt, referenceImages, modelOptions },
          count,
          { ...options, nodeId: step.nodeId },
        );
        const failures = result.failures.map((error) => ({ prompt, error }));
        return {
          images: result.images,
          prompts: result.images.map(() => prompt),
          model: result.model,
          providerRequests: result.providerRequests,
          providerOutputSizes: result.providerOutputSizes,
          failures: failures.length ? failures : undefined,
        };
      }

      const maskReferenceRoles = step.kind === "mask-redraw"
        ? maskReferenceRolePrompt(referenceImages.length)
        : undefined;
      const prompt =
        step.kind === "upscale"
          ? "将这张服装效果图放大为超高清版本，增强面料纹理、走线与边缘细节，保持原有构图、色彩和光影完全不变"
          : step.kind === "fabric-recolor"
            ? fabricRecolorPrompt("fabric", undefined, extra)
          : step.kind === "print-extract"
            ? "提取这件衣服上的印花图案：将印花完整抠出并平铺展开为规整的矩形图案，纯白背景，去除衣身、褶皱、阴影和穿着效果，印花的比例、细节和色彩与原图保持一致，适合作为印花素材复用" +
              (extra ? `。补充要求：${extra}` : "")
            : step.kind === "virtual-try-on"
              ? step.params.workflowStage === "scene-stabilize" || step.params.workflowStage === "garment-refine"
                ? stagedVirtualTryOnPrompt(
                    step.params.workflowStage,
                    referenceRoles,
                    extra,
                    step.params,
                    sceneDescription,
                  )
                : virtualTryOnPrompt(referenceImages.length, extra)
            : step.kind === "mask-redraw"
              ? `目标修改：${extra}。${maskReferenceRoles}，其中红色表示用户涂抹的修改核心，红色已完全遮住旧内容，只用于表达位置；金色表示仅供完整轮廓延展和边缘融合的缓冲区；两者都是修改范围，不是裁切框。请根据用户说明在红色核心内添加、替换、删除或调整内容。凡用户要求替换、删除或改变既有对象时，必须先彻底清除与目标冲突的旧对象、旧包带、旧颜色、旧阴影、旧反光、旧纹理和残留边线，再依据周围连续的面料纹理、颜色、褶皱、缝线和光照完整重建被遮挡的底层服装或背景，然后放入新内容；禁止用模糊、暗斑、色块、漂浮投影或半透明残影遮盖清理区域。只有与新内容真实接触并符合整幅画面光源方向的阴影才可保留。不需要修改的服装结构、面料纹理和光影必须保持。结合整幅画面的构图、服装比例和视觉重量，新内容默认继承目标区域的中心位置与近似占位，除非用户明确要求，不得明显放大、缩小或偏移。只有完整轮廓、褶皱、缝线、阴影、反光和自然遮挡所必需的部分可以进入金色缓冲区，不得沿红色边缘截断，也不得覆盖缓冲区内的文字、独立图案、配饰或其他服装结构。交接处必须匹配原图的面料材质、纹理方向、褶皱、光影、透视、遮挡和清晰度，不得出现重影、透色、硬边或颜色污染。返回与整幅画面同尺寸、同坐标的 PNG 完整最终图片；修改范围以外的画面保持原状。`
              : extra || DEFAULT_PROMPTS[step.kind] || NODE_SPECS[step.kind].description;
      if (step.kind === "mask-redraw" && !extra) {
        throw new Error("局部修改必须填写修改说明");
      }
      const maskReference = step.kind === "mask-redraw" ? step.params.mask : undefined;
      if (step.kind === "mask-redraw" && (typeof maskReference !== "string" || !maskReference)) {
        throw new Error("局部修改必须先保存 PNG 蒙版");
      }
      const mask = typeof maskReference === "string" ? await normalizeImageRef(maskReference) : undefined;
      const preparedMask = step.kind === "mask-redraw"
        ? await prepareMaskForGeneration(referenceImages[0], mask!)
        : undefined;
      const providerMask = preparedMask?.mask ?? mask;
      const providerReferenceImages = preparedMask
        ? [referenceImages[0], ...referenceImages.slice(1), preparedMask.guide]
        : referenceImages;
      const resolvedModelOptions = step.kind === "virtual-try-on"
        ? await virtualTryOnModelOptions(
            modelId as "gpt-image-2" | "gemini-3.1-flash-image-preview",
            step.params.imageSize === "4K" ? "4K" : "2K",
            virtualTryOnAspectReference,
            step.params.workflowStage,
            step.params.aspectRatio,
          )
        : modelOptions;
      const request = {
        prompt,
        referenceImages: providerReferenceImages.length ? providerReferenceImages : undefined,
        aspectRatio: step.kind === "sketch-to-render" || step.kind === "ai-modify"
          ? normalizeExactAspectRatio(step.params.aspectRatio)
          : step.params.aspectRatio as string | undefined,
        batchSize: step.params.batchSize as number | undefined,
        imageSize: step.kind === "upscale" ? normalizeUpscaleSize(step.params.imageSize) : undefined,
        modelOptions: preparedMask ? { ...resolvedModelOptions, size: preparedMask.size } : resolvedModelOptions,
        mask: providerMask,
      };
      const requestedCount = step.kind === "sketch-to-render" || step.kind === "ai-modify"
        ? Math.max(1, Math.min(8, Number(step.params.batchSize) || 1))
        : 1;
      const result = await generateExactImages(
        provider,
        request,
        requestedCount,
        {
          ...options,
          nodeId: step.nodeId,
          beforeProviderCall: async (providerRequest) => {
            await options.beforeProviderCall?.(preliminaryProviderRequests + providerRequest);
          },
        },
      );
      const providerImages = step.kind === "mask-redraw"
        ? await Promise.all(result.images.map((image) => (
            compositeMaskedEdit(referenceImages[0], mask!, image)
          )))
        : result.images;
      const images = await postProcessGeneratedOutputImages(step.kind, step.params, providerImages);
      const providerOutputSizes = step.kind === "virtual-try-on"
        ? await Promise.all(providerImages.map(outputImageSize))
        : result.providerOutputSizes;
      return {
        images,
        model: result.model,
        prompts: images.map(() => prompt),
        providerRequests: preliminaryProviderRequests + result.providerRequests,
        providerOutputSizes,
        failures: result.failures.length ? result.failures.map((error) => ({ prompt, error })) : undefined,
      };
    }
  }
}

/**
 * 将节点图片引用统一解析为 Provider 输入 dataURL。
 * 已标准化上传与生成结果直接复用；旧素材或缺少元数据的本地文件只标准化请求副本。
 */
export async function resolveImageRefs(refs: string[]): Promise<string[]> {
  const localIds = Array.from(new Set(
    refs.filter(isLocalImageReference).map((ref) => ref.slice("/api/files/".length)),
  ));
  const storedInputs = localIds.length === 0
    ? []
    : await query<{ id: string; source_type: string; normalized: boolean }>(`
        SELECT id, source_type, normalized FROM files WHERE id = ANY($1::text[])
      `, [localIds]);
  const metadataById = new Map(storedInputs.map((row) => [row.id, row]));

  return Promise.all(refs.map(async (ref) => {
    const resolved = await normalizeImageRef(ref);
    if (!isLocalImageReference(ref)) return resolved;

    const id = ref.slice("/api/files/".length);
    const metadata = metadataById.get(id);
    if (metadata?.normalized || metadata?.source_type === "generation") return resolved;

    const normalized = await normalizeUploadImageDataUrl(resolved);
    return toDataUrl(normalized.buffer.toString("base64"), normalized.mimeType);
  }));
}

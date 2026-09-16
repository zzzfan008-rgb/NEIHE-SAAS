import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { config } from "../config";
import { fetchWithRetry, parseDataUrl, ProviderError, toDataUrl } from "../providers/base";

const POSE_ANALYSIS_SCHEMA_VERSION = 1;
const POSE_POINT_NAMES = [
  "head", "gazeTarget", "neck", "leftShoulder", "rightShoulder",
  "leftElbow", "rightElbow", "leftWrist", "rightWrist", "pelvis",
  "leftHip", "rightHip", "leftKnee", "rightKnee", "leftAnkle", "rightAnkle",
] as const;

type PosePointName = (typeof POSE_POINT_NAMES)[number];

interface PosePoint {
  x: number;
  y: number;
}

export interface PoseAnalysis {
  points: Record<PosePointName, PosePoint>;
  bodyPose: string;
  handPose: string;
  headPose: string;
  gazeDirection: string;
}

export interface PoseAnalysisResult {
  guideImage: string;
  prompt: string;
  providerRequests: number;
  model: string;
  cacheHit: boolean;
}

export interface PoseAnalysisOptions {
  beforeProviderCall?: (providerRequest: number) => void | Promise<void>;
}

export type PoseAnalyzer = (
  imageDataUrl: string,
  options?: PoseAnalysisOptions,
) => Promise<PoseAnalysisResult>;

interface PoseAnalysisCacheEntry {
  schemaVersion: number;
  model: string;
  analysis: PoseAnalysis;
}

const inFlight = new Map<string, Promise<PoseAnalysisResult>>();
const FORBIDDEN_POSE_CONTENT = /人物身份|五官外观|肤色|发型|体型|服装|衣服|上衣|衬衫|毛衣|外套|夹克|西装|裤|裙|鞋|靴|包袋|手提包|背包|帽|戒指|耳环|耳坠|手镯|手链|项链|腰带|眼镜|首饰|配饰|品牌|文字|背景|场景|建筑|家具|道具|\b(?:identity|facial features|skin tone|hairstyle|body type|clothing|garment|shirt|jacket|suit|pants|trousers|skirt|shoes?|boots?|handbag|backpack|hat|ring|earrings?|bracelet|necklace|belt|glasses|jewelry|accessor(?:y|ies)|brand|text|background|scene|building|furniture|prop)\b/iu;

const ANALYSIS_INSTRUCTION = `你是人体姿势几何解析器。定位画面中的主要人物，只返回 JSON 对象：
{"points":{"head":{"x":0,"y":0},"gazeTarget":{"x":0,"y":0},"neck":{"x":0,"y":0},"leftShoulder":{"x":0,"y":0},"rightShoulder":{"x":0,"y":0},"leftElbow":{"x":0,"y":0},"rightElbow":{"x":0,"y":0},"leftWrist":{"x":0,"y":0},"rightWrist":{"x":0,"y":0},"pelvis":{"x":0,"y":0},"leftHip":{"x":0,"y":0},"rightHip":{"x":0,"y":0},"leftKnee":{"x":0,"y":0},"rightKnee":{"x":0,"y":0},"leftAnkle":{"x":0,"y":0},"rightAnkle":{"x":0,"y":0}},"bodyPose":"","handPose":"","headPose":"","gazeDirection":""}。
所有坐标相对整张图片归一化到 0-1，左右方向均按画面左侧和右侧。head 是头部中心；gazeTarget 是从 head 出发约一个头部宽度的视线方向终点；pelvis 是骨盆中心。遮挡关节根据可见肢体方向做保守几何估计，不改变整体动作。
bodyPose 只描述肩线、髋线、躯干倾斜、重心腿、膝踝和脚的几何关系；handPose 只描述肘腕、手部朝向和身体接触关系；headPose 只描述头部俯仰、旋转和侧倾；gazeDirection 只描述视线方向。
严禁描述或推断人物身份、五官外观、肤色、发型、体型、服装、鞋履、包袋、帽子、首饰、品牌、文字、背景、场景、建筑、家具或道具。不得输出数组、Markdown 或 JSON 以外的文字。`;

const SKELETON_EDGES: ReadonlyArray<readonly [PosePointName, PosePointName]> = [
  ["head", "neck"],
  ["neck", "leftShoulder"], ["neck", "rightShoulder"],
  ["leftShoulder", "leftElbow"], ["leftElbow", "leftWrist"],
  ["rightShoulder", "rightElbow"], ["rightElbow", "rightWrist"],
  ["neck", "pelvis"],
  ["pelvis", "leftHip"], ["pelvis", "rightHip"],
  ["leftHip", "leftKnee"], ["leftKnee", "leftAnkle"],
  ["rightHip", "rightKnee"], ["rightKnee", "rightAnkle"],
];

function validateModel(model: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(model)) {
    throw new ProviderError("姿势分析模型配置无效", 400, model, "invalid_request");
  }
  return model;
}

function normalizedPoint(value: unknown, pathName: string): PosePoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError(`姿势分析坐标 ${pathName} 无效`, 502, "pose-analysis", "invalid_response");
  }
  const point = value as Record<string, unknown>;
  if (
    typeof point.x !== "number" || !Number.isFinite(point.x) || point.x < 0 || point.x > 1
    || typeof point.y !== "number" || !Number.isFinite(point.y) || point.y < 0 || point.y > 1
  ) {
    throw new ProviderError(`姿势分析坐标 ${pathName} 越界`, 502, "pose-analysis", "invalid_response");
  }
  return { x: point.x, y: point.y };
}

function parseAnalysis(value: unknown): PoseAnalysis {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError("姿势分析返回格式无效", 502, "pose-analysis", "invalid_response");
  }
  const source = value as Record<string, unknown>;
  if (!source.points || typeof source.points !== "object" || Array.isArray(source.points)) {
    throw new ProviderError("姿势分析缺少关节点", 502, "pose-analysis", "invalid_response");
  }
  const rawPoints = source.points as Record<string, unknown>;
  const points = {} as Record<PosePointName, PosePoint>;
  for (const name of POSE_POINT_NAMES) points[name] = normalizedPoint(rawPoints[name], name);
  const textFields = ["bodyPose", "handPose", "headPose", "gazeDirection"] as const;
  for (const field of textFields) {
    if (typeof source[field] !== "string" || !source[field].trim() || source[field].length > 800) {
      throw new ProviderError(`姿势分析字段 ${field} 无效`, 502, "pose-analysis", "invalid_response");
    }
  }
  const analysis: PoseAnalysis = {
    points,
    bodyPose: String(source.bodyPose).trim(),
    handPose: String(source.handPose).trim(),
    headPose: String(source.headPose).trim(),
    gazeDirection: String(source.gazeDirection).trim(),
  };
  if (FORBIDDEN_POSE_CONTENT.test(textFields.map((field) => analysis[field]).join("；"))) {
    throw new ProviderError("姿势分析包含禁止传入生图模型的人物、服装或场景内容", 502, "pose-analysis", "invalid_response");
  }
  return analysis;
}

function parseResponseText(payload: unknown): PoseAnalysis {
  const candidates = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })?.candidates;
  const text = candidates?.flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text)
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
  if (!text) throw new ProviderError("姿势分析未返回可用文字", 502, "pose-analysis", "empty_response");
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return parseAnalysis(JSON.parse(normalized));
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("姿势分析返回的 JSON 无效", 502, "pose-analysis", "invalid_response");
  }
}

function analysisPrompt(analysis: PoseAnalysis): string {
  return [
    `身体姿势：${analysis.bodyPose}`,
    `手部姿势：${analysis.handPose}`,
    `头部姿势：${analysis.headPose}`,
    `视线方向：${analysis.gazeDirection}`,
  ].join("；");
}

function cacheKey(model: string, mime: string, image: Buffer): string {
  return createHash("sha256")
    .update(`pose-analysis:${POSE_ANALYSIS_SCHEMA_VERSION}:${model}:${mime}:`)
    .update(image)
    .digest("hex");
}

async function readCache(filePath: string, model: string): Promise<PoseAnalysis | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as PoseAnalysisCacheEntry;
    if (parsed.schemaVersion !== POSE_ANALYSIS_SCHEMA_VERSION || parsed.model !== model) return undefined;
    return parseAnalysis(parsed.analysis);
  } catch {
    return undefined;
  }
}

async function writeCache(filePath: string, entry: PoseAnalysisCacheEntry): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${nanoid(8)}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(entry), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

async function renderPoseGuide(imageDataUrl: string, analysis: PoseAnalysis): Promise<string> {
  const normalized = await sharp(parseDataUrl(imageDataUrl).buffer, {
    animated: false,
    failOn: "error",
    limitInputPixels: 40_000_000,
  }).rotate().png().toBuffer({ resolveWithObject: true });
  const sourceWidth = normalized.info.width;
  const sourceHeight = normalized.info.height;
  if (!sourceWidth || !sourceHeight) throw new Error("姿势参考图尺寸无效");
  const scale = Math.min(
    1024 / Math.max(sourceWidth, sourceHeight),
    Math.max(1, 256 / Math.min(sourceWidth, sourceHeight)),
  );
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const point = (name: PosePointName) => ({
    x: Math.round(analysis.points[name].x * width),
    y: Math.round(analysis.points[name].y * height),
  });
  const lineWidth = Math.max(5, Math.round(Math.min(width, height) * 0.012));
  const jointRadius = Math.max(5, Math.round(lineWidth * 0.7));
  const lines = SKELETON_EDGES.map(([from, to]) => {
    const start = point(from);
    const end = point(to);
    return `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}"/>`;
  }).join("");
  const joints = POSE_POINT_NAMES.filter((name) => name !== "gazeTarget").map((name) => {
    const current = point(name);
    return `<circle cx="${current.x}" cy="${current.y}" r="${jointRadius}"/>`;
  }).join("");
  const head = point("head");
  const gaze = point("gazeTarget");
  const headRadius = Math.max(jointRadius * 2, Math.round(Math.min(width, height) * 0.035));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#f7f7f5"/>
    <g fill="none" stroke="#303238" stroke-width="${lineWidth}" stroke-linecap="round" stroke-linejoin="round">${lines}</g>
    <g fill="#303238">${joints}</g>
    <circle cx="${head.x}" cy="${head.y}" r="${headRadius}" fill="#f7f7f5" stroke="#303238" stroke-width="${lineWidth}"/>
    <line x1="${head.x}" y1="${head.y}" x2="${gaze.x}" y2="${gaze.y}" stroke="#b48943" stroke-width="${Math.max(3, Math.round(lineWidth * 0.65))}" stroke-linecap="round"/>
    <circle cx="${gaze.x}" cy="${gaze.y}" r="${Math.max(4, Math.round(jointRadius * 0.65))}" fill="#b48943"/>
  </svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return toDataUrl(buffer.toString("base64"), "image/png");
}

async function analyzeUncached(
  imageDataUrl: string,
  model: string,
  filePath: string,
  options?: PoseAnalysisOptions,
): Promise<PoseAnalysisResult> {
  const cached = await readCache(filePath, model);
  if (cached) {
    return {
      guideImage: await renderPoseGuide(imageDataUrl, cached),
      prompt: analysisPrompt(cached),
      providerRequests: 0,
      model,
      cacheHit: true,
    };
  }
  const { mime, base64 } = parseDataUrl(imageDataUrl);
  await options?.beforeProviderCall?.(1);
  const response = await fetchWithRetry(
    `${config.apiyiBaseUrl()}/v1beta/models/${model}:generateContent`,
    () => ({
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [
          { text: ANALYSIS_INSTRUCTION },
          { inlineData: { mimeType: mime, data: base64 } },
        ] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    }),
    { timeoutMs: config.aiTimeoutMs(120_000), providerId: model },
  );
  const analysis = parseResponseText(await response.json());
  await writeCache(filePath, { schemaVersion: POSE_ANALYSIS_SCHEMA_VERSION, model, analysis });
  return {
    guideImage: await renderPoseGuide(imageDataUrl, analysis),
    prompt: analysisPrompt(analysis),
    providerRequests: 1,
    model,
    cacheHit: false,
  };
}

export const analyzePoseReference: PoseAnalyzer = async (imageDataUrl, options) => {
  const model = validateModel(config.poseAnalysisModel());
  const { mime, buffer } = parseDataUrl(imageDataUrl);
  const key = cacheKey(model, mime, buffer);
  const filePath = path.join(config.dataDir(), "pose-analysis-cache", `${key}.json`);
  const existing = inFlight.get(key);
  if (existing) {
    const shared = await existing;
    return { ...shared, providerRequests: 0, cacheHit: true };
  }
  const task = analyzeUncached(imageDataUrl, model, filePath, options).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
};

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { config } from "../config";
import { fetchWithRetry, parseDataUrl, ProviderError } from "../providers/base";

const SCENE_ANALYSIS_SCHEMA_VERSION = 2;
const SCENE_FIELDS = [
  "environment",
  "background",
  "lighting",
  "camera",
  "framing",
  "composition",
  "bodyPose",
  "handPose",
  "facialExpression",
  "gazeDirection",
  "subjectPosition",
] as const;

export type SceneAnalysis = Record<(typeof SCENE_FIELDS)[number], string>;

export interface SceneAnalysisResult {
  prompt: string;
  providerRequests: number;
  model: string;
  cacheHit: boolean;
}

export interface SceneAnalysisOptions {
  beforeProviderCall?: (providerRequest: number) => void | Promise<void>;
}

export type SceneAnalyzer = (
  imageDataUrl: string,
  options?: SceneAnalysisOptions,
) => Promise<SceneAnalysisResult>;

interface SceneAnalysisCacheEntry {
  schemaVersion: number;
  model: string;
  analysis: SceneAnalysis;
}

const inFlight = new Map<string, Promise<SceneAnalysisResult>>();
const FORBIDDEN_SCENE_CONTENT = /人物身份|五官|脸型|肤色|发型|体型|服装|衣服|上衣|衬衫|毛衣|外套|夹克|西装|裤|裙|鞋|靴|包袋|手提包|背包|帽|戒指|耳环|耳坠|手镯|手链|项链|腰带|眼镜|首饰|配饰|品牌|文字|\b(?:identity|facial features|skin tone|hairstyle|body type|clothing|garment|shirt|jacket|suit|pants|trousers|skirt|shoes?|boots?|handbag|backpack|hat|ring|earrings?|bracelet|necklace|belt|glasses|jewelry|accessor(?:y|ies)|brand|text)\b/iu;

const ANALYSIS_INSTRUCTION = `你是服装电商摄影的场景解析器。只分析图片中的以下维度，并以 JSON 对象返回：
environment, background, lighting, camera, framing, composition, bodyPose, handPose, facialExpression, gazeDirection, subjectPosition。
只描述场景、背景、光线、摄影机、构图、人物在画面中的位置、身体动作、手部动作、神态与视线。
bodyPose 必须分别描述头部俯仰和侧倾方向、肩线与髋线倾斜、躯干倾斜、重心腿、左右膝踝与脚的位置；左右方向使用画面左侧/右侧。handPose 描述两侧肘腕位置、弯曲与接触关系。gazeDirection 必须区分直视镜头、俯视和侧视，无法判断时注明不确定，禁止默认直视。composition 和 subjectPosition 描述人物占画比例、头顶与脚底留白。只记录可见几何，不猜测遮挡部位。
严禁描述、推断或提取人物身份、五官外观、肤色、发型、体型、服装、鞋履、包袋、帽子、首饰、腰带、眼镜、品牌、文字或任何配饰；这些内容即使清晰可见也必须完全忽略。
每个字段必须是简洁、可执行的中文摄影提示词字符串；不得输出数组、嵌套对象、Markdown 或 JSON 以外的文字。`;

function validateModel(model: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(model)) {
    throw new ProviderError("场景分析模型配置无效", 400, model, "invalid_request");
  }
  return model;
}

function parseAnalysis(value: unknown): SceneAnalysis {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError("场景分析返回格式无效", 502, "scene-analysis", "invalid_response");
  }
  const source = value as Record<string, unknown>;
  const analysis = {} as SceneAnalysis;
  for (const field of SCENE_FIELDS) {
    const text = source[field];
    if (typeof text !== "string" || !text.trim() || text.length > 800) {
      throw new ProviderError(`场景分析字段 ${field} 无效`, 502, "scene-analysis", "invalid_response");
    }
    analysis[field] = text.trim();
  }
  if (FORBIDDEN_SCENE_CONTENT.test(SCENE_FIELDS.map((field) => analysis[field]).join("；"))) {
    throw new ProviderError("场景分析包含禁止传入生图模型的身份、服装或配饰内容", 502, "scene-analysis", "invalid_response");
  }
  return analysis;
}

function parseResponseText(payload: unknown): SceneAnalysis {
  const candidates = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })?.candidates;
  const text = candidates?.flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text)
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
  if (!text) {
    throw new ProviderError("场景分析未返回可用文字", 502, "scene-analysis", "empty_response");
  }
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return parseAnalysis(JSON.parse(normalized));
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("场景分析返回的 JSON 无效", 502, "scene-analysis", "invalid_response");
  }
}

function analysisPrompt(analysis: SceneAnalysis): string {
  return [
    `环境：${analysis.environment}`,
    `背景：${analysis.background}`,
    `光线：${analysis.lighting}`,
    `镜头：${analysis.camera}`,
    `取景：${analysis.framing}`,
    `构图：${analysis.composition}`,
    `身体姿态：${analysis.bodyPose}`,
    `手部姿态：${analysis.handPose}`,
    `神态：${analysis.facialExpression}`,
    `视线：${analysis.gazeDirection}`,
    `人物位置：${analysis.subjectPosition}`,
  ].join("；");
}

function cacheKey(model: string, mime: string, image: Buffer): string {
  return createHash("sha256")
    .update(`scene-analysis:${SCENE_ANALYSIS_SCHEMA_VERSION}:${model}:${mime}:`)
    .update(image)
    .digest("hex");
}

async function readCache(filePath: string, model: string): Promise<SceneAnalysis | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as SceneAnalysisCacheEntry;
    if (parsed.schemaVersion !== SCENE_ANALYSIS_SCHEMA_VERSION || parsed.model !== model) return undefined;
    return parseAnalysis(parsed.analysis);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

async function writeCache(filePath: string, entry: SceneAnalysisCacheEntry): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${nanoid(8)}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(entry), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

async function analyzeUncached(
  imageDataUrl: string,
  model: string,
  filePath: string,
  options?: SceneAnalysisOptions,
): Promise<SceneAnalysisResult> {
  const cached = await readCache(filePath, model);
  if (cached) {
    return { prompt: analysisPrompt(cached), providerRequests: 0, model, cacheHit: true };
  }
  const { mime, base64 } = parseDataUrl(imageDataUrl);
  await options?.beforeProviderCall?.(1);
  const response = await fetchWithRetry(
    `${config.apiyiBaseUrl()}/v1beta/models/${model}:generateContent`,
    () => ({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiyiApiKey()}`,
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: ANALYSIS_INSTRUCTION },
            { inlineData: { mimeType: mime, data: base64 } },
          ],
        }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
        },
      }),
    }),
    { timeoutMs: config.aiTimeoutMs(120_000), providerId: model },
  );
  const analysis = parseResponseText(await response.json());
  await writeCache(filePath, { schemaVersion: SCENE_ANALYSIS_SCHEMA_VERSION, model, analysis });
  return { prompt: analysisPrompt(analysis), providerRequests: 1, model, cacheHit: false };
}

export const analyzeSceneReference: SceneAnalyzer = async (imageDataUrl, options) => {
  const model = validateModel(config.sceneAnalysisModel());
  const { mime, buffer } = parseDataUrl(imageDataUrl);
  const key = cacheKey(model, mime, buffer);
  const filePath = path.join(config.dataDir(), "scene-analysis-cache", `${key}.json`);
  const existing = inFlight.get(key);
  if (existing) {
    const shared = await existing;
    return { ...shared, providerRequests: 0, cacheHit: true };
  }
  const task = analyzeUncached(imageDataUrl, model, filePath, options).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
};

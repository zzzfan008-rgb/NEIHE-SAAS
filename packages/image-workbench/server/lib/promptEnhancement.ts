import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { config } from "../config";
import { fetchWithRetry, ProviderError } from "../providers/base";

export const PROMPT_ENHANCER_MODEL = "gpt-5.6-terra";
const CACHE_VERSION = 2;

export const PROMPT_ENHANCER_SYSTEM_PROMPT = [
  "你是服装 SaaS 的视觉生成提示词编辑器。",
  "把用户的口语要求改写为可直接用于图片模型的中文提示词，按以下六项组织：主体与动作、环境、主光方向与光质、镜头与视点、色调与媒介、构图。",
  "服装任务还必须明确版型、层次、颜色、材质、工艺、穿戴关系和需要避免的缺陷。",
  "用户明确指定的所有人物、商品、服装、配饰、场景、文字和限制都必须保留，不得改写其含义。",
  "不得虚构品牌、Logo、文字、水印、图案、人物、配饰、面料参数或用户未提出的商品。",
  "不得使用 4K、8K、超高清、超精细、杰作、完美、最佳质量等空泛画质词；分辨率由 API 参数控制。",
  "用可验证的视觉描述替代空泛审美词：给出单一可识别主光、真实镜头或视点、明确色调和自然的不完美；除非用户要求，不要强制居中或左右对称。",
  "只返回优化后的提示词，不解释、不加标题、不使用 Markdown。",
].join("\n");

export const TRY_ON_PROMPT_ENHANCER_SYSTEM_PROMPT = [
  "你是写实服装换装提示词增强器，只整理用户目标，不改变系统已经定义的参考图角色和优先级。",
  "enhancedPrompt 必须按六项写清：主体与动作、环境、主光方向与光质、镜头与视点、色调与媒介、构图；同时明确服装版型、层次、颜色、材质、工艺和穿戴接触关系。",
  "保留用户明确指定的所有元素和限制，不得虚构品牌、Logo、文字、水印、图案、人物、配饰、面料参数或商品。",
  "不得使用 4K、8K、超高清、超精细、杰作、完美、最佳质量等空泛画质词；分辨率由 API 参数控制。",
  "优先使用单一可识别主光、真实镜头或视点、明确色调和自然的不完美；除非用户要求，不要强制居中或左右对称。",
  "safePrompt 只移除或泛化可能触发审核的品牌、裸露和身份敏感措辞，必须保留服装结构、材质、姿态、构图和光照目标，不得悄悄替换商品。",
  "返回严格 JSON：{\"enhancedPrompt\":\"可直接附加到系统换装提示词的中文要求\",\"safePrompt\":\"审核降级版本\"}，不使用 Markdown。",
].join("\n");

export interface TryOnPromptEnhancement {
  enhancedPrompt: string;
  safePrompt: string;
  model: string;
  providerRequests: number;
  cacheHit: boolean;
}

export interface TryOnPromptEnhancementInput {
  stage: "scene-stabilize" | "garment-refine";
  prompt: string;
  materialSpec?: string;
  constructionSpec?: string;
  stylePrompt?: string;
}

interface PromptEnhancementOptions {
  beforeProviderCall?: (providerRequest: number) => void | Promise<void>;
}

interface CacheEntry {
  version: number;
  model: string;
  enhancedPrompt: string;
  safePrompt: string;
}

const inFlight = new Map<string, Promise<TryOnPromptEnhancement>>();

function responseText(payload: unknown): string {
  const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })
    .choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  }).join("").trim();
}

function boundedPrompt(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 12_000) {
    throw new ProviderError(`提示词增强字段 ${field} 无效`, 502, PROMPT_ENHANCER_MODEL, "invalid_response");
  }
  return value.trim();
}

function parseStructuredEnhancement(payload: unknown): Pick<TryOnPromptEnhancement, "enhancedPrompt" | "safePrompt"> {
  const normalized = responseText(payload).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  if (!normalized) throw new ProviderError("提示词增强模型未返回文本", 502, PROMPT_ENHANCER_MODEL, "empty_response");
  try {
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    return {
      enhancedPrompt: boundedPrompt(parsed.enhancedPrompt, "enhancedPrompt"),
      safePrompt: boundedPrompt(parsed.safePrompt, "safePrompt"),
    };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("提示词增强模型未返回有效 JSON", 502, PROMPT_ENHANCER_MODEL, "invalid_response");
  }
}

async function chat(messages: Array<{ role: "system" | "user"; content: string }>): Promise<unknown> {
  const response = await fetchWithRetry(
    `${config.apiyiBaseUrl()}/v1/chat/completions`,
    () => ({
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
      body: JSON.stringify({ model: PROMPT_ENHANCER_MODEL, temperature: 0.1, messages }),
    }),
    { timeoutMs: config.aiTimeoutMs(120_000), providerId: PROMPT_ENHANCER_MODEL, maxRetries: 0 },
  );
  return response.json();
}

export async function optimizePromptText(text: string): Promise<string> {
  const payload = await chat([
    {
      role: "system",
      content: PROMPT_ENHANCER_SYSTEM_PROMPT,
    },
    { role: "user", content: text },
  ]);
  const result = responseText(payload);
  if (!result) throw new ProviderError("提示词优化模型未返回文本", 502, PROMPT_ENHANCER_MODEL, "empty_response");
  return result;
}

function cacheKey(input: TryOnPromptEnhancementInput): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: CACHE_VERSION, model: PROMPT_ENHANCER_MODEL, ...input }))
    .digest("hex");
}

async function readCache(filePath: string): Promise<CacheEntry | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as CacheEntry;
    if (parsed.version !== CACHE_VERSION || parsed.model !== PROMPT_ENHANCER_MODEL) return undefined;
    return {
      ...parsed,
      enhancedPrompt: boundedPrompt(parsed.enhancedPrompt, "enhancedPrompt"),
      safePrompt: boundedPrompt(parsed.safePrompt, "safePrompt"),
    };
  } catch {
    return undefined;
  }
}

async function writeCache(filePath: string, entry: CacheEntry): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${nanoid(8)}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(entry), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

async function enhanceUncached(
  input: TryOnPromptEnhancementInput,
  filePath: string,
  options: PromptEnhancementOptions,
): Promise<TryOnPromptEnhancement> {
  const cached = await readCache(filePath);
  if (cached) return { ...cached, providerRequests: 0, cacheHit: true };
  await options.beforeProviderCall?.(1);
  const payload = await chat([
    {
      role: "system",
      content: TRY_ON_PROMPT_ENHANCER_SYSTEM_PROMPT,
    },
    { role: "user", content: JSON.stringify(input) },
  ]);
  const parsed = parseStructuredEnhancement(payload);
  const entry = { version: CACHE_VERSION, model: PROMPT_ENHANCER_MODEL, ...parsed };
  await writeCache(filePath, entry);
  return { ...entry, providerRequests: 1, cacheHit: false };
}

export async function enhanceTryOnPrompt(
  input: TryOnPromptEnhancementInput,
  options: PromptEnhancementOptions = {},
): Promise<TryOnPromptEnhancement> {
  const key = cacheKey(input);
  const filePath = path.join(config.dataDir(), "prompt-enhancement-cache", `${key}.json`);
  const existing = inFlight.get(key);
  if (existing) {
    const shared = await existing;
    return { ...shared, providerRequests: 0, cacheHit: true };
  }
  const task = enhanceUncached(input, filePath, options).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

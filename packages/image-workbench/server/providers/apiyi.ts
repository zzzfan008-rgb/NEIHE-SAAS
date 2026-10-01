import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { requestGptImage25 } from "./gptImage25";
import {
  type AIProvider,
  type ImageGenRequest,
  type ImageGenResult,
} from "../../src/types/workflow";
import {
  defaultImageModelOptions,
  getImageModelContract,
  imageModelOptionsError,
  modelMaximumImagesPerRequest,
  normalizeImageModelOptions,
  modelMaxReferenceImages,
  type ImageModelId,
  type ImageModelOptions,
} from "../../src/types/imageModels";
import { config } from "../config";
import { validateMaskForSource } from "../lib/maskProcessing";
import { detectImageMime, validateImageDataUrl } from "../lib/imageValidation";
import { withImageProcessingSlot } from "../lib/imageProcessingLimit";
import { normalizeProviderReferenceImages } from "../lib/uploadImageNormalization";
import {
  fetchWithRetry,
  parseDataUrl,
  ProviderError,
  providerErrorFromMessage,
  type ProviderErrorCategory,
  toDataUrl,
} from "./base";

const PROVIDER_RESPONSE_PIXEL_LIMIT = 40_000_000;
const REFERENCE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const FLUX_MAX_INPUT_PIXELS = 20_000_000;
const FLUX_MAX_INPUT_BYTES = 20 * 1024 * 1024;
const GEMINI_COMPRESSION_THRESHOLD = 1.5 * 1024 * 1024;
const GEMINI_TOTAL_REFERENCE_BYTES = 6 * 1024 * 1024;
const GEMINI_MAX_REFERENCE_BYTES = 7 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requestOptions(modelId: ImageModelId, req: ImageGenRequest): ImageModelOptions {
  const options = req.modelOptions ?? defaultImageModelOptions(modelId, req.aspectRatio);
  const error = imageModelOptionsError(modelId, options);
  if (error) throw new ProviderError(`模型参数无效：${error}`, 400, modelId, "invalid_request");
  return modelId.startsWith("gpt-image-2.5-") ? normalizeImageModelOptions(modelId, options, req.aspectRatio) : options;
}

function referenceData(req: ImageGenRequest, modelId: ImageModelId): string[] {
  const refs = req.referenceImages ?? [];
  const max = modelMaxReferenceImages(modelId);
  if (refs.length > max) {
    throw new ProviderError(`${modelId} 最多支持 ${max} 张参考图`, 400, modelId, "invalid_request");
  }
  return refs;
}

function parsedReference(dataUrl: string, modelId: ImageModelId): ReturnType<typeof parseDataUrl> {
  try {
    const validated = validateImageDataUrl(dataUrl);
    if (!REFERENCE_MIMES.has(validated.mime)) {
      throw new ProviderError(`${modelId} 仅支持 PNG、JPEG 或 WebP 参考图`, 400, modelId, "invalid_request");
    }
    return {
      mime: validated.mime,
      base64: validated.buffer.toString("base64"),
      buffer: validated.buffer,
    };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      `${modelId} 参考图数据无效`,
      400,
      modelId,
      "invalid_request",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function fluxTargetDimensions(width: number, height: number): { width: number; height: number } {
  const contract = getImageModelContract("flux-2-pro").dimensions!;
  const scale = Math.min(1, Math.sqrt(contract.maxPixels / (width * height)));
  let targetWidth = Math.max(contract.minSide, Math.round((width * scale) / contract.multipleOf) * contract.multipleOf);
  let targetHeight = Math.max(contract.minSide, Math.round((height * scale) / contract.multipleOf) * contract.multipleOf);
  while (targetWidth * targetHeight > contract.maxPixels) {
    const widthScale = targetWidth / width;
    const heightScale = targetHeight / height;
    if (widthScale >= heightScale && targetWidth > contract.minSide) targetWidth -= contract.multipleOf;
    else if (targetHeight > contract.minSide) targetHeight -= contract.multipleOf;
    else break;
  }
  return { width: targetWidth, height: targetHeight };
}

/** FLUX 要求输入至少 64px、宽高为 16 的倍数且不超过 4MP。 */
export async function adaptFluxReference(dataUrl: string): Promise<string> {
  const modelId: ImageModelId = "flux-2-pro";
  const parsed = parsedReference(dataUrl, modelId);
  try {
    return await withImageProcessingSlot(async () => {
      const input = sharp(parsed.buffer, {
        animated: false, failOn: "error", limitInputPixels: FLUX_MAX_INPUT_PIXELS,
      });
      const metadata = await input.metadata();
      if (!metadata.width || !metadata.height) {
        throw new ProviderError("FLUX 参考图尺寸无效", 400, modelId, "invalid_request");
      }
      const swapsAxes = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
      const width = swapsAxes ? metadata.height : metadata.width;
      const height = swapsAxes ? metadata.width : metadata.height;
      const target = fluxTargetDimensions(width, height);
      const alpha = metadata.hasAlpha
        ? await input.clone().rotate().ensureAlpha().extractChannel("alpha").raw().toBuffer()
        : undefined;
      const transparent = alpha?.some((value) => value < 255) ?? false;
      const transformed = sharp(parsed.buffer, {
        animated: false, failOn: "error", limitInputPixels: FLUX_MAX_INPUT_PIXELS,
      })
        .rotate()
        .resize({ width: target.width, height: target.height, fit: "fill" })
        .toColourspace("srgb");
      const output = transparent
        ? await transformed.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
        : await transformed.flatten({ background: "#ffffff" })
          .jpeg({ quality: 92, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer();
      if (output.byteLength > FLUX_MAX_INPUT_BYTES) {
        throw new ProviderError("FLUX 参考图处理后仍超过 20MB，请先裁剪图片", 400, modelId, "invalid_request");
      }
      return toDataUrl(output.toString("base64"), transparent ? "image/png" : "image/jpeg");
    });
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      "FLUX 参考图无法适配，请使用标准 PNG、JPEG 或 WebP 图片",
      400, modelId, "invalid_request",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function appendImages(form: FormData, refs: string[], modelId: ImageModelId): void {
  const editContract = getImageModelContract(modelId).edit;
  const field = refs.length === 1
    ? editContract.singleImageField
    : editContract.multipleImageField;
  if (!field) {
    throw new ProviderError(`${modelId} 缺少 multipart 图片字段契约`, 500, modelId, "invalid_request");
  }
  refs.forEach((ref, index) => {
    const parsed = parsedReference(ref, modelId);
    const extension = parsed.mime === "image/jpeg" ? "jpg" : parsed.mime.split("/")[1];
    form.append(
      field,
      new Blob([new Uint8Array(parsed.buffer)], { type: parsed.mime }),
      `image-${index + 1}.${extension}`,
    );
  });
}

function upstreamModelId(modelId: ImageModelId): string {
  return getImageModelContract(modelId).upstreamModelId;
}

function resolveContractPath(path: string, modelId: ImageModelId): string {
  return path.replace("{model}", encodeURIComponent(upstreamModelId(modelId)));
}

async function fetchApiyi(
  modelId: ImageModelId,
  path: string,
  initFactory: () => RequestInit,
): Promise<Response> {
  const timeout = getImageModelContract(modelId).timeoutMs;
  const configuredTimeout = config.aiTimeoutMs(timeout);
  const minimumResponseTimeoutMs = modelId === "gemini-3.1-flash-image" ? 360_000 : undefined;
  return fetchWithRetry(`${config.apiyiBaseUrl()}${resolveContractPath(path, modelId)}`, initFactory, {
    providerId: modelId,
    timeoutMs: Math.max(minimumResponseTimeoutMs ?? 0,
      Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : timeout),
    minimumResponseTimeoutMs,
    maxRetries: 0,
  });
}

const IMAGE_RESPONSE_MAX_BYTES = 80 * 1024 * 1024;
const IMAGE_TAIL_MIN_BYTES = 1_024;

function imageTailGraceMs(): number {
  const parsed = Number(process.env.AI_IMAGE_TAIL_GRACE_MS ?? 5_000);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 30_000) : 5_000;
}

function parseCompleteJson(
  chunks: Uint8Array[],
  total: number,
  minimumBytes = IMAGE_TAIL_MIN_BYTES,
): unknown | undefined {
  if (total < minimumBytes) return undefined;
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8").trimEnd();
  if (!text.endsWith("}")) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function logProviderResponseShape(
  response: Response,
  payload: unknown,
  modelId: ImageModelId,
  byteCount: number | null,
  tailRecovered: boolean,
): void {
  const body = record(payload);
  const usage = record(body?.usageMetadata);
  const candidates = Array.isArray(body?.candidates) ? body.candidates : [];
  const finishReasons: string[] = [];
  const partKinds: string[] = [];
  for (const candidateValue of candidates.slice(0, 4)) {
    const candidate = record(candidateValue);
    if (typeof candidate?.finishReason === "string") finishReasons.push(candidate.finishReason);
    const content = record(candidate?.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    for (const partValue of parts.slice(0, 12)) {
      const part = record(partValue);
      if ((record(part?.inlineData) ?? record(part?.inline_data))?.data !== undefined) partKinds.push("inlineData");
      else if (typeof part?.text === "string") partKinds.push("text");
      else if (part?.thoughtSignature !== undefined) partKinds.push("thoughtSignature");
      else partKinds.push("other");
    }
  }
  console.info("[ai-provider-response]", JSON.stringify({
    providerId: modelId,
    requestId: response.headers.get("x-request-id"),
    contentType: response.headers.get("content-type"),
    contentLength: response.headers.get("content-length"),
    transferEncoding: response.headers.get("transfer-encoding"),
    byteCount,
    tailRecovered,
    topLevelKeys: body ? Object.keys(body).sort() : [],
    candidateCount: candidates.length,
    candidatesTokenCount: typeof usage?.candidatesTokenCount === "number"
      ? usage.candidatesTokenCount
      : null,
    finishReasons,
    partKinds,
  }));
}

async function readJson(response: Response, modelId: ImageModelId): Promise<unknown> {
  try {
    const contentLength = response.headers.get("content-length");
    if (contentLength || !response.body || process.env.AI_IMAGE_TAIL_RECOVERY === "false") {
      const payload = await response.json();
      logProviderResponseShape(
        response,
        payload,
        modelId,
        contentLength && /^\d+$/.test(contentLength) ? Number(contentLength) : null,
        false,
      );
      return payload;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let pendingRead = reader.read();
    while (true) {
      const winner = await Promise.race([
        pendingRead.then((result) => ({ kind: "read" as const, result })),
        new Promise<{ kind: "grace" }>((resolve) => {
          setTimeout(() => resolve({ kind: "grace" }), imageTailGraceMs());
        }),
      ]);
      if (winner.kind === "grace") {
        const recovered = parseCompleteJson(chunks, total);
        if (recovered !== undefined) {
          void reader.cancel().catch(() => undefined);
          logProviderResponseShape(response, recovered, modelId, total, true);
          return recovered;
        }
        continue;
      }
      if (winner.result.done) break;
      chunks.push(winner.result.value);
      total += winner.result.value.byteLength;
      if (total > IMAGE_RESPONSE_MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new ProviderError(
          "AI 图片响应体积超过系统安全上限",
          502, modelId, "invalid_response", `responseBytes>${IMAGE_RESPONSE_MAX_BYTES}`,
        );
      }
      pendingRead = reader.read();
    }
    const payload = parseCompleteJson(chunks, total, 0);
    if (payload === undefined) throw new SyntaxError("response JSON is incomplete");
    logProviderResponseShape(response, payload, modelId, total, false);
    return payload;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      "AI 响应中断或不完整，结果可能已经生成；系统将按上限自动重试，可能产生重复扣费",
      502, modelId, "outcome_unknown",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function imageUrl(value: unknown, modelId: ImageModelId, index: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProviderError("AI 服务返回了无效图片地址", 502, modelId, "invalid_response", `data[${index}].url invalid`);
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("protocol");
  } catch {
    throw new ProviderError("AI 服务返回了无效图片地址", 502, modelId, "invalid_response", `data[${index}].url invalid`);
  }
  return value;
}

async function base64Image(
  value: unknown,
  modelId: ImageModelId,
  mimeHint?: string,
): Promise<string> {
  if (typeof value !== "string" || !value) {
    throw new ProviderError("AI 服务返回了无效图片数据", 502, modelId, "invalid_response");
  }
  try {
    let buffer: Buffer;
    let mime: string;
    if (value.startsWith("data:")) {
      const validated = validateImageDataUrl(value);
      buffer = validated.buffer;
      mime = validated.mime;
    } else {
      buffer = Buffer.from(value, "base64");
      if (!buffer.length || buffer.toString("base64") !== value) {
        throw new ProviderError("AI 服务返回了损坏的图片数据", 502, modelId, "invalid_response");
      }
      const detected = detectImageMime(buffer);
      if (!detected) {
        throw new ProviderError("AI 服务返回了未知图片格式", 502, modelId, "invalid_response");
      }
      mime = detected;
    }
    if (!REFERENCE_MIMES.has(mime)) {
      throw new ProviderError("AI 服务返回了不支持的图片格式", 502, modelId, "invalid_response");
    }
    if (mimeHint && mime !== mimeHint) {
      throw new ProviderError("AI 服务返回图片的 MIME 与实际格式不一致", 502, modelId, "invalid_response");
    }
    await withImageProcessingSlot(async () => {
      await sharp(buffer, {
        animated: false, failOn: "warning", limitInputPixels: PROVIDER_RESPONSE_PIXEL_LIMIT,
      }).raw().toBuffer();
    });
    return toDataUrl(buffer.toString("base64"), mime);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      "AI 服务返回了损坏的图片数据",
      502,
      modelId,
      "invalid_response",
      `image payload validation failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
    );
  }
}

function throwEmbeddedError(payload: Record<string, unknown>, modelId: ImageModelId): void {
  if (payload.error === undefined || payload.error === null) return;
  const detail = record(payload.error);
  const message = typeof detail?.message === "string" ? detail.message : "API易图片接口返回错误";
  const rawCode = detail?.code;
  const status = typeof rawCode === "number" ? rawCode : undefined;
  const classifierMessage = typeof rawCode === "string" ? `${rawCode}: ${message}` : message;
  throw providerErrorFromMessage(classifierMessage, modelId, status);
}

interface ParsedOpenAiImages {
  images: string[];
  providerOutputSizes?: Array<string | null>;
}

async function parseOpenAiImageResponse(
  payload: unknown,
  modelId: ImageModelId,
  opts?: { urlOnly?: boolean; maxImages?: number; requireOutputSize?: boolean },
): Promise<ParsedOpenAiImages> {
  const body = record(payload);
  if (!body) throw new ProviderError("AI 服务返回格式无效", 502, modelId, "invalid_response");
  throwEmbeddedError(body, modelId);
  if (!Array.isArray(body.data) || body.data.length === 0) {
    throw new ProviderError("AI 服务未返回图片", 502, modelId, "empty_response");
  }
  if (opts?.maxImages && body.data.length > opts.maxImages) {
    throw new ProviderError("AI 服务返回图片数量超出契约", 502, modelId, "invalid_response");
  }
  const images: string[] = [];
  const providerOutputSizes: Array<string | null> = [];
  for (let index = 0; index < body.data.length; index += 1) {
    const item = record(body.data[index]);
    if (!item) throw new ProviderError("AI 服务返回图片条目无效", 502, modelId, "invalid_response");
    if (!opts?.urlOnly && item.b64_json !== undefined) images.push(await base64Image(item.b64_json, modelId));
    else if (item.url !== undefined) images.push(imageUrl(item.url, modelId, index));
    else throw new ProviderError("AI 服务返回图片字段无效", 502, modelId, "invalid_response");
    if (opts?.requireOutputSize) {
      if (typeof item.size !== "string" || !/^[1-9]\d{1,4}x[1-9]\d{1,4}$/.test(item.size)) {
        throw new ProviderError(
          "AI 服务未返回可记录的实际图片尺寸",
          502, modelId, "invalid_response", `data[${index}].size invalid`,
        );
      }
      providerOutputSizes.push(item.size);
    }
  }
  return { images, providerOutputSizes: opts?.requireOutputSize ? providerOutputSizes : undefined };
}

async function parseOpenAiImages(
  payload: unknown,
  modelId: ImageModelId,
  opts?: { urlOnly?: boolean; maxImages?: number },
): Promise<string[]> {
  return (await parseOpenAiImageResponse(payload, modelId, opts)).images;
}

// Allowlist structured diagnostics only: never retain response text, image data or headers wholesale.
function geminiResponseDiagnostic(payload: unknown) {
  const body = record(payload);
  const token = (value: unknown) => typeof value === "string" && /^[\w.:-]{1,160}$/.test(value)
    && !/sk-/i.test(value) ? value : null;
  const ratings = (value: unknown) => Array.isArray(value) ? value.slice(0, 16).map((item) => {
    const rating = record(item);
    return {
      category: token(rating?.category), probability: token(rating?.probability),
      blocked: typeof rating?.blocked === "boolean" ? rating.blocked : null,
    };
  }) : [];
  const feedback = record(body?.promptFeedback);
  return {
    responseId: token(body?.responseId), modelVersion: token(body?.modelVersion),
    promptFeedback: feedback ? { blockReason: token(feedback.blockReason), safetyRatings: ratings(feedback.safetyRatings) } : null,
    candidateFeedback: Array.isArray(body?.candidates) ? body.candidates.slice(0, 16).map((value) => {
      const candidate = record(value);
      return { finishReason: token(candidate?.finishReason), safetyRatings: ratings(candidate?.safetyRatings) };
    }) : [],
  };
}

type GeminiResponseErrorType =
  | "PROMPT_BLOCKED" | "ZERO_CANDIDATES_TOKEN" | "NO_CANDIDATES" | "FINISH_REASON"
  | "NO_PARTS" | "TEXT_RESPONSE" | "UNKNOWN" | "INVALID_RESPONSE" | "PROVIDER_ERROR";
type GeminiTextType = "SAFETY" | "COPYRIGHT" | "REFUSAL" | "OTHER";

interface GeminiResponseFailure {
  success: false;
  errorType: GeminiResponseErrorType;
  userMessage: string;
  devMessage: string;
  /** Server-only: never serialize this field into logs, run records or HTTP responses. */
  rawResponse: unknown;
  status: number;
  category: ProviderErrorCategory;
  blockReason?: string;
  finishReason?: string;
  detectedType?: GeminiTextType;
  apiText?: string;
}

export type GeminiResponseResult =
  | { success: true; images: string[]; texts: string[] }
  | GeminiResponseFailure;

function detectContentType(text: string): GeminiTextType {
  // A text hint only, not a verdict about the user's content or a retry decision.
  if (/版权|著作权|copyright|recitation/i.test(text)) return "COPYRIGHT";
  if (/安全|审核|政策|违规|safety|policy|moderation|prohibited/i.test(text)) return "SAFETY";
  if (/不能|无法|拒绝|不支持|cannot|can't|unable|refus|not allowed/i.test(text)) return "REFUSAL";
  return "OTHER";
}

/** Parse the APIyi Gemini response without losing refusal text or exposing the raw body. */
export async function processGeminiResponse(
  data: unknown, modelId: ImageModelId = "gemini-3-pro-image-preview",
): Promise<GeminiResponseResult> {
  const failure = (
    errorType: GeminiResponseErrorType, userMessage: string, devMessage: string,
    details: Partial<Pick<GeminiResponseFailure,
      "status" | "category" | "blockReason" | "finishReason" | "detectedType" | "apiText">> = {},
  ): GeminiResponseFailure => ({
    success: false, errorType, userMessage, devMessage, rawResponse: data,
    status: 502, category: "invalid_response", ...details,
  });
  const body = record(data);
  if (!body) return failure("INVALID_RESPONSE", "Gemini 响应格式无效，请稍后重试", "response is not an object");
  try {
    throwEmbeddedError(body, modelId);
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    return failure("PROVIDER_ERROR", error.message, "Gemini returned an error object", {
      status: error.status ?? 502, category: error.category,
    });
  }

  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const texts: string[] = [];
  const inlineImages: Record<string, unknown>[] = [];
  const finishReasons: string[] = [];
  let partCount = 0;
  for (const value of candidates) {
    const candidate = record(value);
    if (typeof candidate?.finishReason === "string" && candidate.finishReason) finishReasons.push(candidate.finishReason);
    const content = record(candidate?.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    partCount += parts.length;
    for (const value of parts) {
      const part = record(value);
      // thoughtSignature can accompany normal text/images; it is not a reason to skip a part.
      const text = typeof part?.text === "string" ? part.text.trim() : "";
      if (text && !text.startsWith("data:image/")) texts.push(text);
      const inline = record(part?.inlineData) ?? record(part?.inline_data);
      if (inline?.data !== undefined) inlineImages.push(inline);
    }
  }
  const apiText = texts.length ? texts.join("\n") : undefined;
  const textDetails = apiText ? { apiText, detectedType: detectContentType(apiText) } : {};
  const promptBlockReason = record(body.promptFeedback)?.blockReason;
  if (typeof promptBlockReason === "string" && promptBlockReason && promptBlockReason !== "BLOCK_REASON_UNSPECIFIED") {
    const messages: Record<string, string> = {
      SAFETY: "本次请求未通过 AI 安全审核（SAFETY），请检查提示词或参考图片",
      BLOCKLIST: "本次请求命中服务方屏蔽词规则（BLOCKLIST），请检查提示词",
      PROHIBITED_CONTENT: "本次请求被服务方禁止内容规则拦截（PROHIBITED_CONTENT），请检查参考内容",
      // Supplier confirmed moderation for this APIyi route; do not invent a specific policy category.
      OTHER: "本次请求未通过 Gemini 内容审核（OTHER），请修改提示词或参考图片后重试",
    };
    const message = Object.hasOwn(messages, promptBlockReason)
      ? messages[promptBlockReason] : "服务方阻止了本次请求，未说明具体原因，请联系管理员核查";
    return failure("PROMPT_BLOCKED", apiText ?? message, `promptFeedback.blockReason: ${promptBlockReason}`, {
      status: 422, category: "content_refused", blockReason: promptBlockReason, ...textDetails,
    });
  }

  const finishReason = finishReasons.find((reason) => reason !== "STOP");
  if (finishReason) {
    const messages: Record<string, string> = {
      PROHIBITED_CONTENT: "内容违反安全策略，已被拒绝处理，请调整提示词或参考图片",
      IMAGE_PROHIBITED_CONTENT: "内容违反安全策略，已被拒绝处理，请调整提示词或参考图片",
      SAFETY: "内容触发了安全过滤器，请调整提示词或参考图片",
      IMAGE_SAFETY: "AI 图片安全审核暂时未通过，系统将按上限自动重试",
      BLOCKLIST: "生成被服务方屏蔽词规则拦截（BLOCKLIST），请检查提示词",
      RECITATION: "生成内容可能涉及版权限制，请调整参考内容后重试",
      IMAGE_RECITATION: "生成内容可能涉及版权限制，请调整参考内容后重试",
      NO_IMAGE: "未能生成图片，请调整提示词后重试",
      IMAGE_OTHER: "未能生成图片，请调整提示词后重试",
      OTHER: "本次请求未通过 Gemini 内容审核（OTHER），请修改提示词或参考图片后重试",
      MAX_TOKENS: "生成内容长度超出模型限制，请简化提示词后重试",
    };
    const refused = ["PROHIBITED_CONTENT", "IMAGE_PROHIBITED_CONTENT", "SAFETY", "BLOCKLIST", "RECITATION", "IMAGE_RECITATION", "OTHER"].includes(finishReason);
    const category: ProviderErrorCategory = finishReason === "IMAGE_SAFETY" ? "image_safety"
      : refused ? "content_refused" : finishReason === "MAX_TOKENS" ? "invalid_request" : "invalid_response";
    const message = Object.hasOwn(messages, finishReason) ? messages[finishReason] : "AI 未能完成图片生成，请调整提示词后重试";
    return failure("FINISH_REASON", apiText ?? message, `finishReason: ${finishReason}`, {
      finishReason, category, status: category === "invalid_request" ? 400 : category === "invalid_response" ? 502 : 422,
      ...textDetails,
    });
  }

  const images: string[] = [];
  for (const inline of inlineImages) {
    const mime = inline.mimeType ?? inline.mime_type;
    if (typeof mime !== "string" || !REFERENCE_MIMES.has(mime)) {
      return failure("INVALID_RESPONSE", "Gemini 返回了不支持的图片格式，请重试", "invalid inline image MIME");
    }
    try {
      images.push(await base64Image(inline.data, modelId, mime));
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      return failure("INVALID_RESPONSE", error.message, "inline image validation failed");
    }
  }
  // Valid output/explicit feedback takes precedence over the supplier's zero-token heuristic.
  if (images.length) return { success: true, images, texts };
  if (apiText) {
    return failure("TEXT_RESPONSE", apiText, "text response without an image", {
      status: 422, category: "content_refused", ...textDetails,
    });
  }
  if (record(body.usageMetadata)?.candidatesTokenCount === 0) {
    return failure(
      "ZERO_CANDIDATES_TOKEN", "您的请求在内容审核阶段被拒绝，请修改提示词或参考图片后重试",
      "candidatesTokenCount: 0 with no output - APIyi moderation heuristic",
      { status: 422, category: "content_refused" },
    );
  }
  if (!candidates.length) return failure("NO_CANDIDATES", "AI 服务响应缺少候选结果，请稍后重试", "candidates is missing or empty");
  if (!partCount) return failure("NO_PARTS", "生成失败，AI 服务未返回内容，请重试", "candidate.content.parts is missing or empty");
  return failure("UNKNOWN", "生成失败，未找到图片或文字说明，请检查提示词后重试", "no image data or text response");
}

async function parseGeminiImages(
  payload: unknown, modelId: ImageModelId, context: Record<string, unknown> = {},
): Promise<string[]> {
  const result = await processGeminiResponse(payload, modelId);
  if (result.success) return [result.images.at(-1)!];
  const body = record(payload);
  const feedback = geminiResponseDiagnostic(payload);
  // Deliberately omit rawResponse, apiText, signatures and devMessage from logging/persistence.
  const diagnostic = JSON.stringify({
    ...feedback,
    errorType: result.errorType,
    topLevelKeys: Object.keys(body ?? {}).sort(),
    candidateCount: Array.isArray(body?.candidates) ? body.candidates.length : 0,
    candidatesTokenCount: typeof record(body?.usageMetadata)?.candidatesTokenCount === "number"
      ? record(body?.usageMetadata)!.candidatesTokenCount : null,
    promptBlockReason: feedback.promptFeedback?.blockReason ?? null,
    finishReasons: feedback.candidateFeedback.map((candidate) => candidate.finishReason).filter(Boolean),
    ...context,
  });
  const error = new ProviderError(result.userMessage, result.status, modelId, result.category, diagnostic);
  error.blockReason = result.blockReason;
  error.finishReason = result.finishReason;
  throw error;
}

async function geminiInlineData(
  dataUrl: string,
  modelId: ImageModelId,
  targetBytes = GEMINI_COMPRESSION_THRESHOLD,
  encode: { quality?: number; longEdge?: number } = {},
): Promise<{ inlineData: { mimeType: string; data: string } }> {
  const parsed = parsedReference(dataUrl, modelId);
  try {
    return await withImageProcessingSlot(async () => {
      const inputOptions = { limitInputPixels: PROVIDER_RESPONSE_PIXEL_LIMIT, failOn: "error" as const };
      const metadata = await sharp(parsed.buffer, inputOptions).metadata();
      const transparent = metadata.hasAlpha && (await sharp(parsed.buffer, inputOptions)
        .extractChannel("alpha").stats()).channels[0].min < 255;
      const mimeType = transparent ? "image/png" : "image/jpeg";
      let longEdge = encode.longEdge ?? 2048;
      let buffer = parsed.buffer;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const pipeline = sharp(parsed.buffer, inputOptions)
          .rotate().resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true })
          .toColourspace("srgb");
        buffer = await (transparent
          ? pipeline.png({ compressionLevel: 9 })
          : pipeline.jpeg({ quality: encode.quality ?? 92, chromaSubsampling: "4:4:4", mozjpeg: true })).toBuffer();
        if (buffer.length <= targetBytes) return { inlineData: { mimeType, data: buffer.toString("base64") } };
        const resized = await sharp(buffer).metadata();
        longEdge = Math.max(1, Math.floor(Math.max(resized.width ?? 1, resized.height ?? 1)
          * Math.min(0.85, Math.sqrt(targetBytes / buffer.length) * 0.95)));
      }
      throw new ProviderError("Gemini 参考图压缩后仍超出体积限制，请缩小原图", 400, modelId, "invalid_request");
    });
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("Gemini 参考图标准化失败，请使用有效的 PNG、JPEG 或 WebP 图片", 400, modelId, "invalid_request");
  }
}

async function geminiReferenceParts(refs: string[], modelId: ImageModelId, encode: { quality?: number; longEdge?: number } = {}) {
  let parts = await Promise.all(refs.map((ref) => geminiInlineData(ref, modelId, GEMINI_COMPRESSION_THRESHOLD, encode)));
  const byteCount = () => parts.reduce((total, part) => total + Buffer.byteLength(part.inlineData.data, "base64"), 0);
  if (byteCount() > GEMINI_TOTAL_REFERENCE_BYTES) {
    const budgetPerImage = Math.floor(GEMINI_TOTAL_REFERENCE_BYTES / refs.length);
    parts = await Promise.all(parts.map((part) => geminiInlineData(
      `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`, modelId, budgetPerImage, encode,
    )));
  }
  if (parts.some((part) => Buffer.byteLength(part.inlineData.data, "base64") >= GEMINI_MAX_REFERENCE_BYTES)
    || byteCount() > GEMINI_TOTAL_REFERENCE_BYTES) {
    throw new ProviderError("Gemini 参考图压缩后仍超出体积限制，请减少图片或缩小原图（合计最多 6MB）",
      400, modelId, "invalid_request");
  }
  return parts;
}

type GeminiInlinePart = { inlineData: { mimeType: string; data: string } };

/** The stable Pro route currently documents protobuf snake_case image fields. */
function geminiGenerateContentBody(
  modelId: ImageModelId,
  prompt: string,
  imageParts: GeminiInlinePart[],
  options: ImageModelOptions,
) {
  const stablePro = modelId === "gemini-3-pro-image-preview";
  const parts = stablePro
    ? [
        { text: prompt },
        ...imageParts.map(({ inlineData }) => ({
          inline_data: { mime_type: inlineData.mimeType, data: inlineData.data },
        })),
      ]
    : [{ text: prompt }, ...imageParts];
  const imageConfig = stablePro
    ? { imageSize: options.imageSize }
    : { aspectRatio: options.aspectRatio, imageSize: options.imageSize };
  return {
    imageConfig,
    body: {
      contents: [{ ...(stablePro ? { role: "user" } : {}), parts }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig },
    },
  };
}

export async function validateApiyiRequest(
  modelId: ImageModelId,
  req: ImageGenRequest,
  mode: "generate" | "edit",
): Promise<void> {
  if (!req.prompt.trim()) throw new ProviderError("提示词不能为空", 400, modelId, "invalid_request");
  requestOptions(modelId, req);
  const refs = referenceData(req, modelId);
  if (mode === "edit" && refs.length === 0) {
    throw new ProviderError("编辑模式至少需要一张参考图", 400, modelId, "invalid_request");
  }
  if (mode === "generate" && refs.length > 0) {
    throw new ProviderError("文生图请求不能包含参考图", 400, modelId, "invalid_request");
  }
  refs.forEach((ref) => parsedReference(ref, modelId));
  if (modelId === "gpt-image-2" || modelId.startsWith("gpt-image-2.5-")) {
    if (modelId === "gpt-image-2" && mode !== "edit") {
      throw new ProviderError("gpt-image-2 不支持文生图，仅用于图片编辑", 400, modelId, "invalid_request");
    }
    if (req.mask) await validateMaskForSource(refs[0], req.mask, modelId);
  } else if (req.mask) {
    throw new ProviderError(`${modelId} 不支持蒙版参数`, 400, modelId, "invalid_request");
  }
}

async function generate(modelId: ImageModelId, req: ImageGenRequest): Promise<ImageGenResult> {
  await validateApiyiRequest(modelId, req, "generate");
  const contract = getImageModelContract(modelId);
  if (!contract.generation) throw new ProviderError(`${modelId} 不支持文生图`, 400, modelId, "invalid_request");
  const options = requestOptions(modelId, req);
  let response: Response;
  switch (modelId) {
    case "gpt-image-2.5-flare":
    case "gpt-image-2.5-sunburst":
      return gptImage25Result(modelId, { ...req, modelOptions: options }, "generate");
    case "gpt-image-2":
      throw new ProviderError("gpt-image-2 只能由图片编辑节点调用", 400, modelId, "invalid_request");
    case "gpt-image-2-vip":
      response = await fetchApiyi(modelId, contract.generation.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({ model: upstreamModelId(modelId), prompt: req.prompt, size: options.size }),
      }));
      return { images: await parseOpenAiImages(await readJson(response, modelId), modelId, { maxImages: 1 }), model: modelId };
    case "gemini-3-pro-image-preview":
    case "gemini-3.1-flash-image": {
      const request = geminiGenerateContentBody(modelId, req.prompt, [], options);
      response = await fetchApiyi(modelId, contract.generation.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify(request.body),
      }));
      return { images: await parseGeminiImages(await readJson(response, modelId), modelId), model: modelId };
    }
    case "flux-2-pro":
      response = await fetchApiyi(modelId, contract.generation.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({
          model: upstreamModelId(modelId), prompt: req.prompt, width: options.width, height: options.height,
          output_format: options.outputFormat,
        }),
      }));
      return { images: await parseOpenAiImages(await readJson(response, modelId), modelId, { urlOnly: true, maxImages: 1 }), model: modelId };
    case "seedream-5-0-260128": {
      response = await fetchApiyi(modelId, contract.generation.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({
          model: upstreamModelId(modelId), prompt: req.prompt, size: options.size, response_format: "b64_json",
          watermark: false, sequential_image_generation: "disabled",
        }),
      }));
      const parsed = await parseOpenAiImageResponse(await readJson(response, modelId), modelId, { requireOutputSize: true });
      return { ...parsed, model: modelId };
    }
    case "grok-imagine-image":
      response = await fetchApiyi(modelId, contract.generation.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({
          model: upstreamModelId(modelId), prompt: req.prompt, aspect_ratio: options.aspectRatio, resolution: options.resolution,
          n: Math.max(1, Math.min(req.batchSize ?? 1, modelMaximumImagesPerRequest(modelId))),
          response_format: "b64_json",
        }),
      }));
      return { images: await parseOpenAiImages(await readJson(response, modelId), modelId, { maxImages: 10 }), model: modelId };
  }
}

async function edit(modelId: ImageModelId, req: ImageGenRequest): Promise<ImageGenResult> {
  await validateApiyiRequest(modelId, req, "edit");
  const contract = getImageModelContract(modelId);
  const options = requestOptions(modelId, req);
  const refs = await normalizeProviderReferenceImages(req.referenceImages!, modelId);
  let response: Response;
  switch (modelId) {
    case "gpt-image-2.5-flare":
    case "gpt-image-2.5-sunburst":
      return gptImage25Result(modelId, { ...req, modelOptions: options, referenceImages: refs }, "edit");
    case "gpt-image-2": {
      response = await fetchApiyi(modelId, contract.edit.path, () => {
        const form = new FormData();
        form.append("model", upstreamModelId(modelId));
        form.append("prompt", req.prompt);
        if (options.size) form.append("size", String(options.size));
        if (options.quality) form.append("quality", options.quality);
        appendImages(form, refs, modelId);
        if (req.mask) {
          const mask = parseDataUrl(req.mask);
          form.append("mask", new Blob([new Uint8Array(mask.buffer)], { type: "image/png" }), "mask.png");
        }
        form.append("background", "opaque");
        form.append("output_format", "png");
        return { method: "POST", headers: { Authorization: `Bearer ${config.apiyiApiKey()}` }, body: form };
      });
      return { images: await parseOpenAiImages(await readJson(response, modelId), modelId, { maxImages: 1 }), model: modelId };
    }
    case "gpt-image-2-vip": {
      response = await fetchApiyi(modelId, contract.edit.path, () => {
        const form = new FormData();
        form.append("model", upstreamModelId(modelId));
        form.append("prompt", req.prompt);
        form.append("size", String(options.size));
        appendImages(form, refs, modelId);
        return { method: "POST", headers: { Authorization: `Bearer ${config.apiyiApiKey()}` }, body: form };
      });
      return { images: await parseOpenAiImages(await readJson(response, modelId), modelId, { maxImages: 1 }), model: modelId };
    }
    case "gemini-3-pro-image-preview":
    case "gemini-3.1-flash-image": {
      const imageParts = await geminiReferenceParts(refs, modelId, req.referenceEncoding);
      const request = geminiGenerateContentBody(modelId, req.prompt, imageParts, options);
      const requestSummary = {
        diagnosticId: randomUUID(), model: upstreamModelId(modelId),
        path: resolveContractPath(contract.edit.path, modelId),
        imageConfig: request.imageConfig,
        responseModalities: ["IMAGE"], textPartCount: 1, imageCount: imageParts.length,
        promptCharacters: req.prompt.length,
        promptSha256: createHash("sha256").update(req.prompt).digest("hex"),
        images: await Promise.all(imageParts.map(async ({ inlineData }, index) => {
          const buffer = Buffer.from(inlineData.data, "base64");
          const metadata = await sharp(buffer).metadata();
          return { index: index + 1, mimeType: inlineData.mimeType, bytes: buffer.length,
            width: metadata.width, height: metadata.height,
            sha256: createHash("sha256").update(buffer).digest("hex") };
        })),
      };
      console.info("[ai-gemini-edit-request]", JSON.stringify(requestSummary));
      response = await fetchApiyi(modelId, contract.edit.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify(request.body),
      }));
      const payload = await readJson(response, modelId);
      const rawRequestId = response.headers.get("x-request-id");
      const context = {
        requestSummary, upstreamHttpStatus: response.status,
        upstreamRequestId: rawRequestId && /^[\w.:-]{1,160}$/.test(rawRequestId) && !/sk-/i.test(rawRequestId) ? rawRequestId : null,
      };
      console.info("[ai-gemini-edit-response]", JSON.stringify({ ...context, ...geminiResponseDiagnostic(payload) }));
      const providerRequestId = context.upstreamRequestId ?? undefined;
      return {
        images: await parseGeminiImages(payload, modelId, context), model: modelId, providerRequestId,
        providerDiagnostic: { requestId: context.upstreamRequestId, images: requestSummary.images },
      };
    }
    case "flux-2-pro": {
      const adaptedRefs = await Promise.all(refs.map(adaptFluxReference));
      const inputImages = Object.fromEntries(adaptedRefs.map((ref, index) => [
        index === 0 ? "input_image" : `input_image_${index + 1}`, ref,
      ]));
      response = await fetchApiyi(modelId, contract.edit.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({
          model: upstreamModelId(modelId), prompt: req.prompt, width: options.width, height: options.height,
          output_format: options.outputFormat, ...inputImages,
        }),
      }));
      return { images: await parseOpenAiImages(await readJson(response, modelId), modelId, { urlOnly: true, maxImages: 1 }), model: modelId };
    }
    case "seedream-5-0-260128": {
      response = await fetchApiyi(modelId, contract.edit.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({
          model: upstreamModelId(modelId), prompt: req.prompt, image: refs, size: options.size, response_format: "b64_json",
          watermark: false, sequential_image_generation: "disabled",
        }),
      }));
      const parsed = await parseOpenAiImageResponse(await readJson(response, modelId), modelId, { requireOutputSize: true });
      return { ...parsed, model: modelId };
    }
    case "grok-imagine-image": {
      response = await fetchApiyi(modelId, contract.edit.path, () => {
        const form = new FormData();
        form.append("model", upstreamModelId(modelId));
        form.append("prompt", req.prompt);
        form.append("response_format", "b64_json");
        appendImages(form, refs, modelId);
        return { method: "POST", headers: { Authorization: `Bearer ${config.apiyiApiKey()}` }, body: form };
      });
      return { images: await parseOpenAiImages(await readJson(response, modelId), modelId, { maxImages: 10 }), model: modelId };
    }
  }
}

async function gptImage25Result(modelId: ImageModelId, req: ImageGenRequest, mode: "generate" | "edit"): Promise<ImageGenResult> {
  const { response, model } = await requestGptImage25(req, mode, req.modelSelection === "explicit" ? upstreamModelId(modelId) : undefined);
  const payload = await readJson(response, modelId);
  const usage = record(record(payload)?.usage);
  const input = record(usage?.input_tokens_details);
  const text = input?.text_tokens;
  const image = input?.image_tokens;
  const output = usage?.output_tokens;
  const providerUsage = [text, image, output].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)
    ? { inputTextTokens: text as number, inputImageTokens: image as number, outputTokens: output as number,
        estimatedUsd: ((text as number) * 5 + (image as number) * 8 + (output as number) * 30) / 1_000_000 }
    : undefined;
  const providerRequestId = response.headers.get("x-request-id") ?? undefined;
  console.info("[gpt-image-2.5] completed", { model, providerRequestId, providerUsage });
  return { images: await parseOpenAiImages(payload, modelId, { maxImages: 1 }), model, providerUsage, providerRequestId };
}

export function createApiyiProvider(modelId: ImageModelId): AIProvider {
  return {
    id: modelId,
    validate: (req, mode) => validateApiyiRequest(modelId, req, mode),
    generate: (req) => generate(modelId, req),
    edit: (req) => edit(modelId, req),
  };
}

export const apiyiProviders = Object.fromEntries(
  ([
    "gpt-image-2.5-flare", "gpt-image-2.5-sunburst",
    "gpt-image-2", "gpt-image-2-vip", "gemini-3-pro-image-preview", "gemini-3.1-flash-image",
    "flux-2-pro", "seedream-5-0-260128", "grok-imagine-image",
  ] as const).map((modelId) => [modelId, createApiyiProvider(modelId)]),
) as Record<ImageModelId, AIProvider>;

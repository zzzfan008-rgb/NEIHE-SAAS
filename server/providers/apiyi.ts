import sharp from "sharp";
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
import {
  fetchWithRetry,
  parseDataUrl,
  ProviderError,
  providerErrorFromMessage,
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
      if (record(part?.inlineData)?.data !== undefined) partKinds.push("inlineData");
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

async function parseGeminiImages(payload: unknown, modelId: ImageModelId): Promise<string[]> {
  const body = record(payload);
  if (!body) throw new ProviderError("Gemini 响应格式无效", 502, modelId, "invalid_response");
  throwEmbeddedError(body, modelId);

  const usage = record(body.usageMetadata);
  const candidatesTokenCount = typeof usage?.candidatesTokenCount === "number"
    ? usage.candidatesTokenCount
    : undefined;
  const promptFeedback = record(body.promptFeedback);
  const promptBlockReason = typeof promptFeedback?.blockReason === "string"
    ? promptFeedback.blockReason
    : undefined;
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const images: string[] = [];
  const texts: string[] = [];
  const finishReasons: string[] = [];

  const diagnostic = () => JSON.stringify({
    topLevelKeys: Object.keys(body).sort(),
    candidateCount: candidates.length,
    candidatesTokenCount: candidatesTokenCount ?? null,
    promptBlockReason: promptBlockReason ?? null,
    finishReasons,
  });

  if (promptBlockReason && promptBlockReason !== "BLOCK_REASON_UNSPECIFIED") {
    // Token counts describe usage, not moderation. Only explicit feedback identifies a block.
    const messages: Record<string, string> = {
      SAFETY: "本次请求未通过 AI 安全审核（SAFETY），请检查提示词或参考图片",
      BLOCKLIST: "本次请求命中服务方屏蔽词规则（BLOCKLIST），请检查提示词",
      PROHIBITED_CONTENT: "本次请求被服务方禁止内容规则拦截（PROHIBITED_CONTENT），请检查参考内容",
      OTHER: "服务方阻止了本次请求（OTHER），未说明具体原因；不能据此判定为安全违规",
    };
    throw new ProviderError(
      Object.hasOwn(messages, promptBlockReason) ? messages[promptBlockReason] : "服务方阻止了本次请求，未说明具体原因，请联系管理员核查",
      422, modelId, "content_refused", diagnostic(),
    );
  }
  if (!candidates.length) {
    throw new ProviderError(
      "AI 服务响应缺少候选结果，请稍后重试",
      502, modelId, "invalid_response", diagnostic(),
    );
  }

  for (const candidateValue of candidates) {
    const candidate = record(candidateValue);
    if (!candidate) continue;
    if (typeof candidate.finishReason === "string") finishReasons.push(candidate.finishReason);
    const content = record(candidate.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    for (const partValue of parts) {
      const part = record(partValue);
      if (typeof part?.text === "string" && !part.text.startsWith("data:image/")) {
        const text = part.text.replace(/\s+/g, " ").trim();
        if (text) texts.push(text.slice(0, 500));
      }
      const inline = record(part?.inlineData);
      if (!inline || inline.data === undefined) continue;
      const mime = typeof inline.mimeType === "string" && REFERENCE_MIMES.has(inline.mimeType)
        ? inline.mimeType
        : undefined;
      if (!mime) throw new ProviderError("Gemini 返回了不支持的图片格式", 502, modelId, "invalid_response");
      images.push(await base64Image(inline.data, modelId, mime));
    }
  }

  const abnormalFinishReason = finishReasons.find((reason) => reason !== "STOP");
  if (abnormalFinishReason) {
    if (abnormalFinishReason === "IMAGE_SAFETY") {
      throw new ProviderError(
        "AI 图片安全审核暂时未通过，系统将按上限自动重试",
        422, modelId, "image_safety", diagnostic(),
      );
    }
    if (["SAFETY", "PROHIBITED_CONTENT", "IMAGE_PROHIBITED_CONTENT"].includes(abnormalFinishReason)) {
      throw new ProviderError(
        "本次请求未通过 AI 安全审核，请调整提示词或参考图片后重试",
        422, modelId, "content_refused", diagnostic(),
      );
    }
    if (abnormalFinishReason === "BLOCKLIST") {
      throw new ProviderError(
        "生成被服务方屏蔽词规则拦截（BLOCKLIST），请检查提示词",
        422, modelId, "content_refused", diagnostic(),
      );
    }
    if (["RECITATION", "IMAGE_RECITATION"].includes(abnormalFinishReason)) {
      throw new ProviderError(
        "生成内容可能涉及版权限制，请调整参考内容后重试",
        422, modelId, "content_refused", diagnostic(),
      );
    }
    if (abnormalFinishReason === "MAX_TOKENS") {
      throw new ProviderError(
        "生成内容长度超出模型限制，请简化提示词后重试",
        400, modelId, "invalid_request", diagnostic(),
      );
    }
    throw new ProviderError(
      "AI 未能完成图片生成，请调整提示词后重试",
      502, modelId, "invalid_response", diagnostic(),
    );
  }

  if (images.length) return [images.at(-1)!];
  if (texts.length) {
    throw new ProviderError(
      texts.join("\n").slice(0, 500),
      422, modelId, "content_refused", diagnostic(),
    );
  }
  throw new ProviderError(
    "AI 响应中没有可用的图片或文字说明，请稍后重试",
    502, modelId, "invalid_response", diagnostic(),
  );
}

async function geminiInlineData(
  dataUrl: string,
  modelId: ImageModelId,
  targetBytes = GEMINI_COMPRESSION_THRESHOLD,
): Promise<{ inlineData: { mimeType: string; data: string } }> {
  const parsed = parsedReference(dataUrl, modelId);
  if (parsed.buffer.length <= targetBytes && parsed.mime !== "image/webp") {
    return { inlineData: { mimeType: parsed.mime, data: parsed.base64 } };
  }
  try {
    const mimeType = parsed.mime === "image/jpeg" ? "image/jpeg" : "image/png";
    const converted = await withImageProcessingSlot(async () => {
      let longEdge = 2048;
      let buffer = parsed.buffer;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const pipeline = sharp(parsed.buffer, { limitInputPixels: PROVIDER_RESPONSE_PIXEL_LIMIT })
          .rotate().resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true });
        // PNG has no JPEG-style quality parameter; keep it lossless and reduce dimensions if needed.
        buffer = await (mimeType === "image/jpeg"
          ? pipeline.jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
          : pipeline.png({ compressionLevel: 9 })).toBuffer();
        if (buffer.length <= targetBytes) break;
        const metadata = await sharp(buffer).metadata();
        longEdge = Math.max(1, Math.floor(Math.max(metadata.width ?? 1, metadata.height ?? 1)
          * Math.min(0.85, Math.sqrt(targetBytes / buffer.length) * 0.95)));
      }
      return buffer;
    });
    return { inlineData: { mimeType, data: converted.toString("base64") } };
  } catch (error) {
    if (parsed.mime === "image/webp") {
      throw new ProviderError("Gemini 参考图转换失败，请使用 PNG 或 JPEG", 400, modelId, "invalid_request");
    }
    // Compression failure alone must not discard a valid reference.
    void error;
    return { inlineData: { mimeType: parsed.mime, data: parsed.base64 } };
  }
}

async function geminiReferenceParts(refs: string[], modelId: ImageModelId) {
  let parts = await Promise.all(refs.map((ref) => geminiInlineData(ref, modelId)));
  const byteCount = () => parts.reduce((total, part) => total + Buffer.byteLength(part.inlineData.data, "base64"), 0);
  if (byteCount() > GEMINI_TOTAL_REFERENCE_BYTES) {
    const budgetPerImage = Math.floor(GEMINI_TOTAL_REFERENCE_BYTES / refs.length);
    parts = await Promise.all(parts.map((part) => geminiInlineData(
      `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`, modelId, budgetPerImage,
    )));
  }
  if (parts.some((part) => Buffer.byteLength(part.inlineData.data, "base64") >= GEMINI_MAX_REFERENCE_BYTES)
    || byteCount() > GEMINI_TOTAL_REFERENCE_BYTES) {
    throw new ProviderError("Gemini 参考图压缩后仍超出体积限制，请减少图片或缩小原图（合计最多 6MB）",
      400, modelId, "invalid_request");
  }
  return parts;
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
    case "gemini-3.1-flash-image":
      response = await fetchApiyi(modelId, contract.generation.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({
          contents: [{ parts: [{ text: req.prompt }] }],
          generationConfig: { responseModalities: ["IMAGE"], imageConfig: {
            aspectRatio: options.aspectRatio, imageSize: options.imageSize,
          } },
        }),
      }));
      return { images: await parseGeminiImages(await readJson(response, modelId), modelId), model: modelId };
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
  const refs = req.referenceImages!;
  let response: Response;
  switch (modelId) {
    case "gpt-image-2.5-flare":
    case "gpt-image-2.5-sunburst":
      return gptImage25Result(modelId, { ...req, modelOptions: options }, "edit");
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
      const parts = [{ text: req.prompt }, ...await geminiReferenceParts(refs, modelId)];
      response = await fetchApiyi(modelId, contract.edit.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseModalities: ["IMAGE"], imageConfig: {
            aspectRatio: options.aspectRatio, imageSize: options.imageSize,
          } },
        }),
      }));
      return { images: await parseGeminiImages(await readJson(response, modelId), modelId), model: modelId };
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

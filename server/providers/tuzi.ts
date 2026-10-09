import contracts from "../../docs/ai/tuzi/model-contracts.json";
import { defaultImageModelOptions, normalizeImageModelOptions, type ImageModelId } from "../../src/types/imageModels";
import type { AIProvider, ImageGenRequest, ImageGenResult } from "../../src/types/workflow";
import { config } from "../config";
import { normalizeProviderReferenceImages } from "../lib/uploadImageNormalization";
import { validateImageDataUrl } from "../lib/imageValidation";
import { fetchAiWithRetry as fetchWithRetry, ProviderError } from "./base";
import { base64Image, imageUrl, parseOpenAiImages, readJson, validateApiyiRequest } from "./apiyi";
import { requestGptImage25 } from "./gptImage25";

async function requestTuzi(modelId: ImageModelId, req: ImageGenRequest, mode: "generate" | "edit"): Promise<ImageGenResult> {
  const contract = contracts.models.find((entry) => entry.id === modelId);
  if (!contract) throw new ProviderError(`${modelId}：${contracts.unsupportedReason}`, 400, modelId, "invalid_request");
  // Preserve the product's model options, mask, MIME, reference-count and size limits.
  await validateApiyiRequest(modelId, req, mode);
  const options = modelId.startsWith("gpt-image-2.5-")
    ? normalizeImageModelOptions(modelId, req.modelOptions, req.aspectRatio)
    : req.modelOptions ?? defaultImageModelOptions(modelId, req.aspectRatio);
  const refs = await normalizeProviderReferenceImages(req.referenceImages ?? [], modelId);
  if (refs.length > contract.maxReferences) throw new ProviderError("TuziAPI 参考图数量超出限制", 400, modelId, "invalid_request");
  if (contract.protocol === "gpt-image") {
    const { response } = await requestGptImage25({ ...req, referenceImages: refs, modelOptions: options }, mode, contract.upstreamModelId, "tuzi");
    return { images: await parseOpenAiImages(await readJson(response, modelId), modelId, { maxImages: 1 }), model: contract.upstreamModelId };
  }

  let pathname = `/v1/images/${mode === "generate" ? "generations" : "edits"}`;
  let body: string | FormData;
  if (contract.protocol === "gemini") {
    // TuziAPI 的 Gemini 生图仅经 OpenAI chat/completions 协议交付：图片数据以 base64
    // dataURL 或 URL 混排在流式 delta.content 文本中；generateContent 上行会把参考图
    // 静默丢弃、下行只回空候选（上游控制台仍记成功），因此这里必须用流式聊天端点。
    pathname = "/v1/chat/completions";
    body = JSON.stringify({
      model: contract.upstreamModelId,
      stream: true,
      messages: [{
        role: "user",
        content: [
          // chat 协议没有 imageConfig 字段位，宽高比/分辨率以输出规格尾注传达
          { type: "text", text: req.prompt + (options.imageSize || options.aspectRatio
            ? `\n输出规格：${[options.aspectRatio ? `宽高比 ${options.aspectRatio}` : "", options.imageSize ? `分辨率 ${options.imageSize}` : ""].filter(Boolean).join("，")}。`
            : "") },
          ...refs.map((ref) => ({ type: "image_url", image_url: { url: ref } })),
        ],
      }],
    });
  } else if (mode === "generate") {
    body = JSON.stringify({ model: contract.upstreamModelId, prompt: req.prompt, size: options.size, n: 1, response_format: "b64_json" });
  } else {
    const form = new FormData();
    form.append("model", contract.upstreamModelId);
    form.append("prompt", req.prompt);
    if (options.size) form.append("size", String(options.size));
    form.append("n", "1");
    form.append("response_format", "b64_json");
    refs.forEach((ref, index) => {
      const parsed = validateImageDataUrl(ref);
      const extension = parsed.mime === "image/jpeg" ? "jpg" : parsed.mime.split("/")[1];
      form.append(refs.length === 1 ? "image" : "image[]", new Blob([new Uint8Array(parsed.buffer)], { type: parsed.mime }), `reference-${index + 1}.${extension}`);
    });
    body = form;
  }
  const minimum = 360_000;
  const response = await fetchWithRetry(`${config.tuziBaseUrl()}${pathname}`, () => ({
    method: "POST", body,
    headers: { Authorization: `Bearer ${config.tuziApiKey()}`, ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}) },
  }), { providerId: modelId, timeoutMs: Math.max(minimum, config.aiTimeoutMs(minimum) || minimum), minimumResponseTimeoutMs: minimum, maxRetries: 0, gateway: "tuzi" });
  const images = contract.protocol === "gemini"
    ? await parseTuziChatImages(await readTuziStreamContent(response, modelId), modelId)
    : await parseOpenAiImages(await readJson(response, modelId), modelId, { maxImages: 1 });
  return {
    images,
    model: contract.upstreamModelId,
  };
}

/** TuziAPI 流式 chat/completions：聚合 delta.content 文本与结构化图片分片。 */
async function readTuziStreamContent(response: Response, modelId: ImageModelId): Promise<string[]> {
  if (!response.body) throw new ProviderError("AI 服务响应缺少内容", 502, modelId, "invalid_response");
  const collected: string[] = [];
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const collectContent = (content: unknown): void => {
    if (typeof content === "string") { collected.push(content); return; }
    // 部分兼容网关把 content 返回为 OpenAI 多模态分片数组
    if (!Array.isArray(content)) return;
    for (const item of content) {
      const part = record(item);
      if (typeof part?.text === "string") collected.push(part.text);
      const image = record(part?.image_url);
      if (typeof image?.url === "string") collected.push(image.url);
    }
  };
  const consumeChunk = (chunk: unknown): void => {
    for (const choice of Array.isArray(record(chunk)?.choices) ? record(chunk)!.choices as unknown[] : []) {
      const ch = record(choice);
      collectContent(record(ch?.delta)?.content ?? record(ch?.message)?.content);
      // 兼容网关把图片放在 message.images / delta.images 列表的情形
      const images = record(ch?.message)?.images ?? record(ch?.delta)?.images;
      if (!Array.isArray(images)) continue;
      for (const item of images) {
        const img = record(item);
        const nested = record(img?.image_url);
        const url = nested?.url ?? img?.url;
        if (typeof url === "string") collected.push(url);
        else if (typeof img?.b64_json === "string") collected.push(`data:image/png;base64,${img.b64_json}`);
      }
    }
  };
  const rawChunks: string[] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    const text = decoder.decode(value, { stream: !done });
    buffered += text;
    rawChunks.push(text);
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data && data !== "[DONE]") {
          try { consumeChunk(JSON.parse(data)); } catch { /* 容忍半截残行 */ }
        }
      }
    }
    if (done && buffered.trim()) {
      // 末行缺尾换行时补消费一次
      const line = buffered.trim();
      buffered = "";
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data && data !== "[DONE]") {
          try { consumeChunk(JSON.parse(data)); } catch { /* 容忍半截残行 */ }
        }
      }
    }
    if (done) break;
  }
  if (!collected.length) {
    // 网关若忽略 stream 参数直接回 JSON，退化为非流式 chat 响应
    try {
      consumeChunk(JSON.parse(rawChunks.join("")));
    } catch { /* 下方统一报错 */ }
  }
  if (!collected.length) throw new ProviderError("AI 服务未返回图片", 502, modelId, "invalid_response");
  return collected;
}

const TUZI_DATA_URL_IMAGE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g;
const TUZI_LINKED_IMAGE = /https?:\/\/[^\s<>"'\\)]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s<>"'\\)]*)?/gi;

/** 从混合文本中回收图片：优先 base64 dataURL，其次可下载的图片 URL。 */
async function parseTuziChatImages(fragments: string[], modelId: ImageModelId): Promise<string[]> {
  const content = fragments.join("");
  const images: string[] = [];
  for (const match of content.matchAll(TUZI_DATA_URL_IMAGE)) {
    images.push(await base64Image(match[0], modelId));
    if (images.length >= 1) return images;
  }
  for (const match of content.matchAll(TUZI_LINKED_IMAGE)) {
    images.push(imageUrl(match[0], modelId, images.length));
    if (images.length >= 1) return images;
  }
  if (content.trim()) {
    throw new ProviderError(
      content.trim().slice(0, 500), 422, modelId, "content_refused",
      "text response without an image",
    );
  }
  throw new ProviderError("AI 服务未返回图片", 502, modelId, "invalid_response");
}

export const tuziProviders: Record<string, AIProvider> = Object.fromEntries(contracts.models.map(({ id }) => [id, {
  id,
  validate: (request: ImageGenRequest, mode: "generate" | "edit") => validateApiyiRequest(id as ImageModelId, request, mode),
  generate: (request: ImageGenRequest) => requestTuzi(id as ImageModelId, request, "generate"),
  edit: (request: ImageGenRequest) => requestTuzi(id as ImageModelId, request, "edit"),
}]));

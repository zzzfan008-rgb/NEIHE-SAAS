import contracts from "../../docs/ai/tuzi/model-contracts.json";
import { defaultImageModelOptions, normalizeImageModelOptions, type ImageModelId } from "../../src/types/imageModels";
import type { AIProvider, ImageGenRequest, ImageGenResult } from "../../src/types/workflow";
import { config } from "../config";
import { normalizeProviderReferenceImages } from "../lib/uploadImageNormalization";
import { validateImageDataUrl } from "../lib/imageValidation";
import { fetchAiWithRetry as fetchWithRetry, ProviderError } from "./base";
import { geminiInlineDataParts, geminiReferenceParts, parseGeminiImages, parseOpenAiImages, readJson, validateApiyiRequest } from "./apiyi";
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
    pathname = `/v1beta/models/${encodeURIComponent(contract.upstreamModelId)}:generateContent`;
    const parts = await geminiReferenceParts(refs, modelId, req.referenceEncoding);
    body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: req.prompt }, ...geminiInlineDataParts(parts)] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: options.aspectRatio, imageSize: options.imageSize } },
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
  const payload = await readJson(response, modelId);
  return {
    images: contract.protocol === "gemini" ? await parseGeminiImages(payload, modelId)
      : await parseOpenAiImages(payload, modelId, { maxImages: 1 }),
    model: contract.upstreamModelId,
  };
}

export const tuziProviders: Record<string, AIProvider> = Object.fromEntries(contracts.models.map(({ id }) => [id, {
  id,
  validate: (request: ImageGenRequest, mode: "generate" | "edit") => validateApiyiRequest(id as ImageModelId, request, mode),
  generate: (request: ImageGenRequest) => requestTuzi(id as ImageModelId, request, "generate"),
  edit: (request: ImageGenRequest) => requestTuzi(id as ImageModelId, request, "edit"),
}]));

import contracts from "../../docs/ai/tuzi/model-contracts.json";
import { defaultImageModelOptions, normalizeImageModelOptions, type ImageModelId } from "../../src/types/imageModels";
import type { AIProvider, ImageGenRequest, ImageGenResult } from "../../src/types/workflow";
import { config } from "../config";
import { normalizeProviderReferenceImages } from "../lib/uploadImageNormalization";
import { validateImageDataUrl } from "../lib/imageValidation";
import { fetchAiWithRetry as fetchWithRetry, ProviderError } from "./base";
import { validateApiyiRequest } from "./apiyi";
import { requestGptImage25 } from "./gptImage25";
import { parseTuziImageJson, readTuziImageJson } from "./tuziImageResponse";

function geminiImageOptions(modelId: ImageModelId, req: ImageGenRequest) {
  const options = { ...defaultImageModelOptions(modelId, req.aspectRatio), ...req.modelOptions };
  if (!contracts.geminiImages.aspectRatios.includes(options.aspectRatio ?? "")) {
    throw new ProviderError("TuziAPI 非流式图像接口不支持此宽高比，请选择常规比例或切回 APIYI", 400, modelId, "invalid_request");
  }
  if (!contracts.geminiImages.imageSizes.includes(options.imageSize ?? "")) {
    throw new ProviderError("TuziAPI 非流式图像接口不支持此分辨率，请选择 1K、2K、4K 或切回 APIYI", 400, modelId, "invalid_request");
  }
  return { size: options.aspectRatio!.replace(":", "x"), quality: options.imageSize!.toLowerCase() };
}

async function validateTuziRequest(modelId: ImageModelId, req: ImageGenRequest, mode: "generate" | "edit") {
  await validateApiyiRequest(modelId, req, mode);
  if (contracts.models.find((entry) => entry.id === modelId)?.protocol === "gemini-images") geminiImageOptions(modelId, req);
}

async function requestTuzi(modelId: ImageModelId, req: ImageGenRequest, mode: "generate" | "edit"): Promise<ImageGenResult> {
  const started = performance.now();
  let phaseStarted = started;
  let stage = "prepare";
  const timings: Record<string, number> = {};
  let outcome = "succeeded";
  let requestId: string | undefined;
  try {
    const contract = contracts.models.find((entry) => entry.id === modelId);
    if (!contract) throw new ProviderError(`${modelId}：${contracts.unsupportedReason}`, 400, modelId, "invalid_request");
    await validateTuziRequest(modelId, req, mode);
    const options = modelId.startsWith("gpt-image-2.5-")
      ? normalizeImageModelOptions(modelId, req.modelOptions, req.aspectRatio)
      : req.modelOptions ?? defaultImageModelOptions(modelId, req.aspectRatio);
    const refs = await normalizeProviderReferenceImages(req.referenceImages ?? [], modelId);
    if (refs.length > contract.maxReferences) throw new ProviderError("TuziAPI 参考图数量超出限制", 400, modelId, "invalid_request");

    let pathname = `/v1/images/${mode === "generate" ? "generations" : "edits"}`;
    let body: string | FormData | undefined;
    if (contract.protocol === "gemini-images") {
      // Official synchronous Images API accepts ordered references. The old
      // Gemini edits endpoint is deprecated; never fall back to Chat/native/retry.
      pathname = contracts.geminiImages.path;
      body = JSON.stringify({
        model: contract.upstreamModelId, prompt: req.prompt,
        ...geminiImageOptions(modelId, req), n: 1, response_format: "b64_json",
        ...(refs.length ? { image: refs } : {}),
      });
    } else if (contract.protocol !== "gpt-image") {
      if (mode === "generate") {
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
    }
    timings.prepareMs = Math.round(performance.now() - phaseStarted);
    stage = "request"; phaseStarted = performance.now();
    const minimum = 360_000;
    const configured = config.aiTimeoutMs(minimum);
    const response = contract.protocol === "gpt-image"
      ? (await requestGptImage25({ ...req, referenceImages: refs, modelOptions: options }, mode, contract.upstreamModelId, "tuzi")).response
      : await fetchWithRetry(`${config.tuziBaseUrl()}${pathname}`, () => ({
        method: "POST", body,
        headers: { Authorization: `Bearer ${config.tuziApiKey()}`, ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}) },
      }), { providerId: modelId, timeoutMs: Math.max(minimum, Number.isFinite(configured) ? configured : minimum), minimumResponseTimeoutMs: minimum, maxRetries: 0, gateway: "tuzi" });
    timings.requestMs = Math.round(performance.now() - phaseStarted);
    const rawRequestId = response.headers.get("x-request-id");
    if (rawRequestId && /^[\w.:-]{1,160}$/.test(rawRequestId) && !/sk-/i.test(rawRequestId)
      && rawRequestId !== config.tuziApiKey()) requestId = rawRequestId;
    stage = "read"; phaseStarted = performance.now();
    const payload = await readTuziImageJson(response, modelId);
    timings.readMs = Math.round(performance.now() - phaseStarted);
    stage = "validate"; phaseStarted = performance.now();
    const images = await parseTuziImageJson(payload, modelId);
    timings.validateMs = Math.round(performance.now() - phaseStarted);
    stage = "complete";
    return { images, model: contract.upstreamModelId, providerRequestId: requestId };
  } catch (error) {
    outcome = error instanceof ProviderError ? error.category : "unknown";
    throw error;
  } finally {
    console.info("[tuzi-image-timing]", JSON.stringify({
      modelId, mode, requestId, outcome, stage, ...timings,
      ...(stage !== "complete" ? { stageElapsedMs: Math.round(performance.now() - phaseStarted) } : {}),
      totalMs: Math.round(performance.now() - started),
    }));
  }
}

export const tuziProviders: Record<string, AIProvider> = Object.fromEntries(contracts.models.map(({ id }) => [id, {
  id,
  validate: (request: ImageGenRequest, mode: "generate" | "edit") => validateTuziRequest(id as ImageModelId, request, mode),
  generate: (request: ImageGenRequest) => requestTuzi(id as ImageModelId, request, "generate"),
  edit: (request: ImageGenRequest) => requestTuzi(id as ImageModelId, request, "edit"),
}]));

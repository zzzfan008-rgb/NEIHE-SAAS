import sharp from "sharp";
import { config } from "../config";
import { validateImageDataUrl } from "../lib/imageValidation";
import { withImageProcessingSlot } from "../lib/imageProcessingLimit";
import { fetchWithRetry, ProviderError, toDataUrl } from "./base";
import type { ImageGenRequest } from "../../src/types/workflow";

const THRESHOLD = 1.5 * 1024 * 1024;
const TOTAL = 6 * 1024 * 1024;

/** Keep originals immutable and ordered. Only compression errors fall back. */
export async function prepareGptReferences(refs: string[]): Promise<string[]> {
  const originals = refs.map((ref) => validateImageDataUrl(ref));
  const compress = async (index: number, budget: number): Promise<string> => {
    const original = originals[index];
    if (original.buffer.length <= budget) return refs[index];
    try {
      return await withImageProcessingSlot(async () => {
        let edge = 2048;
        let output = original.buffer;
        for (let attempt = 0; attempt < 12; attempt++) {
          const pipeline = sharp(original.buffer, { limitInputPixels: 40_000_000 }).rotate()
            .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true });
          output = await (original.mime === "image/jpeg" ? pipeline.jpeg({ quality: 90 })
            : original.mime === "image/webp" ? pipeline.webp({ quality: 90 })
            : pipeline.png({ compressionLevel: 9 })).toBuffer();
          if (output.length <= budget) break;
          edge = Math.max(1, Math.floor(edge * Math.min(0.8, Math.sqrt(budget / output.length) * 0.95)));
        }
        return toDataUrl(output.toString("base64"), original.mime);
      });
    } catch {
      console.warn("[gpt-image-2.5] reference compression failed; keeping original", { index });
      return refs[index];
    }
  };
  let result = await Promise.all(refs.map((_, index) => compress(index, THRESHOLD)));
  const totalBytes = () => result.reduce((sum, ref) => sum + validateImageDataUrl(ref).buffer.length, 0);
  if (totalBytes() > TOTAL) result = await Promise.all(refs.map((_, index) => compress(index, Math.floor(TOTAL / refs.length))));
  if (totalBytes() > TOTAL) console.warn("[gpt-image-2.5] references exceed 6 MiB after fallback", { bytes: totalBytes() });
  return result;
}

export async function requestGptImage25(req: ImageGenRequest, mode: "generate" | "edit", selectedModel?: string) {
  const model = selectedModel ?? (mode === "generate" ? config.gptImageGenerationModel() : config.gptImageEditModel());
  if (!/^gpt-image-(?:2(?:-\d{4}-\d{2}-\d{2})?|2\.5-(?:flare|sunburst)(?:-\d{4}-\d{2}-\d{2})?)$/.test(model)) {
    throw new ProviderError("GPT 图片模型环境配置无效", 400, model, "invalid_request");
  }
  const quality = req.modelOptions?.quality ?? "medium";
  const is25 = model.startsWith("gpt-image-2.5-");
  if (!(is25 ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high"]).includes(quality)) {
    throw new ProviderError("当前上游模型不接受此质量档位", 400, model, "invalid_request");
  }
  const minimum = ["high", "xhigh", "max"].includes(quality) ? 600_000 : 360_000;
  const configured = config.aiTimeoutMs(minimum);
  const timeoutMs = Math.max(minimum, Number.isFinite(configured) ? configured : minimum);
  let body: string | FormData;
  if (mode === "generate") {
    body = JSON.stringify({ model, prompt: req.prompt, quality, size: req.modelOptions?.size ?? "2048x2048", n: 1, output_format: "png" });
  } else {
    const refs = await prepareGptReferences(req.referenceImages ?? []);
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", req.prompt);
    form.append("quality", quality);
    form.append("size", req.modelOptions?.size ?? "2048x2048");
    form.append("n", "1");
    form.append("output_format", "png");
    refs.forEach((ref, index) => {
      const parsed = validateImageDataUrl(ref);
      const extension = parsed.mime === "image/jpeg" ? "jpg" : parsed.mime.split("/")[1];
      form.append("image[]", new Blob([new Uint8Array(parsed.buffer)], { type: parsed.mime }), `reference-${index + 1}.${extension}`);
    });
    if (req.mask) {
      const first = validateImageDataUrl(refs[0]);
      const dimensions = await sharp(first.buffer).metadata();
      const mask = await withImageProcessingSlot(() => sharp(validateImageDataUrl(req.mask!).buffer)
        .resize(dimensions.width, dimensions.height, { fit: "fill" }).png().toBuffer());
      if (mask.length >= 4 * 1024 * 1024) throw new ProviderError("蒙版超过 4 MiB", 400, model, "invalid_request");
      form.append("mask", new Blob([new Uint8Array(mask)], { type: "image/png" }), "mask.png");
    }
    body = form;
  }
  const response = await fetchWithRetry(`${config.apiyiBaseUrl()}/v1/images/${mode === "generate" ? "generations" : "edits"}`, () => ({
    method: "POST", body,
    headers: { Authorization: `Bearer ${config.apiyiApiKey()}`, ...(mode === "generate" ? { "Content-Type": "application/json" } : {}) },
  }), { providerId: model, timeoutMs, minimumResponseTimeoutMs: minimum, maxRetries: 0 });
  return { response, model };
}

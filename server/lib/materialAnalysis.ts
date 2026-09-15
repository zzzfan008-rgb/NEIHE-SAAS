import sharp from "sharp";
import { config } from "../config";
import { fetchWithRetry, ProviderError } from "../providers/base";
import { parseColorValue } from "../../src/lib/colorPalette";
import type {
  MaterialAnalysisSuggestion, MaterialCropRect,
} from "../../src/types/materialAnalysis";
import { normalizeUploadImageDataUrl } from "./uploadImageNormalization";
import { withImageProcessingSlot } from "./imageProcessingLimit";

const MATERIAL_PROMPT = `你是服装面料图像分析器。只根据这张裁切后的面料样本返回 JSON：
{
  "materialDescription": "对可见材质、纹理、织法和光泽的简洁中文描述",
  "observedAttributes": ["仅列出图像中可直接观察的属性"],
  "uncertainAttributes": ["成分、克重或无法仅凭图像确定的推测，必须明确写待确认"],
  "colors": [{"hex":"#RRGGBB","name":"简短中文色名"}]
}
返回 1–12 个主要颜色。不得输出 Pantone 色号、品牌、成分定论、Markdown 或 JSON 以外文字。`;

function finiteRatio(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ProviderError(`${name} 必须是 0–1 的有限数值`, 400, "material-analysis", "invalid_request");
  }
  return value;
}

export function validateMaterialCrop(value: unknown): MaterialCropRect {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError("裁切范围无效", 400, "material-analysis", "invalid_request");
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !["x", "y", "width", "height"].includes(key))) {
    throw new ProviderError("裁切范围包含未知字段", 400, "material-analysis", "invalid_request");
  }
  const crop = {
    x: finiteRatio(row.x, "x"), y: finiteRatio(row.y, "y"),
    width: finiteRatio(row.width, "width"), height: finiteRatio(row.height, "height"),
  };
  if (crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > 1.000001 || crop.y + crop.height > 1.000001) {
    throw new ProviderError("裁切范围超出图片边界", 400, "material-analysis", "invalid_request");
  }
  return crop;
}

export async function cropMaterialImage(imageDataUrl: unknown, rawCrop: unknown) {
  const crop = validateMaterialCrop(rawCrop);
  const source = await normalizeUploadImageDataUrl(imageDataUrl);
  const left = Math.floor(source.width * crop.x);
  const top = Math.floor(source.height * crop.y);
  const width = Math.min(source.width - left, Math.max(1, Math.round(source.width * crop.width)));
  const height = Math.min(source.height - top, Math.max(1, Math.round(source.height * crop.height)));
  if (width < 16 || height < 16) {
    throw new ProviderError("裁切区域至少需要 16×16 像素", 400, "material-analysis", "invalid_request");
  }
  const buffer = await withImageProcessingSlot(() => sharp(source.buffer, {
    animated: false, failOn: "error", limitInputPixels: 40_000_000,
  }).rotate().extract({ left, top, width, height }).png().toBuffer());
  return {
    crop,
    sourceDataUrl: `data:${source.mimeType};base64,${source.buffer.toString("base64")}`,
    cropDataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
  };
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 12 || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 200)) {
    throw new ProviderError(`材质分析 ${field} 格式无效`, 502, "material-analysis", "invalid_response");
  }
  return value.map((item) => (item as string).trim());
}

export function parseMaterialSuggestion(value: unknown): MaterialAnalysisSuggestion {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError("材质分析返回格式无效", 502, "material-analysis", "invalid_response");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.materialDescription !== "string" || !row.materialDescription.trim() || row.materialDescription.length > 1_000 ||
      !Array.isArray(row.colors) || row.colors.length < 1 || row.colors.length > 12) {
    throw new ProviderError("材质分析返回字段无效", 502, "material-analysis", "invalid_response");
  }
  const colors = row.colors.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ProviderError("材质分析颜色格式无效", 502, "material-analysis", "invalid_response");
    }
    const color = entry as Record<string, unknown>;
    if (typeof color.hex !== "string") {
      throw new ProviderError("材质分析颜色值无效", 502, "material-analysis", "invalid_response");
    }
    let hex: string;
    try { hex = parseColorValue(color.hex); } catch {
      throw new ProviderError("材质分析颜色值无效", 502, "material-analysis", "invalid_response");
    }
    if (color.name !== undefined && (typeof color.name !== "string" || !color.name.trim() || color.name.length > 80)) {
      throw new ProviderError("材质分析色名无效", 502, "material-analysis", "invalid_response");
    }
    return { hex, ...(typeof color.name === "string" ? { name: color.name.trim() } : {}) };
  });
  return {
    materialDescription: row.materialDescription.trim(),
    observedAttributes: stringArray(row.observedAttributes, "observedAttributes"),
    uncertainAttributes: stringArray(row.uncertainAttributes, "uncertainAttributes"),
    colors,
  };
}

function responseText(payload: unknown): string {
  const candidate = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> })
    ?.candidates?.[0]?.content?.parts?.find((part) => typeof part.text === "string")?.text;
  if (typeof candidate !== "string") {
    throw new ProviderError("材质分析响应缺少 JSON", 502, "material-analysis", "invalid_response");
  }
  return candidate.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

export async function analyzeMaterialImage(
  cropDataUrl: string,
  modelId: string,
  fetcher: typeof fetchWithRetry = fetchWithRetry,
): Promise<MaterialAnalysisSuggestion> {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(modelId)) {
    throw new ProviderError("材质分析模型无效", 400, modelId, "invalid_request");
  }
  const comma = cropDataUrl.indexOf(",");
  if (!cropDataUrl.startsWith("data:image/") || comma < 0) {
    throw new ProviderError("裁切图片无效", 400, modelId, "invalid_request");
  }
  const mimeType = cropDataUrl.slice(5, cropDataUrl.indexOf(";"));
  const data = cropDataUrl.slice(comma + 1);
  const response = await fetcher(
    `${config.apiyiBaseUrl()}/v1beta/models/${modelId}:generateContent`,
    () => ({
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: MATERIAL_PROMPT }, { inlineData: { mimeType, data } }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    }),
    { timeoutMs: config.aiTimeoutMs(120_000), providerId: modelId },
  );
  let parsed: unknown;
  try { parsed = JSON.parse(responseText(await response.json())); } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("材质分析 JSON 无法解析", 502, modelId, "invalid_response");
  }
  return parseMaterialSuggestion(parsed);
}

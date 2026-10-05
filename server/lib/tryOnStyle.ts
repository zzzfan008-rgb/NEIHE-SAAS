import fs from "node:fs/promises";
import path from "node:path";
import { ROOT_DIR } from "../config";
import { builtInTryOnStylePreset, DEFAULT_TRY_ON_STYLE_PRESET_ID } from "../../src/lib/tryOnStylePresets";
import { normalizeImageRef } from "./fileStore";
import { toDataUrl } from "../providers/base";

export interface ResolvedTryOnStyle {
  id: string;
  name: string;
  prompt: string;
  referenceImage?: string;
}

async function builtInReference(asset: string): Promise<string> {
  if (!/^\/assets\/try-on-styles\/[A-Za-z0-9_-]+\.webp$/.test(asset)) {
    throw new Error("内置换装风格参考图路径无效");
  }
  const buffer = await fs.readFile(path.join(ROOT_DIR, "public", asset.slice(1)));
  return toDataUrl(buffer.toString("base64"), "image/webp");
}

export async function resolveTryOnStyle(params: Record<string, unknown>, includeReference = true): Promise<ResolvedTryOnStyle> {
  const requestedId = typeof params.stylePresetId === "string" && params.stylePresetId.trim()
    ? params.stylePresetId.trim()
    : DEFAULT_TRY_ON_STYLE_PRESET_ID;
  const builtIn = builtInTryOnStylePreset(requestedId);
  const requestedPrompt = typeof params.stylePrompt === "string" && params.stylePrompt.trim()
    ? params.stylePrompt.trim()
    : builtIn?.prompt ?? builtInTryOnStylePreset(DEFAULT_TRY_ON_STYLE_PRESET_ID)!.prompt;
  // Saved nodes can carry the former built-in text. Match it exactly so custom
  // style instructions remain verbatim.
  const prompt = requestedId === "faithful" && requestedPrompt === "保持场景参考的真实光线、色彩和镜头质感，不增加额外滤镜或风格化处理。"
    ? builtInTryOnStylePreset("faithful")!.prompt
    : requestedPrompt;
  const name = typeof params.stylePresetName === "string" && params.stylePresetName.trim()
    ? params.stylePresetName.trim()
    : builtIn?.name ?? "自定义风格";
  if (!includeReference) return { id: requestedId, name, prompt };
  const customReference = typeof params.styleReferenceImage === "string" && params.styleReferenceImage
    ? await normalizeImageRef(params.styleReferenceImage)
    : undefined;
  const referenceImage = customReference ?? (builtIn?.referenceAsset
    ? await builtInReference(builtIn.referenceAsset)
    : undefined);
  return { id: requestedId, name, prompt, ...(referenceImage ? { referenceImage } : {}) };
}

import { DEFAULT_GENERATION_MODEL_ID, modelMaxReferenceImages, type GenerationImageModelId } from "../types/imageModels";
import type { AiStylingNodeData } from "../types/workflow";
import type { StylingExtras } from "../types/styling";

export const STYLING_EXTRAS = [
  { id: "outerwear", label: "外套" }, { id: "shoes", label: "鞋履" },
  { id: "bag", label: "包袋" }, { id: "accessories", label: "配饰" }, { id: "hat", label: "帽子" },
] as const;
export const STYLING_PRESERVE_LABELS = { upper: "保留上装", lower: "保留下装", "one-piece": "保留连体服饰", whole: "保留整套服装" } as const;
export function emptyStylingExtras(): StylingExtras {
  return { outerwear: false, shoes: false, bag: false, accessories: false, hat: false };
}
export function orderedOutfitImages(data: { images: string[]; mainImage: string | null }): string[] {
  if (!data.mainImage || !data.images.includes(data.mainImage)) return [];
  return [data.mainImage, ...data.images.filter((image) => image !== data.mainImage)];
}
/** Includes source identity: reconnecting a different upload node invalidates recognition. */
export function stylingReferenceKey(sourceId: string, images: string[]): string {
  return JSON.stringify([sourceId, ...images]);
}
export function stylingReferenceLimit(modelId: GenerationImageModelId = DEFAULT_GENERATION_MODEL_ID, count = 1): number {
  return Math.min(8, modelMaxReferenceImages(modelId) - (count > 1 ? 1 : 0));
}
export function stylingBlockReason(data: AiStylingNodeData, images: string[], analysisValid: boolean, outerwearProtected = false): string | null {
  if (!images.length) return "请上传主图与服饰参考图";
  const limit = stylingReferenceLimit(data.modelId, data.batchSize);
  if (images.length > limit) return `当前模型与生成数量最多支持 ${limit} 张参考图，请减少图片或更换模型`;
  if (!analysisValid || !data.analysisId) return "请先点击识别服饰";
  if (!data.preserve) return "请选择需要保留的服饰";
  if ((data.preserve === "whole" || data.preserve === "one-piece") && !data.prompt.trim() &&
    !STYLING_EXTRAS.some(({ id }) => data.extras[id] && !(id === "outerwear" && outerwearProtected))) {
    return "请选择至少一种搭配单品或填写补充要求";
  }
  return null;
}

import sharp, { type OverlayOptions } from "sharp";
import { parseDataUrl, toDataUrl } from "../providers/base";
import {
  multiImageReferenceError, planMultiImageReferences, MULTI_IMAGE_ROLE_LABELS,
} from "../../src/lib/multiImageTryOn";
import type { GenerationRequestSnapshot } from "./generationRecords";
import { withImageProcessingSlot } from "./imageProcessingLimit";
import { normalizeProviderImageDataUrl, PROVIDER_TARGET_BYTES, UPLOAD_MAX_INPUT_PIXELS } from "./uploadImageNormalization";
import { MAX_IMAGE_BYTES } from "./imageValidation";

/** Local PNG contact sheet: no AI call, no crop/stretch, EXIF-correct, bounded memory. */
export async function stitchReferenceImages(images: readonly string[]): Promise<string> {
  if (images.length === 1) return images[0];
  if (images.length < 2 || images.length > 11) throw new Error("参考图拼接数量无效");
  const encoded = await withImageProcessingSlot(async () => {
    const columns = Math.ceil(Math.sqrt(images.length));
    const rows = Math.ceil(images.length / columns);
    const cell = 1024;
    const gap = 24;
    const tiles: OverlayOptions[] = [];
    // Sequential decoding avoids retaining several full-size decoded uploads at once.
    for (const [index, image] of images.entries()) {
      const input = await sharp(parseDataUrl(image).buffer, { limitInputPixels: UPLOAD_MAX_INPUT_PIXELS, sequentialRead: true, failOn: "error" })
        .rotate().resize(cell, cell, { fit: "contain", background: "#ffffff", withoutEnlargement: true })
        .flatten({ background: "#ffffff" }).png().toBuffer();
      const { width = cell, height = cell } = await sharp(input).metadata();
      tiles.push({ input, left: (index % columns) * (cell + gap) + Math.floor((cell - width) / 2),
        top: Math.floor(index / columns) * (cell + gap) + Math.floor((cell - height) / 2) });
    }
    const buffer = await sharp({ create: { width: columns * cell + (columns - 1) * gap,
      height: rows * cell + (rows - 1) * gap, channels: 3, background: "#ffffff" } })
      .composite(tiles).png().toBuffer();
    if (buffer.length <= PROVIDER_TARGET_BYTES) return toDataUrl(buffer.toString("base64"), "image/png");
    // Bound the encoded sheet before the standard provider normalization gate.
    let compressed = await sharp(buffer).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
    while (compressed.length > MAX_IMAGE_BYTES) {
      const metadata = await sharp(compressed).metadata();
      const scale = Math.sqrt(MAX_IMAGE_BYTES / compressed.length) * 0.9;
      compressed = await sharp(compressed).resize({ width: Math.max(1, Math.floor(metadata.width! * scale)) })
        .jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
    }
    return toDataUrl(compressed.toString("base64"), "image/jpeg");
  });
  // The normalizer uses the same queue: invoke it only after releasing our slot.
  if (parseDataUrl(encoded).buffer.length <= PROVIDER_TARGET_BYTES) return encoded;
  const normalized = await normalizeProviderImageDataUrl(encoded);
  return toDataUrl(normalized.buffer.toString("base64"), normalized.mimeType);
}

export async function prepareMultiImageTryOn(
  images: string[], roles: string[], sources: string[], modelId: string,
) {
  if (images.length !== roles.length || sources.length !== roles.length) throw new Error("多图编辑参考图角色信息不完整");
  const error = multiImageReferenceError(roles);
  if (error) throw new Error(error);
  const groups = planMultiImageReferences(images.map((image, index) => ({ image, role: roles[index], source: sources[index] })), modelId);
  const referenceImages: string[] = [];
  const references: GenerationRequestSnapshot["references"] = [];
  const instructions: string[] = [];
  for (const group of groups) {
    referenceImages.push(await stitchReferenceImages(group.members.map(ref => ref.image)));
    const columns = Math.ceil(Math.sqrt(group.members.length));
    for (const [index, ref] of group.members.entries()) {
      const tile = group.members.length > 1 ? `拼图第${Math.floor(index / columns) + 1}行第${index % columns + 1}列` : "";
      const label = MULTI_IMAGE_ROLE_LABELS[ref.role];
      instructions.push(`参考图${group.number}${tile}：${label}。`);
      // Keep original owner-bound source refs; repeated numbers identify one contact sheet.
      references.push({ number: group.number, role: tile ? `${ref.role} (${tile})` : ref.role, image: ref.source });
    }
  }
  return { referenceImages, references, instructions: instructions.join("\n"),
    referenceRoles: groups.map(group => group.role), aspectReference: images[roles.indexOf("scene")] };
}

export function multiImageTryOnPrompt(referenceMap: string, extra: string, angleControlled: boolean): string {
  return [
    "执行一次多图编辑换装，直接输出完整成片；不是人物预合成、草稿或留待下一轮补细节的基准图。",
    "参考图1仅控制身体姿势、四肢动作与左右关系，不继承其人物身份、衣服和背景。参考图2锁定人物面部身份、发型与体型。参考图3锁定场景、光照和环境。",
    angleControlled ? "拍摄视角与构图遵循下方的3D视角指令；姿势图控制关节动作，但不覆盖3D视角。" : "拍摄视角、透视与构图结合场景和用户要求安排；保持姿势参考的动作与左右关系，不镜像。",
    "后续参考图按以下逐图、逐格对应关系提取服装、鞋袜与配饰，所有指定商品均应正确穿戴：",
    referenceMap,
    "拼图只是参考素材目录，不能照搬白底、网格、边框或拼贴布局到成片；不能把各格内容混成一个新物品，不复制参考商品中的模特身份。",
    "完整保留原始商品图中可见的版型、颜色、印花、纹理、针织组织、蕾丝、缝线、纽扣、五金、鞋袜结构和配饰形状。不得用概括性设计替代可见细节，不虚构不可见文字或工艺。",
    "只输出一张自然、写实、光照协调的穿搭成片，不输出多视图、素材板或对比图。后续局部修改仅在用户需要时单独执行，本轮不能以未来精修为由省略细节。",
    extra ? `用户补充要求（不能改变上述参考职责）：${extra}` : "",
  ].filter(Boolean).join("\n");
}

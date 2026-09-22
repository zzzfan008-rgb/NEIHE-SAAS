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

export function multiImageTryOnPrompt(referenceMap: string, extra: string, angleControlled: boolean, concise = false): string {
  return [
    "以参考图2中的人物为主体，创作一张自然写实的服装目录摄影照片，展示下方指定的服装和配饰。",
    "人物：以参考图2为人物外观依据，保持参考人物外观一致，保留自然肤质、发丝与面部细节，避免过度磨皮。人物图中的动作、服装与背景不作为对应角色的依据。",
    "动作：参照图1的身体朝向、头部朝向、视线、双臂位置、手部动作、双腿弯曲和前后关系；左右以图中画面方向为准。",
    "环境：采用图3的场景、光照和环境色彩，使人物和商品具有协调的光影与透视；不继承场景图中人物的动作、外观或服装。",
    angleControlled ? "拍摄视角与构图遵循下方的3D视角指令；姿势图控制关节动作，但不覆盖3D视角。保留身体动作、关节弯曲、手脚接触与承重关系，按指定相机投影，不把镜头变化理解为改变动作。" : "拍摄视角、透视与取景以图1姿势参考为准；保持姿势参考的动作与左右关系，不镜像。保持头身朝向、肩胯倾斜、关节弯曲、手脚接触、承重与前后遮挡关系；场景透视适配该视角，不用人物图或场景图的姿态替代。输出画幅不同时扩展环境，避免裁掉参考中可见的手脚。",
    "服装及配饰：按以下素材对应表展示商品的实际穿着效果：",
    referenceMap,
    referenceMap.includes("拼图第")
      ? "拼图各格按素材对应表分别提供商品参考；网格、边框和白底不进入成片。"
      : "每张参考图按素材对应表独立提供对应信息。",
    "完整保留原始商品图中可见的版型、颜色、印花、纹理、针织组织、蕾丝、缝线、纽扣、五金、鞋袜结构和配饰形状。不得用概括性设计替代可见细节，不虚构不可见文字或工艺。",
    concise ? "" : "按目标动作重建服装褶皱、接触阴影和自然遮挡，保持面料组织方向及印花比例；服装和配饰参考中的人物动作与背景不进入成片。",
    "输出一张完整的服装摄影照片，呈现指定服装及配饰的可见细节，不输出素材板或对比图。",
    extra ? `用户补充要求（不能改变上述参考职责）：${extra}` : "",
  ].filter(Boolean).join("\n");
}

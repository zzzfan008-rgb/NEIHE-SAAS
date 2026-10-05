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

const POSE_REFERENCE_MIN_LONG_EDGE = 2048;

/** 姿势参考是逐关节 1:1 锚点，放大到至少 2048 长边，避免在小图里被模型弱化。 */
async function upscalePoseReference(dataUrl: string): Promise<string> {
  return withImageProcessingSlot(async () => {
    const parsed = parseDataUrl(dataUrl);
    const metadata = await sharp(parsed.buffer, { limitInputPixels: UPLOAD_MAX_INPUT_PIXELS, failOn: "error" }).metadata();
    const longEdge = Math.max(metadata.width ?? 0, metadata.height ?? 0);
    if (longEdge >= POSE_REFERENCE_MIN_LONG_EDGE) return dataUrl;
    const buffer = await sharp(parsed.buffer)
      .rotate()
      .resize({ width: POSE_REFERENCE_MIN_LONG_EDGE, height: POSE_REFERENCE_MIN_LONG_EDGE, fit: "inside", withoutEnlargement: false })
      .jpeg({ quality: 92, chromaSubsampling: "4:4:4", mozjpeg: true })
      .toBuffer();
    return toDataUrl(buffer.toString("base64"), "image/jpeg");
  });
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
    const stitched = await stitchReferenceImages(group.members.map(ref => ref.image));
    referenceImages.push(group.role === "pose" && group.members.length === 1
      ? await upscalePoseReference(stitched)
      : stitched);
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

export function multiImageTryOnPrompt(referenceMap: string, extra: string, angleControlled: boolean, concise = false, poseReferenceType?: unknown, posePrompt?: unknown, posePromptMode?: unknown): string {
  const skeleton = poseReferenceType === "skeleton";
  const calibrated = posePromptMode === "three-view";
  const posePromptClause = typeof posePrompt === "string" && posePrompt.trim()
    ? calibrated
      ? `三图校准姿势约束：\n${posePrompt.trim()}`
      : `姿势补充描述（仅在图1无法判定的项目上参考）：${posePrompt.trim()}。身体朝向、肩髋倾斜、四肢弯曲、手脚位置与接触、双腿交叉与前后关系、重心与承重一律以图1可见几何为准；该文字中与图1可见几何冲突的部分全部忽略，"无法判断"表示该项没有约束。仅图1无法判定的头部旋转、俯仰、视线方向与面部神态才参考该文字。`
    : "";
  return [
    "以参考图2提供的人物造型基调，创作一位全新的原创模特，呈现下方指定的时尚服装摄影照片，展示指定的服装和配饰。",
    calibrated && posePromptClause
      ? `动作（最高优先级）：依据下方已完成三层校准的姿势方向呈现动作。关节二维位置按骨骼校准结论，四肢前后关系按深度校准结论，手部语义按原图结论。保持画面左右与动作接触关系，姿势、人物、服装、场景及相机指令共同形成完整成图。\n${posePromptClause}`
      : skeleton
      ? `动作（最高优先级）：可参照图1的骨架动作方向。${posePromptClause}按可见关键点与连线呈现人物动作：关键点的位置、连线方向与相对比例逐点对齐，包括肩髋倾斜、肘腕与膝踝弯曲、双手手指与双脚朝向、双腿弯曲与前后关系、重心与承重关系；左右沿用图中画面方向，动作方向优先于人物、场景、服装及相机视角，成图呈现自然人物摄影效果。`
      : `动作（最高优先级）：可参照图1的骨架动作方向。${posePromptClause}按照图1动作方向呈现身体朝向、头部朝向、肩髋倾斜、肩肘腕与髋膝踝位置、双臂与手部动作、双腿弯曲与前后关系、重心与承重关系；左右沿用画面方向，姿势、人物、场景、服装和相机共同形成完整画面。`,
    "人物：参考图2提供体型、发型方向、肤色基调与整体气质，生成全原创形象。",
    "环境：采用图3的场景、光照和环境色彩，使人物和商品具有协调的光影与透视；场景、人物与服装分别依据对应参考图呈现。",
    calibrated && posePromptClause
      ? (angleControlled
        ? '相机视角：仅调整观察角度与取景，保持上述校准姿势的关节、接触、承重和前后关系。'
        : '相机视角：参考图1取景，保持上述校准姿势；场景适配人物透视，输出画幅变化时扩展环境。')
      : angleControlled
      ? "相机视角：在图1动作方向基础上，追加下方3D视角指令描述的观察角度与取景；镜头调整保持动作接触、承重与前后关系，视角投影与动作方向协调。"
      : skeleton
        ? "拍摄视角、透视与取景以场景图与构图需要为准；按骨骼图呈现动作与左右关系，保持关节弯曲、手脚接触、承重与前后遮挡关系；场景透视适配该视角，完整呈现骨骼中可见的手脚。"
        : "拍摄视角、透视与取景以图1动作方向为准；保持头身朝向、肩胯倾斜、关节弯曲、手脚接触、承重与前后遮挡关系；场景透视适配该视角，人物图与场景图分别提供各自职责信息，完整呈现参考中可见的手脚。",
    "服装及配饰：按以下素材对应表展示商品的实际穿着效果：",
    referenceMap,
    referenceMap.includes("拼图第")
      ? "拼图各格按素材对应表分别提供商品参考；网格、边框和白底不进入成片。"
      : "每张参考图按素材对应表独立提供对应信息。",
    "完整呈现原始商品图中可见的版型、颜色、印花、纹理、针织组织、蕾丝、缝线、纽扣、五金、鞋袜结构和配饰形状；以素材中明确可见的细节为准，保持商品设计统一。",
    concise ? "" : "按目标动作重建服装褶皱、接触阴影和自然遮挡，保持面料组织方向及印花比例；服装和配饰参考中的人物动作与背景由对应角色参考提供，成片聚焦目标服装与配饰。",
    ...(concise ? [
      "真实摄影质感：真实自然肤质，完整保留毛孔、细小汗毛、肤色细微起伏、轻微雀斑、局部泛红、细小痘印、浅层纹理、轻微卡粉、极浅痘坑、眼下细纹、鼻翼与脸颊自然凹凸、嘴唇唇纹、少量碎发和发丝边缘；不进行磨皮或美颜处理，皮肤具有自然油脂高光与真实皮下质感。嘴唇及面部边缘拥有真实皮肤纹理，唇纹细腻自然。虹膜呈现复杂放射状纤维结构，瞳孔边缘锐利清晰，角膜拥有真实湿润反射，高光符合物理光学规律；睫毛粗细不一、排列自然；眉毛浓密且富有自然生长方向，保留少量凌乱眉毛。发丝真实自然，包含细碎发丝、绒毛与轻微飞发；人物面部结构符合真实人体解剖比例，呈现自然面部细节与真实摄影质感。细节服从当前拍摄距离、输出分辨率、景深与真实遮挡的尺度。",
    ] : [
      "真实摄影质感：以自然肤质和自然修饰度的服装摄影呈现人物，细节服从当前拍摄距离、输出分辨率、景深与真实遮挡。",
      "肌肤与嘴唇：真实自然肤质，完整保留毛孔、细小汗毛、肤色细微起伏、轻微雀斑、局部泛红、细小痘印、浅层纹理、轻微卡粉、极浅痘坑、眼下细纹、鼻翼与脸颊自然凹凸；不进行磨皮或美颜处理，皮肤具有自然油脂高光与真实皮下质感。嘴唇及面部边缘拥有真实皮肤纹理，唇纹细腻自然。",
      "眼睛与眉睫：虹膜呈现复杂放射状纤维结构，瞳孔边缘锐利清晰，角膜拥有真实湿润反射，高光符合物理光学规律；睫毛粗细不一、排列自然；眉毛浓密且富有自然生长方向，保留少量凌乱眉毛。",
      "发丝与结构：发丝真实自然，包含细碎发丝、绒毛与轻微飞发，保留发丝边缘；人物面部结构符合真实人体解剖比例，呈现自然肌肤、真实发丝和自然面部层次，保持真实摄影质感。",
    ]),
    "内容边界：仅展示原创服装与配饰的原创造型。",
    "输出一张完整的服装摄影照片，呈现指定服装及配饰的可见细节，不输出素材板或对比图。",
    extra ? `用户补充要求（遵循上述参考职责）：${extra}` : "",
  ].filter(Boolean).join("\n");
}

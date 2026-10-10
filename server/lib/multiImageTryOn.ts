import { TRY_ON_NEGATIVE_CONSTRAINTS, TRY_ON_OUTFIT_REFERENCE_EXCLUSIONS, TRY_ON_PHOTOGRAPHIC_REALISM, TRY_ON_POSE_REFERENCE_EXCLUSIONS } from "./tryOnRealism";
import sharp, { type OverlayOptions } from "sharp";
import { parseDataUrl, toDataUrl } from "../providers/base";
import {
  multiImageReferenceError, planMultiImageReferences, MULTI_IMAGE_ROLE_LABELS,
} from "../../src/lib/multiImageTryOn";
import type { GenerationRequestSnapshot } from "./generationRecords";
import { withImageProcessingSlot } from "./imageProcessingLimit";
import { normalizeProviderImageDataUrl, PROVIDER_TARGET_BYTES, UPLOAD_MAX_INPUT_PIXELS } from "./uploadImageNormalization";
import { MAX_IMAGE_BYTES } from "./imageValidation";
import { isCalibratedPoseSupplement, isSequentialPosePrompt } from "../../src/types/poseReference";

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

export function multiImageTryOnPrompt(referenceMap: string, extra: string, angleControlText: string | undefined, concise = false, poseReferenceType?: unknown, posePrompt?: unknown, posePromptMode?: unknown, posePromptVerified?: unknown): string {
  const skeleton = poseReferenceType === "skeleton";
  const calibrated = posePromptMode === "three-view";
  const sequential = calibrated && posePromptVerified === true && isSequentialPosePrompt(posePrompt);
  const poseText = typeof posePrompt === "string" ? posePrompt.trim() : "";
  // The header carries validation/editing state, not instructions for image generation.
  const sequentialPoseBody = sequential
    ? poseText.split("\n").map(line => line.trim()).filter(Boolean).slice(1).join("\n")
    : "";
  const posePromptClause = poseText
    ? calibrated
      ? posePromptVerified === true && isCalibratedPoseSupplement(posePrompt)
        ? `三图校准补充（从属约束）：\n${poseText.replace('三图校准补充（仅补充图1不可见关系）', '三图校准补充（仅补充图3不可见关系）')}`
        : ""
      : `姿势补充描述（仅在图3无法判定的项目上参考）：${poseText}。身体朝向、肩髋倾斜、四肢弯曲、手脚位置与接触、双腿交叉与前后关系、重心与承重一律以图3可见几何为准；该文字中与图3可见几何冲突的部分全部忽略，"无法判断"表示该项没有约束。仅图3无法判定的头部旋转、俯仰、视线方向与面部神态才参考该文字。`
    : "";
  const action = calibrated && !sequential
    ? `动作：参考图3可见人体几何是最高优先级，按照图3呈现身体朝向、肩髋倾斜、关节弯曲、手脚位置、双腿交叉、重心与承重。校准文字仅补充图3无法直接判定的前后深度、手部接触、视线与面部神态；任何文字与图3可见几何冲突时均以图3为准。${posePromptClause ? `\n${posePromptClause}` : ""}`
    : skeleton && !sequential
      ? `动作：参照图3的骨架动作方向。${posePromptClause}按可见关键点与连线呈现人物动作：关键点的位置、连线方向与相对比例逐点对齐，包括肩髋倾斜、肘腕与膝踝弯曲、双手手指与双脚朝向、双腿弯曲与前后关系、重心与承重关系；左右沿用图中画面方向，动作方向优先于人物、场景、服装及相机视角，成图呈现自然人物摄影效果。`
      : `动作：参照图3的骨架动作方向。${posePromptClause}按照图3动作方向呈现身体朝向、头部朝向、肩髋倾斜、肩肘腕与髋膝踝位置、双臂与手部动作、双腿弯曲与前后关系、重心与承重关系；左右沿用画面方向，姿势、人物、场景、服装和相机共同形成完整画面。${sequentialPoseBody ? `\n${sequentialPoseBody}` : ""}`;
  const camera = angleControlText
    ? `相机视角：在图3动作方向基础上，按下方3D视角指令调整观察角度与取景；镜头调整保持动作接触、承重与前后关系，视角投影与动作方向协调。\n${angleControlText}`
    : calibrated && !sequential
      ? "相机视角：参考图3取景并保持图3姿势几何；场景适配人物透视，输出画幅变化时扩展环境。"
      : skeleton && !sequential
        ? "拍摄视角、透视与取景以场景图与构图需要为准；按骨骼图呈现动作与左右关系，保持关节弯曲、手脚接触、承重与前后遮挡关系；场景透视适配该视角，完整呈现骨骼中可见的手脚。"
        : "拍摄视角、透视与取景以图3动作方向为准；保持头身朝向、肩胯倾斜、关节弯曲、手脚接触、承重与前后遮挡关系；场景透视适配该视角，人物图与场景图分别提供各自职责信息，完整呈现参考中可见的手脚。";
  return [
    "以参考图1提供的人物造型基调，创作一位全新的原创模特，呈现下方指定的时尚服装摄影照片。人物：根据参考图1提供的体型、发型方向、肤色基调与整体气质，生成全原创形象。所有左右均为画面方向。",
    "服装及配饰：按以下素材对应表展示商品的实际穿着效果：",
    referenceMap,
    referenceMap.includes("拼图第")
      ? "拼图各格按素材对应表分别提供商品参考；网格、边框和白底不进入成片。"
      : "",
    "服装职责：主穿搭参考提供成片整套服装，其中清晰可见的上装、下装、内外搭层次、穿着方式与上下装比例均按主穿搭呈现，替换参考图1人物对应部位的原有穿着；参考图1仅提供人物体型、发型、肤色与气质基调，其穿着的服装仅在主穿搭未覆盖的部位保留。",
    TRY_ON_OUTFIT_REFERENCE_EXCLUSIONS,
    TRY_ON_POSE_REFERENCE_EXCLUSIONS,
    action,
    "环境：采用图4的场景、光照和图4的环境色彩，使人物和商品具有协调的光影与透视；",
    TRY_ON_PHOTOGRAPHIC_REALISM,
    camera,
    "完整呈现原始商品图中可见的版型、颜色、印花、纹理、针织组织、蕾丝、缝线、纽扣、五金、鞋袜结构和配饰形状；以素材中明确可见的细节为准，保持商品设计统一。",
    concise ? "" : "按目标动作重建服装褶皱、接触阴影和自然遮挡，保持面料组织方向及印花比例；服装和配饰参考中的人物动作与背景由对应角色参考提供，成片聚焦目标服装与配饰。",
    "内容边界：仅展示原创服装与配饰的原创造型。",
    "输出一张完整的服装摄影照片，呈现指定服装及配饰的可见细节，不输出素材板或对比图。",
    extra ? `用户补充要求（遵循上述参考职责）：${extra}` : "",
    TRY_ON_NEGATIVE_CONSTRAINTS,
  ].filter(Boolean).join("\n");
}

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

export function multiImageTryOnPrompt(referenceMap: string, extra: string, angleControlled: boolean, concise = false, poseReferenceType?: unknown, posePrompt?: unknown): string {
  const skeleton = poseReferenceType === "skeleton";
  const posePromptClause = typeof posePrompt === "string" && posePrompt.trim()
    ? `用户确认的姿势描述：${posePrompt.trim()}。肢体关节位置、弯曲、前后与承重以图1可见几何为准；头部旋转、俯仰、视线方向与面部神态以文字描述为准（骨骼关键点只给出头部中心位置，不表达旋转与俯仰）。`
    : "";
  return [
    "以参考图2提供的人物造型基调，创作一位原创虚构模特的时尚服装摄影照片，展示下方指定的服装和配饰。人物为原创虚构角色或已获授权的模特形象，不代表、不映射任何真实在世或已故个人、公众人物或知名 IP 角色。",
    skeleton
      ? `动作（最高优先级）：图1是DWPose骨骼图，是唯一姿势锚点。${posePromptClause}按可见关键点与连线1:1复刻人物动作：每个关键点的位置、连线方向与相对比例逐点对齐，包括肩髋倾斜、肘腕与膝踝弯曲、双手手指与双脚朝向、双腿弯曲与前后关系、重心与承重关系；左右以图中画面方向为准，严禁左右镜像翻转：参考图画面左侧的关节与肢体在成图中必须仍在画面左侧。本动作约束优先于人物、场景、服装及任何相机视角指令，后续相机视角描述只在其基础上调整观察角度，不得改变上述关节动作。缺失关键点不作为约束，不从线条推断视线、表情、体型或精确前后深度，不自行摆正躯干或拉直四肢。骨骼线条与关键点不得渲染到成图。`
      : `动作（最高优先级）：图1是唯一姿势锚点。${posePromptClause}逐关节1:1复刻图1的动作：身体朝向、头部朝向、肩髋倾斜、肩肘腕与髋膝踝位置、双臂与手部动作、双腿弯曲与前后关系、重心与承重关系；左右以图中画面方向为准，严禁左右镜像翻转：参考图画面左侧的肢体与朝向在成图中必须仍在画面左侧；不自行摆正躯干或拉直四肢。本动作约束优先于人物、场景、服装及任何相机视角指令，后续相机视角描述只在其基础上调整观察角度，不得改变上述关节动作。图1中的人物身份、五官、面部特征、体型、发型、服装、鞋履、配饰与背景一律禁止进入成片，不得用图1的外貌或身材替代图2的人物。`,
    "人物：参考图2仅提供体型、发型方向、肤色基调与整体气质的造型参考，生成自然、风格化的人物形象；不复制参考图中任何真实可识别个人的五官结构、面部特征或身份标识，避免照片级真人身份复刻。人物图中的动作、服装与背景不作为对应角色的依据。",
    "环境：采用图3的场景、光照和环境色彩，使人物和商品具有协调的光影与透视；不继承场景图中人物的动作、外观或服装。",
    angleControlled
      ? "相机视角：在已逐关节1:1复刻的图1姿势基础上，追加下方3D视角指令描述的观察角度与取景；只调整镜头，不改变已复刻的关节动作、手脚接触、承重与前后关系。若视角投影使表面观感与关节动作冲突，以关节动作的真实关系为准，不把镜头变化理解为改变动作。"
      : skeleton
        ? "拍摄视角、透视与取景以场景图与构图需要为准；按骨骼图保持动作与左右关系，不镜像、不自行摆正或拉直四肢。保持关节弯曲、手脚接触、承重与前后遮挡关系；场景透视适配该视角，不用人物图或场景图的姿态替代。输出画幅不同时扩展环境，避免裁掉骨骼中可见的手脚。"
        : "拍摄视角、透视与取景以图1姿势参考为准；保持姿势参考的动作与左右关系，不镜像。保持头身朝向、肩胯倾斜、关节弯曲、手脚接触、承重与前后遮挡关系；场景透视适配该视角，不用人物图或场景图的姿态替代。输出画幅不同时扩展环境，避免裁掉参考中可见的手脚。",
    "服装及配饰：按以下素材对应表展示商品的实际穿着效果：",
    referenceMap,
    referenceMap.includes("拼图第")
      ? "拼图各格按素材对应表分别提供商品参考；网格、边框和白底不进入成片。"
      : "每张参考图按素材对应表独立提供对应信息。",
    "完整保留原始商品图中可见的版型、颜色、印花、纹理、针织组织、蕾丝、缝线、纽扣、五金、鞋袜结构和配饰形状。不得用概括性设计替代可见细节，不虚构不可见文字或工艺。",
    concise ? "" : "按目标动作重建服装褶皱、接触阴影和自然遮挡，保持面料组织方向及印花比例；服装和配饰参考中的人物动作与背景不进入成片。",
    "内容边界：本图仅用于原创服装与配饰展示。人物保持虚构或风格化处理，不呈现为可识别的真实个人、公众人物或知名 IP 角色；服装与配饰按素材还原设计细节，不带入任何真实品牌标识、商标、可读文字、水印或证件票据信息。",
    "输出一张完整的服装摄影照片，呈现指定服装及配饰的可见细节，不输出素材板或对比图。",
    extra ? `用户补充要求（不能改变上述参考职责）：${extra}` : "",
  ].filter(Boolean).join("\n");
}

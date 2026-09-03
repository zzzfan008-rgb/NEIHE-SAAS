import sharp from "sharp";
import { ProviderError, toDataUrl } from "../providers/base";
import { withImageProcessingSlot } from "./imageProcessingLimit";
import { validateImageDataUrl } from "./imageValidation";
import {
  adaptiveMaskExpansionRadius,
  adaptiveMaskFeatherRadius,
} from "../../src/lib/maskGeometry";

export const MAX_GPT_IMAGE_MASK_BYTES = 4 * 1024 * 1024;
const MAX_MASK_PIXELS = 40_000_000;
const GPT_IMAGE_SIZE_MULTIPLE = 16;
const GPT_IMAGE_MAX_SIDE = 3840;
const GPT_IMAGE_MIN_PIXELS = 655_360;
const GPT_IMAGE_MAX_PIXELS = 8_294_400;
const GPT_IMAGE_MAX_ASPECT_RATIO = 3;

export interface ValidatedMaskPair {
  sourceBuffer: Buffer;
  maskBuffer: Buffer;
  width: number;
  height: number;
}

export interface PreparedMaskGeneration {
  mask: string;
  /** 最后一张参考图：不透出旧内容的红色核心 + 金色轮廓延展缓冲区。 */
  guide: string;
  size: string;
  width: number;
  height: number;
  expansionRadius: number;
  featherRadius: number;
}

interface MaskCompositeGeometry {
  coreAlpha: Buffer;
  innerAlpha: Buffer;
  outerAlpha: Buffer;
  blendAlpha: Buffer;
  expansionRadius: number;
  featherRadius: number;
}

/**
 * GPT Image 2 的输出尺寸必须是 16 的倍数，并落在文档规定的像素与比例范围内。
 * 在全部合法候选中选择最接近原图比例和像素量的一档；合法原图会原尺寸直出。
 */
export function maskGenerationDimensions(width: number, height: number): { width: number; height: number } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new ProviderError("原图尺寸无效，无法准备蒙版生成", 400, "gpt-image-2", "invalid_request");
  }
  const sourceAspect = width / height;
  const symmetricAspect = Math.max(sourceAspect, 1 / sourceAspect);
  if (symmetricAspect > GPT_IMAGE_MAX_ASPECT_RATIO) {
    throw new ProviderError(
      "原图宽高比超过蒙版模型支持范围，请先裁剪至 3:1 以内",
      400, "gpt-image-2", "invalid_request",
    );
  }
  const desiredPixels = Math.min(GPT_IMAGE_MAX_PIXELS, Math.max(GPT_IMAGE_MIN_PIXELS, width * height));
  let best: { width: number; height: number; score: number } | undefined;
  for (
    let candidateWidth = GPT_IMAGE_SIZE_MULTIPLE;
    candidateWidth <= GPT_IMAGE_MAX_SIDE;
    candidateWidth += GPT_IMAGE_SIZE_MULTIPLE
  ) {
    const candidateHeight = Math.round(candidateWidth / sourceAspect / GPT_IMAGE_SIZE_MULTIPLE)
      * GPT_IMAGE_SIZE_MULTIPLE;
    if (candidateHeight < GPT_IMAGE_SIZE_MULTIPLE || candidateHeight > GPT_IMAGE_MAX_SIDE) continue;
    const pixels = candidateWidth * candidateHeight;
    if (pixels < GPT_IMAGE_MIN_PIXELS || pixels > GPT_IMAGE_MAX_PIXELS) continue;
    const candidateAspect = Math.max(candidateWidth / candidateHeight, candidateHeight / candidateWidth);
    if (candidateAspect > GPT_IMAGE_MAX_ASPECT_RATIO) continue;
    const aspectError = Math.abs(Math.log((candidateWidth / candidateHeight) / sourceAspect));
    const pixelError = Math.abs(Math.log(pixels / desiredPixels));
    const score = aspectError * 100 + pixelError;
    if (!best || score < best.score) best = { width: candidateWidth, height: candidateHeight, score };
  }
  if (!best) {
    throw new ProviderError("找不到可安全映射的蒙版输出尺寸", 400, "gpt-image-2", "invalid_request");
  }
  return { width: best.width, height: best.height };
}

const SHARP_MASK_INPUT = {
  animated: false,
  failOn: "error" as const,
  limitInputPixels: MAX_MASK_PIXELS,
};

async function editableAlpha(
  pair: ValidatedMaskPair,
  options: {
    expansionRadius?: number;
    featherSigma?: number;
    harden?: boolean;
  } = {},
): Promise<Buffer> {
  const radius = options.expansionRadius ?? 0;
  let protectedAlpha = await sharp(pair.maskBuffer, SHARP_MASK_INPUT)
    .extractChannel("alpha")
    .toColourspace("b-w")
    .raw()
    .toBuffer();
  if (radius > 0) {
    // libvips 的 dilate 在这里扩张 Alpha 中的暗色区域；先处理受保护 Alpha，
    // 再反相为编辑权重，才能得到向外扩张的透明编辑区。
    protectedAlpha = await sharp(protectedAlpha, {
      raw: { width: pair.width, height: pair.height, channels: 1 },
    })
      .dilate(radius)
      .toColourspace("b-w")
      .raw()
      .toBuffer();
  }
  let editAlpha = Buffer.allocUnsafe(protectedAlpha.length);
  for (let index = 0; index < protectedAlpha.length; index += 1) {
    editAlpha[index] = 255 - protectedAlpha[index];
  }
  if (options.harden) {
    for (let index = 0; index < editAlpha.length; index += 1) {
      editAlpha[index] = editAlpha[index] >= 128 ? 255 : 0;
    }
  }
  const sigma = options.featherSigma ?? 0;
  if (sigma > 0) {
    editAlpha = await sharp(editAlpha, {
      raw: { width: pair.width, height: pair.height, channels: 1 },
    })
      .blur(sigma)
      .toColourspace("b-w")
      .raw()
      .toBuffer();
  }
  return editAlpha;
}

function selectionExtent(alpha: Buffer, width: number, height: number): { width: number; height: number } {
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let index = 0; index < alpha.length; index += 1) {
    if (alpha[index] <= 12) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  return right >= left && bottom >= top
    ? { width: right - left + 1, height: bottom - top + 1 }
    : { width: 1, height: 1 };
}

async function maskCompositeGeometry(pair: ValidatedMaskPair): Promise<MaskCompositeGeometry> {
  const coreAlpha = await editableAlpha(pair, { expansionRadius: 0 });
  const extent = selectionExtent(coreAlpha, pair.width, pair.height);
  const expansionRadius = adaptiveMaskExpansionRadius(pair.width, pair.height, extent);
  const featherRadius = adaptiveMaskFeatherRadius(pair.width, pair.height, expansionRadius);
  const innerAlpha = expansionRadius > 0
    ? await editableAlpha(pair, { expansionRadius, harden: true })
    : Buffer.from(coreAlpha);
  const outerAlpha = featherRadius > 0
    ? await editableAlpha(pair, { expansionRadius: expansionRadius + featherRadius, harden: true })
    : Buffer.from(innerAlpha);
  if (featherRadius <= 0) {
    return {
      coreAlpha,
      innerAlpha,
      outerAlpha,
      blendAlpha: Buffer.from(innerAlpha),
      expansionRadius,
      featherRadius,
    };
  }
  const blurredInner = await sharp(innerAlpha, {
    raw: { width: pair.width, height: pair.height, channels: 1 },
  })
    .blur(Math.max(0.8, featherRadius / 1.5))
    .toColourspace("b-w")
    .raw()
    .toBuffer();
  const blendAlpha = Buffer.allocUnsafe(coreAlpha.length);
  for (let index = 0; index < blendAlpha.length; index += 1) {
    blendAlpha[index] = innerAlpha[index] >= 128
      ? 255
      : outerAlpha[index] >= 128
        ? Math.max(coreAlpha[index], blurredInner[index])
        : 0;
  }
  return { coreAlpha, innerAlpha, outerAlpha, blendAlpha, expansionRadius, featherRadius };
}

async function rgbaMaskFromAlpha(
  alpha: Buffer,
  width: number,
  height: number,
  invert = false,
): Promise<Buffer> {
  const alphaBuffer = invert ? Buffer.allocUnsafe(alpha.length) : alpha;
  if (invert) {
    for (let index = 0; index < alpha.length; index += 1) {
      alphaBuffer[index] = 255 - alpha[index];
    }
  }
  return sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .joinChannel(alphaBuffer, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

async function maskRegionGuide(
  source: Buffer,
  geometry: MaskCompositeGeometry,
  width: number,
  height: number,
): Promise<Buffer> {
  const overlay = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    const core = geometry.coreAlpha[index];
    const inner = geometry.innerAlpha[index];
    const outer = geometry.outerAlpha[index];
    if (core > 12) {
      overlay[offset] = 239;
      overlay[offset + 1] = 68;
      overlay[offset + 2] = 68;
      // 核心只表达“这里需要修改”，不得继续把旧物轮廓、旧阴影或旧颜色
      // 作为视觉参考喂给模型；完整原图仍由参考图 1 提供上下文。
      overlay[offset + 3] = 255;
    } else if (inner > 12) {
      overlay[offset] = 245;
      overlay[offset + 1] = 158;
      overlay[offset + 2] = 11;
      overlay[offset + 3] = 92;
    } else if (outer > 12) {
      overlay[offset] = 245;
      overlay[offset + 1] = 158;
      overlay[offset + 2] = 11;
      overlay[offset + 3] = 48;
    }
  }
  return sharp(source, SHARP_MASK_INPUT)
    .ensureAlpha()
    .composite([{ input: overlay, raw: { width, height, channels: 4 }, blend: "over" }])
    .png()
    .toBuffer();
}

export async function validateMaskForSource(
  sourceDataUrl: string,
  maskDataUrl: string,
  providerId = "gpt-image-2",
): Promise<ValidatedMaskPair> {
  const source = validateImageDataUrl(sourceDataUrl);
  const mask = validateImageDataUrl(maskDataUrl, MAX_GPT_IMAGE_MASK_BYTES);
  if (mask.mime !== "image/png") {
    throw new ProviderError("蒙版必须是 PNG 图片", 400, providerId, "invalid_request");
  }

  return withImageProcessingSlot(async () => {
    const sourceMeta = await sharp(source.buffer, {
      animated: false, failOn: "error", limitInputPixels: MAX_MASK_PIXELS,
    }).metadata();
    const maskImage = sharp(mask.buffer, {
      animated: false, failOn: "error", limitInputPixels: MAX_MASK_PIXELS,
    });
    const maskMeta = await maskImage.metadata();
    if (!sourceMeta.width || !sourceMeta.height || !maskMeta.width || !maskMeta.height) {
      throw new ProviderError("无法读取原图或蒙版尺寸", 400, providerId, "invalid_request");
    }
    if (sourceMeta.width !== maskMeta.width || sourceMeta.height !== maskMeta.height) {
      throw new ProviderError(
        `蒙版尺寸必须与原图完全一致（原图 ${sourceMeta.width}x${sourceMeta.height}，蒙版 ${maskMeta.width}x${maskMeta.height}）`,
        400, providerId, "invalid_request",
      );
    }
    if (!maskMeta.hasAlpha) {
      throw new ProviderError("蒙版 PNG 必须包含 Alpha 通道", 400, providerId, "invalid_request");
    }
    const alphaPixels = await maskImage.extractChannel("alpha").raw().toBuffer();
    let minAlpha = 255;
    let maxAlpha = 0;
    for (const value of alphaPixels) {
      minAlpha = Math.min(minAlpha, value);
      maxAlpha = Math.max(maxAlpha, value);
    }
    if (minAlpha === 255) {
      throw new ProviderError("蒙版没有可编辑区域，请先涂抹需要修改的位置", 400, providerId, "invalid_request");
    }
    if (maxAlpha === 0) {
      throw new ProviderError("蒙版覆盖了整张图片，请保留不需要修改的区域", 400, providerId, "invalid_request");
    }
    return {
      sourceBuffer: source.buffer,
      maskBuffer: mask.buffer,
      width: sourceMeta.width,
      height: sourceMeta.height,
    };
  });
}

/**
 * 给模型使用的蒙版比用户核心选区略宽，避免新内容在核心边缘被硬截断。
 * 返回值仍保持 GPT Image 的“透明处可编辑、白色不透明处保留”契约。
 */
export async function prepareMaskForGeneration(
  sourceDataUrl: string,
  maskDataUrl: string,
): Promise<PreparedMaskGeneration> {
  const pair = await validateMaskForSource(sourceDataUrl, maskDataUrl);
  const dimensions = maskGenerationDimensions(pair.width, pair.height);
  const geometry = await withImageProcessingSlot(() => maskCompositeGeometry(pair));
  // 模型获得完整的“核心 + 延展 + 外圈融合”区域；用户涂抹区不会成为硬裁切边界。
  const providerMask = await withImageProcessingSlot(() => (
    rgbaMaskFromAlpha(geometry.outerAlpha, pair.width, pair.height, true)
  ));
  const guide = await withImageProcessingSlot(() => (
    maskRegionGuide(pair.sourceBuffer, geometry, pair.width, pair.height)
  ));
  return {
    mask: toDataUrl(providerMask.toString("base64"), "image/png"),
    guide: toDataUrl(guide.toString("base64"), "image/png"),
    size: `${dimensions.width}x${dimensions.height}`,
    ...dimensions,
    expansionRadius: geometry.expansionRadius,
    featherRadius: geometry.featherRadius,
  };
}

function histogramQuantile(histogram: Uint32Array, count: number, quantile: number, offset = 0): number {
  if (count <= 0) return 0;
  const target = Math.max(1, Math.ceil(count * quantile));
  let seen = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    seen += histogram[index];
    if (seen >= target) return index - offset;
  }
  return histogram.length - 1 - offset;
}

function farFieldCorrection(
  source: Buffer,
  generated: Buffer,
  outerAlpha: Buffer,
): [number, number, number] {
  const channelHistograms = [new Uint32Array(511), new Uint32Array(511), new Uint32Array(511)];
  const pixelCount = outerAlpha.length;
  const stride = Math.max(1, Math.ceil(pixelCount / 50_000));
  let samples = 0;
  for (let index = 0; index < pixelCount; index += stride) {
    if (outerAlpha[index] !== 0) continue;
    const offset = index * 4;
    if (source[offset + 3] < 16 || generated[offset + 3] < 16) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      channelHistograms[channel][generated[offset + channel] - source[offset + channel] + 255] += 1;
    }
    samples += 1;
  }
  return channelHistograms.map((histogram) => (
    histogramQuantile(histogram, samples, 0.5, 255)
  )) as [number, number, number];
}

function correctedChannel(value: number, drift: number): number {
  return Math.max(0, Math.min(255, value - drift));
}

async function unifiedGeneratedLayer(
  source: Buffer,
  generated: Buffer,
  geometry: MaskCompositeGeometry,
  width: number,
  height: number,
): Promise<Buffer> {
  const drift = farFieldCorrection(source, generated, geometry.outerAlpha);
  const layer = Buffer.alloc(width * height * 4);
  let replacementWeight = 0;
  let generatedReplacementAlpha = 0;
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    const correctedRed = correctedChannel(generated[offset], drift[0]);
    const correctedGreen = correctedChannel(generated[offset + 1], drift[1]);
    const correctedBlue = correctedChannel(generated[offset + 2], drift[2]);
    const coreMix = geometry.coreAlpha[index] / 255;
    // 核心区必须忠实采用模型的新内容；远场校色只用于防止外围底色漂移。
    layer[offset] = Math.round(generated[offset] * coreMix + correctedRed * (1 - coreMix));
    layer[offset + 1] = Math.round(generated[offset + 1] * coreMix + correctedGreen * (1 - coreMix));
    layer[offset + 2] = Math.round(generated[offset + 2] * coreMix + correctedBlue * (1 - coreMix));
    layer[offset + 3] = Math.round(geometry.blendAlpha[index] * generated[offset + 3] / 255);
    replacementWeight += geometry.innerAlpha[index];
    generatedReplacementAlpha += geometry.innerAlpha[index] * generated[offset + 3];
  }
  if (replacementWeight > 0 && generatedReplacementAlpha / replacementWeight < 250) {
    throw new ProviderError(
      "AI 返回的完整修改区仍有透明缺口，已保留原图；请重试",
      502, "gpt-image-2", "invalid_response",
    );
  }
  return sharp(layer, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/**
 * 用户蒙版是修改意图核心，不是裁切框：核心外保留全强度延展区，最外圈再羽化回原图。
 * 核心与完整延展区采用连续局部画面，清除冲突旧内容并只在最外圈羽化回原图。
 */
export async function compositeMaskedEdit(
  sourceDataUrl: string,
  maskDataUrl: string,
  generatedDataUrl: string,
): Promise<string> {
  const pair = await validateMaskForSource(sourceDataUrl, maskDataUrl);
  const generated = validateImageDataUrl(generatedDataUrl);
  return withImageProcessingSlot(async () => {
    const generatedImage = sharp(generated.buffer, {
      animated: false, failOn: "error", limitInputPixels: MAX_MASK_PIXELS,
    });
    const generatedMeta = await generatedImage.metadata();
    if (!generatedMeta.width || !generatedMeta.height) {
      throw new ProviderError("无法读取 AI 返回图片尺寸", 502, "gpt-image-2", "invalid_response");
    }
    // 输出以整幅画面为坐标系映射回源图；供应商返回尺寸不同不再把修改区当裁切框。
    const alignedGenerated = generatedMeta.width === pair.width && generatedMeta.height === pair.height
      ? await generatedImage.ensureAlpha().raw().toBuffer()
      : await sharp(generated.buffer, SHARP_MASK_INPUT)
        .resize({ width: pair.width, height: pair.height, fit: "fill" })
        .ensureAlpha()
        .raw()
        .toBuffer();
    const source = await sharp(pair.sourceBuffer, SHARP_MASK_INPUT).ensureAlpha().raw().toBuffer();
    const geometry = await maskCompositeGeometry(pair);
    const generatedLayer = await unifiedGeneratedLayer(
      source, alignedGenerated, geometry, pair.width, pair.height,
    );
    const output = await sharp(pair.sourceBuffer)
      .ensureAlpha()
      .composite([{ input: generatedLayer, blend: "over" }])
      .png()
      .toBuffer();
    return toDataUrl(output.toString("base64"), "image/png");
  });
}

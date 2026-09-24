import sharp, { type Metadata, type OutputInfo } from "sharp";
import contracts from "../../docs/ai/apiyi/model-contracts.json";
import { withImageProcessingSlot } from "./imageProcessingLimit";
import { ImageValidationError, validateImageDataUrl } from "./imageValidation";
import { ProviderError, toDataUrl } from "../providers/base";

const inputContract = contracts.inputNormalization;
const uploadContract = contracts.uploadStorage;

export const UPLOAD_MAX_INPUT_BYTES = inputContract.maxInputBytes;
export const UPLOAD_MAX_INPUT_PIXELS = inputContract.maxInputPixels;
export const UPLOAD_MAX_LONG_EDGE = inputContract.maxLongEdge;
export const PROVIDER_TARGET_BYTES = inputContract.targetBytes;
export const UPLOAD_COMPRESSION_THRESHOLD_BYTES = uploadContract.preserveAtOrBelowBytes;
export const UPLOAD_COMPRESSED_TARGET_BYTES = uploadContract.compressAboveBytesTo;
export const UPLOAD_JPEG_QUALITY = inputContract.jpegQuality.initial;
export const UPLOAD_MIN_JPEG_QUALITY = inputContract.jpegQuality.minimum;

const MIN_SHRINK_LONG_EDGE = 256;
const SHARP_INPUT_OPTIONS = {
  animated: false,
  failOn: "error" as const,
  limitInputPixels: UPLOAD_MAX_INPUT_PIXELS,
  sequentialRead: true,
};

export type NormalizedUploadMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface NormalizedUploadImage {
  buffer: Buffer;
  mimeType: NormalizedUploadMime;
  width: number;
  height: number;
  byteLength: number;
  normalized: true;
}

interface EncodedImage {
  buffer: Buffer;
  info: OutputInfo;
}

function orientedDimensions(metadata: Metadata): { width: number; height: number } {
  if (!metadata.width || !metadata.height) {
    throw new ImageValidationError("无法读取图片尺寸，请换一张标准 PNG、JPEG、WebP 或 GIF 图片");
  }
  if (metadata.width * metadata.height > UPLOAD_MAX_INPUT_PIXELS) {
    throw new ImageValidationError(
      `图片像素过大（最多 ${UPLOAD_MAX_INPUT_PIXELS.toLocaleString("en-US")} 像素），请缩小后重试`,
    );
  }
  const swapsAxes = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
  return swapsAxes
    ? { width: metadata.height, height: metadata.width }
    : { width: metadata.width, height: metadata.height };
}

function dimensionsWithinLongEdge(width: number, height: number): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= UPLOAD_MAX_LONG_EDGE) return { width, height };
  const scale = UPLOAD_MAX_LONG_EDGE / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function smallerDimensions(
  width: number,
  height: number,
  encodedBytes: number,
  targetBytes: number,
): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= MIN_SHRINK_LONG_EDGE) {
    throw new ImageValidationError("图片内容过于复杂，压缩后仍超过目标体积，请先裁剪图片后重试");
  }
  const estimated = Math.sqrt(targetBytes / Math.max(encodedBytes, 1)) * 0.96;
  const scale = Math.max(0.5, Math.min(0.9, estimated));
  const next = {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
  if (next.width === width && next.height === height) {
    return width >= height
      ? { width: width - 1, height }
      : { width, height: height - 1 };
  }
  return next;
}

function pipeline(buffer: Buffer, width: number, height: number) {
  return sharp(buffer, SHARP_INPUT_OPTIONS)
    .rotate()
    .resize({ width, height, fit: "fill" })
    .toColourspace("srgb");
}

async function encodeJpeg(buffer: Buffer, width: number, height: number, quality: number): Promise<EncodedImage> {
  const result = await pipeline(buffer, width, height)
    .flatten({ background: "#ffffff" })
    .jpeg({ quality, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { buffer: result.data, info: result.info };
}

async function encodeOpaqueWithinLimit(
  buffer: Buffer,
  initialWidth: number,
  initialHeight: number,
  targetBytes: number,
): Promise<EncodedImage> {
  let width = initialWidth;
  let height = initialHeight;
  for (;;) {
    const high = await encodeJpeg(buffer, width, height, UPLOAD_JPEG_QUALITY);
    if (high.buffer.byteLength <= targetBytes) return high;

    const low = await encodeJpeg(buffer, width, height, UPLOAD_MIN_JPEG_QUALITY);
    if (low.buffer.byteLength <= targetBytes) {
      let best = low;
      let left = UPLOAD_MIN_JPEG_QUALITY + 1;
      let right = UPLOAD_JPEG_QUALITY - 1;
      while (left <= right) {
        const quality = Math.floor((left + right) / 2);
        const candidate = await encodeJpeg(buffer, width, height, quality);
        if (candidate.buffer.byteLength <= targetBytes) {
          best = candidate;
          left = quality + 1;
        } else {
          right = quality - 1;
        }
      }
      return best;
    }
    ({ width, height } = smallerDimensions(width, height, low.buffer.byteLength, targetBytes));
  }
}

async function encodeTransparentWithinLimit(
  buffer: Buffer,
  initialWidth: number,
  initialHeight: number,
  targetBytes: number,
): Promise<EncodedImage> {
  let width = initialWidth;
  let height = initialHeight;
  for (;;) {
    const result = await pipeline(buffer, width, height)
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer({ resolveWithObject: true });
    if (result.data.byteLength <= targetBytes) return { buffer: result.data, info: result.info };
    ({ width, height } = smallerDimensions(width, height, result.data.byteLength, targetBytes));
  }
}

async function hasMeaningfulAlpha(buffer: Buffer, metadata: Metadata): Promise<boolean> {
  if (!metadata.hasAlpha) return false;
  const alpha = await sharp(buffer, SHARP_INPUT_OPTIONS)
    .rotate()
    .ensureAlpha()
    .extractChannel("alpha")
    .raw()
    .toBuffer();
  return alpha.some((value) => value < 255);
}

async function processImageDataUrl(
  dataUrl: unknown,
  preserveAtOrBelowBytes: number | null,
  targetBytes: number,
): Promise<NormalizedUploadImage> {
  const validated = validateImageDataUrl(dataUrl, UPLOAD_MAX_INPUT_BYTES);
  try {
    return await withImageProcessingSlot(async () => {
      const metadata = await sharp(validated.buffer, SHARP_INPUT_OPTIONS).metadata();
      const oriented = orientedDimensions(metadata);
      if (preserveAtOrBelowBytes !== null && validated.buffer.byteLength <= preserveAtOrBelowBytes) {
        return {
          buffer: validated.buffer,
          mimeType: validated.mime,
          width: oriented.width,
          height: oriented.height,
          byteLength: validated.buffer.byteLength,
          normalized: true,
        };
      }
      const target = dimensionsWithinLongEdge(oriented.width, oriented.height);
      const transparent = await hasMeaningfulAlpha(validated.buffer, metadata);
      const encoded = transparent
        ? await encodeTransparentWithinLimit(validated.buffer, target.width, target.height, targetBytes)
        : await encodeOpaqueWithinLimit(validated.buffer, target.width, target.height, targetBytes);
      if (!encoded.info.width || !encoded.info.height) {
        throw new ImageValidationError("标准化后无法读取图片尺寸");
      }
      return {
        buffer: encoded.buffer,
        mimeType: transparent ? "image/png" : "image/jpeg",
        width: encoded.info.width,
        height: encoded.info.height,
        byteLength: encoded.buffer.byteLength,
        normalized: true,
      };
    });
  } catch (error) {
    if (error instanceof ImageValidationError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    if (/pixel limit|exceeds.*pixels|too large/i.test(detail)) {
      throw new ImageValidationError(
        `图片像素过大（最多 ${UPLOAD_MAX_INPUT_PIXELS.toLocaleString("en-US")} 像素），请缩小后重试`,
      );
    }
    throw new ImageValidationError(
      `图片无法完成标准化处理，请转换为标准 PNG、JPEG、WebP 或 GIF 后重试（${detail.slice(0, 160)}）`,
    );
  }
}

/** 所有图像上传统一归一化：sRGB → EXIF 摆正 → 长边 2048（不放大）→ 不透明 JPEG q92 / 透明保留 PNG → 去元数据。 */
export function normalizeUploadImageDataUrl(dataUrl: unknown): Promise<NormalizedUploadImage> {
  return processImageDataUrl(
    dataUrl,
    null,
    UPLOAD_COMPRESSED_TARGET_BYTES,
  );
}

/** Provider 请求副本继续按模型输入契约收敛，不改写已保存的原始素材。 */
export function normalizeProviderImageDataUrl(dataUrl: unknown): Promise<NormalizedUploadImage> {
  return processImageDataUrl(dataUrl, null, PROVIDER_TARGET_BYTES);
}

export const PROVIDER_REFERENCE_LONG_EDGE = 2048;
export const PROVIDER_REFERENCE_JPEG_QUALITY = 92;

/** 参考图发送前统一预处理：sRGB → EXIF 摆正 → 长边 2048（不放大）→ 去元数据。不透明图转 JPEG q92，透明图保留 alpha 转 PNG（与 geminiInlineData / adaptFluxReference 一致）。 */
export async function normalizeProviderReferenceImage(dataUrl: unknown, modelId = "reference"): Promise<string> {
  try {
    const validated = validateImageDataUrl(dataUrl);
    const { buffer, mimeType } = await withImageProcessingSlot(async () => {
      const inputOptions = {
        animated: false,
        failOn: "error" as const,
        limitInputPixels: UPLOAD_MAX_INPUT_PIXELS,
      };
      const metadata = await sharp(validated.buffer, inputOptions).metadata();
      const transparent = metadata.hasAlpha
        && (await sharp(validated.buffer, inputOptions).extractChannel("alpha").stats()).channels[0].min < 255;
      const pipeline = sharp(validated.buffer, inputOptions)
        .rotate()
        .toColourspace("srgb")
        .resize({
          width: PROVIDER_REFERENCE_LONG_EDGE,
          height: PROVIDER_REFERENCE_LONG_EDGE,
          fit: "inside",
          withoutEnlargement: true,
        });
      const buffer = await (transparent
        ? pipeline.png({ compressionLevel: 9 })
        : pipeline.flatten({ background: "#ffffff" })
          .jpeg({ quality: PROVIDER_REFERENCE_JPEG_QUALITY, chromaSubsampling: "4:4:4", mozjpeg: true }))
        .toBuffer();
      return { buffer, mimeType: transparent ? "image/png" : "image/jpeg" };
    });
    return toDataUrl(buffer.toString("base64"), mimeType);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("参考图预处理失败，请使用标准 PNG、JPEG 或 WebP 图片", 400, modelId, "invalid_request", error instanceof Error ? error.message : String(error));
  }
}

/** 所有参考图统一走同一预处理，不单独针对某张图。 */
export async function normalizeProviderReferenceImages(refs: readonly string[], modelId?: string): Promise<string[]> {
  return Promise.all(refs.map((ref) => normalizeProviderReferenceImage(ref, modelId)));
}

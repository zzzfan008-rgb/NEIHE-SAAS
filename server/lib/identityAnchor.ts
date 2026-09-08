import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { config } from "../config";
import { fetchWithRetry, parseDataUrl, toDataUrl } from "../providers/base";

interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface IdentityAnchorResult {
  image: string;
  model: string;
  providerRequests: number;
  cacheHit: boolean;
  fallback: boolean;
}

export interface IdentityAnchorOptions {
  beforeProviderCall?: (providerRequest: number) => void | Promise<void>;
}

export type IdentityAnchorer = (
  imageDataUrl: string,
  options?: IdentityAnchorOptions,
) => Promise<IdentityAnchorResult>;

const CACHE_VERSION = 1;
const inFlight = new Map<string, Promise<IdentityAnchorResult>>();

function validModel(model: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("身份定位模型配置无效");
  return model;
}

function parseBox(payload: unknown): FaceBox {
  const candidates = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })?.candidates;
  const text = candidates?.flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text)
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
  if (!text) throw new Error("身份定位未返回坐标");
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const box = JSON.parse(normalized) as Partial<FaceBox>;
  for (const key of ["x", "y", "width", "height"] as const) {
    if (typeof box[key] !== "number" || !Number.isFinite(box[key])) throw new Error("身份定位坐标无效");
  }
  if (box.x! < 0 || box.y! < 0 || box.width! <= 0 || box.height! <= 0 ||
      box.x! + box.width! > 1 || box.y! + box.height! > 1) {
    throw new Error("身份定位坐标越界");
  }
  return box as FaceBox;
}

async function cropFace(imageDataUrl: string, box?: FaceBox): Promise<string> {
  const input = parseDataUrl(imageDataUrl).buffer;
  const normalized = await sharp(input, { animated: false, failOn: "error", limitInputPixels: 40_000_000 })
    .rotate()
    .png()
    .toBuffer({ resolveWithObject: true });
  const imageWidth = normalized.info.width;
  const imageHeight = normalized.info.height;
  const fallback = { x: 0.2, y: 0, width: 0.6, height: 0.5 };
  const source = box ?? fallback;
  const paddingX = source.width * 0.45;
  const paddingY = source.height * 0.65;
  const leftRatio = Math.max(0, source.x - paddingX);
  const topRatio = Math.max(0, source.y - paddingY);
  const rightRatio = Math.min(1, source.x + source.width + paddingX);
  const bottomRatio = Math.min(1, source.y + source.height + paddingY);
  const left = Math.min(imageWidth - 1, Math.floor(leftRatio * imageWidth));
  const top = Math.min(imageHeight - 1, Math.floor(topRatio * imageHeight));
  const width = Math.max(1, Math.min(imageWidth - left, Math.ceil((rightRatio - leftRatio) * imageWidth)));
  const height = Math.max(1, Math.min(imageHeight - top, Math.ceil((bottomRatio - topRatio) * imageHeight)));
  const buffer = await sharp(normalized.data).extract({ left, top, width, height }).png().toBuffer();
  return toDataUrl(buffer.toString("base64"), "image/png");
}

async function analyzeBox(imageDataUrl: string, model: string, options: IdentityAnchorOptions): Promise<FaceBox> {
  const { mime, base64 } = parseDataUrl(imageDataUrl);
  await options.beforeProviderCall?.(1);
  const response = await fetchWithRetry(
    `${config.apiyiBaseUrl()}/v1beta/models/${model}:generateContent`,
    () => ({
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [
          { text: "定位画面中主要人物的脸部边界框。只返回 JSON，坐标归一化到 0-1：{\"x\":0.0,\"y\":0.0,\"width\":0.0,\"height\":0.0}。边界框只包住完整脸部和下巴，不描述身份、性别、年龄、服装或背景。" },
          { inlineData: { mimeType: mime, data: base64 } },
        ] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    }),
    { timeoutMs: config.aiTimeoutMs(120_000), providerId: model, maxRetries: 0 },
  );
  return parseBox(await response.json());
}

async function readBox(filePath: string, model: string): Promise<FaceBox | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as { version: number; model: string; box: FaceBox };
    if (parsed.version !== CACHE_VERSION || parsed.model !== model) return undefined;
    return parsed.box;
  } catch {
    return undefined;
  }
}

async function writeBox(filePath: string, model: string, box: FaceBox): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${nanoid(8)}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ version: CACHE_VERSION, model, box }), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

export const createIdentityAnchor: IdentityAnchorer = async (imageDataUrl, options = {}) => {
  const model = validModel(config.identityAnalysisModel());
  const parsed = parseDataUrl(imageDataUrl);
  const key = createHash("sha256").update(`identity:${CACHE_VERSION}:${model}:${parsed.mime}:`).update(parsed.buffer).digest("hex");
  const filePath = path.join(config.dataDir(), "identity-anchor-cache", `${key}.json`);
  const existing = inFlight.get(key);
  if (existing) {
    const shared = await existing;
    return { ...shared, providerRequests: 0, cacheHit: true };
  }
  const task = (async (): Promise<IdentityAnchorResult> => {
    const cached = await readBox(filePath, model);
    if (cached) return { image: await cropFace(imageDataUrl, cached), model, providerRequests: 0, cacheHit: true, fallback: false };
    try {
      const box = await analyzeBox(imageDataUrl, model, options);
      await writeBox(filePath, model, box);
      return { image: await cropFace(imageDataUrl, box), model, providerRequests: 1, cacheHit: false, fallback: false };
    } catch {
      return { image: await cropFace(imageDataUrl), model, providerRequests: 1, cacheHit: false, fallback: true };
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
};

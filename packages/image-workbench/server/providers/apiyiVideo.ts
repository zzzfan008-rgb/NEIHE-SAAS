import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import sharp from "sharp";
import { mimeOfFile, normalizeImageRef, storedMediaPath } from "../lib/fileStore";
import { fetchWithRetry, parseDataUrl, ProviderError, toDataUrl } from "./base";
import {
  SEEDANCE_MODEL_CAPABILITIES,
  SEEDANCE_OUTPUT_FORMATS,
  SEEDANCE_RATIOS,
  SEEDANCE_RESOLUTIONS,
  SEEDANCE_VIDEO_MODES,
  isSeedance25,
  isSeedanceVideoModel,
  seedanceModeRequiresAdaptive,
} from "../../src/lib/seedance";
import type {
  SeedanceOutputFormat,
  SeedanceVideoModelId,
  VideoAspectRatio,
  VideoGenerationMode,
  VideoResolution,
} from "../../src/types/workflow";

export const SEEDANCE_25_MODEL: SeedanceVideoModelId = "doubao-seedance-2-5-260628";
const TASK_PATH = "/seedance/api/v3/contents/generations/tasks";
const ASSET_REFERENCE = /^asset:\/\/[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const EDIT_INTENT = /(?:增加|加上|删除|去掉|修改|替换|改成|add|remove|delete|modify|replace)/iu;
const EXTEND_INTENT = /(?:向前延长|向后延长|延续|续写|继续|extend|continue)/iu;

export type ApiYiVideoReferenceRole =
  | "first-frame"
  | "last-frame"
  | "reference-image"
  | "reference-video"
  | "reference-audio"
  | "source-video";

export interface ApiYiVideoReference {
  role: ApiYiVideoReferenceRole;
  url: string;
}

export interface ApiYiVideoRequest {
  mode: VideoGenerationMode;
  model: SeedanceVideoModelId;
  prompt: string;
  aspectRatio: VideoAspectRatio;
  resolution: VideoResolution;
  seconds: number;
  generateAudio: boolean;
  outputFormat: SeedanceOutputFormat;
  references: ApiYiVideoReference[];
  idempotencyKey?: string;
  resumeTask?: ApiYiVideoTask;
  beforeProviderCall?: (requestNumber: number) => void | Promise<void>;
  onTaskAccepted?: (task: ApiYiVideoTask) => void | Promise<void>;
}

export interface ApiYiVideoTask {
  id: string;
  model: string;
}

export interface ApiYiVideoUsage {
  completionTokens?: number;
  totalTokens?: number;
  duration?: number;
  resolution?: string;
  ratio?: string;
  seed?: number;
}

export interface ApiYiVideoResult {
  video: string;
  model: string;
  providerRequests: number;
  taskId: string;
  usage: ApiYiVideoUsage;
}

interface SeedanceTaskPayload {
  id?: unknown;
  model?: unknown;
  status?: unknown;
  content?: { video_url?: unknown };
  usage?: { completion_tokens?: unknown; total_tokens?: unknown };
  duration?: unknown;
  resolution?: unknown;
  ratio?: unknown;
  seed?: unknown;
  error?: unknown;
  message?: unknown;
}

type SeedanceContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string }; role: "first_frame" | "last_frame" | "reference_image" }
  | { type: "video_url"; video_url: { url: string }; role: "reference_video" }
  | { type: "audio_url"; audio_url: { url: string }; role: "reference_audio" };

export class AcceptedVideoTaskPersistenceError extends Error {
  constructor(cause: unknown) {
    super(
      `视频任务已受理但状态保存失败，结果状态未知；请核对 API易消耗记录后再决定是否重试：${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "AcceptedVideoTaskPersistenceError";
  }
}

const apiHeaders = () => ({
  Authorization: `Bearer ${config.seedanceApiKey()}`,
  "Accept-Encoding": "identity",
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function endpoint(suffix = ""): string {
  return `${config.seedanceApiBaseUrl()}${TASK_PATH}${suffix}`;
}

function acceptedTask(payload: unknown, model: SeedanceVideoModelId): ApiYiVideoTask {
  const body = payload as SeedanceTaskPayload;
  if (typeof body.id !== "string" || !body.id.trim()) {
    throw new ProviderError("Seedance 视频服务未返回任务编号", 502, model, "invalid_response");
  }
  return { id: body.id, model };
}

function upstreamError(payload: SeedanceTaskPayload): string | undefined {
  if (typeof payload.error === "string") return payload.error;
  if (payload.error && typeof payload.error === "object") {
    const error = payload.error as Record<string, unknown>;
    if (typeof error.message === "string") return error.message;
    if (typeof error.code === "string") return error.code;
  }
  return typeof payload.message === "string" ? payload.message : undefined;
}

function isAssetReference(value: string): boolean {
  return ASSET_REFERENCE.test(value);
}

async function imageReference(value: string): Promise<string> {
  if (isAssetReference(value)) return value;
  const normalized = await normalizeImageRef(value);
  const { buffer } = parseDataUrl(normalized);
  const metadata = await sharp(buffer, { failOn: "error", limitInputPixels: 36_000_000 }).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const ratio = height > 0 ? width / height : 0;
  if (buffer.byteLength >= 30 * 1024 * 1024 || width < 300 || width > 6_000 || height < 300 || height > 6_000 || ratio < 0.4 || ratio > 2.5) {
    throw new ProviderError(
      "Seedance 参考图必须小于 30MB、边长 300–6000px、宽高比 0.4–2.5",
      400,
      "apiyi-video",
      "invalid_request",
    );
  }
  return normalized;
}

function remotelyReachableMedia(value: string, model: SeedanceVideoModelId): string {
  if (isAssetReference(value) || /^https:\/\//i.test(value)) return value;
  throw new ProviderError(
    "Seedance 的视频和音频参考必须使用 HTTPS 公网地址或 asset:// 素材；本地上传需先登记到素材库",
    400,
    model,
    "invalid_request",
  );
}

function assetEndpoint(pathname: string): string {
  return `${config.seedanceAssetApiBaseUrl()}${pathname}`;
}

function assetHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.seedanceAssetApiKey()}`,
    "Content-Type": "application/json",
  };
}

async function assetFetch(url: string, initFactory: () => RequestInit): Promise<Response> {
  try {
    return await fetchWithRetry(url, initFactory, {
      providerId: "seedance-asset-library",
      timeoutMs: config.aiTimeoutMs(120_000),
      maxRetries: 0,
    });
  } catch (error) {
    if (error instanceof ProviderError && error.category === "outcome_unknown") {
      throw new ProviderError(
        "Seedance 素材转存服务暂时不可用，请稍后重试",
        503,
        "seedance-asset-library",
        "gateway_unavailable",
        error.diagnostic,
      );
    }
    throw error;
  }
}

async function uploadLocalVideoReference(value: string, model: SeedanceVideoModelId): Promise<string> {
  let filePath: string;
  try {
    filePath = storedMediaPath(value, ["video/mp4", "video/quicktime"]);
  } catch (error) {
    throw new ProviderError(
      "Seedance 本地参考视频只支持 MP4 或 MOV",
      400,
      model,
      "invalid_request",
      error instanceof Error ? error.message : String(error),
    );
  }
  const buffer = await fs.readFile(filePath);
  if (buffer.byteLength > 50 * 1024 * 1024) {
    throw new ProviderError("Seedance 本地参考视频不得超过 50MB", 400, model, "invalid_request");
  }
  const mime = mimeOfFile(path.basename(filePath));
  const ext = mime === "video/quicktime" ? "mov" : "mp4";
  const presignResponse = await assetFetch(assetEndpoint("/storage/presign"), () => ({
    method: "POST",
    headers: assetHeaders(),
    body: JSON.stringify({ ext, contentType: mime }),
  }));
  const presign = await presignResponse.json() as {
    code?: unknown;
    data?: { uploadUrl?: unknown; publicUrl?: unknown };
  };
  const uploadUrl = typeof presign.data?.uploadUrl === "string" ? presign.data.uploadUrl : "";
  const publicUrl = typeof presign.data?.publicUrl === "string" ? presign.data.publicUrl : "";
  if (presign.code !== 0 || !/^https:\/\//i.test(uploadUrl) || !/^https:\/\//i.test(publicUrl)) {
    throw new ProviderError("Seedance 素材转存服务返回无效地址", 502, model, "invalid_response");
  }
  await assetFetch(uploadUrl, () => ({
    method: "PUT",
    headers: { "Content-Type": mime },
    body: new Uint8Array(buffer),
  }));
  return publicUrl;
}

async function contentFor(request: ApiYiVideoRequest): Promise<SeedanceContent[]> {
  const content: SeedanceContent[] = [{ type: "text", text: request.prompt }];
  for (const reference of request.references) {
    if (reference.role === "first-frame" || reference.role === "last-frame" || reference.role === "reference-image") {
      content.push({
        type: "image_url",
        image_url: { url: await imageReference(reference.url) },
        role: reference.role === "first-frame"
          ? "first_frame"
          : reference.role === "last-frame" ? "last_frame" : "reference_image",
      });
      continue;
    }
    if (reference.role === "reference-audio") {
      content.push({
        type: "audio_url",
        audio_url: { url: remotelyReachableMedia(reference.url, request.model) },
        role: "reference_audio",
      });
      continue;
    }
    const videoUrl = reference.url.startsWith("/api/files/")
      ? await uploadLocalVideoReference(reference.url, request.model)
      : remotelyReachableMedia(reference.url, request.model);
    content.push({
      type: "video_url",
      video_url: { url: videoUrl },
      role: "reference_video",
    });
  }
  return content;
}

async function submit(request: ApiYiVideoRequest): Promise<ApiYiVideoTask> {
  const content = await contentFor(request);
  await request.beforeProviderCall?.(1);
  const response = await fetchWithRetry(endpoint(), () => ({
    method: "POST",
    headers: {
      ...apiHeaders(),
      "Content-Type": "application/json",
      ...(request.idempotencyKey ? { "Idempotency-Key": request.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      model: request.model,
      content,
      resolution: request.resolution,
      ratio: request.aspectRatio,
      duration: request.seconds,
      generate_audio: request.generateAudio,
      watermark: false,
      ...(isSeedance25(request.model) ? { output_format: request.outputFormat } : {}),
      ...(request.mode === "video-edit" ? { omni_reference_task_type: "edit" } : {}),
      ...(request.mode === "video-extend" ? { omni_reference_task_type: "extend" } : {}),
    }),
  }), {
    providerId: request.model,
    timeoutMs: config.aiTimeoutMs(90_000),
    maxRetries: 0,
  });
  return acceptedTask(await response.json(), request.model);
}

async function waitUntilComplete(task: ApiYiVideoTask): Promise<SeedanceTaskPayload> {
  const deadline = Date.now() + 15 * 60_000;
  await wait(25_000);
  while (Date.now() < deadline) {
    const response = await fetchWithRetry(endpoint(`/${encodeURIComponent(task.id)}`), () => ({
      headers: apiHeaders(),
    }), {
      providerId: task.model,
      timeoutMs: config.aiTimeoutMs(30_000),
      maxRetries: 0,
    });
    const payload = await response.json() as SeedanceTaskPayload;
    if (payload.status === "succeeded") return payload;
    if (payload.status === "failed" || payload.status === "expired") {
      throw new ProviderError(
        upstreamError(payload) || `Seedance 视频生成${payload.status === "expired" ? "已过期" : "失败"}`,
        422,
        task.model,
        "invalid_request",
      );
    }
    if (payload.status !== "queued" && payload.status !== "running") {
      throw new ProviderError("Seedance 返回了未知任务状态", 502, task.model, "invalid_response");
    }
    await wait(15_000);
  }
  throw new ProviderError("Seedance 视频生成等待超时，结果状态未知", 504, task.model, "outcome_unknown");
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageFrom(payload: SeedanceTaskPayload): ApiYiVideoUsage {
  return {
    completionTokens: numeric(payload.usage?.completion_tokens),
    totalTokens: numeric(payload.usage?.total_tokens),
    duration: numeric(payload.duration),
    resolution: typeof payload.resolution === "string" ? payload.resolution : undefined,
    ratio: typeof payload.ratio === "string" ? payload.ratio : undefined,
    seed: numeric(payload.seed),
  };
}

async function download(
  payload: SeedanceTaskPayload,
  model: SeedanceVideoModelId,
  outputFormat: SeedanceOutputFormat,
): Promise<string> {
  const rawUrl = payload.content?.video_url;
  if (typeof rawUrl !== "string") {
    throw new ProviderError("Seedance 成功响应缺少视频地址", 502, model, "invalid_response");
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProviderError("Seedance 返回了无效的视频地址", 502, model, "invalid_response");
  }
  if (url.protocol !== "https:") {
    throw new ProviderError("Seedance 视频地址必须使用 HTTPS", 502, model, "invalid_response");
  }

  const response = await fetchWithRetry(url.toString(), () => ({ method: "GET" }), {
    providerId: model,
    timeoutMs: config.aiTimeoutMs(180_000),
    maxRetries: 4,
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength < 12 || buffer.subarray(4, 8).toString("ascii") !== "ftyp") {
    throw new ProviderError("Seedance 下载内容不是有效的 MP4/MOV", 502, model, "invalid_response");
  }
  if (buffer.byteLength > 100 * 1024 * 1024) {
    throw new ProviderError("Seedance 视频结果超过 100MB 限制", 413, model, "invalid_response");
  }
  const mime = outputFormat === "mov" ? "video/quicktime" : "video/mp4";
  return toDataUrl(buffer.toString("base64"), mime);
}

function assertRequest(request: ApiYiVideoRequest): void {
  const fail = (message: string): never => {
    throw new ProviderError(message, 400, request.model, "invalid_request");
  };
  if (!request.prompt.trim()) fail("视频提示词不能为空");
  if (!isSeedanceVideoModel(request.model)) fail("不支持的 Seedance 模型");
  if (!SEEDANCE_VIDEO_MODES.includes(request.mode)) fail("不支持的 Seedance 视频模式");
  if (!SEEDANCE_RESOLUTIONS.includes(request.resolution)) fail("Seedance 仅支持 480p、720p 或 1080p");
  if (!SEEDANCE_RATIOS.includes(request.aspectRatio)) fail("Seedance 视频比例无效");
  if (!SEEDANCE_OUTPUT_FORMATS.includes(request.outputFormat)) fail("Seedance 输出格式无效");
  if (typeof request.generateAudio !== "boolean") fail("必须显式设置是否生成音频");

  const capability = SEEDANCE_MODEL_CAPABILITIES[request.model];
  if (request.resolution === "1080p" && !capability.supports1080p) fail("Fast 和 Mini 不支持 1080p");
  if (request.outputFormat === "mov" && !capability.supportsMov) fail("只有 Seedance 2.5 支持 MOV 输出");
  if (request.seconds !== -1 && (!Number.isSafeInteger(request.seconds) || request.seconds < 4 || request.seconds > capability.maxDuration)) {
    fail(`视频时长必须是 -1 或 4 至 ${capability.maxDuration} 秒整数`);
  }
  if ((request.mode === "video-edit" || request.mode === "video-extend") && !capability.supportsEdit) {
    fail("视频编辑与延长只支持 Seedance 2.5");
  }
  if (seedanceModeRequiresAdaptive(request.model, request.mode) && request.aspectRatio !== "adaptive") {
    fail("该 Seedance 2.5 任务必须使用 adaptive 比例");
  }
  if (request.mode === "video-edit" && request.seconds !== -1) fail("Seedance 2.5 视频编辑的 duration 必须为 -1");

  const count = (role: ApiYiVideoReferenceRole) => request.references.filter((item) => item.role === role).length;
  if (request.mode === "text-to-video" && request.references.length !== 0) fail("文生视频不能携带参考素材");
  if (request.mode === "first-frame-to-video" && (request.references.length !== 1 || count("first-frame") !== 1)) {
    fail("首帧生视频必须使用 1 张首帧图片");
  }
  if (request.mode === "keyframes-to-video" && (
    request.references.length !== 2 || count("first-frame") !== 1 || count("last-frame") !== 1
  )) fail("首尾帧生视频必须各使用 1 张首帧和尾帧图片");
  if (request.mode === "multimodal-reference") {
    const images = count("reference-image");
    const videos = count("reference-video");
    const audios = count("reference-audio");
    if (images + videos + audios !== request.references.length) fail("多模态参考素材角色无效");
    if (images > capability.maxImages || videos > capability.maxVideos || audios > capability.maxAudios) {
      fail("参考素材数量超过所选模型限制");
    }
    if (images + videos + audios === 0 || (!capability.supportsAudioOnly && images + videos === 0)) {
      fail("所选模型需要至少 1 张图片或 1 个视频参考");
    }
  }
  if ((request.mode === "video-edit" || request.mode === "video-extend") && (
    request.references.length !== 1 || count("source-video") !== 1
  )) fail("视频编辑或延长必须提供 1 个源视频");
  if (request.mode === "video-edit" && !EDIT_INTENT.test(request.prompt)) fail("视频编辑提示词必须包含增加、删除、修改或替换意图");
  if (request.mode === "video-extend" && !EXTEND_INTENT.test(request.prompt)) fail("视频延长提示词必须包含延长、延续或续写意图");
}

export async function generateApiYiVideo(request: ApiYiVideoRequest): Promise<ApiYiVideoResult> {
  assertRequest(request);
  let providerRequests = 0;
  let task = request.resumeTask;
  if (task) {
    if (!task.id.trim() || task.id.length > 256 || task.model !== request.model) {
      throw new ProviderError("已保存的 Seedance 视频任务状态无效", 500, request.model, "invalid_response");
    }
  } else {
    task = await submit(request);
    providerRequests = 1;
    try {
      await request.onTaskAccepted?.(task);
    } catch (error) {
      throw new AcceptedVideoTaskPersistenceError(error);
    }
  }
  const payload = await waitUntilComplete(task);
  return {
    video: await download(payload, request.model, request.outputFormat),
    model: request.model,
    providerRequests,
    taskId: task.id,
    usage: usageFrom(payload),
  };
}

const LEGACY_VEO_MODEL = /^veo-?3\.1(?:[-.][A-Za-z0-9]+)*$/;

export function isLegacyVeoTask(task: ApiYiVideoTask | undefined): task is ApiYiVideoTask {
  return Boolean(task && task.id.trim() && task.id.length <= 256 && LEGACY_VEO_MODEL.test(task.model));
}

async function waitForLegacyVeoTask(task: ApiYiVideoTask): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  let firstPoll = true;
  while (Date.now() < deadline) {
    if (!firstPoll) await wait(8_000);
    firstPoll = false;
    const response = await fetchWithRetry(
      `${config.apiyiBaseUrl()}/v1/videos/${encodeURIComponent(task.id)}`,
      () => ({ headers: { Authorization: `Bearer ${config.apiyiApiKey()}` } }),
      { providerId: task.model, timeoutMs: config.aiTimeoutMs(30_000), maxRetries: 0 },
    );
    const payload = await response.json() as { status?: unknown; error?: unknown };
    if (payload.status === "completed" || payload.status === "succeeded") return;
    if (payload.status === "failed" || payload.status === "cancelled") {
      const detail = typeof payload.error === "string"
        ? payload.error
        : payload.error && typeof payload.error === "object" && typeof (payload.error as { message?: unknown }).message === "string"
          ? (payload.error as { message: string }).message
          : "旧视频任务生成失败";
      throw new ProviderError(detail, 422, task.model, "invalid_request");
    }
  }
  throw new ProviderError("旧视频任务等待超时，结果状态未知", 504, task.model, "outcome_unknown");
}

async function downloadLegacyVeoTask(task: ApiYiVideoTask): Promise<string> {
  const response = await fetchWithRetry(
    `${config.apiyiBaseUrl()}/v1/videos/${encodeURIComponent(task.id)}/content`,
    () => ({ headers: { Authorization: `Bearer ${config.apiyiApiKey()}` } }),
    { providerId: task.model, timeoutMs: config.aiTimeoutMs(180_000), maxRetries: 0 },
  );
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength < 12 || buffer.subarray(4, 8).toString("ascii") !== "ftyp") {
    throw new ProviderError("旧视频任务下载内容不是有效 MP4", 502, task.model, "invalid_response");
  }
  if (buffer.byteLength > 100 * 1024 * 1024) {
    throw new ProviderError("旧视频任务结果超过 100MB 限制", 502, task.model, "invalid_response");
  }
  return toDataUrl(buffer.toString("base64"), "video/mp4");
}

/** 仅恢复升级前已经受理的 VEO 任务；绝不允许通过旧接口创建新任务。 */
export async function resumeLegacyVeoTask(task: ApiYiVideoTask): Promise<ApiYiVideoResult> {
  if (!isLegacyVeoTask(task)) {
    throw new ProviderError("已保存的旧视频任务状态无效", 500, "apiyi-video", "invalid_response");
  }
  await waitForLegacyVeoTask(task);
  return {
    video: await downloadLegacyVeoTask(task),
    model: task.model,
    providerRequests: 0,
    taskId: task.id,
    usage: {},
  };
}

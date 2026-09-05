import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { config } from "../config";
import { normalizeImageRef, storedMediaPath } from "../lib/fileStore";
import { fetchWithRetry, parseDataUrl, ProviderError, toDataUrl } from "./base";
import type { VideoGenerationMode } from "../../src/types/workflow";

export interface ApiYiVideoRequest {
  mode: VideoGenerationMode;
  prompt: string;
  quality: "fast" | "standard";
  aspectRatio: "16:9" | "9:16";
  resolution: "720p" | "1080p" | "4k";
  seconds: 4 | 6 | 8;
  references: string[];
  idempotencyKey?: string;
  resumeTask?: ApiYiVideoTask;
  beforeProviderCall?: (requestNumber: number) => void | Promise<void>;
  onTaskAccepted?: (task: ApiYiVideoTask) => void | Promise<void>;
}

export interface ApiYiVideoTask {
  id: string;
  model: string;
}

export interface ApiYiVideoResult {
  video: string;
  model: string;
  providerRequests: number;
}

const authHeaders = () => ({ Authorization: `Bearer ${config.apiyiApiKey()}` });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function taskId(payload: unknown): string {
  const body = payload as { task_id?: unknown; id?: unknown };
  const id = typeof body.task_id === "string" ? body.task_id : typeof body.id === "string" ? body.id : "";
  if (!id) throw new ProviderError("视频服务未返回任务编号", 502, "apiyi-video", "invalid_response");
  return id;
}

function reverseModel(request: ApiYiVideoRequest): string {
  return [
    "veo-3.1",
    request.aspectRatio === "16:9" ? "landscape" : "",
    request.quality === "fast" ? "fast" : "",
    "fl",
  ].filter(Boolean).join("-");
}

function officialModel(request: ApiYiVideoRequest): string {
  return request.quality === "fast" ? "veo-3.1-fast-generate-preview" : "veo-3.1-generate-preview";
}

function dimensions(request: ApiYiVideoRequest): string {
  const landscape = request.aspectRatio === "16:9";
  if (request.resolution === "4k") return landscape ? "3840x2160" : "2160x3840";
  if (request.resolution === "1080p") return landscape ? "1920x1080" : "1080x1920";
  return landscape ? "1280x720" : "720x1280";
}

async function imageFile(ref: string, index: number): Promise<File> {
  const normalized = await normalizeImageRef(ref);
  const { mime, buffer } = parseDataUrl(normalized);
  if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) {
    throw new ProviderError("视频参考帧只支持 JPEG、PNG 或 WebP", 400, "apiyi-video", "invalid_request");
  }
  const ext = mime === "image/jpeg" ? "jpg" : mime.split("/")[1];
  return new File([new Uint8Array(buffer)], `frame-${index + 1}.${ext}`, { type: mime });
}

async function extractFirstFrame(videoRef: string): Promise<string> {
  const source = storedMediaPath(videoRef, ["video/mp4", "video/webm", "video/quicktime"]);
  const target = path.join(os.tmpdir(), `garment-video-frame-${nanoid(10)}.png`);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", source, "-frames:v", "1", "-vf", "scale='min(1920,iw)':-2", "-y", target], { stdio: ["ignore", "ignore", "pipe"] });
      let errorText = "";
      child.stderr.on("data", (chunk) => { errorText += String(chunk).slice(0, 2_000); });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(errorText || `ffmpeg exited ${code}`)));
    });
    const buffer = await fs.readFile(target);
    return toDataUrl(buffer.toString("base64"), "image/png");
  } catch (error) {
    throw new ProviderError("无法读取视频首帧，请换用标准 MP4/H.264 视频", 400, "apiyi-video", "invalid_request", error instanceof Error ? error.message : String(error));
  } finally {
    await fs.rm(target, { force: true }).catch(() => undefined);
  }
}

async function submit(request: ApiYiVideoRequest): Promise<ApiYiVideoTask> {
  const usesReverseFrames = request.mode === "keyframes-to-video" || request.mode === "multi-image-video";
  const model = usesReverseFrames ? reverseModel(request) : officialModel(request);
  let refs = request.references;
  if (request.mode === "video-to-video") refs = [await extractFirstFrame(request.references[0])];
  await request.beforeProviderCall?.(1);

  let body: BodyInit;
  let headers: Record<string, string> = {
    ...authHeaders(),
    ...(request.idempotencyKey ? { "Idempotency-Key": request.idempotencyKey } : {}),
  };
  if (request.mode === "text-to-video") {
    headers = { ...headers, "Content-Type": "application/json" };
    body = JSON.stringify({
      model,
      prompt: request.prompt,
      seconds: String(request.seconds),
      size: dimensions(request),
      metadata: { resolution: request.resolution, aspectRatio: request.aspectRatio },
    });
  } else {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", request.prompt);
    if (!usesReverseFrames) {
      form.append("seconds", String(request.seconds));
      form.append("size", dimensions(request));
      form.append("resolution", request.resolution);
      form.append("aspectRatio", request.aspectRatio);
    }
    const limit = usesReverseFrames ? 2 : 1;
    for (const [index, ref] of refs.slice(0, limit).entries()) {
      form.append("input_reference", await imageFile(ref, index));
    }
    body = form;
  }
  const response = await fetchWithRetry(`${config.apiyiBaseUrl()}/v1/videos`, () => ({ method: "POST", headers, body }), {
    providerId: model,
    timeoutMs: config.aiTimeoutMs(90_000),
    maxRetries: 0,
  });
  return { id: taskId(await response.json()), model };
}

async function waitUntilComplete(id: string, model: string, resolution: ApiYiVideoRequest["resolution"]): Promise<void> {
  const deadline = Date.now() + (resolution === "4k" ? 10 * 60_000 : 5 * 60_000);
  let firstPoll = true;
  while (Date.now() < deadline) {
    if (!firstPoll) await wait(8_000);
    firstPoll = false;
    const response = await fetchWithRetry(`${config.apiyiBaseUrl()}/v1/videos/${encodeURIComponent(id)}`, () => ({ headers: authHeaders() }), {
      providerId: model,
      timeoutMs: config.aiTimeoutMs(30_000),
      maxRetries: 0,
    });
    const payload = await response.json() as { status?: string; error?: { message?: string } | string };
    if (payload.status === "completed" || payload.status === "succeeded") return;
    if (payload.status === "failed" || payload.status === "cancelled") {
      const detail = typeof payload.error === "string" ? payload.error : payload.error?.message;
      throw new ProviderError(detail || "视频生成失败", 422, model, "invalid_request");
    }
  }
  throw new ProviderError("视频生成等待超时，结果状态未知", 504, model, "outcome_unknown");
}

async function download(id: string, model: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt > 0) await wait(4_000);
    try {
      const response = await fetchWithRetry(`${config.apiyiBaseUrl()}/v1/videos/${encodeURIComponent(id)}/content`, () => ({ headers: authHeaders() }), {
        providerId: model,
        timeoutMs: config.aiTimeoutMs(180_000),
        maxRetries: 0,
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength < 12 || buffer.subarray(4, 8).toString("ascii") !== "ftyp") throw new Error("下载内容不是有效 MP4");
      if (buffer.byteLength > 100 * 1024 * 1024) throw new Error("视频结果超过 100MB 限制");
      return toDataUrl(buffer.toString("base64"), "video/mp4");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("视频下载失败");
}

export async function generateApiYiVideo(request: ApiYiVideoRequest): Promise<ApiYiVideoResult> {
  if (!request.prompt.trim()) throw new ProviderError("视频提示词不能为空", 400, "apiyi-video", "invalid_request");
  if (request.resolution !== "720p" && request.seconds !== 8) throw new ProviderError("1080p 与 4K 视频必须使用 8 秒时长", 400, "apiyi-video", "invalid_request");
  if ((request.mode === "keyframes-to-video" || request.mode === "multi-image-video") && request.references.length !== 2) {
    throw new ProviderError("首尾帧或多图参考必须使用 2 张图片", 400, "apiyi-video", "invalid_request");
  }
  if (request.mode === "video-to-video" && request.references.length !== 1) throw new ProviderError("视频重制需要 1 个源视频", 400, "apiyi-video", "invalid_request");
  const expectedModel = request.mode === "keyframes-to-video" || request.mode === "multi-image-video"
    ? reverseModel(request)
    : officialModel(request);
  let providerRequests = 0;
  let task = request.resumeTask;
  if (task) {
    if (!task.id.trim() || task.id.length > 256 || task.model !== expectedModel) {
      throw new ProviderError("已保存的视频任务状态无效", 500, expectedModel, "invalid_response");
    }
  } else {
    task = await submit(request);
    providerRequests = 1;
    try {
      await request.onTaskAccepted?.(task);
    } catch (error) {
      throw new Error(
        `视频任务已受理但状态保存失败，请核对 API易消耗记录后再决定是否重试：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  await waitUntilComplete(task.id, task.model, request.resolution);
  return { video: await download(task.id, task.model), model: task.model, providerRequests };
}

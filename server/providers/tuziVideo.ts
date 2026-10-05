import { config } from "../config";
import dns from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import { isGlobalIpAddress } from "../lib/fileStore";
import { isSeedance25 } from "../../src/lib/seedance";
import { fetchAiWithRetry as fetchWithRetry, parseDataUrl, ProviderError, toDataUrl } from "./base";
import { AcceptedVideoTaskPersistenceError, assertRequest, imageReference, uploadLocalVideoReference,
  type ApiYiVideoRequest, type ApiYiVideoResult, type ApiYiVideoTask } from "./apiyiVideo";

const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MODES = { "text-to-video": "textToVideo", "first-frame-to-video": "imageToVideo",
  "keyframes-to-video": "firstAndLastFrame", "multimodal-reference": "referToVideo", "video-extend": "videoExtend" } as const;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Payload = Record<string, unknown>;

async function bodyBytes(response: Response, max: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError("TuziAPI 返回了空响应", 502, "tuzi-video", "invalid_response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel(); }, 180_000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new ProviderError("TuziAPI 读取结果超时", 504, "tuzi-video", "outcome_unknown");
      if (done) break;
      total += value.length;
      if (total > max) {
        await reader.cancel();
        throw new ProviderError("TuziAPI 响应超过大小限制", 502, "tuzi-video", "invalid_response");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

function api(path: string, init: RequestInit = {}) {
  return fetchWithRetry(`${config.tuziBaseUrl()}${path}`, () => ({
    ...init, redirect: "error", headers: { Authorization: `Bearer ${config.tuziApiKey()}`, ...init.headers },
  }), { providerId: "tuzi-video", timeoutMs: config.aiTimeoutMs(180_000), maxRetries: 0, gateway: "tuzi", video: true });
}

async function json(path: string, init: RequestInit = {}): Promise<Payload> {
  const bytes = await bodyBytes(await api(path, init), 256 * 1024);
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* Do not expose provider response text. */ }
  throw new ProviderError("TuziAPI 返回了无效 JSON", 502, "tuzi-video", "invalid_response");
}

/** Result URLs are untrusted. Pin public DNS answers, validate every redirect, and never forward the API key. */
export async function downloadTuziVideoUrl(raw: string, redirects = 0): Promise<Buffer> {
  const url = new URL(raw);
  if (redirects > 4 || url.protocol !== "https:" || url.username || url.password) throw new ProviderError("TuziAPI 视频结果地址无效", 502, "tuzi-video", "invalid_response");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isGlobalIpAddress(address))) throw new ProviderError("TuziAPI 视频结果地址不可访问", 502, "tuzi-video", "invalid_response");
  const result = await new Promise<Buffer | string>((resolve, reject) => {
    const request = https.get(url, {
      signal: AbortSignal.timeout(180_000), headers: { accept: "video/*" },
      family: addresses[0].family,
      lookup: (_host, _opts, callback) => callback(null, addresses[0].address, addresses[0].family),
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        response.resume(); resolve(new URL(response.headers.location, url).href); return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(new ProviderError("TuziAPI 视频下载失败", 502, "tuzi-video", "invalid_response")); return; }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > 100 * 1024 * 1024) response.destroy(new ProviderError("TuziAPI 视频超过 100MB", 502, "tuzi-video", "invalid_response"));
        else chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => resolve(Buffer.concat(chunks, total)));
    });
    request.once("error", reject);
  });
  return typeof result === "string" ? downloadTuziVideoUrl(result, redirects + 1) : result;
}

async function downloadContent(taskPath: string, payload: Payload): Promise<Buffer> {
  if (typeof payload.video_url === "string") return downloadTuziVideoUrl(payload.video_url);
  const response = await fetch(`${config.tuziBaseUrl()}${taskPath}/content`, {
    headers: { Authorization: `Bearer ${config.tuziApiKey()}` }, redirect: "manual", signal: AbortSignal.timeout(180_000),
  });
  const location = response.headers.get("location");
  if ([301, 302, 303, 307, 308].includes(response.status) && location) {
    await response.body?.cancel();
    return downloadTuziVideoUrl(new URL(location, config.tuziBaseUrl()).href);
  }
  if (!response.ok) { await response.body?.cancel(); throw new ProviderError("TuziAPI 视频下载失败", 502, "tuzi-video", "invalid_response"); }
  return bodyBytes(response, 100 * 1024 * 1024);
}

function assetData(payload: Payload): Payload {
  if (payload.success !== true || !payload.data || typeof payload.data !== "object") {
    throw new ProviderError("TuziAPI 素材服务返回异常", 502, "tuzi-video", "invalid_response");
  }
  return payload.data as Payload;
}

async function approvedImage(reference: string): Promise<string> {
  let id: string;
  let data: Payload;
  if (reference.startsWith("asset://")) {
    id = reference.slice(8);
    if (!ASSET_ID.test(id)) throw new ProviderError("TuziAPI 素材编号无效", 400, "tuzi-video", "invalid_request");
    data = assetData(await json(`/v1/seedance/assets/${encodeURIComponent(id)}`));
  } else {
    const normalized = await imageReference(reference);
    const { buffer, mime } = parseDataUrl(normalized);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buffer)], { type: mime }), `reference.${mime === "image/jpeg" ? "jpg" : "png"}`);
    data = assetData(await json("/v1/seedance/assets", { method: "POST", body: form }));
    if (typeof data.id !== "string" || !ASSET_ID.test(data.id)) throw new ProviderError("TuziAPI 素材编号无效", 502, "tuzi-video", "invalid_response");
    id = data.id;
  }
  const deadline = Date.now() + 5 * 60_000;
  if (data.status === "pending" && data.compliance_started !== true) {
    data = assetData(await json(`/v1/seedance/assets/${encodeURIComponent(id)}/compliance`, { method: "POST" }));
  }
  while (data.status === "pending" && Date.now() < deadline) {
    await wait(5_000);
    data = assetData(await json(`/v1/seedance/assets/${encodeURIComponent(id)}`));
  }
  if (data.status !== "active") {
    throw new ProviderError("TuziAPI 参考素材尚未通过审核，请检查素材权限及审核状态", 422, "tuzi-video", "invalid_request");
  }
  if (data.asset_type !== "image" || typeof data.reference !== "string" || data.reference !== `asset://${id}`) {
    throw new ProviderError("TuziAPI 返回的素材类型或引用无效", 502, "tuzi-video", "invalid_response");
  }
  return data.reference;
}

async function contentFor(request: ApiYiVideoRequest): Promise<Payload[]> {
  const content: Payload[] = [{ type: "text", text: request.prompt }];
  for (const ref of request.references) {
    if (["first-frame", "last-frame", "reference-image"].includes(ref.role)) {
      content.push({ type: "image_url", role: ref.role.replaceAll("-", "_"), image_url: { url: await approvedImage(ref.url) } });
    } else if (ref.role === "reference-audio") {
      // Audio references are already validated by the execution plan's ownership boundary.
      if (!/^https:\/\//i.test(ref.url) && !/^asset:\/\/[A-Za-z0-9._:-]+$/.test(ref.url)) {
        throw new ProviderError("TuziAPI 音频参考需要 HTTPS 地址或已审核素材", 400, request.model, "invalid_request");
      }
      content.push({ type: "audio_url", role: "reference_audio", audio_url: { url: ref.url } });
    } else {
      // Tuzi's asset API only accepts images/audio. Keep the independent media storage service.
      const url = ref.url.startsWith("/api/files/") ? await uploadLocalVideoReference(ref.url, request.model) : ref.url;
      if (!/^https:\/\//i.test(url)) throw new ProviderError("TuziAPI 视频参考需要 HTTPS 地址", 400, request.model, "invalid_request");
      content.push({ type: "video_url", role: "reference_video", video_url: { url } });
    }
  }
  return content;
}

export async function generateTuziVideo(request: ApiYiVideoRequest): Promise<ApiYiVideoResult> {
  assertRequest(request);
  if (request.mode === "video-edit") throw new ProviderError("TuziAPI 暂不支持视频编辑，请切回 APIYI", 400, request.model, "invalid_request");
  if (request.seconds === -1) throw new ProviderError("TuziAPI 需要明确的视频时长，请关闭智能时长", 400, request.model, "invalid_request");
  let task: ApiYiVideoTask | undefined = request.resumeTask;
  let providerRequests = 0;
  if (!task) {
    const content = await contentFor(request);
    await request.beforeProviderCall?.(1);
    const payload = await json("/v1/videos", {
      method: "POST", headers: { "Content-Type": "application/json", ...(request.idempotencyKey ? { "Idempotency-Key": request.idempotencyKey } : {}) },
      body: JSON.stringify({ model: request.model, content, refer_model: MODES[request.mode],
        resolution: request.resolution.toUpperCase(), ratio: request.aspectRatio, duration: request.seconds,
        generate_audio: request.generateAudio, count: 1, ...(isSeedance25(request.model) ? { output_format: request.outputFormat } : {}) }),
    });
    const id = payload.id ?? payload.task_id;
    if (typeof id !== "string" || !ASSET_ID.test(id)) throw new ProviderError("TuziAPI 未返回有效的视频任务编号", 502, request.model, "outcome_unknown");
    task = { id, model: request.model };
    providerRequests = 1;
    try { await request.onTaskAccepted?.(task); } catch (error) { throw new AcceptedVideoTaskPersistenceError(error); }
  }
  if (!ASSET_ID.test(task.id) || task.model !== request.model) throw new ProviderError("已保存的 TuziAPI 视频任务无效", 500, request.model, "invalid_response");
  const taskPath = `/v1/videos/${encodeURIComponent(task.id)}`;
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const payload = await json(taskPath);
    if (payload.status === "completed") {
      const buffer = await downloadContent(taskPath, payload);
      if (buffer.length < 12 || buffer.subarray(4, 8).toString("ascii") !== "ftyp") throw new ProviderError("TuziAPI 下载内容不是有效视频", 502, task.model, "invalid_response");
      return { video: toDataUrl(buffer.toString("base64"), request.outputFormat === "mov" ? "video/quicktime" : "video/mp4"),
        model: task.model, providerRequests, taskId: task.id, usage: { duration: request.seconds, resolution: request.resolution, ratio: request.aspectRatio } };
    }
    if (payload.status === "failed") throw new ProviderError("TuziAPI 视频生成失败，请检查提示词、参考素材与模型权限", 422, task.model, "invalid_request");
    if (payload.status !== "queued" && payload.status !== "in_progress") throw new ProviderError("TuziAPI 返回未知视频任务状态", 502, task.model, "invalid_response");
    await wait(15_000);
  }
  throw new ProviderError("TuziAPI 视频等待超时，将继续查询已受理任务", 504, task.model, "outcome_unknown");
}

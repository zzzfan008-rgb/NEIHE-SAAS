/**
 * Provider 层共用辅助：错误类型、超时重试 fetch、dataURL 工具。
 * 类型契约从 src/types/workflow.ts 导入，不在此处重复定义。
 */
import { config } from "../config";
import { Agent } from "undici";

type ProviderFetchInit = RequestInit & { dispatcher: Agent };

const providerDispatchers = new Map<string, Agent>();

function boundedTimeout(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return Math.max(minimum, Math.min(fallback, maximum));
  return Math.max(minimum, Math.min(Math.floor(parsed), maximum));
}

function providerDispatcher(totalTimeoutMs: number, minimumResponseTimeoutMs = 1_000): Agent {
  const connectTimeout = boundedTimeout(process.env.AI_CONNECT_TIMEOUT_MS, 30_000, 1_000, totalTimeoutMs);
  const headersTimeout = boundedTimeout(
    process.env.AI_HEADERS_TIMEOUT_MS,
    totalTimeoutMs,
    minimumResponseTimeoutMs,
    totalTimeoutMs,
  );
  const bodyTimeout = boundedTimeout(
    process.env.AI_BODY_TIMEOUT_MS,
    totalTimeoutMs,
    minimumResponseTimeoutMs,
    totalTimeoutMs,
  );
  const key = `${connectTimeout}:${headersTimeout}:${bodyTimeout}`;
  const existing = providerDispatchers.get(key);
  if (existing) return existing;
  const dispatcher = new Agent({
    connect: { timeout: connectTimeout },
    headersTimeout,
    bodyTimeout,
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 120_000,
  });
  providerDispatchers.set(key, dispatcher);
  return dispatcher;
}

export class ProviderError extends Error {
  blockReason?: string;
  finishReason?: string;
  constructor(
    message: string,
    public readonly status?: number,
    public readonly providerId?: string,
    public readonly category: ProviderErrorCategory = "unknown",
    /** 仅供服务端日志诊断，绝不返回浏览器或写入用户运行记录。 */
    public readonly diagnostic?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type ProviderErrorCategory =
  | "content_refused"
  | "image_safety"
  | "model_unavailable"
  | "gateway_authentication"
  | "invalid_request"
  | "rate_limited"
  | "timeout"
  | "outcome_unknown"
  | "gateway_unavailable"
  | "empty_response"
  | "invalid_response"
  | "unknown";

function classifyProviderMessage(status: number | undefined, rawMessage: string): {
  category: ProviderErrorCategory;
  publicMessage: string;
} {
  const message = rawMessage
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (status === 401 || status === 403) {
    return {
      category: "gateway_authentication",
      publicMessage: "AI 网关鉴权失败，请联系管理员检查 API Key 或账号权限",
    };
  }
  const contentRefused =
    /content\s*(policy|filter)|content management policy|responsible\s*ai\s*policy\s*violation|responsibleaipolicyviolation/i.test(message) ||
    /(safety system|moderation).{0,50}(block|filter|reject|refus)/i.test(message) ||
    /(block|filter|reject|refus).{0,50}(safety system|moderation|content management policy)/i.test(message) ||
    /内容.{0,12}(安全|审核|政策|过滤).{0,12}(拦截|过滤|拒绝|违规)|内容.{0,10}(拒绝|违规)/i.test(message);
  if (contentRefused) {
    return {
      category: "content_refused",
      publicMessage: "本次请求未通过 AI 安全审核，请调整提示词或参考图片后重试",
    };
  }
  if (/model.{0,40}(not found|does not exist|unsupported|not available|invalid)|unknown model|模型.{0,10}(不存在|不可用|不支持)/i.test(message)) {
    return {
      category: "model_unavailable",
      publicMessage: "当前 AI 模型不可用，请联系管理员检查模型配置",
    };
  }
  const deterministicParameterError =
    /(invalid|unknown|unsupported|not supported|out of range).{0,60}(parameter|argument|field|resolution|aspect ratio|size|width|height|format|image count)/i.test(message) ||
    /(parameter|argument|field|resolution|aspect ratio|size|width|height|format|image count).{0,60}(invalid|unknown|unsupported|not supported|out of range|must be|only supports?)/i.test(message);
  if (deterministicParameterError) {
    return {
      category: "invalid_request",
      publicMessage: "AI 服务暂不支持当前参数或参考图组合，请调整后重试",
    };
  }
  if (status === 429) {
    return { category: "rate_limited", publicMessage: "AI 服务当前繁忙，请稍后重试" };
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return {
      category: "invalid_request",
      publicMessage: "AI 服务暂不支持当前参数或参考图组合，请调整后重试",
    };
  }
  if (status !== undefined && status >= 500) {
    return { category: "gateway_unavailable", publicMessage: "AI 服务暂时不可用，请稍后重试" };
  }
  return { category: "unknown", publicMessage: "AI 服务返回异常，请稍后重试" };
}

export function providerErrorFromResponse(status: number, responseBody: string, providerId?: string): ProviderError {
  const classified = classifyProviderMessage(status, responseBody);
  return new ProviderError(
    classified.publicMessage,
    status,
    providerId,
    classified.category,
    `HTTP ${status}: ${responseBody.slice(0, 2_000)}`,
  );
}

export function providerErrorFromMessage(message: string, providerId?: string, status?: number): ProviderError {
  const classified = classifyProviderMessage(status, message);
  return new ProviderError(classified.publicMessage, status, providerId, classified.category, message.slice(0, 2_000));
}

export function publicProviderErrorMessage(error: unknown): string {
  if (error instanceof ProviderError) return error.message;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "AI 服务响应超时，请稍后重试";
  }
  return "AI 服务暂时不可用，请稍后重试";
}

/** 将仅供服务端使用的网关诊断压缩并脱敏，避免日志泄露 Key、URL 或图片数据。 */
export function sanitizedProviderDiagnostic(error: ProviderError): string | undefined {
  if (!error.diagnostic) return undefined;
  const redact = (value: string) => value
    .replace(/(?:bearer\s+)?sk-[a-z0-9_-]+/gi, "[redacted-key]")
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "[redacted-image]")
    .replace(/https?:\/\/[^\s\"']+/gi, "[redacted-url]")
    .slice(0, 800);
  const match = /^HTTP\s+(\d+):\s*([\s\S]*)$/i.exec(error.diagnostic);
  if (!match) return redact(error.diagnostic);
  try {
    const parsed = JSON.parse(match[2]) as { error?: unknown };
    const source = typeof parsed.error === "object" && parsed.error !== null
      ? parsed.error as Record<string, unknown>
      : parsed as Record<string, unknown>;
    const safe = Object.fromEntries(
      ["message", "type", "code", "param", "status"]
        .filter((key) => typeof source[key] === "string" || typeof source[key] === "number")
        .map((key) => [key, redact(String(source[key]))]),
    );
    return `HTTP ${match[1]}: ${JSON.stringify(safe)}`;
  } catch {
    return `HTTP ${match[1]}: ${redact(match[2])}`;
  }
}

export class NotImplementedError extends ProviderError {
  constructor(feature: string) {
    super(`Not implemented: ${feature}`);
    this.name = "NotImplementedError";
  }
}

/**
 * 单次 Provider 请求出口。重试统一由 PostgreSQL Worker 调度；Provider 层本身不重放。
 * 网络错误、超时或连接中断可能已经产生计费，因此标记为 outcome_unknown，
 * Worker 会按用户确认的策略最多自动重试两次。
 */
export async function fetchWithRetry(
  url: string,
  initFactory: () => RequestInit,
  opts?: {
    timeoutMs?: number;
    minimumResponseTimeoutMs?: number;
    maxRetries?: number;
    providerId?: string;
  },
): Promise<Response> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ProviderError("AI 网关地址无效，请联系管理员检查配置", 400, opts?.providerId, "invalid_request");
  }
  if (parsedUrl.protocol !== "https:") {
    throw new ProviderError(
      "AI 网关必须使用 HTTPS，请联系管理员检查配置",
      400,
      opts?.providerId,
      "invalid_request",
      `Blocked non-HTTPS provider URL with protocol ${parsedUrl.protocol}`,
    );
  }
  const timeoutMs = opts?.timeoutMs ?? config.aiTimeoutMs();
  void opts?.maxRetries;
  try {
    const requestInit: ProviderFetchInit = {
      ...initFactory(),
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: providerDispatcher(timeoutMs, Math.min(
        timeoutMs,
        Math.max(1_000, opts?.minimumResponseTimeoutMs ?? 1_000),
      )),
    };
    const res = await fetch(url, requestInit);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw providerErrorFromResponse(res.status, body, opts?.providerId);
    }
    return res;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new ProviderError(
      timedOut
        ? "AI 请求已超时，结果可能已经生成；系统将按上限自动重试，可能产生重复扣费"
        : "AI 连接中断，结果可能已经生成；系统将按上限自动重试，可能产生重复扣费",
      timedOut ? 504 : 502,
      opts?.providerId,
      "outcome_unknown",
      transportErrorDiagnostic(error),
    );
  }
}

function transportErrorDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause && typeof error.cause === "object"
    ? error.cause as { code?: unknown; name?: unknown; message?: unknown }
    : undefined;
  return [
    error.message,
    typeof cause?.code === "string" ? `cause.code=${cause.code}` : undefined,
    typeof cause?.name === "string" ? `cause.name=${cause.name}` : undefined,
    typeof cause?.message === "string" ? `cause.message=${cause.message}` : undefined,
  ].filter(Boolean).join("; ");
}

// ---------- dataURL 工具 ----------

export interface ParsedDataUrl {
  mime: string;
  base64: string;
  buffer: Buffer;
}

/** 解析 "data:image/png;base64,xxxx" */
export function parseDataUrl(dataUrl: string): ParsedDataUrl {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m || !m[2]) {
    throw new ProviderError("Invalid dataURL (expected base64)");
  }
  const mime = m[1] || "image/png";
  const base64 = m[3];
  return { mime, base64, buffer: Buffer.from(base64, "base64") };
}

export function toDataUrl(base64: string, mime = "image/png"): string {
  return `data:${mime};base64,${base64}`;
}

/** aspectRatio → gpt-image size 映射 */
export function aspectRatioToSize(aspectRatio?: string): string {
  switch (aspectRatio) {
    case "3:4":
    case "9:16":
      return "1024x1536";
    case "4:3":
    case "16:9":
      return "1536x1024";
    default:
      return "1024x1024";
  }
}

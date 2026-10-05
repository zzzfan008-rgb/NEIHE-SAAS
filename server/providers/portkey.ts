import { config } from "../config";
import type { AiGatewayId } from "../../src/types/aiGateway";
import { currentAiGateway } from "./gatewayContext";

/** Portkey client configuration only. Portkey's conditional router owns target selection. */
export function portkeyRequest(
  upstreamUrl: string,
  init: RequestInit,
  options: { gateway?: AiGatewayId; video?: boolean; timeoutMs: number },
): { url: string; init: RequestInit } {
  const gateway = options.gateway ?? currentAiGateway();
  const source = (id: AiGatewayId) => ({
    base: id === "apiyi" && options.video ? config.seedanceApiBaseUrl() : config.aiBaseUrl(id),
    key: id === "apiyi" && options.video ? config.seedanceApiKey() : config.aiApiKey(id),
  });
  const selected = source(gateway);
  if (!upstreamUrl.startsWith(`${selected.base}/`)) throw new Error("供应商请求地址与任务绑定不匹配");
  const suffix = upstreamUrl.slice(selected.base.length);
  const targets = (["apiyi", "tuzi"] as const).flatMap((id) => {
    try {
      const { base, key } = source(id);
      const parsed = new URL(base);
      if (!key.trim() || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return [];
      return [{ name: id, provider: "openai", api_key: key, custom_host: base }];
    } catch { return []; }
  });
  if (!targets.some((target) => target.name === gateway)) throw new Error("该供应商尚未配置");
  const headers = new Headers(init.headers);
  // The browser never supplies these headers. Avoid leaking either provider key to the wrong target.
  headers.delete("authorization");
  headers.delete("host");
  for (const name of [...headers.keys()]) if (name.startsWith("x-portkey-")) headers.delete(name);
  headers.set("x-portkey-config", JSON.stringify({
    strategy: {
      mode: "conditional",
      conditions: ["apiyi", "tuzi"].map((id) => ({ query: { "metadata.supplier": { $eq: id } }, then: id })),
      default: "unconfigured-supplier",
    },
    targets,
    retry: { attempts: 0 },
    request_timeout: options.timeoutMs,
  }));
  headers.set("x-portkey-metadata", JSON.stringify({ supplier: gateway }));
  // /v1 is Portkey's proxy prefix; retain the full native path, including the upstream /v1.
  return { url: `${config.portkeyBaseUrl()}/v1${suffix}`, init: { ...init, headers, redirect: "error" } };
}

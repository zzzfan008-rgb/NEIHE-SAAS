import type { ImageModelId } from "../../src/types/imageModels";
import { parseOpenAiImages } from "./apiyi";
import { ProviderError } from "./base";

const MAX_RESPONSE_BYTES = 80 * 1024 * 1024;

/** Read one non-streaming JSON object, even over chunked HTTP. Scan once, then
 * decode/parse once: no gateway EOF wait or repeated copying of a Base64 body. */
export async function readTuziImageJson(response: Response, modelId: ImageModelId): Promise<unknown> {
  if (!response.body) throw new ProviderError("TuziAPI 响应缺少内容", 502, modelId, "outcome_unknown");
  const reader = response.body.getReader();
  const invalid = () => new ProviderError("TuziAPI 图片响应格式无效", 502, modelId, "invalid_response");
  const oversized = () => new ProviderError("AI 图片响应体积超过系统安全上限", 502, modelId, "invalid_response");
  const chunks: Uint8Array[] = [];
  const closing: number[] = [];
  let total = 0;
  let started = false;
  let complete = false;
  let inString = false;
  let escaped = false;
  try {
    if (response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) throw invalid();
    const length = response.headers.get("content-length");
    if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) throw oversized();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new ProviderError("TuziAPI 响应不完整，结果可能已经生成，请核查生成记录", 502, modelId, "outcome_unknown");
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw oversized();
      chunks.push(value);
      for (const byte of value) {
        const whitespace = byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
        if (complete) { if (!whitespace) throw invalid(); continue; }
        if (!started) {
          if (whitespace) continue;
          if (byte !== 0x7b) throw invalid();
          started = true;
        }
        if (inString) {
          if (escaped) escaped = false;
          else if (byte === 0x5c) escaped = true;
          else if (byte === 0x22) inString = false;
          else if (byte < 0x20) throw invalid();
        } else if (byte === 0x22) inString = true;
        else if (byte === 0x7b || byte === 0x5b) {
          closing.push(byte === 0x7b ? 0x7d : 0x5d);
          if (closing.length > 128) throw invalid();
        } else if (byte === 0x7d || byte === 0x5d) {
          if (closing.pop() !== byte) throw invalid();
          complete = closing.length === 0;
        }
      }
      if (complete) {
        try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total))); }
        catch { throw invalid(); }
      }
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    // Transport text can contain credentials, URLs or response data: omit it.
    throw new ProviderError("TuziAPI 响应中断，结果可能已经生成，请核查生成记录", 502, modelId, "outcome_unknown");
  } finally {
    // Awaiting cancellation can itself wait for the remote EOF.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function parseTuziImageJson(payload: unknown, modelId: ImageModelId): Promise<string[]> {
  // Images may include b64_json:null alongside a valid URL. Adapt locally;
  // retain APIYI's parser and never infer refusal from missing image content.
  if (payload && typeof payload === "object" && "data" in payload && Array.isArray(payload.data)) {
    payload = { ...payload, data: payload.data.map((item: unknown) => {
      if (item && typeof item === "object" && "b64_json" in item && (item.b64_json == null || item.b64_json === "")) {
        const { b64_json: _unused, ...rest } = item;
        return rest;
      }
      return item;
    }) };
  }
  return parseOpenAiImages(payload, modelId, { maxImages: 1 });
}

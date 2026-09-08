import { config } from "../config";
import { fetchWithRetry, parseDataUrl, ProviderError } from "../providers/base";

export interface TryOnCandidateScore {
  index: number;
  identity: number;
  anatomy: number;
  garment: number;
  material: number;
  accessories: number;
  scene: number;
  total: number;
  hardFail: boolean;
  reasons: string[];
}

export interface TryOnCandidateSelection {
  selectedIndex: number | null;
  scores: TryOnCandidateScore[];
  model: string;
  providerRequests: number;
  allHardFail: boolean;
}

export interface TryOnCandidateSelectionInput {
  stage: "scene-stabilize" | "garment-refine";
  candidates: string[];
  referenceImages: string[];
  referenceRoles: string[];
  prompt: string;
  beforeProviderCall?: (providerRequest: number) => void | Promise<void>;
}

export type TryOnCandidateSelector = (
  input: TryOnCandidateSelectionInput,
) => Promise<TryOnCandidateSelection>;

function integerScore(value: unknown, max: number, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > max) {
    throw new ProviderError(`候选评分字段 ${field} 无效`, 502, "try-on-judge", "invalid_response");
  }
  return Number(value);
}

export function parseTryOnCandidateSelection(payload: unknown, count: number, model: string): TryOnCandidateSelection {
  const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })
    .choices?.[0]?.message?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.flatMap((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : []).join("")
      : "";
  if (!text) throw new ProviderError("候选评审未返回结果", 502, model, "empty_response");
  const normalized = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  let raw: unknown;
  try {
    raw = JSON.parse(normalized);
  } catch {
    throw new ProviderError("候选评审返回的 JSON 无效", 502, model, "invalid_response");
  }
  const rows = (raw as { scores?: unknown }).scores;
  if (!Array.isArray(rows) || rows.length !== count) {
    throw new ProviderError("候选评审数量不匹配", 502, model, "invalid_response");
  }
  const seen = new Set<number>();
  const scores = rows.map((value, rowIndex): TryOnCandidateScore => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ProviderError("候选评分格式无效", 502, model, "invalid_response");
    }
    const row = value as Record<string, unknown>;
    const index = integerScore(row.index, count - 1, `scores[${rowIndex}].index`);
    if (seen.has(index)) throw new ProviderError("候选评分索引重复", 502, model, "invalid_response");
    seen.add(index);
    const identity = integerScore(row.identity, 20, "identity");
    const anatomy = integerScore(row.anatomy, 15, "anatomy");
    const garment = integerScore(row.garment, 20, "garment");
    const material = integerScore(row.material, 20, "material");
    const accessories = integerScore(row.accessories, 15, "accessories");
    const scene = integerScore(row.scene, 10, "scene");
    const reasons = Array.isArray(row.reasons)
      ? row.reasons.filter((reason): reason is string => typeof reason === "string").slice(0, 8)
      : [];
    return {
      index, identity, anatomy, garment, material, accessories, scene,
      total: identity + anatomy + garment + material + accessories + scene,
      hardFail: row.hardFail === true,
      reasons,
    };
  }).sort((left, right) => left.index - right.index);
  const eligible = scores.filter((score) => !score.hardFail);
  const selected = [...eligible].sort((left, right) => right.total - left.total || left.index - right.index)[0];
  return {
    selectedIndex: selected?.index ?? null,
    scores,
    model,
    providerRequests: 1,
    allHardFail: eligible.length === 0,
  };
}

export const selectBestTryOnCandidate: TryOnCandidateSelector = async (input) => {
  if (input.candidates.length < 2) {
    return {
      selectedIndex: 0,
      scores: [],
      model: "single-candidate",
      providerRequests: 0,
      allHardFail: false,
    };
  }
  const model = config.tryOnJudgeModel();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("换装评审模型配置无效");
  const roleText = input.referenceRoles.map((role, index) => `参考${index + 1}=${role}`).join("，");
  const content: Array<Record<string, unknown>> = [{
    type: "text",
    text: `你是写实服装换装候选评审器。阶段=${input.stage}。${roleText}。下面先给参考图，再给候选图。严格按指令符合度、身份20、肢体结构15、服装版型20、材质纹理20、配饰与文字准确性15、构图与场景10评分。身份替换、明显多肢缺肢、严重手脚错误、场景服装污染、核心穿搭错误、虚构或改写 Logo/文字、核心包鞋缺失必须 hardFail=true。只返回 JSON：{\"scores\":[{\"index\":0,\"identity\":0,\"anatomy\":0,\"garment\":0,\"material\":0,\"accessories\":0,\"scene\":0,\"hardFail\":false,\"reasons\":[\"具体问题\"]}]}。index 从0开始且每张候选恰好一项。目标提示词：${input.prompt}`,
  }];
  input.referenceImages.forEach((image, index) => {
    parseDataUrl(image);
    content.push({ type: "text", text: `参考图 ${index + 1}，角色：${input.referenceRoles[index] ?? "unknown"}` });
    content.push({ type: "image_url", image_url: { url: image } });
  });
  input.candidates.forEach((image, index) => {
    parseDataUrl(image);
    content.push({ type: "text", text: `候选图 ${index}，评分结果的 index 必须为 ${index}` });
    content.push({ type: "image_url", image_url: { url: image } });
  });
  await input.beforeProviderCall?.(1);
  const response = await fetchWithRetry(
    `${config.apiyiBaseUrl()}/v1/chat/completions`,
    () => ({
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content }],
      }),
    }),
    { timeoutMs: config.aiTimeoutMs(180_000), providerId: model, maxRetries: 0 },
  );
  return parseTryOnCandidateSelection(await response.json(), input.candidates.length, model);
};

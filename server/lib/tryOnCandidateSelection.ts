import { config } from "../config";
import sharp from "sharp";
import { fetchWithRetry, parseDataUrl, ProviderError } from "../providers/base";

export interface TryOnPoseChecks {
  headAndTorso: boolean;
  armsAndHands: boolean;
  legsAndWeight: boolean;
}

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
  poseMatches?: boolean;
  poseChecks?: TryOnPoseChecks;
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

function parsePoseChecks(
  value: unknown,
  required: boolean,
): TryOnPoseChecks | undefined {
  if (value === undefined && !required) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError("候选评审缺少有效的姿势分项判定", 502, "try-on-judge", "invalid_response");
  }
  const checks = value as Record<string, unknown>;
  const fields = ["headAndTorso", "armsAndHands", "legsAndWeight"] as const;
  for (const field of fields) {
    if (typeof checks[field] !== "boolean") {
      throw new ProviderError("候选评审缺少有效的姿势分项判定", 502, "try-on-judge", "invalid_response");
    }
  }
  return {
    headAndTorso: checks.headAndTorso as boolean,
    armsAndHands: checks.armsAndHands as boolean,
    legsAndWeight: checks.legsAndWeight as boolean,
  };
}

export function parseTryOnCandidateSelection(
  payload: unknown,
  count: number,
  model: string,
  requirePose = false,
  requirePoseChecks = false,
): TryOnCandidateSelection {
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
  const rows = raw && typeof raw === "object" ? (raw as { scores?: unknown }).scores : undefined;
  if (!Array.isArray(rows) || rows.length !== count) {
    throw new ProviderError("候选评审数量不匹配", 502, model, "invalid_response");
  }
  const seen = new Set<number>();
  const scores = rows.map((value, rowIndex): TryOnCandidateScore => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ProviderError("候选评分格式无效", 502, model, "invalid_response");
    }
    const row = value as Record<string, unknown>;
    const reportedHardFail = row.hardFail;
    const poseMatches = typeof row.poseMatches === "boolean"
      ? row.poseMatches
      : undefined;
    if (typeof reportedHardFail !== "boolean" || (requirePose && poseMatches === undefined)) {
      throw new ProviderError("候选评审缺少有效的姿势或硬失败判定", 502, model, "invalid_response");
    }
    const poseChecks = parsePoseChecks(row.poseChecks, requirePoseChecks);
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
    const poseCheckFailed = requirePoseChecks && (
      !poseChecks?.headAndTorso ||
      !poseChecks.armsAndHands ||
      !poseChecks.legsAndWeight
    );
    return {
      index, identity, anatomy, garment, material, accessories, scene,
      total: identity + anatomy + garment + material + accessories + scene,
      hardFail: reportedHardFail || (requirePose && poseMatches === false) || poseCheckFailed,
      poseMatches,
      poseChecks,
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
  if (input.stage === "scene-stabilize" && !input.referenceRoles.includes("scene")) {
    throw new ProviderError("候选评审缺少原始场景参考图", 400, model, "invalid_request");
  }
  if (input.stage === "scene-stabilize" && !input.referenceRoles.includes("pose")) {
    throw new ProviderError("候选评审缺少原始人物姿势参考图", 400, model, "invalid_request");
  }
  const poseChecksSchema = input.stage === "scene-stabilize"
    ? ',"poseChecks":{"headAndTorso":true,"armsAndHands":true,"legsAndWeight":true}'
    : "";
  const content: Array<Record<string, unknown>> = [{
    type: "text",
    text: `你是写实服装换装候选评审器。阶段=${input.stage}。${roleText}。下面先给参考图，再给候选图。严格按指令符合度、身份20、肢体结构15、服装版型20、材质纹理20、配饰与文字准确性15、构图与场景10评分。身份替换、明显多肢缺肢、严重手脚错误、场景服装污染、核心穿搭错误、虚构或改写 Logo/文字、核心包鞋缺失必须 hardFail=true。只返回 JSON：{\"scores\":[{\"index\":0,\"identity\":0,\"anatomy\":0,\"garment\":0,\"material\":0,\"accessories\":0,\"scene\":0,\"hardFail\":false,\"poseMatches\":true${poseChecksSchema},\"reasons\":[\"具体问题\"]}]}。index 从0开始且每张候选恰好一项。目标提示词：${input.prompt}`,
  }];
  content.push({
    type: "text",
    text: input.stage === "scene-stabilize"
      ? "每项评分必须返回布尔字段 poseMatches 和 poseChecks，其中 poseChecks 必须包含 headAndTorso、armsAndHands、legsAndWeight 三项。pose 参考图是第一轮姿势判断的唯一标准；它是用户手动选择的原图、骨骼图或深度图，不得要求其携带人物身份或衣物。仅对照该类型图片能够表达的几何，不因骨骼或深度图缺少外观而扣分；不得偏好站姿、坐姿或任何所谓“标准姿势”，不得因姿态类型本身加分或扣分，只能依据候选与 pose 参考图的姿势一致性判断。第一轮必须直接对照 pose 参考图检查头部俯仰、侧倾、视线、肩线、髋线、重心腿、膝踝、手臂与手部位置，禁止用 person 或 scene 的人物姿势代替 pose。headAndTorso 检查头部、视线、肩髋线与躯干倾斜；armsAndHands 检查双臂、肘腕、手部位置与接触关系；legsAndWeight 检查重心腿、膝踝和交叉或前后关系。任一分项为 false，或因遮挡与图像质量无法判断，必须 poseMatches=false 且 hardFail=true；不能仅凭相同背景、交叉腿或局部手势判为一致。scene 只用于核对背景空间、镜头、构图与光线，并检查候选没有继承 scene 中任何人物或服装。身份、环境、服装和姿势分别按各自角色核对。"
      : "每项评分必须返回布尔字段 poseMatches。第二轮对照 baseline 保持姿势；身份、环境、服装和姿势分别按各自角色核对。明显姿势偏差必须 poseMatches=false 且 hardFail=true，并说明具体差异。",
  });
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
  // Bound the judge payload without changing generation references or their aspect ratios.
  for (const part of content) {
    if (part.type !== "image_url") continue;
    const image = part.image_url as { url: string };
    const { buffer } = parseDataUrl(image.url);
    const thumbnail = await sharp(buffer).rotate().resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    image.url = `data:image/jpeg;base64,${thumbnail.toString("base64")}`;
  }
  for (let attempt = 0; ; attempt += 1) {
    await input.beforeProviderCall?.(attempt + 1);
    try {
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
      const selection = parseTryOnCandidateSelection(
        await response.json(),
        input.candidates.length,
        model,
        true,
        input.stage === "scene-stabilize",
      );
      return { ...selection, providerRequests: attempt + 1 };
    } catch (error) {
      const retryable = error instanceof SyntaxError || (error instanceof ProviderError &&
        ["invalid_response", "empty_response", "timeout", "gateway_unavailable"].includes(error.category));
      if (attempt >= 1 || !retryable) throw error;
    }
  }
};

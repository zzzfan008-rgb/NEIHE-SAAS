import {
  validateInputManifest,
  validateOutputCount,
} from "../../src/lib/imageConversationRules";
import type {
  ConversationImageInput,
  ImageConversationMode,
  ImageConversationParameters,
  ImageConversationPlan,
} from "../../src/types/imageConversation";

export interface ImageConversationPlannerInput {
  mode: ImageConversationMode;
  prompt: string;
  clarificationAnswer?: string;
  clarificationHistory?: Array<{ question: string; answer: string }>;
  sourceResultId: string | null;
  inputManifest: ConversationImageInput[];
  parameters: ImageConversationParameters;
  effectiveRequirements: Record<string, unknown>;
}

export interface ImageConversationPlannerRequest {
  systemPrompt: string;
  userPayload: ImageConversationPlannerInput;
}

export interface ImageConversationPlannerModel {
  complete(request: ImageConversationPlannerRequest): Promise<unknown>;
}

export type ImageConversationPlannerErrorCode =
  | "timeout"
  | "invalid_response"
  | "model_error";

export class ImageConversationPlannerError extends Error {
  readonly code: ImageConversationPlannerErrorCode;

  constructor(code: ImageConversationPlannerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ImageConversationPlannerError";
    this.code = code;
  }
}

export const IMAGE_CONVERSATION_PLANNER_SYSTEM_PROMPT = [
  "你是图片修改对话的结构化规划器。只根据用户原文、已授权输入和有效要求生成 JSON。",
  "不要改变输入图片清单、蒙版、模型、画质、尺寸、比例或项目权限；这些字段由服务端控制。",
  "未表达多方案时输出一个意图；同一张图片的多个修改要求仍属于一个意图。",
  "明确数量与独立效果数量不一致时输出 clarification，不补足、不截断、不自动分批。",
  "输出只能是设计契约中的 ready、clarification 或 rejected JSON，不要 Markdown 或解释文本。",
  'ready 契约：{"kind":"ready","outputCount":1,"intents":[{"ordinal":1,"label":"简短标题","instruction":"完整独立执行指令","requirements":{}}]}。outputCount 必须是 1–8 整数，intents 长度必须相等，ordinal 从 1 连续递增；label 为 1–160 字符，instruction 为 1–12000 字符。',
  'clarification 契约：{"kind":"clarification","reason":"ambiguous_requirement","question":"需要确认的问题"}。reason 仅允许 ambiguous_requirement 或 count_mismatch；后者必须提供 requestedCount（1–8整数）和 specifiedIntentCount（0–8整数）且二者不同。question 为 1–2000 字符。',
  'rejected 契约：{"kind":"rejected","code":"count_exceeded","message":"拒绝原因"}。code 仅允许 count_exceeded 或 invalid_plan，message 为 1–2000 字符。',
  "requirements 是修改要求对象；任意层级禁止 ownerId、projectId、sourceRef、sourceRefs、inputManifest、maskRef、generationOutputId、generationRunId、outputCount、modelId、quality、size、aspectRatio。",
  "clarificationHistory 按时间排列，包含历史问题及回答与本次问题及回答；综合全部回答规划，不得遗失之前确认的要求。",
].join("\n");

const MAX_LABEL_LENGTH = 160;
const MAX_INSTRUCTION_LENGTH = 12_000;
const MAX_QUESTION_LENGTH = 2_000;
const MAX_MESSAGE_LENGTH = 2_000;
const FORBIDDEN_CONTROL_KEYS = new Set([
  "ownerId",
  "projectId",
  "sourceRef",
  "sourceRefs",
  "inputManifest",
  "maskRef",
  "generationOutputId",
  "generationRunId",
  "outputCount",
  "modelId",
  "quality",
  "size",
  "aspectRatio",
]);

export class ImageConversationPlanner {
  constructor(
    private readonly model: ImageConversationPlannerModel,
    private readonly timeoutMs = 30_000,
  ) {}

  async plan(input: ImageConversationPlannerInput): Promise<ImageConversationPlan> {
    validatePlannerInput(input);
    const request: ImageConversationPlannerRequest = {
      systemPrompt: IMAGE_CONVERSATION_PLANNER_SYSTEM_PROMPT,
      userPayload: clonePlannerInput(input),
    };
    let raw: unknown;
    try {
      raw = await withTimeout(this.model.complete(request), this.timeoutMs);
    } catch (error) {
      if (error instanceof ImageConversationPlannerError) throw error;
      throw new ImageConversationPlannerError("model_error", "image conversation planner failed", { cause: error });
    }
    try {
      return parseImageConversationPlan(raw);
    } catch (error) {
      if (error instanceof ImageConversationPlannerError) throw error;
      throw new ImageConversationPlannerError("invalid_response", "image conversation planner returned invalid JSON", { cause: error });
    }
  }
}

export function validatePlannerInput(input: ImageConversationPlannerInput): true {
  if (!input || typeof input !== "object") throw new Error("planner input is required");
  if (typeof input.prompt !== "string" || !input.prompt.trim()) throw new Error("planner prompt is required");
  if (input.clarificationAnswer !== undefined && (
    typeof input.clarificationAnswer !== "string" ||
    !input.clarificationAnswer.trim() ||
    input.clarificationAnswer.length > MAX_MESSAGE_LENGTH
  )) {
    throw new Error("planner clarification answer is invalid");
  }
  validateInputManifest(input.mode, input.inputManifest);
  validateOutputCount(input.parameters.outputCount);
  if (typeof input.parameters.modelId !== "string" || !input.parameters.modelId.trim()) {
    throw new Error("planner model is required");
  }
  if (typeof input.parameters.quality !== "string" || !input.parameters.quality.trim()) {
    throw new Error("planner quality is required");
  }
  if (!isPlainRecord(input.effectiveRequirements)) throw new Error("planner requirements are invalid");
  return true;
}

export function parseImageConversationPlan(raw: unknown): ImageConversationPlan {
  const value = parseStructuredValue(raw);
  if (!isPlainRecord(value) || typeof value.kind !== "string") {
    throw new ImageConversationPlannerError("invalid_response", "planner response must be an object with a kind");
  }
  if (value.kind === "ready") return parseReadyPlan(value);
  if (value.kind === "clarification") return parseClarificationPlan(value);
  if (value.kind === "rejected") return parseRejectedPlan(value);
  throw new ImageConversationPlannerError("invalid_response", "planner response kind is invalid");
}

function parseReadyPlan(value: Record<string, unknown>): ImageConversationPlan {
  const outputCount = value.outputCount;
  if (!isInteger(outputCount) || outputCount < 1 || outputCount > 8) {
    throw new ImageConversationPlannerError("invalid_response", "planner output count must be an integer between 1 and 8");
  }
  if (!Array.isArray(value.intents) || value.intents.length !== outputCount) {
    throw new ImageConversationPlannerError("invalid_response", "planner intent count must equal output count");
  }
  const intents = value.intents.map((intent, index) => {
    if (!isPlainRecord(intent)) throw new ImageConversationPlannerError("invalid_response", "planner intent is invalid");
    if (intent.ordinal !== index + 1) {
      throw new ImageConversationPlannerError("invalid_response", "planner intent ordinals must be sequential");
    }
    const label = boundedString(intent.label, MAX_LABEL_LENGTH, "planner intent label");
    const instruction = boundedString(intent.instruction, MAX_INSTRUCTION_LENGTH, "planner intent instruction");
    if (!isPlainRecord(intent.requirements)) {
      throw new ImageConversationPlannerError("invalid_response", "planner intent requirements are invalid");
    }
    rejectControlOverrides(intent.requirements);
    return {
      ordinal: index + 1,
      label,
      instruction,
      requirements: cloneRecord(intent.requirements),
    };
  });
  return { kind: "ready", outputCount, intents };
}

function parseClarificationPlan(value: Record<string, unknown>): ImageConversationPlan {
  const question = boundedString(value.question, MAX_QUESTION_LENGTH, "planner clarification question");
  if (value.reason !== "count_mismatch" && value.reason !== "ambiguous_requirement") {
    throw new ImageConversationPlannerError("invalid_response", "planner clarification reason is invalid");
  }
  const requestedCount = optionalCount(value.requestedCount);
  const specifiedIntentCount = optionalIntentCount(value.specifiedIntentCount);
  if (value.reason === "count_mismatch" && (
    requestedCount === undefined || specifiedIntentCount === undefined || requestedCount === specifiedIntentCount
  )) {
    throw new ImageConversationPlannerError("invalid_response", "count clarification must include different counts");
  }
  return {
    kind: "clarification",
    question,
    reason: value.reason,
    ...(requestedCount === undefined ? {} : { requestedCount }),
    ...(specifiedIntentCount === undefined ? {} : { specifiedIntentCount }),
  };
}

function parseRejectedPlan(value: Record<string, unknown>): ImageConversationPlan {
  if (value.code !== "count_exceeded" && value.code !== "invalid_plan") {
    throw new ImageConversationPlannerError("invalid_response", "planner rejection code is invalid");
  }
  return {
    kind: "rejected",
    code: value.code,
    message: boundedString(value.message, MAX_MESSAGE_LENGTH, "planner rejection message"),
  };
}

function parseStructuredValue(raw: unknown): unknown {
  if (typeof raw === "string") return parseJson(raw);
  if (!isPlainRecord(raw)) return raw;
  const choices = raw.choices;
  if (Array.isArray(choices) && choices.length > 0 && isPlainRecord(choices[0])) {
    const message = choices[0].message;
    if (isPlainRecord(message) && typeof message.content === "string") return parseJson(message.content);
  }
  return raw;
}

function parseJson(value: string): unknown {
  if (!value.trim() || value.trim().startsWith("``")) {
    throw new ImageConversationPlannerError("invalid_response", "planner response must be strict JSON");
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new ImageConversationPlannerError("invalid_response", "planner response must be valid JSON", { cause: error });
  }
}

function rejectControlOverrides(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_CONTROL_KEYS.has(key)) {
      throw new ImageConversationPlannerError("invalid_response", `planner cannot override ${key}`);
    }
    const child = value[key];
    if (isPlainRecord(child)) rejectControlOverrides(child);
    if (Array.isArray(child)) {
      for (const item of child) if (isPlainRecord(item)) rejectControlOverrides(item);
    }
  }
}

function boundedString(value: unknown, maxLength: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new ImageConversationPlannerError("invalid_response", `${field} is invalid`);
  }
  return value.trim();
}

function optionalCount(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!isInteger(value) || value < 1 || value > 8) {
    throw new ImageConversationPlannerError("invalid_response", "planner requested count is invalid");
  }
  return value;
}

function optionalIntentCount(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!isInteger(value) || value < 0 || value > 8) {
    throw new ImageConversationPlannerError("invalid_response", "planner specified intent count is invalid");
  }
  return value;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function clonePlannerInput(input: ImageConversationPlannerInput): ImageConversationPlannerInput {
  return JSON.parse(JSON.stringify(input)) as ImageConversationPlannerInput;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new ImageConversationPlannerError("timeout", "image conversation planner timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

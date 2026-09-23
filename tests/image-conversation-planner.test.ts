import assert from "node:assert/strict";
import { ApiYiImageConversationPlannerModel } from "../server/providers/imageConversationPlanner";
import { ProviderError } from "../server/providers/base";
import {
  ImageConversationPlanner,
  ImageConversationPlannerError,
  type ImageConversationPlannerRequest,
  parseImageConversationPlan,
} from "../server/lib/imageConversationPlanner";
import type { ImageConversationPlannerInput } from "../server/lib/imageConversationPlanner";

const input: ImageConversationPlannerInput = {
  mode: "single",
  prompt: "把上衣改成蓝色，缩短袖子，保留背景",
  sourceResultId: "result-a",
  inputManifest: [{ role: "base", ordinal: 0, sourceRef: "/api/files/base.png" }],
  parameters: { modelId: "sunburst", quality: "medium", outputCount: 1, size: "2K" },
  effectiveRequirements: { background: "unchanged" },
};

function ready(count: number, labels: string[]) {
  return {
    kind: "ready" as const,
    outputCount: count,
    intents: labels.map((label, index) => ({
      ordinal: index + 1,
      label,
      instruction: label === "综合修改"
        ? "把上衣改成蓝色，缩短袖子，并保持背景不变"
        : `生成${label}效果`,
      requirements: label === "综合修改" ? { color: "blue", sleeve: "shorter" } : { view: label },
    })),
  };
}

async function planWith(
  response: unknown,
  options?: { timeoutMs?: number; plannerInput?: ImageConversationPlannerInput },
) {
  let seen: ImageConversationPlannerRequest | undefined;
  const planner = new ImageConversationPlanner({
    async complete(request) {
      seen = request;
      return response;
    },
  }, options?.timeoutMs ?? 100);
  const result = await planner.plan(options?.plannerInput ?? input);
  return { result, seen };
}

const fixtures = [
  ["默认 1 张", ready(1, ["综合修改"])],
  ["明确 5 张", ready(5, ["正面", "侧面", "微侧面", "背面", "细节"])],
  ["三种效果自动得到 3 张", ready(3, ["正面", "侧面", "微侧面"])],
  ["授权补足到 5 张", ready(5, ["正面", "侧面", "微侧面", "其他角度一", "其他角度二"])],
] as const;

for (const [name, response] of fixtures) {
  const { result } = await planWith(response);
  assert.equal(result.kind, "ready", name);
  if (result.kind === "ready") assert.equal(result.outputCount, response.outputCount, name);
}

const mismatch = await planWith({
  kind: "clarification",
  reason: "count_mismatch",
  question: "你写了 5 张，但只列出 3 个独立效果，要补足到 5 张吗？",
  requestedCount: 5,
  specifiedIntentCount: 3,
});
assert.equal(mismatch.result.kind, "clarification");

const combined = await planWith(ready(1, ["综合修改"]));
assert.equal(combined.result.kind, "ready");
if (combined.result.kind === "ready") assert.equal(combined.result.intents.length, 1, "同一图片多项修改不能按短语拆分");

const rejected = await planWith({
  kind: "rejected",
  code: "count_exceeded",
  message: "单轮最多输出 8 张，请缩减或拆分。",
});
assert.deepEqual(rejected.result, {
  kind: "rejected",
  code: "count_exceeded",
  message: "单轮最多输出 8 张，请缩减或拆分。",
});

assert.equal((combined.seen?.userPayload.inputManifest[0]?.sourceRef), "/api/files/base.png");
assert.equal(combined.seen?.userPayload.parameters.modelId, "sunburst");
for (const field of ['"kind":"ready"', '"ordinal":1', '"requirements":{}',
  '"kind":"clarification"', 'specifiedIntentCount', '"kind":"rejected"', 'invalid_plan']) {
  assert.ok(combined.seen?.systemPrompt.includes(field), `model receives contract field ${field}`);
}

const answered = await planWith(ready(5, ["正面", "侧面", "微侧面", "其他角度一", "其他角度二"]), {
  plannerInput: { ...input, clarificationAnswer: "另外两张角度由你安排" },
});
assert.equal(answered.seen?.userPayload.clarificationAnswer, "另外两张角度由你安排");

for (const invalid of [
  { kind: "ready", outputCount: 9, intents: [] },
  { kind: "ready", outputCount: 2, intents: [ready(1, ["一个"]).intents[0]] },
  { kind: "ready", outputCount: 1, intents: [{ ordinal: 1, label: "越权", instruction: "改变", requirements: { sourceRef: "https://attacker" } }] },
  { kind: "clarification", reason: "count_mismatch", question: "缺少数量" },
  { kind: "not-a-plan" },
]) {
  assert.throws(() => parseImageConversationPlan(invalid), ImageConversationPlannerError);
}

const malformedPlanner = new ImageConversationPlanner({ async complete() { return "不是 JSON"; } }, 100);
await assert.rejects(() => malformedPlanner.plan(input), (error: unknown) => (
  error instanceof ImageConversationPlannerError && error.code === "invalid_response"
));

const timeoutPlanner = new ImageConversationPlanner({
  async complete() { return new Promise(() => undefined); },
}, 5);
await assert.rejects(() => timeoutPlanner.plan(input), (error: unknown) => (
  error instanceof ImageConversationPlannerError && error.code === "timeout"
));

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const envKeys = ["APIYI_API_KEY", "APIYI_BASE_URL", "IMAGE_CONVERSATION_PLANNER_MODEL"] as const;
const originalEnv = envKeys.map((key) => process.env[key]);
const diagnostics: unknown[][] = [];
const fakeKey = "private-token-for-planner-diagnostic-test";
let providerCalls = 0;
try {
  process.env.APIYI_API_KEY = fakeKey;
  process.env.APIYI_BASE_URL = "https://planner.invalid";
  process.env.IMAGE_CONVERSATION_PLANNER_MODEL = "test-planner";
  console.error = (...args: unknown[]) => { diagnostics.push(args); };
  globalThis.fetch = async () => {
    providerCalls += 1;
    return new Response(JSON.stringify({ error: {
      message: `Unsupported temperature; ${fakeKey} sk-secret-test https://private.invalid/path data:image/png;base64,AAAA`,
      type: "invalid_request_error", code: "unsupported_value", param: "temperature",
    } }), { status: 400 });
  };
  const adapter = new ApiYiImageConversationPlannerModel();
  const failingPlanner = new ImageConversationPlanner(adapter);
  await assert.rejects(() => failingPlanner.plan(input), (error: unknown) => {
    assert.ok(error instanceof ImageConversationPlannerError);
    assert.equal(error.code, "model_error");
    assert.equal(error.message, "image conversation planner failed");
    assert.ok(error.cause instanceof ProviderError);
    assert.equal(error.cause.status, 400);
    return true;
  });
  assert.equal(providerCalls, 1, "diagnostics must not retry the paid request");
  assert.equal(diagnostics.length, 1, "provider failure must produce one diagnostic");
  assert.equal(diagnostics[0][0], "[image-conversation-planner-failure]");
  const diagnostic = JSON.parse(String(diagnostics[0][1]));
  assert.equal(diagnostic.model, "test-planner");
  assert.equal(diagnostic.status, 400);
  assert.equal(diagnostic.category, "invalid_request");
  assert.match(diagnostic.diagnostic, /unsupported_value/);
  assert.match(diagnostic.diagnostic, /temperature/);
  const logged = JSON.stringify(diagnostics);
  for (const secret of [fakeKey, "sk-secret-test", "https://private.invalid", "data:image/png", input.prompt]) {
    assert.ok(!logged.includes(secret), "logs must not contain credentials, URLs, images or request prompts");
  }
  diagnostics.length = 0;
  globalThis.fetch = async () => new Response("not JSON", { status: 200 });
  await assert.rejects(() => failingPlanner.plan(input), ImageConversationPlannerError);
  assert.equal(diagnostics.length, 1);
  assert.equal(JSON.parse(String(diagnostics[0][1])).errorType, "SyntaxError");
  diagnostics.length = 0;
  let gatewayCalls = 0;
  let wireBody: { response_format: { type: string }; messages: Array<{ role: string; content: string }> } | undefined;
  globalThis.fetch = async (_url, init) => {
    gatewayCalls += 1;
    wireBody = JSON.parse(String(init?.body));
    // Some gateways validate Responses input separately from system instructions.
    const userMessage = wireBody!.messages.find((message) => message.role === "user")!;
    if (!/\bjson\b/i.test(userMessage.content)) {
      return new Response(JSON.stringify({ error: {
        message: "Response input messages must contain the word 'json' to use json_object.",
        type: "invalid_request_error", param: "input",
      } }), { status: 400 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(ready(1, ["综合修改"])) } }] }));
  };
  assert.deepEqual(await failingPlanner.plan(input), ready(1, ["综合修改"]));
  assert.equal(gatewayCalls, 1);
  assert.equal(diagnostics.length, 0);
  assert.equal(wireBody!.response_format.type, "json_object");
  assert.equal(wireBody!.messages[0].content, combined.seen!.systemPrompt);
  const userContent = wireBody!.messages[1].content;
  assert.deepEqual(JSON.parse(userContent.slice(userContent.indexOf("\n") + 1)), input, "JSON mode instruction must not modify the input snapshot");
} finally {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  envKeys.forEach((key, index) => {
    if (originalEnv[index] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[index];
  });
}

console.log("image-conversation-planner: ok");

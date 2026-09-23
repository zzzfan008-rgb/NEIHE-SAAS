import assert from "node:assert/strict";
import { ProviderError } from "../server/providers/base";
import { assertPlanInputs, buildExecutionPlan, type FlowNode } from "../server/engine/dag";
import { executeStep, type ExecuteStepOptions } from "../server/engine/runner";
import { createExecutionInputFingerprint } from "../server/lib/executionInputFingerprint";
import { compileTiAngleText } from "../src/lib/tiAngle";
import { SCENE_STABILIZE_MODEL_IDS, defaultImageModelOptions } from "../src/types/imageModels";
import type { AIProvider, ImageGenRequest, NodeExecution } from "../src/types/workflow";

console.log("TiAngelNode 运行提示词与回退测试");

const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const angleText = "只改变相机观察视角：从人物正面向其左前方观察（环绕角 45°）；高处俯拍15°；画面逆时针10°。";

function stageStep(): NodeExecution {
  return {
    nodeId: "stabilize",
    kind: "virtual-try-on",
    inputImages: [image, image, image, image],
    params: {
      workflowStage: "scene-stabilize",
      modelId: "gemini-3.1-flash-image",
      modelOptions: { aspectRatio: "1:1", imageSize: "2K" },
      imageSize: "2K",
      aspectRatio: "1:1",
      prompt: "保持人物动作",
      promptEnhancement: false,
      qualityMode: "fast",
      safetyFallback: true,
      stylePresetId: "faithful",
      angleControl: {
        sourceNodeId: "angle",
        config: { version: 1, enabled: true, azimuthDeg: 45, elevationDeg: 15, rollDeg: -10 },
        adapterVersion: 1,
        targetModelId: "gemini-3.1-flash-image",
        text: angleText,
      },
    },
  };
}

const referenceRoles = ["person", "scene", "pose", "outfit"];
const sceneAnalyzer = async () => ({
  prompt: "室内场景；干净背景；柔和光线；固定视点；中景取景；稳定构图",
  providerRequests: 0,
  model: "scene-test",
  cacheHit: false,
});
const poseAnalyzer = async () => ({
  guideImage: image,
  prompt: "保持原姿势",
  providerRequests: 0,
  model: "pose-test",
  cacheHit: false,
});
const identityAnchorer = async () => ({
  image,
  providerRequests: 0,
  model: "identity-test",
  cacheHit: false,
  fallback: false,
});
const candidateSelector = async () => ({
  selectedIndex: 0,
  scores: [],
  model: "judge-test",
  providerRequests: 0,
  allHardFail: false,
});

const requests: ImageGenRequest[] = [];
const provider: AIProvider = {
  id: "gemini-3.1-flash-image",
  async generate(request) {
    requests.push(request);
    return { images: [image], model: "provider-test" };
  },
  async edit(request) {
    requests.push(request);
    return { images: [image], model: "provider-test" };
  },
};

const result = await executeStep(stageStep(), stageStep().inputImages, () => provider, {
  referenceRoles,
  sceneAnalyzer,
  poseAnalyzer,
  identityAnchorer,
  candidateSelector,
  promptEnhancer: async () => {
    throw new Error("关闭角度专用测试不应调用提示词增强");
  },
});
assert.equal(result.providerRequests, 1);
assert.equal(requests.length, 1);
assert.match(requests[0].prompt, /环绕角 45°/);
assert.match(requests[0].prompt, /逆时针10°/);
assert.match(requests[0].prompt, /只改变相机观察视角/);

let fallbackCalls = 0;
const fallbackPrompts: string[] = [];
const fallbackProvider: AIProvider = {
  id: "gemini-3.1-flash-image",
  async generate(request) {
    fallbackCalls += 1;
    fallbackPrompts.push(request.prompt);
    if (fallbackCalls === 1) {
      throw new ProviderError("内容审核拒绝", 400, "gemini-3.1-flash-image", "content_refused");
    }
    return { images: [image], model: "provider-test" };
  },
  async edit(request) {
    fallbackCalls += 1;
    fallbackPrompts.push(request.prompt);
    if (fallbackCalls === 1) {
      throw new ProviderError("内容审核拒绝", 400, "gemini-3.1-flash-image", "content_refused");
    }
    return { images: [image], model: "provider-test" };
  },
};
await assert.rejects(() => executeStep(
  stageStep(),
  stageStep().inputImages,
  () => fallbackProvider,
  {
    referenceRoles,
    sceneAnalyzer,
    poseAnalyzer,
    identityAnchorer,
    candidateSelector,
  },
), /内容审核拒绝/);
assert.equal(fallbackCalls, 1);
assert.equal(fallbackPrompts.length, 1);
for (const prompt of fallbackPrompts) {
  assert.match(prompt, /环绕角 45°/);
  assert.match(prompt, /逆时针10°/);
}

async function runAngleAwarePrompt(options: {
  prompt: string;
  promptEnhancement: boolean;
  promptEnhancer?: ExecuteStepOptions["promptEnhancer"];
}) {
  const step = stageStep();
  step.params = {
    ...step.params,
    prompt: options.prompt,
    promptEnhancement: options.promptEnhancement,
  };
  const prompts: string[] = [];
  let judgedPrompt = "";
  const result = await executeStep(step, step.inputImages, () => ({
    id: "angle-aware-provider",
    async generate(request) {
      prompts.push(request.prompt);
      return { images: [image], model: "angle-aware-provider" };
    },
    async edit(request) {
      prompts.push(request.prompt);
      return { images: [image], model: "angle-aware-provider" };
    },
  }), {
    referenceRoles,
    sceneAnalyzer,
    poseAnalyzer,
    identityAnchorer,
    promptEnhancer: options.promptEnhancer,
    candidateSelector: async (input) => {
      judgedPrompt = input.prompt;
      return {
        selectedIndex: 0,
        scores: [],
        model: "single-candidate",
        providerRequests: 0,
        allHardFail: false,
      };
    },
  });
  return { prompts, judgedPrompt, result };
}

let enhancementCalls = 0;
const enhancedAngle = await runAngleAwarePrompt({
  prompt: "严格保持原场景正面镜头与二维姿势投影",
  promptEnhancement: true,
  promptEnhancer: async (_input, enhancerOptions) => {
    enhancementCalls += 1;
    await enhancerOptions?.beforeProviderCall?.(1);
    return {
      enhancedPrompt: "继续使用原场景正面镜头，逐像素复制原姿势二维投影",
      safePrompt: "保持原场景正面镜头与原姿势投影",
      model: "enhancer-stub",
      providerRequests: 1,
      cacheHit: false,
    };
  },
});
assert.equal(enhancementCalls, 0);
assert.equal(enhancedAngle.prompts.length, 1);
assert.equal(enhancedAngle.result.providerRequests, 1);
for (const prompt of [enhancedAngle.prompts[0], enhancedAngle.judgedPrompt]) {
  assert.match(prompt, /相机环绕、俯仰与画面 roll 仅由 3D 视角约束决定/);
  assert.match(prompt, /场景参考只控制背景空间、材质、色彩与光线风格/);
  assert.match(prompt, /允许为目标镜头合理重建透视/);
  assert.match(prompt, /姿势引导只控制肢体动作及关节相对关系/);
  assert.match(prompt, /按目标相机角度合理投影/);
  assert.match(prompt, /若本视角描述与上方姿势要求冲突，以上方姿势要求为准/);
  assert.match(prompt, /若与其他补充要求冲突，以本段为准/);
  assert.match(prompt, /环绕角 45°/);
}

let failedEnhancementCalls = 0;
const failedEnhancementAngle = await runAngleAwarePrompt({
  prompt: "保持人物身份和服装",
  promptEnhancement: true,
  promptEnhancer: async () => {
    failedEnhancementCalls += 1;
    throw new Error("mock enhancer unavailable");
  },
});
assert.equal(failedEnhancementCalls, 0);
assert.equal(failedEnhancementAngle.result.providerRequests, 1);
assert.match(failedEnhancementAngle.prompts[0], /相机环绕、俯仰与画面 roll 仅由 3D 视角约束决定/);
assert.match(failedEnhancementAngle.prompts[0], /环绕角 45°/);

let angleOnlyEnhancementCalls = 0;
const angleOnly = await runAngleAwarePrompt({
  prompt: "",
  promptEnhancement: true,
  promptEnhancer: async () => {
    angleOnlyEnhancementCalls += 1;
    throw new Error("只有角度时不应调用提示词增强器");
  },
});
assert.equal(angleOnlyEnhancementCalls, 0);
assert.equal(angleOnly.result.providerRequests, 1);
assert.match(angleOnly.prompts[0], /环绕角 45°/);

const supportedAngleConfig = {
  version: 1 as const,
  enabled: true,
  azimuthDeg: 45,
  elevationDeg: 15,
  rollDeg: -10,
};
for (const modelId of SCENE_STABILIZE_MODEL_IDS) {
  const compiled = compileTiAngleText(supportedAngleConfig, modelId);
  const modelStep = stageStep();
  modelStep.params = {
    ...modelStep.params,
    modelId,
    modelOptions: defaultImageModelOptions(modelId),
    angleControl: {
      sourceNodeId: "angle",
      config: supportedAngleConfig,
      adapterVersion: compiled.adapterVersion,
      targetModelId: compiled.targetModelId,
      text: compiled.text,
    },
  };
  const modelRequests: ImageGenRequest[] = [];
  const modelResult = await executeStep(modelStep, modelStep.inputImages, () => ({
    id: modelId,
    async generate(request) {
      modelRequests.push(request);
      return { images: [image], model: modelId };
    },
    async edit(request) {
      modelRequests.push(request);
      return { images: [image], model: modelId };
    },
  }), {
    referenceRoles,
    sceneAnalyzer,
    poseAnalyzer,
    identityAnchorer,
    candidateSelector,
  });
  assert.equal(modelResult.providerRequests, 1, modelId);
  assert.equal(modelRequests.length, 1, modelId);
  assert.match(modelRequests[0].prompt, /受控相机视角（TiAngelNode，适配器版本 1）/);
  assert.ok(modelRequests[0].prompt.includes(compiled.text), modelId);
}

const disabledAngleStep = stageStep();
delete disabledAngleStep.params.angleControl;
const disabledPrompts: string[] = [];
await executeStep(disabledAngleStep, disabledAngleStep.inputImages, () => ({
  id: "disabled-angle-provider",
  async generate(request) {
    disabledPrompts.push(request.prompt);
    return { images: [image], model: "disabled-angle-provider" };
  },
  async edit(request) {
    disabledPrompts.push(request.prompt);
    return { images: [image], model: "disabled-angle-provider" };
  },
}), {
  referenceRoles,
  sceneAnalyzer,
  poseAnalyzer,
  identityAnchorer,
  candidateSelector,
});
assert.match(disabledPrompts[0], /场景环境参考，只控制背景空间、镜头视点、取景、构图与光线/);
assert.doesNotMatch(disabledPrompts[0], /TiAngelNode|3D 视角约束/);

for (const enabled of [true, false]) {
  const composedStep = stageStep();
  composedStep.params.sceneInputMode = "composed-person";
  composedStep.params.modelId = "gemini-3-pro-image-preview";
  composedStep.params.modelOptions = defaultImageModelOptions("gemini-3-pro-image-preview");
  composedStep.params.angleControl = enabled ? {
    sourceNodeId: "angle", config: supportedAngleConfig,
    ...compileTiAngleText(supportedAngleConfig, "gemini-3-pro-image-preview"),
  } : undefined;
  const recorded: ImageGenRequest[] = [];
  await executeStep(composedStep, [image, image], () => ({
    id: "composed-stub",
    async generate(request) { recorded.push(request); return { images: [image], model: "stub" }; },
    async edit(request) { recorded.push(request); return { images: [image], model: "stub" }; },
  }), {
    referenceRoles: ["person", "outfit"],
    candidateSelector: async input => {
      assert.equal(input.angleControlled, enabled);
      return candidateSelector();
    },
  });
  assert.equal(recorded.length, 1);
  if (enabled) {
    assert.match(recorded[0].prompt, /允许为目标相机重建透视与取景/);
    assert.doesNotMatch(recorded[0].prompt, /光线、镜头、构图与画幅/);
  } else {
    assert.match(recorded[0].prompt, /光线、镜头、构图与画幅/);
    assert.doesNotMatch(recorded[0].prompt, /TiAngelNode/);
  }
}

console.log("通过正常、关闭角度、首轮不增强不回退及预合成路径的角度约束快照测试");

const firstStageImage = image;
const secondStageImage = image;
const imageNode = (id: string, imageUrl: string): FlowNode => ({
  id,
  type: "image-input",
  data: { kind: "image-input", label: id, status: "idle", imageUrl, imageRole: "default" },
});

const firstStage: FlowNode = {
  id: "staged-first",
  type: "virtual-try-on",
  data: {
    kind: "virtual-try-on",
    label: "第一轮场景定版",
    status: "idle",
    workflowStage: "scene-stabilize",
    prompt: "保持人物动作",
    modelId: "gemini-3.1-flash-image",
    modelOptions: { aspectRatio: "1:1", imageSize: "2K" },
    imageSize: "2K",
    aspectRatio: "1:1",
    basisRevision: 0,
    outputImages: [],
  },
};
const angleNode: FlowNode = {
  id: "staged-angle",
  type: "ti-angle",
  data: {
    kind: "ti-angle",
    label: "3D 视角",
    status: "idle",
    angle: { version: 1, enabled: true, azimuthDeg: 45, elevationDeg: 15, rollDeg: -10 },
  },
};
const person = imageNode("staged-person", image);
const scene = imageNode("staged-scene", image);
const pose = imageNode("staged-pose", image);
const outfit = imageNode("staged-outfit", image);
const stageOneEdges = [
  { source: "staged-angle", sourceHandle: "text", target: firstStage.id, targetHandle: "angle-direction" },
  { source: person.id, target: firstStage.id, targetHandle: "person" },
  { source: scene.id, target: firstStage.id, targetHandle: "scene" },
  { source: pose.id, target: firstStage.id, targetHandle: "pose" },
  { source: outfit.id, target: firstStage.id, targetHandle: "outfit" },
];
const firstStagePlan = buildExecutionPlan(
  [angleNode, person, scene, pose, outfit, firstStage],
  stageOneEdges,
  { onlyNodeId: firstStage.id, includeDownstream: false },
);
assertPlanInputs(firstStagePlan, stageOneEdges);
const firstStep = firstStagePlan.steps[0];
assert.equal(firstStep.params.angleControl?.targetModelId, "gemini-3.1-flash-image");
assert.match(String(firstStep.params.angleControl?.text), /左前方/);
const firstInputFingerprint = createExecutionInputFingerprint({
  runType: "workflow",
  projectId: "staged-input-fingerprint",
  nodeId: firstStage.id,
  plan: firstStagePlan,
});
assert.equal(
  firstInputFingerprint,
  createExecutionInputFingerprint({
    runType: "workflow",
    projectId: "staged-input-fingerprint",
    nodeId: firstStage.id,
    plan: structuredClone(firstStagePlan),
  }),
);
const changedInputPlan = structuredClone(firstStagePlan);
changedInputPlan.steps[0].params.prompt = "改成另一套场景输入";
assert.notEqual(
  firstInputFingerprint,
  createExecutionInputFingerprint({
    runType: "workflow",
    projectId: "staged-input-fingerprint",
    nodeId: firstStage.id,
    plan: changedInputPlan,
  }),
);

const stagedCalls: ImageGenRequest[] = [];
let stagedCallNumber = 0;
const stagedProvider: AIProvider = {
  id: "staged-chain-stub",
  async generate(request) {
    stagedCalls.push(request);
    stagedCallNumber += 1;
    return { images: [stagedCallNumber === 1 ? firstStageImage : secondStageImage], model: "staged-chain-stub" };
  },
  async edit(request) {
    stagedCalls.push(request);
    stagedCallNumber += 1;
    return { images: [stagedCallNumber === 1 ? firstStageImage : secondStageImage], model: "staged-chain-stub" };
  },
};
const stagedOptions = {
  referenceRoles: ["scene", "pose", "person", "outfit"],
  sceneAnalyzer: async () => ({
    prompt: "固定场景",
    providerRequests: 0,
    model: "scene-stub",
    cacheHit: false,
  }),
  poseAnalyzer: async () => ({
    guideImage: image,
    prompt: "保持原姿势",
    providerRequests: 0,
    model: "pose-stub",
    cacheHit: false,
  }),
  identityAnchorer: async () => ({
    image,
    providerRequests: 0,
    model: "identity-stub",
    cacheHit: false,
    fallback: false,
  }),
};
const firstStageResult = await executeStep(
  firstStep,
  firstStep.inputImages,
  () => stagedProvider,
  stagedOptions,
);
assert.equal(firstStageResult.images[0], firstStageImage);
assert.equal(stagedCalls.length, 1);
assert.match(stagedCalls[0].prompt, /左前方/);

const approval: FlowNode = {
  id: "staged-approval",
  type: "stage-approval",
  data: {
    kind: "stage-approval",
    label: "确认第一轮基准",
    status: "idle",
    approvalKind: "scene-baseline",
    approvedSourceNodeId: firstStage.id,
    approvedBaselineRef: firstStageImage,
    approvedBasisRevision: 1,
    approvedAt: "2026-09-18T00:00:00.000Z",
  },
};
firstStage.data.outputImages = [firstStageImage];
firstStage.data.basisRevision = 1;
const stageTwo: FlowNode = {
  id: "staged-second",
  type: "virtual-try-on",
  data: {
    kind: "virtual-try-on",
    label: "第二轮服装精修",
    status: "idle",
    workflowStage: "garment-refine",
    prompt: "保持人物和场景不变",
    modelId: "gpt-image-2",
    modelOptions: { size: "2048x2048", quality: "medium" },
    imageSize: "2K",
    aspectRatio: "1:1",
    garmentCategory: "knit",
    materialSpec: "羊毛双股纱，中等厚度",
    constructionSpec: "12GG 平针，1×1 罗纹领口",
    outputImages: [],
  },
};
const stageTwoEdges = [
  { source: firstStage.id, sourceHandle: "image", target: approval.id, targetHandle: "baseline-candidate" },
  { source: approval.id, sourceHandle: "image", target: stageTwo.id, targetHandle: "baseline" },
  { source: outfit.id, target: stageTwo.id, targetHandle: "outfit" },
];
const approvalPlan = buildExecutionPlan(
  [firstStage, approval, outfit, stageTwo],
  stageTwoEdges,
  { onlyNodeId: approval.id, includeDownstream: false },
);
assertPlanInputs(approvalPlan, stageTwoEdges);
const approvalResult = await executeStep(approvalPlan.steps[0], approvalPlan.steps[0].inputImages);
assert.deepEqual(approvalResult.images, [firstStageImage]);

const stageTwoPlan = buildExecutionPlan(
  [firstStage, approval, outfit, stageTwo],
  stageTwoEdges,
  { onlyNodeId: stageTwo.id, includeDownstream: false },
);
assertPlanInputs(stageTwoPlan, stageTwoEdges);
const secondStep = stageTwoPlan.steps[0];
assert.deepEqual(secondStep.inputImages, [firstStageImage, image]);
assert.equal(secondStep.params.baselineApprovalValid, true);
assert.equal("angleControl" in secondStep.params, false);
const secondStageResult = await executeStep(
  secondStep,
  secondStep.inputImages,
  () => stagedProvider,
  { referenceRoles: ["baseline", "outfit"] },
);
assert.equal(secondStageResult.images[0], secondStageImage);
assert.equal(stagedCalls.length, 2);
assert.match(stagedCalls[1].prompt, /羊毛双股纱/);
assert.doesNotMatch(stagedCalls[1].prompt, /左前方/);

console.log("通过首轮角度 mock 产出、人工确认与第二轮 mock 精修链路测试");

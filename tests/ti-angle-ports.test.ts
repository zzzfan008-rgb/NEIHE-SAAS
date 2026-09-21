import assert from "node:assert/strict";
import {
  connectionCompatibilityError,
  inputPortSpecs,
} from "../src/lib/workflowPorts";
import {
  assertPlanInputs,
  buildExecutionPlan,
  type FlowNode,
} from "../server/engine/dag";
import { executeStep } from "../server/engine/runner";
import { validateAndMigrateFlow } from "../server/lib/workflowSchema";

console.log("TiAngelNode 端口与执行计划测试");

const angleConfig = {
  version: 1 as const,
  enabled: true,
  azimuthDeg: 45,
  elevationDeg: 15,
  rollDeg: -10,
};

function angleNode(id = "angle", enabled = true): FlowNode {
  return {
    id,
    type: "ti-angle",
    data: {
      kind: "ti-angle",
      label: "3D 视角",
      status: "idle",
      angle: { ...angleConfig, enabled },
    },
  } as FlowNode;
}

function imageNode(id = "preview", imageUrl = "/api/files/preview.png"): FlowNode {
  return {
    id,
    type: "image-input",
    data: {
      kind: "image-input",
      label: id,
      status: "idle",
      imageRole: "reference",
      imageUrl,
    },
  } as FlowNode;
}

function textNode(id = "text"): FlowNode {
  return {
    id,
    type: "text-input",
    data: {
      kind: "text-input",
      label: id,
      status: "idle",
      text: "从左前方观察",
    },
  } as FlowNode;
}

function stageNode(
  id = "stabilize",
  stage: "scene-stabilize" | "garment-refine" | "standard" = "scene-stabilize",
): FlowNode {
  return {
    id,
    type: "virtual-try-on",
    data: {
      kind: "virtual-try-on",
      label: id,
      status: "idle",
      workflowStage: stage,
      prompt: "",
      imageSize: "2K",
      aspectRatio: "1:1",
      modelId: stage === "garment-refine" ? "gpt-image-2" : "gemini-3.1-flash-image",
      modelOptions: { aspectRatio: "1:1", imageSize: "2K" },
      promptEnhancement: false,
      qualityMode: "balanced",
      safetyFallback: true,
      stylePresetId: "none",
      outputImages: [],
      ...(stage === "scene-stabilize" ? { basisRevision: 0 } : {}),
    },
  } as FlowNode;
}

const angleToStage = {
  id: "angle-stage",
  source: "angle",
  sourceHandle: "text",
  target: "stabilize",
  targetHandle: "angle-direction",
};

const previewToAngle = {
  id: "preview-angle",
  source: "preview",
  sourceHandle: "image",
  target: "angle",
  targetHandle: "preview-image",
};

assert.equal(
  inputPortSpecs(stageNode().data).find((port) => port.id === "angle-direction")?.valueKind,
  "text",
);
assert.equal(
  inputPortSpecs(stageNode().data).find((port) => port.id === "angle-direction")?.maxSources,
  1,
);

assert.equal(
  connectionCompatibilityError({
    source: angleNode(),
    target: stageNode(),
    sourceHandle: "text",
    targetHandle: "angle-direction",
  }),
  undefined,
);
assert.match(
  connectionCompatibilityError({
    source: textNode(),
    target: stageNode(),
    sourceHandle: "text",
    targetHandle: "angle-direction",
  }) ?? "",
  /只允许.*TiAngelNode|3D 视角/,
);
assert.match(
  connectionCompatibilityError({
    source: angleNode(),
    target: stageNode("standard", "standard"),
    sourceHandle: "text",
    targetHandle: "angle-direction",
  }) ?? "",
  /第一轮|scene-stabilize/,
);
assert.equal(
  connectionCompatibilityError({
    source: imageNode(),
    target: angleNode(),
    sourceHandle: "image",
    targetHandle: "preview-image",
  }),
  undefined,
);
assert.match(
  connectionCompatibilityError({
    source: stageNode(),
    target: angleNode(),
    sourceHandle: "image",
    targetHandle: "preview-image",
  }) ?? "",
  /图片输入|image-input/,
);
assert.match(
  connectionCompatibilityError({
    source: angleNode("angle-2"),
    target: stageNode(),
    sourceHandle: "text",
    targetHandle: "angle-direction",
    existingEdges: [angleToStage],
  }) ?? "",
  /最多连接 1/,
);

const imageEdges = Array.from({ length: 14 }, (_, index) => ({
  source: `image-${index}`,
  target: "stabilize",
  targetHandle: "person",
}));
assert.equal(
  connectionCompatibilityError({
    source: angleNode(),
    target: stageNode(),
    sourceHandle: "text",
    targetHandle: "angle-direction",
    existingEdges: imageEdges,
  }),
  undefined,
  "角度文本边不得占用换装图片名额",
);

const plan = buildExecutionPlan(
  [angleNode(), imageNode(), stageNode()],
  [previewToAngle, angleToStage],
  { onlyNodeId: "stabilize", includeDownstream: false },
);
const stageStep = plan.steps[0];
assert.equal(stageStep.nodeId, "stabilize");
assert.deepEqual(stageStep.inputImages, []);
assert.deepEqual(stageStep.upstream, [], "angle-direction 和 preview-image 不得进入图片 upstream");
assert.deepEqual(stageStep.params.angleControl, {
  sourceNodeId: "angle",
  config: angleConfig,
  adapterVersion: 1,
  targetModelId: "gemini-3.1-flash-image",
  text: stageStep.params.angleControl && (stageStep.params.angleControl as { text: string }).text,
});
assert.match(
  (stageStep.params.angleControl as { text: string }).text,
  /左前方|45/,
);

const requiredReferences = [
  imageNode("person", "/api/files/person.png"),
  imageNode("scene", "/api/files/scene.png"),
  imageNode("pose", "/api/files/pose.png"),
  imageNode("outfit", "/api/files/outfit.png"),
];
const requiredEdges = [
  { source: "outfit", target: "stabilize", targetHandle: "outfit" },
  { source: "pose", target: "stabilize", targetHandle: "pose" },
  { source: "person", target: "stabilize", targetHandle: "person" },
  { source: "scene", target: "stabilize", targetHandle: "scene" },
];
const planWithoutAngle = buildExecutionPlan(
  [...requiredReferences, stageNode()],
  requiredEdges,
  { onlyNodeId: "stabilize", includeDownstream: false },
);
const planWithAngle = buildExecutionPlan(
  [angleNode(), ...requiredReferences, stageNode()],
  [...requiredEdges, angleToStage],
  { onlyNodeId: "stabilize", includeDownstream: false },
);
assertPlanInputs(planWithoutAngle, requiredEdges);
assertPlanInputs(planWithAngle, [...requiredEdges, angleToStage]);
assert.deepEqual(
  planWithAngle.steps[0].inputImages,
  planWithoutAngle.steps[0].inputImages,
  "启用角度不得改变原必需图片顺序",
);
assert.deepEqual(
  planWithAngle.steps[0].upstream,
  planWithoutAngle.steps[0].upstream,
  "角度文本边不得进入图片依赖",
);

const unsupportedTryOn = stageNode();
if (unsupportedTryOn.data.kind !== "virtual-try-on") throw new Error("测试夹具必须是换装节点");
(unsupportedTryOn.data as typeof unsupportedTryOn.data & { modelId: string }).modelId = "flux-2-pro";
const unsupportedPlan = buildExecutionPlan(
  [angleNode(), ...requiredReferences, unsupportedTryOn],
  [...requiredEdges, angleToStage],
  { onlyNodeId: "stabilize", includeDownstream: false },
);
assert.throws(
  () => assertPlanInputs(unsupportedPlan, [...requiredEdges, angleToStage]),
  /not allowed|不支持|模型/,
  "纯文本适配成功不得扩大一键换装模型白名单",
);

const disabledStage = buildExecutionPlan(
  [angleNode("disabled-angle", false), stageNode()],
  [{ ...angleToStage, source: "disabled-angle" }],
  { onlyNodeId: "stabilize", includeDownstream: false },
).steps[0];
assert.equal(disabledStage.params.angleControl, undefined);

const angleOnlyPlan = buildExecutionPlan([angleNode()], [], {
  onlyNodeId: "angle",
  includeDownstream: false,
});
assert.doesNotThrow(() => assertPlanInputs(angleOnlyPlan, []));
const noProviderResult = await executeStep(
  angleOnlyPlan.steps[0],
  [],
  () => {
    throw new Error("TiAngelNode 不得请求 Provider");
  },
);
assert.deepEqual(noProviderResult, { images: [], providerRequests: 0 });

const persistedAngle = {
  id: "angle",
  type: "ti-angle",
  position: { x: 0, y: 0 },
  data: {
    kind: "ti-angle",
    label: "3D 视角",
    status: "idle",
    angle: angleConfig,
  },
};
const persistedStage = {
  id: "stabilize",
  type: "virtual-try-on",
  position: { x: 400, y: 0 },
  data: {
    kind: "virtual-try-on",
    label: "第一轮",
    status: "idle",
    workflowStage: "scene-stabilize",
    prompt: "",
    imageSize: "2K",
    aspectRatio: "1:1",
    modelId: "gemini-3.1-flash-image",
    modelOptions: { aspectRatio: "1:1", imageSize: "2K" },
    promptEnhancement: false,
    qualityMode: "balanced",
    safetyFallback: true,
    stylePresetId: "none",
    outputImages: [],
    basisRevision: 0,
  },
};
assert.doesNotThrow(() => validateAndMigrateFlow({
  schemaVersion: 18,
  nodes: [persistedAngle, persistedStage],
  edges: [angleToStage],
}));
assert.throws(() => validateAndMigrateFlow({
  schemaVersion: 18,
  nodes: [persistedAngle, persistedStage],
  edges: [{ ...angleToStage, source: "stabilize", target: "angle" }],
}), /不支持输入角色|数据类型不兼容|只能连接第一轮/);

console.log("通过 TiAngelNode 端口、显示边、角度计划与零 Provider 执行测试");

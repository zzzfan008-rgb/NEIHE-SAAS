import assert from "node:assert/strict";
import { selectActiveDocument, useFlowStore, type FlowNode } from "../src/store/flowStore";
import type {
  StageApprovalNodeData,
  TiAngleConfig,
  VirtualTryOnNodeData,
} from "../src/types/workflow";

console.log("TiAngelNode 基准失效测试");

const angleConfig: TiAngleConfig = {
  version: 1,
  enabled: true,
  azimuthDeg: 35,
  elevationDeg: 10,
  rollDeg: 0,
};

const baselineRef = "/api/files/ti-angle-approved-baseline.png";

const angle: FlowNode = {
  id: "angle-basis-source",
  type: "ti-angle",
  position: { x: 0, y: 0 },
  data: {
    kind: "ti-angle",
    label: "视角控制",
    status: "idle",
    angle: angleConfig,
  },
};

const stage: FlowNode = {
  id: "angle-basis-stage",
  type: "virtual-try-on",
  position: { x: 360, y: 0 },
  data: {
    kind: "virtual-try-on",
    label: "第一轮场景定版",
    status: "success",
    workflowStage: "scene-stabilize",
    prompt: "",
    imageSize: "2K",
    aspectRatio: "1:1",
    modelId: "gemini-3.1-flash-image",
    modelOptions: { aspectRatio: "1:1", imageSize: "2K" },
    basisRevision: 1,
    promptEnhancement: false,
    qualityMode: "fast",
    safetyFallback: false,
    stylePresetId: "faithful",
    outputImages: [baselineRef],
  } satisfies VirtualTryOnNodeData,
};

const approval: FlowNode = {
  id: "angle-basis-approval",
  type: "stage-approval",
  position: { x: 720, y: 0 },
  data: {
    kind: "stage-approval",
    label: "确认第一轮基准",
    status: "success",
    approvalKind: "scene-baseline",
    approvedSourceNodeId: stage.id,
    approvedBaselineRef: baselineRef,
    approvedBasisRevision: 1,
    approvedAt: "2026-09-19T00:00:00.000Z",
  } satisfies StageApprovalNodeData,
};

function currentNodes() {
  return selectActiveDocument(useFlowStore.getState()).nodes;
}

function currentAngle() {
  const node = currentNodes().find((candidate) => candidate.id === angle.id);
  assert.equal(node?.data.kind, "ti-angle");
  return node.data.angle;
}

function currentStage() {
  const node = currentNodes().find((candidate) => candidate.id === stage.id);
  assert.equal(node?.data.kind, "virtual-try-on");
  return node.data;
}

function currentApproval() {
  const node = currentNodes().find((candidate) => candidate.id === approval.id);
  assert.equal(node?.data.kind, "stage-approval");
  return node.data;
}

useFlowStore.getState().loadFlow({
  projectId: "ti-angle-basis-project",
  projectName: "TiAngelNode 基准失效",
  nodes: [angle, stage, approval],
  edges: [
    {
      id: "angle-basis-edge",
      source: angle.id,
      target: stage.id,
      sourceHandle: "text",
      targetHandle: "angle-direction",
    },
    {
      id: "angle-basis-approval-edge",
      source: stage.id,
      target: approval.id,
      targetHandle: "baseline-candidate",
    },
  ],
});
useFlowStore.temporal.getState().clear();

useFlowStore.getState().updateNodeData(angle.id, {
  angle: { ...angleConfig, azimuthDeg: -55 },
});

assert.equal(currentAngle().azimuthDeg, -55);
assert.equal(currentStage().basisRevision, 2);
assert.equal(currentApproval().approvedBasisRevision, 1);
assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);

useFlowStore.getState().undo();

assert.deepEqual(currentAngle(), angleConfig);
assert.equal(currentStage().basisRevision, 1);
assert.deepEqual(currentStage().outputImages, [baselineRef]);
assert.equal(currentApproval().approvedSourceNodeId, stage.id);
assert.equal(currentApproval().approvedBaselineRef, baselineRef);
assert.equal(currentApproval().approvedBasisRevision, 1);
assert.equal(useFlowStore.temporal.getState().futureStates.length, 1);

useFlowStore.getState().redo();

assert.equal(currentAngle().azimuthDeg, -55);
assert.equal(currentStage().basisRevision, 2);
assert.equal(currentApproval().approvedBasisRevision, 1);

console.log("通过 TiAngelNode 配置变更、审批失效及完整撤销重做测试");

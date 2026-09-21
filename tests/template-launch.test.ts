import assert from "node:assert/strict";
import { launchTemplateInNewTab } from "../src/lib/templateLaunch";
import { selectActiveDocument, useFlowStore } from "../src/store/flowStore";
import {
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowTemplate,
} from "../src/types/workflow";

console.log("模板克隆 ID 与引用重映射测试");

const template: WorkflowTemplate = {
  schemaVersion: WORKFLOW_SCHEMA_VERSION,
  id: "ti-angle-clone-contract",
  name: "TiAngelNode 克隆契约",
  description: "测试模板克隆时的节点、边和内部引用重映射。",
  builtIn: false,
  createdAt: "2026-09-19T00:00:00.000Z",
  flow: {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    nodes: [
      {
        id: "person",
        type: "image-input",
        position: { x: 0, y: 0 },
        data: {
          kind: "image-input",
          label: "人物",
          status: "idle",
          imageRole: "reference",
          autoConnectTargets: [
            { targetNodeId: "view-angle", targetHandle: "preview-image" },
          ],
        },
      },
      {
        id: "view-angle",
        type: "ti-angle",
        position: { x: 320, y: 0 },
        data: {
          kind: "ti-angle",
          label: "3D 视角",
          status: "idle",
          angle: {
            version: 1,
            enabled: true,
            azimuthDeg: 35,
            elevationDeg: 12,
            rollDeg: -8,
          },
        },
      },
      {
        id: "styling",
        type: "ai-styling",
        position: { x: 640, y: 0 },
        data: {
          kind: "ai-styling",
          label: "搭配",
          status: "idle",
          prompt: "",
          aspectRatio: "3:4",
          batchSize: 1,
          preserve: null,
          extras: {
            outerwear: false,
            shoes: false,
            bag: false,
            accessories: false,
            hat: false,
          },
          outputImages: [],
          resultNodeId: "result",
          modelId: "gpt-image-2.5-flare",
          modelOptions: { size: "1536x2048", quality: "medium" },
        },
      },
      {
        id: "result",
        type: "result",
        position: { x: 960, y: 0 },
        data: {
          kind: "result",
          label: "结果",
          status: "idle",
          images: [],
        },
      },
    ],
    edges: [
      {
        id: "person-view-angle-preview",
        source: "person",
        sourceHandle: "image",
        target: "view-angle",
        targetHandle: "preview-image",
      },
      {
        id: "view-angle-styling",
        source: "view-angle",
        sourceHandle: "text",
        target: "styling",
        targetHandle: "angle-direction",
      },
      {
        id: "styling-result",
        source: "styling",
        target: "result",
      },
    ],
  },
};

useFlowStore.getState().loadFlow({
  projectId: "template-clone-seed",
  projectName: "模板克隆测试种子",
  nodes: [],
  edges: [],
});

const sourceNodeIds = new Set(template.flow.nodes.map((node) => node.id));
const sourceEdgeIds = new Set(template.flow.edges.map((edge) => edge.id));
const { landingNodeId } = launchTemplateInNewTab(template, "default");
const document = selectActiveDocument(useFlowStore.getState());
const clonedNodeIds = new Set(document.nodes.map((node) => node.id));
const clonedEdgeIds = new Set(document.edges.map((edge) => edge.id));
const nodeIdBySourceId = new Map(
  template.flow.nodes.map((node, index) => [node.id, document.nodes[index]?.id]),
);

assert.equal(document.nodes.length, template.flow.nodes.length);
assert.equal(document.edges.length, template.flow.edges.length);
assert.ok([...sourceNodeIds].every((id) => !clonedNodeIds.has(id)));
assert.ok([...sourceEdgeIds].every((id) => !clonedEdgeIds.has(id)));
assert.equal(new Set(document.nodes.map((node) => node.id)).size, document.nodes.length);
assert.equal(new Set(document.edges.map((edge) => edge.id)).size, document.edges.length);
assert.ok(document.edges.every((edge) => clonedNodeIds.has(edge.source) && clonedNodeIds.has(edge.target)));

const clonedPerson = document.nodes.find((node) => node.data.label === "人物");
const clonedAngle = document.nodes.find((node) => node.data.kind === "ti-angle");
const clonedStyling = document.nodes.find((node) => node.data.label === "搭配");
assert.equal(clonedPerson?.data.kind, "image-input");
assert.equal(
  clonedPerson?.data.kind === "image-input"
    ? clonedPerson.data.autoConnectTargets?.[0]?.targetNodeId
    : undefined,
  clonedAngle?.id,
);
assert.equal(
  clonedStyling?.data.kind === "ai-styling"
    ? clonedStyling.data.resultNodeId
    : undefined,
  document.nodes.find((node) => node.data.kind === "result")?.id,
);
assert.deepEqual(
  clonedAngle?.data.kind === "ti-angle" ? clonedAngle.data.angle : undefined,
  template.flow.nodes[1]?.data.kind === "ti-angle"
    ? template.flow.nodes[1].data.angle
    : undefined,
);
assert.equal(landingNodeId, clonedPerson?.id);
assert.deepEqual(
  document.edges.map((edge) => [edge.sourceHandle, edge.targetHandle]),
  template.flow.edges.map((edge) => [edge.sourceHandle, edge.targetHandle]),
);
assert.deepEqual(
  [...nodeIdBySourceId.values()].sort().length,
  template.flow.nodes.length,
);

console.log("通过模板克隆节点、边、TiAngelNode 内部引用与端口契约");

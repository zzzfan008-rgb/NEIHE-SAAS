import assert from "node:assert/strict";
import { resolveCanvasImageDrop } from "../src/lib/imageConversationDrag";
import { selectActiveDocumentTarget, useFlowStore } from "../src/store/flowStore";
import {
  appendConversationInput,
  buildConversationInputManifest,
  conversationSourceForOutput,
  maskDraftPatchForInputChange,
  conversationMaskNodeId,
  documentTargetsMatch,
} from "../src/lib/imageConversationInputs";

console.log("图片对话输入来源与蒙版边界测试");

const base = { role: "base" as const, ordinal: 0, sourceRef: "/api/files/base.png" };
const reference = { role: "reference" as const, ordinal: 1, sourceRef: "/api/files/ref.png" };

assert.deepEqual(
  appendConversationInput("fusion", [], { sourceRef: base.sourceRef, previewRef: base.sourceRef, label: "底图" }),
  [base],
);
assert.deepEqual(
  appendConversationInput("fusion", [base], { sourceRef: reference.sourceRef, previewRef: reference.sourceRef, label: "参考" }),
  [base, reference],
);
assert.equal(
  appendConversationInput("single", [base], { sourceRef: reference.sourceRef, previewRef: reference.sourceRef, label: "参考" }),
  null,
);

const drafts = {
  single: { mode: "single" as const, inputs: [base], prompt: "单图" },
  fusion: { mode: "fusion" as const, inputs: [base, reference], prompt: "融合" },
  mask: { mode: "mask" as const, inputs: [base], prompt: "蒙版", maskSourceRef: "/api/files/mask.png" },
};
assert.deepEqual(buildConversationInputManifest(drafts.single), [base]);
assert.deepEqual(buildConversationInputManifest(drafts.fusion), [base, reference]);
assert.deepEqual(buildConversationInputManifest(drafts.mask), [base]);
assert.equal(JSON.stringify(buildConversationInputManifest(drafts.single)).includes("融合"), false);

const nextBase = { role: "base" as const, ordinal: 0, sourceRef: "/api/files/next.png" };
assert.deepEqual(
  maskDraftPatchForInputChange(drafts.mask, [nextBase]),
  { inputs: [nextBase], maskSourceRef: undefined },
);
assert.deepEqual(maskDraftPatchForInputChange(drafts.mask, [base]), { inputs: [base] });

assert.deepEqual(
  conversationSourceForOutput({ generationOutputId: "output-1", imageRef: "/api/files/result.png" }),
  { sourceRef: "generation-output/output-1", previewRef: "/api/files/result.png" },
);
assert.deepEqual(
  conversationSourceForOutput({ generationOutputId: null, imageRef: "/api/files/result.png" }),
  { sourceRef: "/api/files/result.png", previewRef: "/api/files/result.png" },
);

assert.equal(conversationMaskNodeId("tab/with unsafe characters"), "image-conversation-tab-with-unsafe-characters");
assert.equal(documentTargetsMatch(
  { tabId: "tab", projectId: "project", documentEpoch: 1 },
  { tabId: "tab", projectId: "project", documentEpoch: 1 },
), true);
assert.equal(documentTargetsMatch(
  { tabId: "tab", projectId: "project", documentEpoch: 1 },
  { tabId: "tab", projectId: "project", documentEpoch: 2 },
), false);

const flowStore = useFlowStore.getState();
const nodeId = flowStore.addNode("image-input", { x: 0, y: 0 });
assert.ok(nodeId);
flowStore.updateNodeData(nodeId, {
  imageUrl: "/api/files/preview-1",
  imageConversationSourceRef: "generation-output/output-1",
  label: "待修改图片",
});
const currentTarget = selectActiveDocumentTarget(useFlowStore.getState());
const dragPayload = JSON.stringify({ target: currentTarget, nodeId, imageRef: "/api/files/preview-1" });
assert.deepEqual(resolveCanvasImageDrop(dragPayload, currentTarget, useFlowStore.getState()), {
  sourceRef: "generation-output/output-1",
  previewRef: "/api/files/preview-1",
  label: "待修改图片",
  sourceResultId: "output-1",
});
assert.equal(resolveCanvasImageDrop(dragPayload, { ...currentTarget, documentEpoch: currentTarget.documentEpoch + 1 }, useFlowStore.getState()), null);
assert.equal(resolveCanvasImageDrop(JSON.stringify({ target: currentTarget, nodeId, imageRef: "/api/files/other" }), currentTarget, useFlowStore.getState()), null);
assert.equal(resolveCanvasImageDrop(JSON.stringify({ target: currentTarget, nodeId: "removed-node", imageRef: "/api/files/preview-1" }), currentTarget, useFlowStore.getState()), null);
assert.equal(resolveCanvasImageDrop(JSON.stringify({ target: currentTarget, nodeId, imageRef: "https://example.com/image.png" }), currentTarget, useFlowStore.getState()), null);
assert.equal(resolveCanvasImageDrop("invalid json", currentTarget, useFlowStore.getState()), null);

console.log("图片对话输入来源与蒙版边界测试通过");

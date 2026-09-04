import assert from "node:assert/strict";
import {
  documentTargetMatches,
  findNearestVisibleNodePosition,
  parseCanvasCreationDragPayload,
  serializeCanvasCreationDragPayload,
} from "../src/lib/canvasCreation";
import { selectActiveDocument, useFlowStore } from "../src/store/flowStore";
import type { CanvasCreationIntent } from "../src/types/workbench";

console.log("画布创建意图测试");

const textIntent: CanvasCreationIntent = { type: "node", kind: "text-input" };
assert.deepEqual(parseCanvasCreationDragPayload(serializeCanvasCreationDragPayload(textIntent)), textIntent);
assert.equal(parseCanvasCreationDragPayload("not-json"), undefined);
assert.equal(parseCanvasCreationDragPayload(JSON.stringify({ type: "node", kind: "unknown" })), undefined);

const safe = findNearestVisibleNodePosition({
  viewport: { left: 0, top: 0, right: 1000, bottom: 700 },
  preferred: { x: 500, y: 350 },
  nodeSize: { width: 280, height: 180 },
  occupied: [{ left: 360, top: 260, right: 640, bottom: 440 }],
  gap: 24,
});
assert.ok(safe.x >= 0 && safe.x + 280 <= 1000);
assert.ok(safe.y >= 0 && safe.y + 180 <= 700);
assert.ok(safe.x + 280 + 24 <= 360 || safe.x >= 640 + 24 || safe.y + 180 + 24 <= 260 || safe.y >= 440 + 24);

const exactDrop = { x: 187.25, y: 392.5 };
assert.deepEqual(findNearestVisibleNodePosition({
  viewport: { left: 0, top: 0, right: 1000, bottom: 700 },
  preferred: exactDrop,
  nodeSize: { width: 280, height: 180 },
  occupied: [],
  gap: 24,
  preservePreferred: true,
}), exactDrop, "拖放必须保留 React Flow 转换后的精确释放位置");

useFlowStore.getState().loadFlow({ projectId: "creation", projectName: "创建测试", nodes: [], edges: [] });
const initial = selectActiveDocument(useFlowStore.getState());
const target = { tabId: initial.id, projectId: initial.projectId, documentEpoch: initial.documentEpoch };
assert.equal(documentTargetMatches(target, target), true);
assert.equal(documentTargetMatches(target, { ...target, documentEpoch: target.documentEpoch + 1 }), false);

const createdId = useFlowStore.getState().addNode("text-input", exactDrop);
assert.ok(createdId);
assert.equal(selectActiveDocument(useFlowStore.getState()).nodes.length, 1);
useFlowStore.getState().undo();
assert.equal(selectActiveDocument(useFlowStore.getState()).nodes.length, 0, "一次撤销必须完整移除一次节点创建");

useFlowStore.getState().openFlowTab({
  projectId: "creation-read-only", projectName: "只读", nodes: [], edges: [], readOnly: true,
});
assert.equal(useFlowStore.getState().addNode("text-input", { x: 10, y: 20 }), null);
assert.equal(selectActiveDocument(useFlowStore.getState()).nodes.length, 0, "只读文档不得创建节点");

console.log("通过 1 项画布创建测试");

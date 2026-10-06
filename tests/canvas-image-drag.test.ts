import assert from "node:assert/strict";
import { selectActiveDocumentTarget, useFlowStore } from "../src/store/flowStore";
import {
  CANVAS_IMAGE_DROP_EVENT,
  CANVAS_IMAGE_LONG_PRESS_MS,
  CANVAS_IMAGE_PRESS_TOLERANCE_PX,
  canvasImageDragPayload,
} from "../src/lib/canvasImageDrag";
import { resolveCanvasImageDrop } from "../src/lib/imageConversationDrag";
import { CANVAS_IMAGE_DROPZONE_ATTRIBUTE } from "../src/store/canvasImageDragStore";

const source = "/api/files/pose.png";

useFlowStore.getState().loadFlow({
  projectId: "canvas-image-drag",
  projectName: "图片拖拽",
  nodes: [{
    id: "pose",
    type: "image-input",
    position: { x: 0, y: 0 },
    data: { kind: "image-input", label: "姿势参考", status: "idle", imageRole: "reference", imageUrl: source },
  }] as never,
  edges: [],
});

// 手势契约显式固定，避免阈值、容差与落点属性无声漂移。
assert.equal(CANVAS_IMAGE_LONG_PRESS_MS, 350);
assert.equal(CANVAS_IMAGE_PRESS_TOLERANCE_PX, 8);
assert.equal(CANVAS_IMAGE_DROP_EVENT, "garment:canvas-image-drop");
assert.equal(CANVAS_IMAGE_DROPZONE_ATTRIBUTE, "data-canvas-image-dropzone");

// 长按构造的 payload 必须与原生拖放一致，并被对话面板的同一解析函数接受。
const payload = canvasImageDragPayload("pose", source);
assert.ok(payload, "受支持的画布图片引用必须能构造拖拽 payload");
const target = selectActiveDocumentTarget(useFlowStore.getState());
assert.deepEqual(JSON.parse(payload), { target, nodeId: "pose", imageRef: source });
const resolved = resolveCanvasImageDrop(payload, target, useFlowStore.getState());
assert.equal(resolved?.previewRef, source, "长按拖拽必须复用对话面板的落点解析");
assert.equal(resolved?.label, "姿势参考");

// 不支持的引用不进入拖拽态。
assert.equal(canvasImageDragPayload("pose", "https://example.com/remote.png"), null);
assert.equal(canvasImageDragPayload("pose", "data:image/png;base64,AA=="), null);

console.log("画布图片右键长按拖拽：阈值、payload 与落点解析契约通过");

import assert from "node:assert/strict";
import {
  DRAWING_LIMITS,
  DrawingBoardValidationError,
  createEmptyDrawingDocument,
  simplifyStrokePoints,
  validateDrawingDocument,
  type DrawingDocument,
} from "../src/components/drawing/drawingModel";
import {
  DrawingBoardClientError,
  drawingBoardCreationOutcomeIsUnknown,
} from "../src/lib/drawingBoardClient";
import {
  applyDrawingCommand,
  createDrawingHistory,
  drawingKeyboardCommand,
  redoDrawingCommand,
  undoDrawingCommand,
} from "../src/components/drawing/drawingHistory";

let passed = 0;
function test(name: string, run: () => void) {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("画板文档与本地历史合同测试");

test("底图只允许受控本地图片，替换可撤销且保留标注", () => {
  const document = createEmptyDrawingDocument();
  assert.throws(() => validateDrawingDocument({ ...document, baseImage: { url: "https://example.com/image.png", width: 400, height: 800 } }), /底图/);
  assert.throws(() => validateDrawingDocument({ ...document, baseImage: { url: "/api/files/../secret.png", width: 400, height: 800 } }), /底图/);
  assert.throws(() => validateDrawingDocument({ ...document, baseImage: { url: "/api/files/image.png", width: 0, height: 800 } }), /底图/);
  const withImage = { ...document, baseImage: { url: "/api/files/image.png", width: 400, height: 800 } };
  const history = applyDrawingCommand(createDrawingHistory(document), { type: "replace-document", document: withImage });
  assert.deepEqual(history.present, withImage);
  assert.deepEqual(undoDrawingCommand(history).present, document);
  assert.deepEqual(redoDrawingCommand(undoDrawingCommand(history)).present, withImage);
});

test("空白 v1 文档可验证且保留明确画布设置", () => {
  const document = createEmptyDrawingDocument(1200, 900, "#F5F5F5");
  assert.deepEqual(validateDrawingDocument(document), document);
});

test("拒绝画布、图层、对象、点、文本、坐标和导出上限之外的文档", () => {
  assert.throws(
    () => validateDrawingDocument(createEmptyDrawingDocument(255, 900, "#FFFFFF")),
    DrawingBoardValidationError,
  );
  const sixLayers = createEmptyDrawingDocument(1024, 1024, "#FFFFFF");
  sixLayers.layers = Array.from({ length: DRAWING_LIMITS.maxLayers + 1 }, (_, index) => ({
    id: `layer-${index}`, name: `图层 ${index}`, visible: true, locked: false, opacity: 1, objects: [],
  }));
  assert.throws(() => validateDrawingDocument(sixLayers), /最多 5 个图层/);

  const invalidCoordinate = createEmptyDrawingDocument(1024, 1024, "#FFFFFF");
  invalidCoordinate.layers[0].objects.push({
    id: "bad-line", kind: "line", x1: Number.NaN, y1: 0, x2: 1, y2: 1,
    color: "#000000", width: 4,
  });
  assert.throws(() => validateDrawingDocument(invalidCoordinate), /有限数值/);

  const longText = createEmptyDrawingDocument(1024, 1024, "#FFFFFF");
  longText.layers[0].objects.push({
    id: "too-long", kind: "text", text: "你".repeat(1400), x: 0, y: 0,
    width: 300, fontSize: 24, fontFamily: "sans-serif", align: "left", color: "#000000",
  });
  assert.throws(() => validateDrawingDocument(longText), /4000 字节/);

  const tooLargeExport = createEmptyDrawingDocument(4096, 4096, "#FFFFFF");
  assert.throws(
    () => validateDrawingDocument(tooLargeExport, { exportPixelRatio: 2 }),
    /导出像素总量/,
  );
});

test("未知对象、重复 id 和超大 canonical JSON fail closed", () => {
  const duplicate = createEmptyDrawingDocument(1024, 1024, "#FFFFFF");
  duplicate.layers[0].objects.push(
    { id: "same", kind: "rectangle", x: 1, y: 1, width: 10, height: 10, color: "#000000", strokeWidth: 1 },
    { id: "same", kind: "ellipse", x: 1, y: 1, radiusX: 5, radiusY: 5, color: "#000000", strokeWidth: 1 },
  );
  assert.throws(() => validateDrawingDocument(duplicate), /id 不能重复/);

  const unknown = createEmptyDrawingDocument(1024, 1024, "#FFFFFF") as DrawingDocument;
  unknown.layers[0].objects.push({ id: "unknown", kind: "path" } as never);
  assert.throws(() => validateDrawingDocument(unknown), /不支持的绘画对象/);

  const huge = createEmptyDrawingDocument(1024, 1024, "#FFFFFF");
  huge.layers[0].name = "x".repeat(DRAWING_LIMITS.maxDocumentBytes + 1);
  assert.throws(() => validateDrawingDocument(huge), /2 MiB/);
});

test("笔迹点在保留端点和拐点的前提下确定性简化", () => {
  const points = [0, 0, 1, 0.01, 2, -0.01, 3, 0, 3, 3];
  const simplified = simplifyStrokePoints(points, 0.05);
  assert.deepEqual(simplified, [0, 0, 3, 0, 3, 3]);
  assert.deepEqual(simplifyStrokePoints(points, 0.05), simplified);
});

test("局部命令历史不触碰项目历史，撤销后新命令清空 redo", () => {
  const document = createEmptyDrawingDocument(1024, 1024, "#FFFFFF");
  let history = createDrawingHistory(document);
  history = applyDrawingCommand(history, {
    type: "add-object", layerId: history.present.layers[0].id,
    object: { id: "rect", kind: "rectangle", x: 10, y: 10, width: 100, height: 80, color: "#CC0000", strokeWidth: 2 },
  });
  history = applyDrawingCommand(history, {
    type: "update-layer", layerId: history.present.layers[0].id, patch: { opacity: 0.5 },
  });
  assert.equal(history.past.length, 2);
  history = undoDrawingCommand(history);
  assert.equal(history.present.layers[0].opacity, 1);
  assert.equal(history.future.length, 1);
  history = applyDrawingCommand(history, {
    type: "update-layer", layerId: history.present.layers[0].id, patch: { visible: false },
  });
  assert.equal(history.future.length, 0);
  assert.equal(redoDrawingCommand(history), history);
});

test("键盘命令映射确定且不截获输入框文本编辑", () => {
  assert.equal(drawingKeyboardCommand({ key: "z", metaKey: true }), "undo");
  assert.equal(drawingKeyboardCommand({ key: "Z", ctrlKey: true, shiftKey: true }), "redo");
  assert.equal(drawingKeyboardCommand({ key: "Delete" }), "delete-selection");
  assert.equal(drawingKeyboardCommand({ key: "z", metaKey: true }, "textarea"), null);
});


test("画板创建仅把明确未提交响应视为可取消，代理 5xx 与网络错误保持待确认", () => {
  assert.equal(drawingBoardCreationOutcomeIsUnknown(new DrawingBoardClientError("参数错误", 400)), false);
  assert.equal(drawingBoardCreationOutcomeIsUnknown(new DrawingBoardClientError("提交应答丢失", 500)), true);
  assert.equal(drawingBoardCreationOutcomeIsUnknown(new DrawingBoardClientError("Bad Gateway", 502)), true);
  assert.equal(drawingBoardCreationOutcomeIsUnknown(new TypeError("fetch failed")), true);
});
console.log(`画板文档与本地历史合同测试通过：${passed}`);

import assert from "node:assert/strict";
import { buildExecutionPlan } from "../server/engine/dag";
import { fabricRecolorPrompt } from "../server/engine/runner";
import {
  ColorValueError,
  normalizeColorSwatches,
  parseColorValue,
} from "../src/lib/colorPalette";
import type { WorkflowNodeData } from "../src/types/workflow";
import { isDocumentConnectionValid } from "../src/store/flowStore";

let passed = 0;
function test(name: string, run: () => void) {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("色板与类型化颜色流合同测试");

test("只接受精确 HEX/RGB/HSL 子集并输出大写 #RRGGBB", () => {
  assert.equal(parseColorValue("#abc"), "#AABBCC");
  assert.equal(parseColorValue(" #a1B2c3 "), "#A1B2C3");
  assert.equal(parseColorValue("RGB(255, 0, 16)"), "#FF0010");
  assert.equal(parseColorValue("hSl(360, 100%, 50%)"), "#FF0000");
  assert.equal(parseColorValue("hsl(-120,100%,50%)"), "#0000FF");
  for (const invalid of [
    "#abcd", "#12345678", "rgba(1,2,3,.5)", "hsla(0,0%,0%,1)",
    "rgb(1.2,2,3)", "rgb(256,0,0)", "hsl(0,101%,50%)", "red", "NaN",
  ]) assert.throws(() => parseColorValue(invalid), ColorValueError);
});

test("色板去重、限制 1–32 色并保留首次来源", () => {
  const swatches = normalizeColorSwatches([
    { value: "#abc", source: "quick" },
    { value: "rgb(170,187,204)", source: "custom" },
    { value: "hsl(0, 100%, 50%)", source: "favorite", name: "红" },
  ]);
  assert.deepEqual(swatches.map((swatch) => swatch.value), ["#AABBCC", "#FF0000"]);
  assert.equal(swatches[0].source, "quick");
  assert.throws(() => normalizeColorSwatches([]), /至少 1 个颜色/);
  assert.throws(
    () => normalizeColorSwatches(Array.from({ length: 33 }, (_, index) => ({
      value: `rgb(${index},0,0)`, source: "custom" as const,
    }))),
    /最多 32 个颜色/,
  );
});

test("连接色板作为执行参数且不会计入参考图片，优先于节点内颜色", () => {
  const image = {
    id: "garment", type: "image-input", data: {
      kind: "image-input", label: "服装", status: "idle", imageRole: "garment",
      imageUrl: "/api/files/garment.png",
    } as WorkflowNodeData,
  };
  const palette = {
    id: "palette", type: "color-palette", data: {
      kind: "color-palette", label: "色板", status: "idle", paletteVersion: 1,
      swatches: [
        { id: "red", value: "#FF0000", source: "quick" },
        { id: "blue", value: "#0000FF", source: "custom" },
      ],
    } as WorkflowNodeData,
  };
  const recolor = {
    id: "recolor", type: "fabric-recolor", data: {
      kind: "fabric-recolor", label: "配色替换", status: "idle", operationMode: "color",
      colors: ["#111111"], prompt: "", outputImages: [], modelId: "gpt-image-2-vip", modelOptions: {},
    } as WorkflowNodeData,
  };
  const plan = buildExecutionPlan([image, palette, recolor], [
    { source: image.id, sourceHandle: "image", target: recolor.id, targetHandle: "references" },
    { source: palette.id, sourceHandle: "colors", target: recolor.id, targetHandle: "palette" },
  ], { onlyNodeId: recolor.id, includeDownstream: false });
  const step = plan.steps[0];
  assert.deepEqual(step.inputImages, ["/api/files/garment.png"]);
  assert.deepEqual(step.params.colors, ["#FF0000", "#0000FF"]);
  assert.equal(step.params.paletteSourceNodeId, "palette");
});

test("已提交画板以普通图片快照进入 DAG，未提交画板不伪造图片", () => {
  const committed = {
    id: "board", type: "drawing-board", data: {
      kind: "drawing-board", label: "画板", status: "success", boardVersion: 1,
      width: 1024, height: 1024, background: "#FFFFFF",
      contentRef: "board-version-1", previewImageRef: "/api/files/board-preview.png",
    } as WorkflowNodeData,
  };
  const empty = {
    ...committed, id: "empty-board", data: {
      ...committed.data, contentRef: undefined, previewImageRef: undefined,
    } as WorkflowNodeData,
  };
  const consumer = {
    id: "modify", type: "ai-modify", data: {
      kind: "ai-modify", label: "改款", status: "idle", prompt: "加一条线",
      aspectRatio: "1:1", batchSize: 1, outputImages: [], modelId: "gpt-image-2-vip", modelOptions: {},
    } as WorkflowNodeData,
  };
  assert.deepEqual(
    buildExecutionPlan([committed, consumer], [{ source: "board", sourceHandle: "image", target: "modify", targetHandle: "references" }]).steps
      .find((step) => step.nodeId === "modify")?.inputImages,
    ["/api/files/board-preview.png"],
  );
  assert.deepEqual(
    buildExecutionPlan([empty, consumer], [{ source: "empty-board", sourceHandle: "image", target: "modify", targetHandle: "references" }]).steps
      .find((step) => step.nodeId === "modify")?.inputImages,
    [],
  );
  assert.equal(isDocumentConnectionValid({ nodes: [committed, consumer], edges: [] }, {
    source: "board", sourceHandle: "image", target: "modify", targetHandle: "references",
  }), true);
  assert.equal(isDocumentConnectionValid({ nodes: [empty, consumer], edges: [] }, {
    source: "empty-board", sourceHandle: "image", target: "modify", targetHandle: "references",
  }), false);
});

test("三种面料配色模式生成不同且边界清晰的系统提示", () => {
  const fabric = fabricRecolorPrompt("fabric", undefined, "哑光");
  const color = fabricRecolorPrompt("color", "#AABBCC");
  const combined = fabricRecolorPrompt("combined", "#AABBCC");
  assert.match(fabric, /保留原有配色/);
  assert.match(fabric, /面料参考图/);
  assert.match(color, /#AABBCC/);
  assert.match(color, /保持原有面料纹理/);
  assert.doesNotMatch(color, /依据面料参考图替换/);
  assert.match(combined, /#AABBCC/);
  assert.match(combined, /面料参考图/);
  assert.throws(() => fabricRecolorPrompt("color"), /至少一个目标颜色/);
});

console.log(`色板与类型化颜色流合同测试通过：${passed}`);

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import { nodeTypes } from "../src/components/nodes";
import { TiAngelNode } from "../src/components/nodes/TiAngelNode";
import { readFileSync } from "node:fs";
import type { TiAngleNodeData } from "../src/types/workflow";

console.log("TiAngelNode 节点接入与折叠输出测试");

const data: TiAngleNodeData = {
  kind: "ti-angle",
  label: "3D 视角",
  status: "idle",
  angle: {
    version: 1,
    enabled: false,
    azimuthDeg: 0,
    elevationDeg: 0,
    rollDeg: 0,
    camera: {
      cameraModel: "sony-a7r-v",
      focalLengthMm: 85,
      aperture: "f/2.8",
    },
  },
};

const html = renderToStaticMarkup(
  createElement(
    ReactFlowProvider,
    null,
    createElement(TiAngelNode, {
      id: "ti-angle-node",
      data,
      selected: false,
    } as never),
  ),
);

assert.equal(nodeTypes["ti-angle"], TiAngelNode);
assert.match(html, /3D 视角预览/);
assert.match(html, /输出视角约束/);
assert.match(html, /相机参数/);
assert.match(html, /查看输出文本/);
assert.match(html, /Sony α7R V · 85 mm · 光圈 f\/2\.8/);
assert.equal(html.match(/aria-expanded="false"/g)?.length, 3);
assert.doesNotMatch(html, /将最终画面改为/);
assert.doesNotMatch(html, /启用 3D 视角/);
assert.match(html, /preview-image/);
assert.match(html, /text/);

const nodeSource = readFileSync(
  new URL("../src/components/nodes/TiAngelNode.tsx", import.meta.url),
  "utf8",
);
assert.match(nodeSource, /navigator\.clipboard/);
assert.match(nodeSource, /aria-controls/);
assert.match(nodeSource, /未绑定模型/);
assert.match(nodeSource, /启用 3D 视角/);
assert.match(nodeSource, /环绕角/);
assert.match(nodeSource, /俯仰角/);
assert.match(nodeSource, /画面倾斜/);
assert.match(nodeSource, /品牌相机/);
assert.match(nodeSource, /焦距/);
assert.match(nodeSource, /ISO/);
assert.match(nodeSource, /快门速度/);
assert.match(nodeSource, /光圈大小/);
assert.match(nodeSource, /#b98d45/);
assert.match(nodeSource, /#181818/);

const librarySource = readFileSync(
  new URL("../src/components/panels/NodeLibraryPanel.tsx", import.meta.url),
  "utf8",
);
assert.match(librarySource, /"ti-angle"/);

console.log("通过 TiAngelNode 注册、控件渲染与默认折叠输出测试");

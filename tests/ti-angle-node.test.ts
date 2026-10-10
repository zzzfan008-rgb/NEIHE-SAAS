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
    enabled: true,
    azimuthDeg: 0,
    elevationDeg: 0,
    rollDeg: 0,
    framing: "half-body",
    lighting: { azimuthDeg: 45, elevationDeg: 30 },
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

// 画布注册表统一用 memo 包装（拖拽时跳过无关重渲染），因此校验被包装的组件本体。
assert.equal((nodeTypes["ti-angle"] as unknown as { type: unknown }).type, TiAngelNode);
assert.match(html, /3D 视角预览/);
assert.match(html, /输出视角约束/);
assert.match(html, /半身照/);
assert.match(html, /光45°\/30°/);
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
assert.match(nodeSource, /构图视角/);
assert.match(nodeSource, /照明角度/);
assert.match(nodeSource, /光源方位角/);
assert.match(nodeSource, /光源高度角/);
assert.match(nodeSource, /布光模式/);
assert.match(nodeSource, /照明风格/);
assert.match(nodeSource, /TI_ANGLE_LIGHT_PATTERNS/);
assert.match(nodeSource, /TI_ANGLE_LIGHT_STYLES/);
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

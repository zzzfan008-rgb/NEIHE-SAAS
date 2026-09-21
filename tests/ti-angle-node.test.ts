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
assert.match(html, /启用 3D 视角/);
assert.match(html, /环绕角/);
assert.match(html, /俯仰角/);
assert.match(html, /画面倾斜/);
assert.match(html, /查看输出文本/);
assert.match(html, /正面/);
assert.match(html, /重置视角/);
assert.match(html, /aria-expanded="false"/);
assert.doesNotMatch(html, /将最终画面改为/);
assert.match(html, /preview-image/);
assert.match(html, /text/);

const nodeSource = readFileSync(
  new URL("../src/components/nodes/TiAngelNode.tsx", import.meta.url),
  "utf8",
);
assert.match(nodeSource, /navigator\.clipboard/);
assert.match(nodeSource, /aria-controls/);
assert.match(nodeSource, /未绑定模型/);

const librarySource = readFileSync(
  new URL("../src/components/panels/NodeLibraryPanel.tsx", import.meta.url),
  "utf8",
);
assert.match(librarySource, /"ti-angle"/);

console.log("通过 TiAngelNode 注册、控件渲染与默认折叠输出测试");

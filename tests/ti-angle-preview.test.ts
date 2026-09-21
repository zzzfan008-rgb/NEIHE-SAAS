import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TiAnglePreview } from "../src/components/nodes/TiAnglePreview";

console.log("TiAngelNode Three.js 预览渲染契约测试");

const html = renderToStaticMarkup(
  createElement(TiAnglePreview, {
    image: undefined,
    config: { version: 1, enabled: true, azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 },
    onCommit: () => undefined,
  }),
);
assert.match(html, /data-ti-angle-preview/);
assert.match(html, /3D 视角预览/);
assert.match(html, /示意参考图/);

const source = readFileSync(
  new URL("../src/components/nodes/TiAnglePreview.tsx", import.meta.url),
  "utf8",
);
assert.match(source, /import\("@\/lib\/tiAngleThreeRuntime"\)/, "Three.js 必须懒加载");
assert.match(
  readFileSync(new URL("../src/lib/tiAngleThreeRuntime.ts", import.meta.url), "utf8"),
  /from "three\/src\//,
  "运行时适配层必须使用 Three.js",
);
assert.match(source, /WebGLRenderer/);
assert.match(source, /setPointerCapture/);
assert.match(source, /ResizeObserver/);
assert.match(source, /devicePixelRatio[\s\S]{0,80}2/);
assert.match(source, /dispose\(\)/, "卸载时必须释放 renderer 资源");
assert.match(source, /contextlost/);
assert.match(source, /contextrestored/);
assert.match(source, /onPointerCancel/);

console.log("通过 Three.js 懒加载、交互隔离、Resize/DPR、资源释放契约测试");

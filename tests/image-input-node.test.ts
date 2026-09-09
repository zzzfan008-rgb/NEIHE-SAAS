import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import {
  fitImageNodeDimensions,
  ImageFileInput,
  ImageInputNode,
} from "../src/components/nodes/ImageInputNode";
import type { ImageInputNodeData } from "../src/types/workflow";

let passed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function renderNode(data: ImageInputNodeData, selected = false): string {
  return renderToStaticMarkup(
    createElement(
      ReactFlowProvider,
      null,
      createElement(ImageInputNode, {
        id: "upload-node",
        data,
        selected,
      } as never),
    ),
  );
}

function assertDirectFileInput(html: string, label: string): void {
  const fileInputs = html.match(/<input[^>]*type="file"[^>]*>/g) ?? [];
  assert.equal(fileInputs.length, 1, "每种节点状态都应直接渲染一个原生文件控件");
  assert.match(fileInputs[0], /accept="image\/\*"/);
  assert.match(fileInputs[0], new RegExp(`aria-label="${label}"`));
  assert.match(fileInputs[0], /class="[^"]*nodrag[^"]*nopan[^"]*absolute[^"]*inset-0[^"]*opacity-0[^"]*"/);
  assert.doesNotMatch(fileInputs[0], /\bhidden\b/);
  assert.doesNotMatch(fileInputs[0], /\bmultiple(?:=|\s|>)/);
  assert.doesNotMatch(fileInputs[0], /\bdisabled(?:=|\s|>)/);
  assert.doesNotMatch(fileInputs[0], /pointer-events-none/);
}

const baseData: ImageInputNodeData = {
  kind: "image-input",
  label: "图片上传",
  status: "idle",
  imageRole: "reference",
};

console.log("图片上传节点文件选择测试");

test("各图片状态均隐藏素材地址输入，已有素材仍可展示和更换", () => {
  for (const imageUrl of [undefined, "/api/files/source.png", "asset://existing-image"]) {
    for (const selected of [false, true]) {
      const html = renderNode({ ...baseData, imageUrl }, selected);
      assert.doesNotMatch(html, /API易图片素材 ID|应用 API易图片素材|placeholder="asset:\/\//);
      if (!imageUrl || selected) assertDirectFileInput(html, imageUrl ? "重新上传" : "本地上传");
      if (imageUrl?.startsWith("asset://")) assert.match(html, /API易图片素材/);
    }
  }
});

test("空节点提供本地上传与素材库两个明确入口", () => {
  const html = renderNode(baseData);
  assertDirectFileInput(html, "本地上传");
  assert.match(html, />本地上传</);
  assert.match(html, />从素材库选择</);
  assert.match(html, /支持拖拽图片到节点/);
});

test("已有图片被选中时在窗口外提供重新上传与素材库入口", () => {
  const html = renderNode({ ...baseData, imageUrl: "/api/files/source.png" }, true);
  assertDirectFileInput(html, "重新上传");
  assert.match(html, />重新上传</);
  assert.match(html, />素材库</);
  assert.match(html, /gc-image-input-media/);
});

test("已上传图片区域只负责节点选择与拖动，不再打开查看器", () => {
  const html = renderNode({ ...baseData, imageUrl: "/api/files/source.png" });
  const source = readFileSync(new URL("../src/components/nodes/ImageInputNode.tsx", import.meta.url), "utf8");
  assert.match(html, /<img[^>]*draggable="false"[^>]*alt="已上传图片"/);
  assert.doesNotMatch(html, /单击查看大图|cursor-zoom-in/);
  assert.doesNotMatch(source, /openViewer/);
  assert.match(source, /className=\{`gc-image-input-media relative/);
  assert.doesNotMatch(source, /gc-image-input-media nodrag nopan/);
});

test("画布中的上传图、生成结果和局部重绘源图均直接加载原图", () => {
  const nodeSource = readFileSync(new URL("../src/components/nodes/ImageInputNode.tsx", import.meta.url), "utf8");
  const gridSource = readFileSync(new URL("../src/components/nodes/ImageGrid.tsx", import.meta.url), "utf8");
  const redrawSource = readFileSync(new URL("../src/components/nodes/MaskRedrawNode.tsx", import.meta.url), "utf8");
  const html = renderNode({ ...baseData, imageUrl: "/api/files/source.png" });

  assert.match(html, /src="\/api\/files\/source\.png"/);
  assert.doesNotMatch(html, /\/thumbnail/);
  for (const source of [nodeSource, gridSource, redrawSource]) {
    assert.doesNotMatch(source, /thumbnailImageUrl/);
  }
  assert.match(gridSource, /<img[\s\S]*?src=\{url\}/);
  assert.match(redrawSource, /<img[\s\S]*?src=\{source\}/);
});

test("上传入口不再通过脚本点击隐藏文件控件", () => {
  const source = readFileSync(new URL("../src/components/nodes/ImageInputNode.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fileInputRef/);
  assert.doesNotMatch(source, /\.click\(\)/);
  assert.doesNotMatch(source, /type="file"[\s\S]{0,200}className="hidden"/);
});

test("生产文件控件把选择结果交给上传逻辑并清空 value 以支持重选同一文件", () => {
  const selected = { name: "probe.png", type: "image/png" } as File;
  let received: File | undefined;
  const picker = ImageFileInput({
    label: "上传图片",
    onFile: (file) => {
      received = file;
    },
  });
  const props = picker.props as {
    disabled?: boolean;
    className: string;
    onChange: (event: { target: { files: File[]; value: string } }) => void;
  };
  const target = { files: [selected], value: "/fake/path/probe.png" };

  props.onChange({ target });

  assert.equal(received, selected);
  assert.equal(target.value, "");
  assert.notEqual(props.disabled, true);
  assert.doesNotMatch(props.className, /pointer-events-none/);
});

test("图片窗口保持真实宽高比并把长边收敛到 280px", () => {
  assert.deepEqual(fitImageNodeDimensions(1200, 800), { width: 280, height: 187 });
  assert.deepEqual(fitImageNodeDimensions(600, 1200), { width: 140, height: 280 });
  assert.deepEqual(fitImageNodeDimensions(0, 0), { width: 280, height: 180 });
});

test("上传完成态保留节点名称并维持图片外框样式", () => {
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.gc-image-node:has\(\.gc-image-input-media\) \.gc-node-floating-title\s*\{[\s\S]*?display:\s*none/);
});

console.log(`\n${passed} 项图片上传节点文件选择测试全部通过`);

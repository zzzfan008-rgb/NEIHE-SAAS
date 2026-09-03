import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import { ImageFileInput, ImageInputNode } from "../src/components/nodes/ImageInputNode";
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

function renderNode(data: ImageInputNodeData): string {
  return renderToStaticMarkup(
    createElement(
      ReactFlowProvider,
      null,
      createElement(ImageInputNode, {
        id: "upload-node",
        data,
        selected: false,
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
  assert.match(html, /focus-within:ring-1/);
}

const baseData: ImageInputNodeData = {
  kind: "image-input",
  label: "图片上传",
  status: "idle",
  imageRole: "reference",
};

console.log("图片上传节点文件选择测试");

test("空节点的整个上传区域由原生文件控件直接接收点击", () => {
  const html = renderNode(baseData);
  assertDirectFileInput(html, "上传图片");
  assert.match(html, /点击 \/ 拖拽 \/ 选中后 Ctrl\+V/);
});

test("已有图片时重新上传区域仍由原生文件控件直接接收点击", () => {
  const html = renderNode({ ...baseData, imageUrl: "/api/files/source.png" });
  assertDirectFileInput(html, "重新上传图片");
  assert.match(html, />重新上传<\/span>/);
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

console.log(`\n${passed} 项图片上传节点文件选择测试全部通过`);

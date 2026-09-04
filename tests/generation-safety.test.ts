import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getGenerationSafetyBlockReason,
  INITIAL_GENERATION_SAFETY_BLOCK_REASON,
  setGenerationSafetyBlockReason,
  subscribeGenerationSafety,
} from "../src/store/generationSafety";

console.log("生成安全门契约测试");

assert.equal(
  getGenerationSafetyBlockReason(),
  INITIAL_GENERATION_SAFETY_BLOCK_REASON,
  "冷启动在历史对账完成前必须默认 fail-closed",
);

const originalFetch = globalThis.fetch;
let coldStartRequests = 0;
globalThis.fetch = async () => {
  coldStartRequests += 1;
  throw new Error("冷启动门禁失效：不应发出网络请求");
};
try {
  const { useFlowStore } = await import("../src/store/flowStore");
  await useFlowStore.getState().runNode("cold-start-probe");
  assert.equal(coldStartRequests, 0, "未挂载 Workspace 时 runNode 也必须默认拒绝网络请求");
} finally {
  globalThis.fetch = originalFetch;
}

let notifications = 0;
const unsubscribe = subscribeGenerationSafety(() => { notifications += 1; });
setGenerationSafetyBlockReason(INITIAL_GENERATION_SAFETY_BLOCK_REASON);
assert.equal(notifications, 0, "重复写入冷启动门禁不得触发通知");
setGenerationSafetyBlockReason("历史同步失败");
assert.equal(getGenerationSafetyBlockReason(), "历史同步失败");
assert.equal(notifications, 1, "重复写入同一门禁状态不得触发无意义渲染");
setGenerationSafetyBlockReason("历史同步失败");
assert.equal(notifications, 1, "重复写入同一门禁状态不得触发无意义渲染");
setGenerationSafetyBlockReason(null);
assert.equal(getGenerationSafetyBlockReason(), null);
assert.equal(notifications, 2);
unsubscribe();
console.log("  ✓ 安全门状态可订阅且不进入项目 Store");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
const nodeFrameSource = fs.readFileSync(path.join(root, "src/components/nodes/NodeFrame.tsx"), "utf8");
const imageViewerSource = fs.readFileSync(path.join(root, "src/components/ImageViewer.tsx"), "utf8");
const accountMenuSource = fs.readFileSync(path.join(root, "src/components/panels/AccountMenu.tsx"), "utf8");
const projectTabsSource = fs.readFileSync(path.join(root, "src/components/panels/ProjectTabs.tsx"), "utf8");
const storeSource = fs.readFileSync(path.join(root, "src/store/flowStore.ts"), "utf8");

assert.doesNotMatch(appSource, /absolute inset-0 z-100/, "历史失败不得再用全屏遮罩锁住工作台");
assert.match(appSource, /画布仍可编辑和保存/, "历史失败必须明确保留非付费操作");
assert.match(nodeFrameSource, /newGenerationBlocked/, "共享运行按钮必须呈现安全门禁用状态");
assert.match(imageViewerSource, /generationSafetyBlockReason/, "图片查看器的重新生成入口必须同步安全门");
assert.match(imageViewerSource, /role="dialog"/, "图片查看器必须使用对话框语义");
assert.match(imageViewerSource, /aria-label="关闭图片查看器"/, "图片查看器关闭按钮必须有可访问名称");
assert.match(accountMenuSource, /role="dialog"/, "账户面板必须使用对话框语义");
assert.match(accountMenuSource, /aria-label="关闭账户面板"/, "账户面板关闭按钮必须有可访问名称");
assert.match(storeSource, /getGenerationSafetyBlockReason\(\)/, "runNode 必须二次校验安全门，不能只依赖按钮禁用");
assert.match(projectTabsSource, /runReconciliationBlockReason/, "活动任务对账完成前页签关闭入口必须 fail-closed");
assert.match(storeSource, /closeTab:[\s\S]*getGenerationSafetyBlockReason\(\)/, "closeTab action 必须独立执行对账门禁");
console.log("  ✓ 历史失败只封锁新生成，并保留工作台与二次校验契约");

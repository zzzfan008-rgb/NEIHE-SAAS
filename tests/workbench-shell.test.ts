import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  INITIAL_WORKBENCH_UI_STATE,
  workbenchUiReducer,
  type WorkbenchUiState,
} from "../src/components/workbench/workbenchState";
import {
  desktopShortcutPlatformFromValues,
  workbenchShortcutRows,
} from "../src/lib/keyboardShortcuts";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const workbenchRoot = path.resolve(testRoot, "../src/components/workbench");

function sourceFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(absolute));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(absolute);
  }
  return files.sort();
}

console.log("新工作台外壳源码契约测试");

const files = sourceFiles(workbenchRoot);
assert.ok(files.length > 0, "缺少 src/components/workbench 外壳源码");

let state: WorkbenchUiState = INITIAL_WORKBENCH_UI_STATE;
assert.deepEqual(state, { activePanel: null });

state = workbenchUiReducer(state, { type: "toggle-panel", panel: "library" });
assert.deepEqual(state, { activePanel: "library" });
state = workbenchUiReducer(state, { type: "toggle-panel", panel: "inspector" });
assert.deepEqual(state, { activePanel: "inspector" });
state = workbenchUiReducer(state, { type: "toggle-panel", panel: "inspector" });
assert.deepEqual(state, { activePanel: null });
console.log("  ✓ 外壳 reducer 仅允许一个左侧 Dock 面板打开，并支持再次点击收起");

assert.equal(desktopShortcutPlatformFromValues("MacIntel"), "macos");
assert.equal(desktopShortcutPlatformFromValues("Win32"), "windows");
assert.equal(desktopShortcutPlatformFromValues("", "Mozilla/5.0 (Macintosh; Intel Mac OS X)"), "macos");
const macShortcuts = workbenchShortcutRows("macos");
const windowsShortcuts = workbenchShortcutRows("windows");
assert.deepEqual(macShortcuts.map(({ label }) => label), windowsShortcuts.map(({ label }) => label));
assert.equal(macShortcuts.find(({ label }) => label === "放大")?.shortcut, "⌘ +");
assert.equal(windowsShortcuts.find(({ label }) => label === "放大")?.shortcut, "Ctrl +");
assert.equal(macShortcuts.find(({ label }) => label === "删除")?.shortcut, "⌫");
assert.equal(windowsShortcuts.find(({ label }) => label === "删除")?.shortcut, "Delete");
assert.equal(macShortcuts.find(({ label }) => label === "取消撤销")?.shortcut, "⇧⌘ Z");
assert.equal(windowsShortcuts.find(({ label }) => label === "取消撤销")?.shortcut, "Ctrl Y");
console.log("  ✓ 快捷键菜单按 macOS / Windows 显示对应修饰键与系统删除键");

const relative = (file: string) => path.relative(path.resolve(testRoot, ".."), file);
const sources = files.map((file) => ({ file, source: fs.readFileSync(file, "utf8") }));
const combined = sources.map(({ source }) => source).join("\n");
const appSource = fs.readFileSync(path.resolve(testRoot, "../src/App.tsx"), "utf8");
const shellSource = fs.readFileSync(
  path.resolve(testRoot, "../src/components/workbench/WorkbenchShell.tsx"),
  "utf8",
);
const canvasFlowSource = fs.readFileSync(
  path.resolve(testRoot, "../src/components/CanvasFlow.tsx"),
  "utf8",
);
const canvasZoomControlsSource = fs.readFileSync(
  path.resolve(testRoot, "../src/components/CanvasZoomControls.tsx"),
  "utf8",
);
const contextPanelSource = fs.readFileSync(
  path.resolve(testRoot, "../src/components/panels/ContextPanel.tsx"),
  "utf8",
);
const topBarSource = fs.readFileSync(
  path.resolve(testRoot, "../src/components/panels/TopBar.tsx"),
  "utf8",
);
const indexCssSource = fs.readFileSync(path.resolve(testRoot, "../src/index.css"), "utf8");
const initialDraftWorkspaceSource = fs.readFileSync(
  path.resolve(testRoot, "../src/initialDraft/InitialDraftWorkspace.tsx"),
  "utf8",
);
const nodeFrameSource = fs.readFileSync(
  path.resolve(testRoot, "../src/components/nodes/NodeFrame.tsx"),
  "utf8",
);
const flowStoreSource = fs.readFileSync(path.resolve(testRoot, "../src/store/flowStore.ts"), "utf8");
const runPlanRouteSource = fs.readFileSync(path.resolve(testRoot, "../server/routes/runPlan.ts"), "utf8");
const nodeLibrarySource = fs.readFileSync(
  path.resolve(testRoot, "../src/components/panels/NodeLibraryPanel.tsx"),
  "utf8",
);
const workbenchShellRenderSource = shellSource.slice(shellSource.indexOf("export function WorkbenchShell"));

assert.match(combined, /@\/components\/ui\//, "新外壳必须复用已安装的 shadcn 基础组件");
assert.match(combined, /aria-(?:label|labelledby|expanded|controls)/, "新外壳的交互入口必须提供可感知名称或状态");
assert.match(combined, /transition-\[width,visibility\]/, "桌面 Dock 应通过占位宽度开合，避免遮挡画布控件与结果");
assert.doesNotMatch(shellSource, /工作台右侧工具|border-l border-\[var\(--gc-border\)\]/, "工作台不得保留右侧工具栏或右侧 Dock");
assert.match(shellSource, /absolute top-3 z-40/, "节点与上下文入口应为画布左侧悬浮按钮");
assert.match(canvasFlowSource, /new ResizeObserver/, "Dock 改变画布尺寸时必须监听容器几何变化");
assert.match(
  canvasFlowSource,
  /x: viewport\.x \+ delta\.width \/ 2/,
  "Dock 开合必须维持画布中心对应的世界坐标",
);
assert.match(canvasFlowSource, /compactMinimap \? 128 : 200/, "窄画布必须缩小 MiniMap");
assert.match(canvasFlowSource, /<CanvasZoomControls \/>/, "画布必须使用自定义横向缩放控制器");
assert.doesNotMatch(canvasFlowSource, /<Controls\b/, "画布不得继续使用 React Flow 竖向 Controls");
assert.match(canvasZoomControlsSource, /@\/components\/ui\/slider/, "缩放拖动条必须使用本地 shadcn Slider");
assert.match(canvasZoomControlsSource, /flex-row/, "缩放控制器必须横向排列");
assert.match(canvasZoomControlsSource, /zoomPercent/, "缩放控制器必须显示实时百分比");
assert.match(canvasZoomControlsSource, /CANVAS_ZOOM_COMMAND_EVENT/, "键盘缩放必须复用画布缩放控制器");
assert.match(canvasFlowSource, /multiSelectionKeyCode=\{multiSelectionKeyCode\}/, "多选修饰键必须按桌面系统显式配置");
assert.match(
  canvasFlowSource,
  /autoPanOnNodeDrag=\{false\}/,
  "拖动节点接近画布边缘时不得自动平移视口，否则松手时会产生画布跳动",
);
assert.doesNotMatch(
  indexCssSource,
  /\.react-flow__node[^}]*\{[^}]*\btranslate\s*:/s,
  "节点悬停不得改变 React Flow 坐标，否则拖拽状态切换会产生视觉跳动",
);
assert.match(
  initialDraftWorkspaceSource,
  /syncState !== "error"[\s\S]*?className="sr-only"[\s\S]*?<Card\b/,
  "正常草稿同步只能提供无布局占位的辅助状态，错误提示才允许显示 shadcn Card",
);
assert.match(
  initialDraftWorkspaceSource,
  /from "@\/components\/ui\/card"/,
  "草稿同步错误提示必须使用本地 shadcn Card",
);
assert.match(topBarSource, /from "@\/components\/ui\/dropdown-menu"/, "快捷键浮层必须使用本地 shadcn DropdownMenu");
assert.match(topBarSource, /DropdownMenuShortcut/, "快捷键标签必须使用 shadcn Shortcut 对齐槽位");
assert.match(topBarSource, /w-56 min-w-56/, "快捷键浮层宽度必须收敛到 224px");
assert.doesNotMatch(topBarSource, /ShortcutKey|pinned|openTimer|closeTimer/, "快捷键浮层不得保留手写键帽与悬停固定状态");
assert.match(appSource, /requestCanvasZoom\("in"\)/, "主修饰键加号必须缩放画布而不是浏览器页面");
assert.match(appSource, /copySelectedNodesToClipboard\(\)/, "复制快捷键必须读取 canonical 多选节点");
assert.match(appSource, /addExistingNodes\(additions\)/, "多节点粘贴必须通过原子批量 action 落入文档");
assert.doesNotMatch(combined, /absolute inset-y-0 (?:left|right)-0/, "桌面业务面板不得覆盖画布控件与结果");
assert.equal(
  (workbenchShellRenderSource.match(/\{children\}/g) ?? []).length,
  1,
  "中心画布子树必须只挂载一次，Dock 开合不得重建 React Flow",
);
assert.equal(
  (workbenchShellRenderSource.match(/\{library\}/g) ?? []).length,
  1,
  "节点与素材 Dock 必须保持单实例挂载",
);
assert.equal(
  (workbenchShellRenderSource.match(/\{inspector\}/g) ?? []).length,
  1,
  "属性与结果 Dock 必须保持单实例挂载",
);
assert.match(shellSource, /id=\{LIBRARY_PANEL_ID\}[\s\S]*?inert=\{!libraryOpen\}/);
assert.match(shellSource, /id=\{INSPECTOR_PANEL_ID\}[\s\S]*?inert=\{!inspectorOpen\}/);
assert.doesNotMatch(shellSource, /MobileSheet|useMediaQuery|DESKTOP_QUERY|mobilePanel/);
assert.doesNotMatch(appSource, /workspaceKey=\{activeTabId\}/);
assert.match(
  contextPanelSource,
  /from "@\/components\/ui\/tabs"/,
  "属性与结果上下文必须复用本地 shadcn Tabs",
);
assert.equal(
  (contextPanelSource.match(/<TabsContent[\s\S]*?keepMounted/g) ?? []).length,
  2,
  "属性与结果 Tab 都必须 keepMounted",
);
assert.match(appSource, /inspector=\{\([\s\S]*?<ContextPanel/);
assert.doesNotMatch(
  appSource,
  /<ReactFlowProvider[\s\S]*?<ResultsPanel/,
  "Results 不应再占用中心画布底部",
);
assert.doesNotMatch(nodeLibrarySource, /AssetList|素材库|\/api\/assets/, "左侧节点库不得继续包含素材库页签或素材请求");
assert.match(nodeLibrarySource, /@\/components\/ui\/button/, "节点库操作必须使用本地 shadcn Button");
assert.match(nodeLibrarySource, /@\/components\/ui\/card/, "节点库卡片必须使用本地 shadcn Card");
assert.match(appSource, /LazyAssetPickerOverlay/, "节点内的素材选择浮层必须继续保留");
assert.doesNotMatch(nodeFrameSource, /onCancel|>\s*取消\s*</, "生成按钮不得再暴露取消入口");
assert.doesNotMatch(flowStoreSource, /cancelNodeRun|\/api\/run-plan\/.*\/cancel/, "客户端不得保留任务取消模块");
assert.doesNotMatch(runPlanRouteSource, /\/:id\/cancel|cancelDurableRun/, "运行 API 不得暴露用户取消端点");
console.log("  ✓ 生成节点、客户端 Store 与运行 API 均不再暴露取消功能");

for (const { file, source } of sources) {
  assert.doesNotMatch(
    source,
    /(?:bg|text|border|ring|outline|fill|stroke)-\[#[0-9a-f]{3,8}\]/i,
    `${relative(file)} 不应把旧十六进制视觉常量带进新外壳`,
  );
  assert.doesNotMatch(
    source,
    /(?:classList\.(?:add|remove|toggle)|dataset\.theme)[\s\S]{0,100}(?:dark|current|white|eye)/,
    `${relative(file)} 不得建立第二套主题状态，主题写入必须继续走 src/lib/theme.ts`,
  );
  assert.doesNotMatch(
    source,
    /window\.(?:alert|confirm)\s*\(/,
    `${relative(file)} 的确认与错误反馈应使用可访问的工作台 UI，而非阻塞式浏览器弹窗`,
  );
}

console.log(`  ✓ ${files.length} 个 workbench 源文件使用语义 token、共享 UI primitives 与可访问入口`);

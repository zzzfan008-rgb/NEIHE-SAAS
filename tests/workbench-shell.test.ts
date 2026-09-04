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
assert.deepEqual(state, {
  hoveredToolGroupId: null,
  openToolGroupId: null,
  pinnedToolGroupId: null,
  rightDockOpen: false,
  resultsFlyoutOpen: false,
  focusReturnGroupId: null,
});

state = workbenchUiReducer(state, { type: "hover-group", groupId: "add" });
assert.equal(state.openToolGroupId, "add");
assert.equal(state.hoveredToolGroupId, "add");
state = workbenchUiReducer(state, { type: "leave-group", groupId: "add" });
assert.equal(state.openToolGroupId, "add", "pointer leave 只排队关闭，reducer 不得立即闪退");
state = workbenchUiReducer(state, { type: "close-hover", groupId: "add" });
assert.equal(state.openToolGroupId, null);

state = workbenchUiReducer(state, { type: "toggle-pin", groupId: "apparel" });
assert.equal(state.pinnedToolGroupId, "apparel");
assert.equal(state.openToolGroupId, "apparel");
state = workbenchUiReducer(state, { type: "hover-group", groupId: "video" });
assert.equal(state.openToolGroupId, "apparel", "固定窗口不能被快速悬停替换");
state = workbenchUiReducer(state, { type: "escape" });
assert.equal(state.openToolGroupId, null);
assert.equal(state.pinnedToolGroupId, null);
assert.equal(state.focusReturnGroupId, "apparel");
state = workbenchUiReducer(state, { type: "consume-focus-return" });
assert.equal(state.focusReturnGroupId, null);
state = workbenchUiReducer(state, { type: "toggle-right-dock" });
assert.equal(state.rightDockOpen, true);
state = workbenchUiReducer(state, { type: "toggle-results-flyout" });
assert.equal(state.resultsFlyoutOpen, true);
state = workbenchUiReducer(state, { type: "close-results-flyout" });
assert.equal(state.resultsFlyoutOpen, false);
console.log("  ✓ 外壳 reducer 覆盖悬停延迟关闭、点击固定、Escape 与焦点恢复元数据");

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
const popoverSource = fs.readFileSync(
  path.resolve(testRoot, "../src/components/ui/popover.tsx"),
  "utf8",
);
const nodeLibrarySource = fs.readFileSync(
  path.resolve(testRoot, "../src/components/panels/NodeLibraryPanel.tsx"),
  "utf8",
);
const workbenchShellRenderSource = shellSource.slice(shellSource.indexOf("export function WorkbenchShell"));

assert.match(combined, /@\/components\/ui\//, "新外壳必须复用已安装的 shadcn 基础组件");
assert.match(combined, /aria-(?:label|labelledby|expanded|controls)/, "新外壳的交互入口必须提供可感知名称或状态");
assert.match(combined, /transition-\[width,visibility\]/, "桌面 Dock 应通过占位宽度开合，避免遮挡画布控件与结果");
assert.match(shellSource, /<ToolRail state=\{state\} dispatch=\{dispatch\}/, "左侧入口必须替换为五组 ToolRail");
assert.doesNotMatch(shellSource, /LIBRARY_PANEL_ID|workbench-library-panel/, "旧节点库 Dock 不得继续出现在工作台外壳");
assert.match(shellSource, /border-l border-\[var\(--gc-border\)\]/, "属性必须使用固定右侧 Dock");
assert.match(shellSource, /RESULTS_FLYOUT_PANEL_ID[\s\S]*?absolute inset-y-0 left-0 z-\[60\]/, "结果与记录必须从最左侧覆盖展开");
assert.match(shellSource, /absolute left-2 top-2 z-40/, "五组工具入口应为画布左侧悬浮工具栏");
assert.match(popoverSource, /PopoverPrimitive\.Positioner/, "工具浮层必须使用具备碰撞定位能力的 Positioner");
assert.match(popoverSource, /max-h-\(--available-height\)/, "工具浮层高度必须受可用视口边界约束");
assert.match(popoverSource, /motion-reduce:animate-none/, "工具浮层必须尊重减少动态效果偏好");
assert.match(canvasFlowSource, /new ResizeObserver/, "Dock 改变画布尺寸时必须监听容器几何变化");
assert.match(
  canvasFlowSource,
  /x: viewport\.x \+ delta\.width \/ 2/,
  "Dock 开合必须维持画布中心对应的世界坐标",
);
assert.match(canvasFlowSource, /compactMinimap \? 128 : 200/, "窄画布必须缩小 MiniMap");
assert.match(canvasFlowSource, /minZoom=\{0\.2\}/, "React Flow 必须真实开放到 20% 缩放");
assert.match(canvasFlowSource, /maxZoom=\{3\}/, "React Flow 必须真实开放到 300% 缩放");
assert.match(canvasFlowSource, /<CanvasZoomControls minimapWidth=\{minimapWidth\} \/>/, "缩放控制器必须按 MiniMap 宽度动态避让");
assert.doesNotMatch(canvasFlowSource, /<Controls\b/, "画布不得继续使用 React Flow 竖向 Controls");
assert.match(canvasZoomControlsSource, /@\/components\/ui\/slider/, "缩放拖动条必须使用本地 shadcn Slider");
assert.match(canvasZoomControlsSource, /flex-row/, "缩放控制器必须横向排列");
assert.match(canvasZoomControlsSource, /zoomPercent/, "缩放控制器必须显示实时百分比");
assert.match(canvasZoomControlsSource, /FIT_CANVAS_ZOOM = 0\.68/, "适应画布必须固定为 68%");
assert.match(canvasZoomControlsSource, /step=\{1\}/, "缩放拖动条必须能精确回显 68% 等整数比例");
assert.match(canvasZoomControlsSource, /MINIMAP_CONTROL_GAP = 28/, "缩放控制器与 MiniMap 必须保留约 28px 间距");
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
assert.doesNotMatch(topBarSource, /ShortcutKey|pinned|openTimer/, "快捷键浮层不得保留手写键帽与点击固定状态");
assert.match(topBarSource, /onPointerEnter=\{openMenu\}[\s\S]*?onPointerLeave=\{scheduleClose\}/, "快捷键浮层必须悬停打开并在移开后关闭");
assert.match(appSource, /requestCanvasZoom\("in"\)/, "主修饰键加号必须缩放画布而不是浏览器页面");
assert.match(appSource, /copySelectedNodesToClipboard\(\)/, "复制快捷键必须读取 canonical 多选节点");
assert.match(appSource, /addExistingNodes\(additions\)/, "多节点粘贴必须通过原子批量 action 落入文档");
assert.equal(
  (workbenchShellRenderSource.match(/\{children\}/g) ?? []).length,
  1,
  "中心画布子树必须只挂载一次，Dock 开合不得重建 React Flow",
);
assert.equal(
  (workbenchShellRenderSource.match(/\{inspector\}/g) ?? []).length,
  1,
  "属性 Dock 必须保持单实例挂载",
);
assert.equal((workbenchShellRenderSource.match(/\{results\}/g) ?? []).length, 1, "结果与记录面板必须保持单实例挂载");
assert.match(shellSource, /id=\{INSPECTOR_PANEL_ID\}[\s\S]*?inert=\{!state\.rightDockOpen\}/);
assert.doesNotMatch(shellSource, /MobileSheet|useMediaQuery|DESKTOP_QUERY|mobilePanel/);
assert.doesNotMatch(appSource, /workspaceKey=\{activeTabId\}/);
assert.match(appSource, /inspector=\{\([\s\S]*?<InspectorPanel view="properties"/);
assert.match(appSource, /results=\{\([\s\S]*?<ResultsPanel[\s\S]*?<InspectorPanel view="result"/);
assert.doesNotMatch(appSource, /NodeLibraryPanel/, "旧节点库不得继续挂载；工具发现统一由 ToolRail 提供");
assert.ok(nodeLibrarySource.length > 0, "旧节点库源码暂保留以支持回滚，但不得挂载");
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

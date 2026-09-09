import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const mainSource = source("src/main.tsx");
const authGateSource = source("src/AuthGate.tsx");
const authContextSource = source("src/auth/AuthContext.tsx");
const appSource = source("src/App.tsx");
const compareSource = source("src/components/CompareOverlay.tsx");
const assetPickerSource = source("src/components/AssetPickerOverlay.tsx");
const projectTabsSource = source("src/components/panels/ProjectTabs.tsx");
const drawingBoardNodeSource = source("src/components/nodes/DrawingBoardNode.tsx");
const nodeRegistrySource = source("src/components/nodes/index.ts");

assert.match(mainSource, /import \{ AuthGate \} from "\.\/AuthGate"/);
assert.doesNotMatch(mainSource, /import App from/);
assert.match(authGateSource, /lazy\(\(\) => import\("\.\/App"\)\)/);
assert.match(authGateSource, /<AuthenticatedWorkspace userId=\{user\.id\}/);
assert.doesNotMatch(authContextSource, /flowStore/);
assert.match(authContextSource, /from "@\/lib\/workspaceRestoreState"/);
console.log("  ✓ 登录壳不静态拉取工作台 Store，认证后才加载 App");

for (const moduleName of ["CompareOverlay", "ImageViewer", "AssetPickerOverlay"]) {
  assert.match(appSource, new RegExp(`lazy\\(\\(\\) => import\\(\"@/components/${moduleName}\"\\)`));
}
assert.match(appSource, /window\.addEventListener\(OPEN_COMPARE_EVENT, openCompare\)/);
assert.match(appSource, /window\.addEventListener\(OPEN_ASSET_PICKER_EVENT, openAssetPicker\)/);
assert.match(appSource, /setAssetPickerRequest\(request\)/);
assert.match(appSource, /window\.addEventListener\("keydown", closeActiveOverlay\)/);
assert.match(appSource, /if \(viewerOpen\)[\s\S]*closeViewer\(\)[\s\S]*else if \(assetPickerRequest\)[\s\S]*setAssetPickerRequest\(null\)[\s\S]*else if \(compareOpen\)/);
assert.doesNotMatch(compareSource, /addEventListener\(OPEN_COMPARE_EVENT/);
assert.doesNotMatch(assetPickerSource, /addEventListener\(OPEN_ASSET_PICKER_EVENT/);
console.log("  ✓ 常驻工作台保留弹层事件和 Esc，懒加载首次操作不丢请求");

assert.match(projectTabsSource, /const loadProjectCenter = \(\) => import\("\.\/ProjectCenter"\)/);
assert.match(projectTabsSource, /onFocus=\{\(\) => void loadProjectCenter\(\)\}/);
assert.match(projectTabsSource, /onPointerEnter=\{\(\) => void loadProjectCenter\(\)\}/);
assert.match(projectTabsSource, /projectCenterRequested && \(/);
assert.match(projectTabsSource, /<LazyProjectCenter open=\{projectCenterOpen\}/);
console.log("  ✓ 项目中心支持 focus\/hover 预取，首次打开后保留组件实例");

assert.match(
  drawingBoardNodeSource,
  /lazy\(async \(\) => \{[\s\S]*?import\("@\/components\/drawing\/DrawingEditor"\)[\s\S]*?\}\)/,
  "绘画编辑器必须从画板节点动态加载",
);
assert.doesNotMatch(
  nodeRegistrySource,
  /from ["']@\/components\/drawing\/DrawingEditor["']/,
  "初始节点注册表不得静态拉取 Konva 绘画编辑器",
);
console.log("  ✓ Konva 绘画编辑器保留独立动态加载边界");

import assert from "node:assert/strict";
import fs from "node:fs";
import { TOOL_GROUPS } from "../src/lib/toolCatalog";
import { THEMES } from "../src/lib/theme";
import { VIDEO_CAPABILITIES, videoCapabilityToolItems } from "../src/lib/videoCapabilities";

const read = (path: string) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

console.log("工作台二次整改契约测试");

assert.deepEqual(THEMES.map((theme) => theme.id), ["current"], "只允许经典暗金主题");

const shell = read("src/components/workbench/WorkbenchShell.tsx");
assert.match(shell, /RESULTS_FLYOUT_PANEL_ID/);
assert.match(shell, /left-0/);
assert.match(shell, /z-\[60\]/);
assert.match(shell, /aria-label="属性"/);
assert.doesNotMatch(shell, /属性 \/ 结果/);

const frame = read("src/components/nodes/NodeFrame.tsx");
assert.match(frame, /gc-node-floating-title/);
assert.match(frame, /gc-node-border-state/);
assert.doesNotMatch(frame, /StatusDot|DISPLAY_STATE_STYLE|NODE_DISPLAY_META\[derivedState\]\.label/);

const zoom = read("src/components/CanvasZoomControls.tsx");
assert.match(zoom, /MIN_ZOOM_PERCENT = 20/);
assert.match(zoom, /MAX_ZOOM_PERCENT = 300/);
assert.match(zoom, /FIT_CANVAS_ZOOM = 0\.68/);
assert.match(zoom, /value=\{sliderValue\}/);
assert.doesNotMatch(zoom, /value=\{\[sliderValue\]\}/);

const toolbar = read("src/components/nodes/NodeActionToolbar.tsx");
assert.match(toolbar, /提示词优化/);
assert.match(toolbar, /风格转绘/);
assert.match(toolbar, /局部重绘/);
assert.match(toolbar, /2K/);
assert.match(toolbar, /4K/);
assert.match(toolbar, /\/api\/prompt-optimize/);
const promptOptimizer = read("server/routes/promptOptimize.ts");
const promptEnhancement = read("server/lib/promptEnhancement.ts");
assert.match(promptOptimizer, /optimizePromptText/);
assert.match(promptEnhancement, /gpt-5\.6-terra/);
assert.match(promptEnhancement, /\/v1\/chat\/completions/);

const store = read("src/store/flowStore.ts");
assert.match(store, /ensureGeneratedResultNode/);
assert.match(store, /runWithoutHistory\([\s\S]*ensureGeneratedResultNode/);

const items = TOOL_GROUPS.flatMap((group) => group.items);
for (const name of [
  "草图到效果图", "AI 改款", "面料替换", "配色替换", "印花提取", "印花裂变",
  "白底图制作", "一键换装", "风格迁移",
]) {
  const item = items.find((candidate) => candidate.name === name);
  assert.equal(item?.availability, "available", `${name} 必须可用`);
  assert.equal(item?.creationIntent?.type, "workflow-template", `${name} 必须启动完整工作流`);
}

assert.equal(items.find((item) => item.name === "本地上传视频")?.creationIntent?.type, "node");
assert.deepEqual(VIDEO_CAPABILITIES.map((item) => item.id), [
  "text-to-video", "first-frame-to-video", "keyframes-to-video",
  "multimodal-reference", "video-edit", "video-extend",
]);
for (const item of videoCapabilityToolItems()) {
  assert.equal(item.availability, "available", "用户确认后六个真实视频工具必须可用");
  assert.equal(item.creationIntent?.type, "workflow-template", "视频工具必须启动完整工作流");
  assert.equal(item.capabilityGate?.approvalState, "approved");
}

const tryOn = read("src/components/nodes/VirtualTryOnNode.tsx");
assert.doesNotMatch(tryOn, /打开双模型|图片模型|GPT Image 2|Gemini 3\.1 Flash/);
assert.match(tryOn, /FASHION_ASPECT_RATIOS/);
assert.match(tryOn, /默认 2K|2K/);

const fabricRecolor = read("src/components/nodes/FabricRecolorNode.tsx");
assert.match(fabricRecolor, /from "@\/components\/ui\/button"/);
assert.match(fabricRecolor, /from "@\/components\/ui\/input"/);
assert.match(fabricRecolor, /aria-label="自定义取色"/);

const videoProvider = read("server/providers/apiyiVideo.ts");
const seedanceContract = read("src/lib/seedance.ts");
assert.match(videoProvider, /\/seedance\/api\/v3\/contents\/generations\/tasks/);
assert.match(videoProvider, /doubao-seedance-2-5-260628/);
assert.match(seedanceContract, /doubao-seedance-2-0-mini-260615/);
assert.match(videoProvider, /reference_image/);
assert.match(videoProvider, /content\?\.video_url/);
assert.match(videoProvider, /Accept-Encoding/);
assert.doesNotMatch(videoProvider, /\/v1\/videos/);
const videoNode = read("src/components/nodes/VideoGenerateNode.tsx");
assert.match(videoNode, /产生对应费用/);
assert.match(videoNode, /SEEDANCE_MODEL_CAPABILITIES/);
assert.match(seedanceContract, /Seedance 2\.5/);
assert.match(seedanceContract, /Seedance 2\.0/);

console.log("工作台二次整改契约测试通过");

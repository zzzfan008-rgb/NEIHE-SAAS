import type { ToolGroup, ToolItem } from "../types/workbench";
import { videoCapabilityToolItems } from "./videoCapabilities";

const available = (
  id: string,
  name: string,
  icon: string,
  description: string,
  creationIntent: NonNullable<ToolItem["creationIntent"]>,
): ToolItem => ({
  id,
  name,
  icon,
  description,
  availability: "available",
  creationIntent,
});

const unavailable = (
  id: string,
  name: string,
  icon: string,
  description: string,
  disabledReason: string,
): ToolItem => ({
  id,
  name,
  icon,
  description,
  availability: "unavailable",
  disabledReason,
});

export const TOOL_GROUPS: readonly ToolGroup[] = [
  {
    id: "add",
    label: "添加节点",
    icon: "plus",
    items: [
      available(
        "text-node",
        "文本节点",
        "type",
        "在画布中添加可编辑的文字说明。",
        { type: "node", kind: "text-input" },
      ),
      available(
        "ti-angle",
        "3D 视角",
        "rotate-3d",
        "添加可拖动的三轴视角控制，并输出适配生图模型的角度文本。",
        { type: "node", kind: "ti-angle" },
      ),
      available(
        "local-image",
        "本地上传图片",
        "image-plus",
        "创建图片输入并从本机选择文件。",
        { type: "node", kind: "image-input" },
      ),
      available(
        "pose-reference",
        "人物姿势参考图",
        "user-round",
        "上传姿势图片并分析动作，可连接第一轮的通用图片入口作为姿势参考。",
        { type: "node", kind: "image-input", preset: { poseReference: true } },
      ),
      available(
        "background-extract",
        "背景板生成",
        "scan",
        "上传或连接图片，移除人物、主体和物品，生成可复用的背景板图片。",
        { type: "node", kind: "background-extract" },
      ),
      available(
        "character-board",
        "人物板生成",
        "user-round",
        "上传模特图，一键生成四视图人物身份板。",
        { type: "node", kind: "character-board" },
      ),
      available(
        "local-video",
        "本地上传视频",
        "video",
        "从本机添加视频素材。",
        { type: "node", kind: "video-input" },
      ),
      available(
        "asset-library",
        "从资产库中选择",
        "library",
        "创建图片输入并打开已有资产库。",
        { type: "asset-picker" },
      ),
    ],
  },
  {
    id: "apparel",
    label: "服装设计",
    icon: "shirt",
    items: [
      available(
        "sketch-render",
        "草图到效果图",
        "wand-sparkles",
        "打开已连线的草图渲染工作流。",
        { type: "workflow-template", templateId: "builtin-tool-sketch-render" },
      ),
      available(
        "ai-modify",
        "AI 改款",
        "scissors",
        "打开已连线的服装改款工作流。",
        { type: "workflow-template", templateId: "builtin-tool-ai-modify" },
      ),
      available(
        "fabric-replace",
        "面料配色替换",
        "layers",
        "打开已连线的面料配色替换工作流。",
        {
          type: "workflow-template",
          templateId: "builtin-tool-fabric-replace",
        },
      ),
      available(
        "print-extract",
        "印花提取",
        "scan",
        "打开已连线的印花提取工作流。",
        { type: "workflow-template", templateId: "builtin-tool-print-extract" },
      ),
      available(
        "print-mutate",
        "印花裂变",
        "sparkles",
        "打开已连线的印花裂变工作流。",
        { type: "workflow-template", templateId: "builtin-tool-print-mutate" },
      ),
    ],
  },
  {
    id: "try-on",
    label: "模特换装",
    icon: "user-round",
    items: [
      available(
        "white-background",
        "白底图制作",
        "frame",
        "打开已连线的白底图工作流。",
        {
          type: "workflow-template",
          templateId: "builtin-tool-white-background",
        },
      ),
      available(
        "one-click-try-on",
        "一键换装",
        "shirt",
        "打开简洁的一键换装工作流。",
        {
          type: "workflow-template",
          templateId: "builtin-tool-one-click-try-on",
        },
      ),
      available(
        "ai-styling",
        "AI 搭配",
        "shirt",
        "识别参考服饰，生成协调的全身搭配。",
        { type: "workflow-template", templateId: "builtin-tool-ai-styling" },
      ),
      available(
        "style-transfer",
        "风格迁移",
        "blend",
        "打开已连线的风格迁移工作流。",
        {
          type: "workflow-template",
          templateId: "builtin-tool-style-transfer",
        },
      ),
    ],
  },
  {
    id: "video",
    label: "视频制作",
    icon: "clapperboard",
    items: [...videoCapabilityToolItems()],
  },
  {
    id: "create",
    label: "创作工具",
    icon: "paintbrush",
    items: [
      available(
        "drawing-board",
        "绘画工具",
        "pencil-ruler",
        "新建独立空白画板并进行手工绘制。",
        { type: "drawing-board" },
      ),
      available(
        "color-tool",
        "色彩工具",
        "pipette",
        "快速选择、收藏并输出可连接色板。",
        { type: "color-palette", swatches: [] },
      ),
    ],
  },
] as const;

export function toolGroupById(
  id: string | null | undefined,
): ToolGroup | undefined {
  return TOOL_GROUPS.find((group) => group.id === id);
}

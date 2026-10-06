import { memo, type ComponentType } from "react";
import type { NodeProps, NodeTypes } from "@xyflow/react";
import { ImageInputNode } from "./ImageInputNode";
import { CharacterBoardNode } from "./CharacterBoardNode";
import { SketchToRenderNode } from "./SketchToRenderNode";
import { SketchOptimizeNode } from "./SketchOptimizeNode";
import { BackgroundExtractNode } from "./BackgroundExtractNode";
import { AiModifyNode } from "./AiModifyNode";
import { FabricRecolorNode } from "./FabricRecolorNode";
import { UpscaleNode } from "./UpscaleNode";
import { PrintExtractNode } from "./PrintExtractNode";
import { PrintMutateNode } from "./PrintMutateNode";
import { ResultNode } from "./ResultNode";
import { MaskRedrawNode } from "./MaskRedrawNode";
import { VirtualTryOnNode } from "./VirtualTryOnNode";
import { TextInputNode } from "./TextInputNode";
import { VideoInputNode } from "./VideoInputNode";
import { VideoGenerateNode } from "./VideoGenerateNode";
import { AudioInputNode } from "./AudioInputNode";
import { StageApprovalNode } from "./StageApprovalNode";
import { DrawingBoardNode } from "./DrawingBoardNode";
import { ColorPaletteNode } from "./ColorPaletteNode";
import { OutfitReferenceNode } from "./OutfitReferenceNode";
import { AiStylingNode } from "./AiStylingNode";
import { TiAngelNode } from "./TiAngelNode";

/** React Flow 拖拽时逐帧传入新的绝对坐标；节点自身不读取这些属性，比较时忽略以避免整棵节点树重渲染。 */
const VOLATILE_NODE_PROP_NAMES = new Set(["positionAbsoluteX", "positionAbsoluteY"]);

function nodePropsEqual<Props extends NodeProps>(previous: Props, next: Props): boolean {
  const previousProps = previous as unknown as Record<string, unknown>;
  const nextProps = next as unknown as Record<string, unknown>;
  for (const key of Object.keys(nextProps)) {
    if (VOLATILE_NODE_PROP_NAMES.has(key)) continue;
    if (!Object.is(previousProps[key], nextProps[key])) return false;
  }
  return Object.keys(previousProps).every((key) => key in nextProps);
}

function memoNode<Props extends NodeProps>(component: ComponentType<Props>): ComponentType<Props> {
  return memo(component, nodePropsEqual) as ComponentType<Props>;
}

export const nodeTypes: NodeTypes = {
  "character-board": memoNode(CharacterBoardNode),
  "outfit-reference": memoNode(OutfitReferenceNode),
  "ai-styling": memoNode(AiStylingNode),
  "image-input": memoNode(ImageInputNode),
  "background-extract": memoNode(BackgroundExtractNode),
  "text-input": memoNode(TextInputNode),
  "video-input": memoNode(VideoInputNode),
  "audio-input": memoNode(AudioInputNode),
  "video-generate": memoNode(VideoGenerateNode),
  "stage-approval": memoNode(StageApprovalNode),
  "drawing-board": memoNode(DrawingBoardNode),
  "color-palette": memoNode(ColorPaletteNode),
  "sketch-to-render": memoNode(SketchToRenderNode),
  "sketch-optimize": memoNode(SketchOptimizeNode),
  "ai-modify": memoNode(AiModifyNode),
  "fabric-recolor": memoNode(FabricRecolorNode),
  upscale: memoNode(UpscaleNode),
  "print-extract": memoNode(PrintExtractNode),
  "print-mutate": memoNode(PrintMutateNode),
  "mask-redraw": memoNode(MaskRedrawNode),
  "virtual-try-on": memoNode(VirtualTryOnNode),
  "ti-angle": memoNode(TiAngelNode),
  result: memoNode(ResultNode),
};

export { ImageInputNode } from "./ImageInputNode";
export { BackgroundExtractNode } from "./BackgroundExtractNode";
export { SketchToRenderNode } from "./SketchToRenderNode";
export { AiModifyNode } from "./AiModifyNode";
export { FabricRecolorNode } from "./FabricRecolorNode";
export { UpscaleNode } from "./UpscaleNode";
export { PrintExtractNode } from "./PrintExtractNode";
export { ResultNode } from "./ResultNode";
export { MaskRedrawNode } from "./MaskRedrawNode";
export { VirtualTryOnNode } from "./VirtualTryOnNode";
export { TextInputNode } from "./TextInputNode";
export { AudioInputNode } from "./AudioInputNode";
export { StageApprovalNode } from "./StageApprovalNode";
export { DrawingBoardNode } from "./DrawingBoardNode";
export { ColorPaletteNode } from "./ColorPaletteNode";
export { TiAngelNode } from "./TiAngelNode";

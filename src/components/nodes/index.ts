import type { NodeTypes } from "@xyflow/react";
import { ImageInputNode } from "./ImageInputNode";
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

export const nodeTypes: NodeTypes = {
  "outfit-reference": OutfitReferenceNode,
  "ai-styling": AiStylingNode,
  "image-input": ImageInputNode,
  "background-extract": BackgroundExtractNode,
  "text-input": TextInputNode,
  "video-input": VideoInputNode,
  "audio-input": AudioInputNode,
  "video-generate": VideoGenerateNode,
  "stage-approval": StageApprovalNode,
  "drawing-board": DrawingBoardNode,
  "color-palette": ColorPaletteNode,
  "sketch-to-render": SketchToRenderNode,
  "sketch-optimize": SketchOptimizeNode,
  "ai-modify": AiModifyNode,
  "fabric-recolor": FabricRecolorNode,
  upscale: UpscaleNode,
  "print-extract": PrintExtractNode,
  "print-mutate": PrintMutateNode,
  "mask-redraw": MaskRedrawNode,
  "virtual-try-on": VirtualTryOnNode,
  result: ResultNode,
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

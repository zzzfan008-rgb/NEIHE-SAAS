import { Position, type Node, type NodeProps } from "@xyflow/react";
import { NodeHandle as Handle } from "./NodeHandle";
import { NodeFrame, RunButton, Developing, inputClass } from "./NodeFrame";
import { ImageGrid } from "./ImageGrid";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { useCoalescedTextEdit } from "@/hooks/useCoalescedTextEdit";
import { selectActiveNodeInputImages, selectActiveReadOnly, useFlowStore } from "@/store/flowStore";
import { isNodeRunActive, type SketchOptimizeNodeData } from "@/types/workflow";
import { DEFAULT_GENERATION_MODEL_ID, IMAGE_MODEL_IDS, imageModelLabel, isImageModelId, defaultImageModelOptions, imageModelAspectRatioPatch } from "@/types/imageModels";

export function SketchOptimizeNode({ id, data, selected }: NodeProps<Node<SketchOptimizeNodeData>>) {
  const updateNodeData = useFlowStore((state) => state.updateNodeData);
  const runNode = useFlowStore((state) => state.runNode);
  const inputCount = useFlowStore((state) => selectActiveNodeInputImages(state, id).length);
  const readOnly = useFlowStore(selectActiveReadOnly);
  const edit = useCoalescedTextEdit({ kind: "node-data", nodeId: id, field: "prompt" }, { multiline: true });
  const running = isNodeRunActive(data.status);
  const disabled = readOnly || running;
  return <>
    <Handle id="references" type="target" position={Position.Left} title="设计草图（必需，一张）" style={{ top: "38%" }} />
    <Handle id="prompt" type="target" position={Position.Left} title="设计要求" style={{ top: "72%" }} />
    <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected} missingInput={inputCount !== 1}>
      <label className="block space-y-1">
        <span className="text-xs text-(--gc-node-muted)">设计理念与修改要求</span>
        <Textarea aria-label="设计理念与修改要求" value={data.prompt} {...edit.bind} disabled={disabled} rows={5}
          placeholder="如：保留落肩轮廓，缩短衣长，袖口改为罗纹，衣身使用羊毛。"
          className={inputClass + " min-h-28 resize-y"} />
      </label>
      <p className="text-[10px] leading-4 text-(--gc-node-muted)">内置服装专业指令：整理结构线，以黑白灰区分面料与服装层次；保留未要求修改的设计，不生成写实效果图。</p>
      <label className="block space-y-1">
        <span className="text-[10px] text-(--gc-node-muted)">图片模型</span>
        <Select value={data.modelId ?? DEFAULT_GENERATION_MODEL_ID} disabled={disabled} onValueChange={(value) => {
          if (isImageModelId(value)) updateNodeData(id, { modelId: value, modelOptions: defaultImageModelOptions(value, data.aspectRatio) });
        }}>
          <SelectTrigger className="nodrag w-full" aria-label="线稿优化模型"><SelectValue>{imageModelLabel(data.modelId ?? DEFAULT_GENERATION_MODEL_ID)}</SelectValue></SelectTrigger>
          <SelectContent>{IMAGE_MODEL_IDS.filter((value) => value !== "gpt-image-2").map((value) => <SelectItem key={value} value={value}>{imageModelLabel(value)}</SelectItem>)}</SelectContent>
        </Select>
      </label>
      <label className="block space-y-1">
        <span className="text-[10px] text-(--gc-node-muted)">画幅比例</span>
        <Select value={data.aspectRatio} disabled={disabled} onValueChange={(value) => {
          if (value) updateNodeData(id, imageModelAspectRatioPatch(data.modelId, data.modelOptions, value));
        }}>
          <SelectTrigger className="nodrag w-full" aria-label="线稿画幅比例"><SelectValue /></SelectTrigger>
          <SelectContent>{["1:1", "3:4", "4:3", "9:16", "16:9"].map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
        </Select>
      </label>
      {inputCount !== 1 && <p className="text-[10px] text-(--gc-node-muted)">请连接一张已上传的草图或手绘图。</p>}
      <RunButton status={data.status} label="生成优化线稿" disabled={readOnly || inputCount !== 1} onClick={() => void runNode(id)} />
      {running && <Developing />}
      <ImageGrid images={data.outputImages} />
    </NodeFrame>
    <Handle id="image" type="source" position={Position.Right} title="优化后的线稿" />
  </>;
}

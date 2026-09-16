import { Position, type Node, type NodeProps } from "@xyflow/react";
import { NodeHandle as Handle } from "./NodeHandle";
import { useFlowStore, selectActiveNodeInputImages, selectActiveReadOnly } from "@/store/flowStore";
import { isNodeRunActive, type BackgroundExtractNodeData } from "@/types/workflow";
import { NodeFrame, RunButton, Developing } from "./NodeFrame";
import { ImageGrid } from "./ImageGrid";
import { ModelControls } from "./ModelControls";

export function BackgroundExtractNode({ id, data, selected }: NodeProps<Node<BackgroundExtractNodeData>>) {
  const runNode = useFlowStore((state) => state.runNode);
  const inputCount = useFlowStore((state) => selectActiveNodeInputImages(state, id).length);
  const readOnly = useFlowStore(selectActiveReadOnly);
  const running = isNodeRunActive(data.status);

  return (
    <>
      <Handle id="references" type="target" position={Position.Left} title="待提取图片（必需，一张）" />
      <NodeFrame
        nodeId={id}
        title={data.label}
        status={data.status}
        error={data.error}
        selected={selected}
        missingInput={inputCount !== 1}
      >
        <p className="text-[10px] leading-relaxed text-[var(--gc-node-muted)]">
          连接一张图片，移除人物和物体，仅保留原图背景。
        </p>
        {inputCount !== 1 && (
          <p className="text-[10px] text-[var(--gc-node-muted)]">请连接一张图片后再提取背景。</p>
        )}
        <ModelControls
          nodeId={id}
          modelId={data.modelId}
          modelOptions={data.modelOptions}
          disabled={running}
        />
        <RunButton
          status={data.status}
          label="提取背景"
          disabled={readOnly || inputCount !== 1}
          onClick={() => void runNode(id)}
        />
        {running && <Developing />}
        <ImageGrid images={data.outputImages} />
      </NodeFrame>
      <Handle id="image" type="source" position={Position.Right} title="背景图片" />
    </>
  );
}

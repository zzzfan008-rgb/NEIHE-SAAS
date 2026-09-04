import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useFlowStore } from "@/store/flowStore";
import { BATCH_SIZES, isNodeRunActive, type SketchToRenderNodeData } from "@/types/workflow";
import { imageModelAspectRatioPatch } from "@/types/imageModels";
import { NodeFrame, RunButton, Developing, inputClass } from "./NodeFrame";
import { ImageGrid } from "./ImageGrid";
import { ModelControls } from "./ModelControls";
import { useCoalescedTextEdit } from "@/hooks/useCoalescedTextEdit";

const ASPECT_RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9"];
export function SketchToRenderNode({
  id,
  data,
  selected,
}: NodeProps<Node<SketchToRenderNodeData>>) {
  const updateNodeData = useFlowStore((s) => s.updateNodeData);
  const runNode = useFlowStore((s) => s.runNode);
  const promptEdit = useCoalescedTextEdit(
    { kind: "node-data", nodeId: id, field: "prompt" },
    { multiline: true },
  );
  const running = isNodeRunActive(data.status);

  return (
    <>
      <Handle id="references" type="target" position={Position.Left} title="参考图" style={{ top: "38%" }} />
      <Handle id="prompt" type="target" position={Position.Left} title="提示词" style={{ top: "72%" }} />
      <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected}>
        <label className="block space-y-1">
          <span className="text-[10px] text-neutral-500">渲染提示词</span>
          <textarea
            value={data.prompt}
            {...promptEdit.bind}
            rows={9}
            placeholder="如：写实摄影风，柔和自然光，白底服装效果图"
            className={`${inputClass} resize-none`}
          />
          <span className="text-[9px] text-neutral-600">可连接 0–8 张参考图，按连线顺序传入</span>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1">
            <span className="text-[10px] text-neutral-500">画幅比例</span>
            <select
              value={data.aspectRatio}
              onChange={(e) => updateNodeData(
                id,
                imageModelAspectRatioPatch(data.modelId, data.modelOptions, e.target.value),
              )}
              className={inputClass}
            >
              {ASPECT_RATIOS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] text-neutral-500">生成数量</span>
            <select
              value={data.batchSize}
              onChange={(e) =>
                updateNodeData(id, { batchSize: Number(e.target.value) as 1 | 2 | 4 | 8 })
              }
              className={inputClass}
            >
              {BATCH_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n} 张
                </option>
              ))}
            </select>
          </label>
        </div>
        <ModelControls nodeId={id} modelId={data.modelId} modelOptions={data.modelOptions} preferredAspectRatio={data.aspectRatio} disabled={running} />
        <RunButton status={data.status} onClick={() => void runNode(id)} label="生成效果图" />
        {running && <Developing />}
        <ImageGrid images={data.outputImages} />
      </NodeFrame>
      <Handle id="image" type="source" position={Position.Right} title="生成图片" />
    </>
  );
}

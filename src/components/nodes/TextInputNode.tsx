import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useFlowStore } from "@/store/flowStore";
import type { TextInputNodeData } from "@/types/workflow";
import { NodeFrame, inputClass } from "./NodeFrame";
import { TextNodeActionToolbar } from "./NodeActionToolbar";

export function TextInputNode({ id, data, selected }: NodeProps<Node<TextInputNodeData>>) {
  const updateNodeData = useFlowStore((state) => state.updateNodeData);
  return (
    <>
      <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected} toolbar={<TextNodeActionToolbar nodeId={id} text={data.text} />}>
        <textarea
          aria-label="文本内容"
          value={data.text}
          rows={5}
          placeholder="输入说明、灵感或备注…"
          onChange={(event) => updateNodeData(id, { text: event.target.value })}
          className={`${inputClass} resize-none leading-relaxed`}
        />
        <p className="text-[10px] leading-4 text-[var(--gc-node-muted)]">仅作为画布说明，不会自动触发生成。</p>
      </NodeFrame>
      <Handle type="source" position={Position.Right} id="text" title="文本输出" />
    </>
  );
}

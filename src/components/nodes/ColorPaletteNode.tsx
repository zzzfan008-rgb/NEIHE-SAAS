import { Position, type Node, type NodeProps } from "@xyflow/react";
import { NodeHandle as Handle } from "./NodeHandle";
import type { ColorPaletteNodeData } from "@/types/workflow";
import { NodeFrame } from "./NodeFrame";

export function ColorPaletteNode({ id, data, selected }: NodeProps<Node<ColorPaletteNodeData>>) {
  return (
    <>
      <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected}>
        <div className="grid grid-cols-4 gap-1.5" aria-label={`${data.swatches.length} 个目标颜色`}>
          {data.swatches.map((swatch) => (
            <div key={swatch.id} className="space-y-1" title={`${swatch.name ?? "颜色"} ${swatch.value}`}>
              <span className="block h-9 rounded-md border border-white/15" style={{ backgroundColor: swatch.value }} />
              <span className="block truncate text-center font-mono text-[8px] text-[var(--gc-node-muted)]">{swatch.value}</span>
            </div>
          ))}
        </div>
        <p className="text-[9px] leading-4 text-[var(--gc-node-muted)]">
          连接到配色替换节点后，本色板优先于节点内的临时颜色。
        </p>
      </NodeFrame>
      <Handle type="source" position={Position.Right} id="colors" title="颜色数据输出" />
    </>
  );
}

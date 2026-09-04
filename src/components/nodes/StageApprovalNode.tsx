import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Button } from "@/components/ui/button";
import { selectActiveEdges, selectActiveNodes, useFlowStore } from "@/store/flowStore";
import type { StageApprovalNodeData, WorkflowNodeData } from "@/types/workflow";
import { NodeFrame } from "./NodeFrame";

function firstOutput(data: WorkflowNodeData): string | undefined {
  if (data.kind === "image-input") return data.imageUrl;
  if (data.kind === "drawing-board") return data.previewImageRef;
  if (data.kind === "result") return data.images[0];
  if ("outputImages" in data && Array.isArray(data.outputImages)) return data.outputImages[0];
  return undefined;
}

export function StageApprovalNode({ id, data, selected }: NodeProps<Node<StageApprovalNodeData>>) {
  const nodes = useFlowStore(selectActiveNodes);
  const edges = useFlowStore(selectActiveEdges);
  const updateNodeData = useFlowStore((state) => state.updateNodeData);
  const candidateEdge = edges.find((edge) => edge.target === id && edge.targetHandle === "baseline-candidate");
  const candidate = candidateEdge ? nodes.find((node) => node.id === candidateEdge.source) : undefined;
  const baselineRef = candidate ? firstOutput(candidate.data) : undefined;
  const basisRevision = candidate?.data.kind === "virtual-try-on"
    && candidate.data.workflowStage === "scene-stabilize"
    ? candidate.data.basisRevision ?? 0
    : undefined;
  const hasApproval = Boolean(data.approvedSourceNodeId || data.approvedBaselineRef || data.approvedAt);
  const confirmed = Boolean(
    candidate
    && baselineRef
    && data.approvedSourceNodeId === candidate.id
    && data.approvedBaselineRef === baselineRef
    && data.approvedBasisRevision === basisRevision,
  );
  const state = !baselineRef
    ? (hasApproval ? "stale" : "waiting")
    : confirmed
      ? "confirmed"
      : hasApproval
        ? "stale"
        : "confirmable";
  const stateLabel = {
    waiting: "等待第一轮结果",
    confirmable: "待确认",
    confirmed: "已确认",
    stale: "需要重新确认",
  }[state];

  const approve = () => {
    if (!candidate || !baselineRef || basisRevision === undefined) return;
    updateNodeData(id, {
      approvedSourceNodeId: candidate.id,
      approvedBaselineRef: baselineRef,
      approvedBasisRevision: basisRevision,
      approvedAt: new Date().toISOString(),
      error: undefined,
    });
  };

  return (
    <>
      <Handle
        id="baseline-candidate"
        type="target"
        position={Position.Left}
        title="baseline-candidate · 待确认第一轮基准"
      />
      <NodeFrame
        nodeId={id}
        title={data.label}
        status={data.status}
        error={data.error}
        selected={selected}
        displayState={state === "stale" ? "needs-reconfirmation" : state === "waiting" ? "missing-input" : state === "confirmed" ? "success" : "ready"}
        summary={<p className="text-[9px] text-[var(--gc-node-muted)]">人工门槛，不会调用图片模型</p>}
      >
        <div className="space-y-1.5">
          <div className="rounded-md border border-[var(--gc-node-border)] bg-[var(--gc-node-inner)] p-1.5">
            <p className="text-[10px] text-[var(--gc-text-muted)]">人工审批状态</p>
            <p className={state === "stale" ? "text-xs font-medium text-amber-600" : "text-xs font-medium text-[var(--gc-text)]"}>
              {stateLabel}
            </p>
            {candidate && <p className="mt-1 truncate text-[9px] text-[var(--gc-text-muted)]">来源：{candidate.data.label}</p>}
          </div>
          <p className="text-[9px] leading-relaxed text-[var(--gc-text-muted)]">
            检查人物身份、动作神态、手脚、场景构图、主穿搭轮廓与目标配饰。
          </p>
          <Button
            type="button"
            size="sm"
            variant={confirmed ? "default" : "outline"}
            disabled={!baselineRef || confirmed}
            onClick={approve}
            className="nodrag w-full text-[10px]"
          >
            {confirmed ? "基准已确认" : baselineRef ? "确认当前第一轮基准" : "等待第一轮结果"}
          </Button>
        </div>
      </NodeFrame>
      <Handle id="image" type="source" position={Position.Right} title="已确认基准图" />
    </>
  );
}

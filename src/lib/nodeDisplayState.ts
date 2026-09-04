import type { NodeDisplayState, NodeRunStatus } from "@/types/workflow";

export type { NodeDisplayState } from "@/types/workflow";

export interface NodeDisplayStateInput {
  runStatus?: NodeRunStatus;
  approvalStale?: boolean;
  missingInput?: boolean;
  terminalMatchesBasis?: boolean;
  executable?: boolean;
}

export const NODE_DISPLAY_META: Record<NodeDisplayState, { label: string; icon: string }> = {
  idle: { label: "空闲", icon: "circle" },
  "missing-input": { label: "缺少输入", icon: "circle-alert" },
  ready: { label: "可运行", icon: "play" },
  queued: { label: "排队中", icon: "clock" },
  running: { label: "运行中", icon: "loader" },
  retrying: { label: "自动重试", icon: "refresh-cw" },
  success: { label: "成功", icon: "circle-check" },
  failed: { label: "失败", icon: "circle-x" },
  "unknown-outcome": { label: "结果未知", icon: "circle-help" },
  "needs-reconfirmation": { label: "需要重新确认", icon: "shield-alert" },
};

export function deriveNodeDisplayState(input: NodeDisplayStateInput): NodeDisplayState {
  if (input.runStatus === "queued") return "queued";
  if (input.runStatus === "running" || input.runStatus === "cancel_requested") return "running";
  if (input.runStatus === "retry_wait") return "retrying";
  if (input.approvalStale) return "needs-reconfirmation";
  if (input.missingInput) return "missing-input";
  if (input.terminalMatchesBasis !== false) {
    if (input.runStatus === "success") return "success";
    if (input.runStatus === "error") return "failed";
    if (input.runStatus === "outcome_unknown") return "unknown-outcome";
  }
  if (input.executable) return "ready";
  return "idle";
}

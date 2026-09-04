import { useRef, useState, type ReactNode } from "react";
import { isNodeRunActive, type NodeDisplayState, type NodeRunStatus } from "@/types/workflow";
import { useGenerationSafetyBlockReason } from "@/store/generationSafety";
import { useCoalescedTextEdit } from "@/hooks/useCoalescedTextEdit";
import { deriveNodeDisplayState } from "@/lib/nodeDisplayState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const STATUS_TEXT: Record<NodeRunStatus, string> = {
  idle: "空闲",
  queued: "排队中",
  running: "运行中",
  retry_wait: "等待重试",
  cancel_requested: "取消请求中",
  success: "成功",
  error: "失败",
  outcome_unknown: "结果未知",
  cancelled: "已取消",
};

interface NodeFrameProps {
  title: string;
  status: NodeRunStatus;
  error?: string;
  selected?: boolean;
  displayState?: NodeDisplayState;
  missingInput?: boolean;
  executable?: boolean;
  approvalStale?: boolean;
  terminalMatchesBasis?: boolean;
  summary?: ReactNode;
  primaryAction?: ReactNode;
  latestOutput?: ReactNode;
  toolbar?: ReactNode;
  /** 传入 nodeId 后标题支持双击改名（回车/失焦确认，Esc 取消） */
  nodeId?: string;
  children?: ReactNode;
}

/**
 * 单框节点：标题悬浮在边框上方 2px，执行状态仅通过边框颜色/动画表达。
 * 不再设置独立标题栏、状态点或状态文字，避免视觉层级重复。
 */
export function NodeFrame({
  title,
  status,
  error,
  selected,
  nodeId,
  displayState,
  missingInput,
  executable,
  approvalStale,
  terminalMatchesBasis,
  summary,
  primaryAction,
  latestOutput,
  toolbar,
  children,
}: NodeFrameProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const cancelledRef = useRef(false);
  const labelEdit = useCoalescedTextEdit(nodeId ? { kind: "node-data", nodeId, field: "label" } : null);
  const derivedState = displayState ?? deriveNodeDisplayState({
    runStatus: status,
    missingInput,
    executable,
    approvalStale,
    terminalMatchesBasis,
  });

  const commit = () => {
    const value = draft.trim();
    if (!value) labelEdit.cancel();
    else {
      labelEdit.updateValue(value);
      labelEdit.flush();
    }
    setEditing(false);
  };

  return (
    <div className="gc-node-frame relative w-[280px]">
      {selected && toolbar && (
        <div className="gc-node-floating-toolbar nodrag nopan absolute bottom-[calc(100%+27px)] left-1/2 z-20 -translate-x-1/2">
          {toolbar}
        </div>
      )}
      <div className="gc-node-floating-title absolute bottom-[calc(100%+2px)] left-1/2 z-10 w-[calc(100%-18px)] -translate-x-1/2 text-center">
        {editing ? (
          <Input
            aria-label="节点名称"
            value={draft}
            autoFocus
            {...labelEdit.bind}
            onChange={(event) => {
              setDraft(event.target.value);
              labelEdit.updateValue(event.target.value);
            }}
            onBlur={() => {
              if (cancelledRef.current) cancelledRef.current = false;
              else commit();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) commit();
              if (event.key === "Escape") {
                cancelledRef.current = true;
                labelEdit.cancel();
                setEditing(false);
              }
            }}
            className="nodrag h-6 w-full rounded-sm border-[var(--gc-node-accent)] bg-[var(--gc-node-main)] px-1.5 text-center text-xs text-[var(--gc-node-text)] focus-visible:border-[var(--gc-node-accent)] focus-visible:ring-2 focus-visible:ring-[var(--gc-node-accent)]/45"
          />
        ) : (
          <span
            className={`inline-block max-w-full truncate rounded-t-md bg-[var(--gc-canvas)] px-2 text-xs font-medium tracking-wide text-[var(--gc-node-text)] ${nodeId ? "cursor-text" : ""}`}
            title={nodeId ? "双击改名" : undefined}
            onDoubleClick={nodeId ? () => {
              cancelledRef.current = false;
              setDraft(title);
              setEditing(true);
            } : undefined}
          >
            {title}
          </span>
        )}
      </div>
      <div
        data-display-state={derivedState}
        className={`gc-node-card gc-node-border-state rounded-xl border bg-[var(--gc-node-main)] shadow-xl shadow-black/25 transition-[border-color,box-shadow] ${selected ? "is-selected" : ""}`}
      >
        <div className="gc-node-body space-y-2 p-2.5">
          {summary && <div className="gc-node-summary">{summary}</div>}
          {children}
          {primaryAction && <div className="gc-node-primary-action">{primaryAction}</div>}
          {latestOutput && <div className="gc-node-latest-output">{latestOutput}</div>}
        </div>
        {error && (
          <div className="gc-node-error mx-2.5 mb-2.5 rounded-md border border-red-900/50 bg-red-950/40 px-2 py-1 text-[10px] leading-relaxed text-red-500">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

interface RunButtonProps {
  status: NodeRunStatus;
  onClick: () => void;
  label?: string;
  disabled?: boolean;
}

export function RunButton({ status, onClick, label = "运行", disabled }: RunButtonProps) {
  const active = isNodeRunActive(status);
  const safetyBlockReason = useGenerationSafetyBlockReason();
  const newGenerationBlocked = !active && Boolean(safetyBlockReason);
  return (
    <Button
      type="button"
      size="sm"
      onClick={onClick}
      disabled={active || disabled || newGenerationBlocked}
      title={newGenerationBlocked ? safetyBlockReason ?? undefined : undefined}
      className={`nodrag h-8 w-full rounded-md px-3 text-xs font-medium ${
        active
          ? "btn-running-breathe bg-[var(--gc-control)] text-[var(--gc-accent)]"
          : "bg-[var(--gc-accent)] text-[var(--gc-primary-foreground)] hover:bg-[var(--gc-accent)]/80"
      }`}
    >
      {active ? STATUS_TEXT[status] : newGenerationBlocked ? "生成暂不可用" : label}
    </Button>
  );
}

export function Developing() {
  return (
    <div className="develop-overlay nodrag h-28 w-full">
      <div className="develop-gridlines" />
      <div className="develop-scanline" />
      <span className="develop-label">显影中</span>
    </div>
  );
}

export const inputClass =
  "nodrag w-full rounded-md border border-[var(--gc-node-border)] bg-[var(--gc-node-inner)] px-2 py-1.5 text-xs text-[var(--gc-node-text)] placeholder:text-[var(--gc-node-muted)] outline-none focus-visible:border-[var(--gc-node-accent)] focus-visible:ring-2 focus-visible:ring-[var(--gc-node-accent)]/40";

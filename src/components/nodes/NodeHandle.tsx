import { Handle as ReactFlowHandle, useNodeId, type HandleProps } from "@xyflow/react";
import { selectActiveEdges, selectActiveReadOnly, useFlowStore } from "../../store/flowStore";

/** Keep React Flow's connection mechanics; disconnect only this endpoint. */
export function NodeHandle({ id, type = "source", title, onContextMenu, onKeyDown, ...props }: HandleProps) {
  const nodeId = useNodeId();
  const readOnly = useFlowStore(selectActiveReadOnly);
  const disabled = readOnly || props.isConnectable === false;
  return (
    <ReactFlowHandle
      {...props}
      id={id}
      type={type}
      role="button"
      aria-label={props["aria-label"] ?? title ?? (type === "source" ? "输出连接点" : "输入连接点")}
      aria-disabled={disabled || undefined}
      tabIndex={props["aria-hidden"] || disabled ? -1 : (props.tabIndex ?? 0)}
      className={`${props.className ?? ""} focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gc-accent)]`}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        event.stopPropagation();
        if (!disabled && !event.repeat) event.currentTarget.click();
      }}
      title={title ? `${title} · 右键取消连线` : "右键取消连线"}
      onContextMenu={(event) => {
        onContextMenu?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        const state = useFlowStore.getState();
        if (!nodeId || selectActiveReadOnly(state)) return;
        const changes = selectActiveEdges(state)
          .filter((edge) => type === "source"
            ? edge.source === nodeId && (edge.sourceHandle ?? null) === (id ?? null)
            : edge.target === nodeId && (edge.targetHandle ?? null) === (id ?? null))
          .map((edge) => ({ id: edge.id, type: "remove" as const }));
        if (changes.length > 0) state.onEdgesChange(changes);
      }}
    />
  );
}

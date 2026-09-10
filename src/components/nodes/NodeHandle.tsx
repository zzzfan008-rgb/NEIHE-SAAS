import { Handle as ReactFlowHandle, useNodeId, type HandleProps } from "@xyflow/react";
import { selectActiveEdges, selectActiveReadOnly, useFlowStore } from "../../store/flowStore";

/** Keep React Flow's connection mechanics; disconnect only this endpoint. */
export function NodeHandle({ id, type = "source", title, onContextMenu, ...props }: HandleProps) {
  const nodeId = useNodeId();

  return (
    <ReactFlowHandle
      {...props}
      id={id}
      type={type}
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

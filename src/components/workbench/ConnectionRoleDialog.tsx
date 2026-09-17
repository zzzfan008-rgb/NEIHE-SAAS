import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { compatibleUnusedInputRoles } from "@/lib/workflowPorts";
import { selectActiveEdges, selectActiveNodes, useFlowStore } from "@/store/flowStore";
import type { WorkflowInputRole } from "@/types/workflow";

export function ConnectionRoleDialog() {
  const draft = useFlowStore((state) => state.pendingConnectionDraft);
  const connectionDraftError = useFlowStore((state) => state.connectionDraftError);
  const confirmPendingConnection = useFlowStore((state) => state.confirmPendingConnection);
  const cancelPendingConnection = useFlowStore((state) => state.cancelPendingConnection);
  const nodes = useFlowStore(selectActiveNodes);
  const edges = useFlowStore(selectActiveEdges);
  const [selectedRole, setSelectedRole] = useState<WorkflowInputRole | null>(null);

  const availableRoles = useMemo(() => {
    if (!draft) return [];
    const source = nodes.find((node) => node.id === draft.sourceNodeId);
    const target = nodes.find((node) => node.id === draft.targetNodeId);
    if (!source || !target) return [];
    const compatibleUnused = compatibleUnusedInputRoles({
      source,
      target,
      sourceHandle: draft.sourceHandle,
      existingEdges: edges,
    });
    if (!draft.proposedTargetHandle) return compatibleUnused;
    return compatibleUnused.filter((port) => port.id === draft.proposedTargetHandle);
  }, [draft, edges, nodes]);

  useEffect(() => {
    if (!draft) {
      setSelectedRole(null);
      return;
    }
    setSelectedRole((draft.proposedTargetHandle ?? availableRoles[0]?.id ?? null) as WorkflowInputRole | null);
  }, [availableRoles, draft]);

  const close = () => {
    cancelPendingConnection();
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[role="application"][aria-label="工作流画布"]')?.focus();
    });
  };

  return (
    <Dialog open={Boolean(draft)} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent
        aria-label="确认连接角色"
        showCloseButton={false}
        className="max-h-[calc(100vh-48px)] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>确认连接角色</DialogTitle>
          <DialogDescription>
            先指定这张参考图在当前阶段的唯一职责，确认后才会写入连线和撤销历史。
          </DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-[var(--gc-text)]">可用角色</legend>
          {availableRoles.map((role) => (
            <label key={role.id} className="flex cursor-pointer items-start gap-2 rounded-lg border border-[var(--gc-border)] p-2">
              <input
                type="radio"
                name="connection-role"
                value={role.id}
                checked={selectedRole === role.id}
                onChange={() => setSelectedRole(role.id as WorkflowInputRole)}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block text-xs text-[var(--gc-text)]">{role.label}</span>
                <span className="block text-[10px] text-[var(--gc-text-muted)]">
                  {role.required ? "必填" : "可选"} · 已连接来源 {edges.filter((edge) => edge.target === draft?.targetNodeId && edge.targetHandle === role.id).length}/{role.maxSources}
                </span>
              </span>
            </label>
          ))}
          {availableRoles.length === 0 && (
            <p className="rounded-md bg-amber-500/10 p-2 text-xs text-amber-600">没有兼容且尚未占满的角色。</p>
          )}
        </fieldset>
        {connectionDraftError && <p role="alert" className="text-xs text-red-500">{connectionDraftError}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>取消</Button>
          <Button
            type="button"
            disabled={!selectedRole}
            onClick={() => { if (selectedRole) confirmPendingConnection(selectedRole); }}
          >
            确认连接
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

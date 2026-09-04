import { useState } from "react";
import { CopyIcon, CropIcon, PaintbrushIcon, SparklesIcon, Trash2Icon, WandSparklesIcon } from "lucide-react";
import { nanoid } from "nanoid";
import { selectActiveNodes, selectActiveReadOnly, useFlowStore, type FlowNode } from "@/store/flowStore";
import { isNodeRunActive } from "@/types/workflow";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

function IconAction({
  label,
  onClick,
  children,
  disabled,
  destructive,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            className={destructive
              ? "text-[var(--gc-text-muted)] hover:bg-destructive/10 hover:text-destructive"
              : "text-[var(--gc-text-muted)] hover:bg-[var(--gc-panel-hover)] hover:text-[var(--gc-text)]"}
          >
            {children}
          </Button>
        )}
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function useToolbarDisabled(nodeId: string) {
  const readOnly = useFlowStore(selectActiveReadOnly);
  const status = useFlowStore((state) => selectActiveNodes(state).find((node) => node.id === nodeId)?.data.status);
  return readOnly || !status || isNodeRunActive(status);
}

function duplicateNode(nodeId: string) {
  const state = useFlowStore.getState();
  const node = selectActiveNodes(state).find((candidate) => candidate.id === nodeId);
  if (!node) return;
  const clone = structuredClone(node) as FlowNode;
  clone.id = nanoid(8);
  clone.position = { x: node.position.x + 32, y: node.position.y + 32 };
  clone.selected = true;
  clone.data.status = "idle";
  clone.data.error = undefined;
  state.addExistingNode(clone);
}

function deleteNode(nodeId: string) {
  useFlowStore.getState().onNodesChange([{ id: nodeId, type: "remove" }]);
}

function connectTransform(nodeId: string, kind: "ai-modify" | "mask-redraw" | "upscale", patch?: Record<string, unknown>) {
  const state = useFlowStore.getState();
  const newId = state.addConnectedNode(nodeId, kind, "downstream");
  if (newId && patch) useFlowStore.getState().updateNodeData(newId, patch);
}

export function TextNodeActionToolbar({ nodeId, text }: { nodeId: string; text: string }) {
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeError, setOptimizeError] = useState<string | null>(null);
  const toolbarDisabled = useToolbarDisabled(nodeId);
  const optimize = async () => {
    if (!text.trim() || optimizing || toolbarDisabled) return;
    setOptimizing(true);
    setOptimizeError(null);
    try {
      const response = await fetch("/api/prompt-optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const payload = await response.json().catch(() => ({})) as { text?: string; error?: string };
      if (!response.ok || !payload.text?.trim()) throw new Error(payload.error || "提示词优化失败");
      // 按产品约定直接覆盖；updateNodeData 仍保留一次可撤销历史。
      useFlowStore.getState().updateNodeData(nodeId, { text: payload.text.trim() });
    } catch (error) {
      setOptimizeError(error instanceof Error ? error.message : "提示词优化失败");
    } finally {
      setOptimizing(false);
    }
  };

  return (
    <div role="toolbar" aria-label="文本节点操作" className="flex h-9 items-center gap-0.5 rounded-lg border border-[var(--gc-border)] bg-[var(--gc-panel)] p-1 shadow-xl">
      <Button type="button" variant="ghost" size="sm" onClick={() => void optimize()} disabled={toolbarDisabled || optimizing || !text.trim()} className="text-[10px] text-[var(--gc-accent)] hover:bg-[var(--gc-panel-hover)] hover:text-[var(--gc-accent)]">
        <WandSparklesIcon aria-hidden="true" className="size-3.5" />
        {optimizing ? "优化中…" : "提示词优化"}
      </Button>
      <IconAction label="复制" onClick={() => duplicateNode(nodeId)} disabled={toolbarDisabled}><CopyIcon aria-hidden="true" className="size-3.5" /></IconAction>
      <IconAction label="删除" onClick={() => deleteNode(nodeId)} disabled={toolbarDisabled} destructive><Trash2Icon aria-hidden="true" className="size-3.5" /></IconAction>
      {optimizeError && <span role="alert" title={optimizeError} className="max-w-28 truncate px-1 text-[9px] text-red-400">{optimizeError}</span>}
    </div>
  );
}

export function MediaNodeActionToolbar({ nodeId, imageActions = true }: { nodeId: string; imageActions?: boolean }) {
  const toolbarDisabled = useToolbarDisabled(nodeId);
  return (
    <div role="toolbar" aria-label="媒体节点操作" className="flex h-9 items-center gap-0.5 rounded-lg border border-[var(--gc-border)] bg-[var(--gc-panel)] p-1 shadow-xl">
      {imageActions && (
        <>
          <Button type="button" variant="ghost" size="sm" disabled={toolbarDisabled} onClick={() => connectTransform(nodeId, "ai-modify", { prompt: "在保持主体可辨识和构图稳定的前提下，完成目标风格转绘" })} className="text-[10px] text-[var(--gc-text-muted)] hover:bg-[var(--gc-panel-hover)] hover:text-[var(--gc-text)]">
            <PaintbrushIcon aria-hidden="true" className="size-3.5" />风格转绘
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={toolbarDisabled} onClick={() => connectTransform(nodeId, "mask-redraw")} className="text-[10px] text-[var(--gc-text-muted)] hover:bg-[var(--gc-panel-hover)] hover:text-[var(--gc-text)]">
            <CropIcon aria-hidden="true" className="size-3.5" />局部重绘
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={toolbarDisabled}
              render={(
                <Button type="button" variant="ghost" size="sm" aria-label="高清放大" className="text-[10px] text-[var(--gc-text-muted)] hover:bg-[var(--gc-panel-hover)] hover:text-[var(--gc-text)]">
                  <SparklesIcon aria-hidden="true" className="size-3.5" />高清放大
                </Button>
              )}
            />
            <DropdownMenuContent side="bottom" align="start" className="w-24 min-w-24 border border-[var(--gc-border)] bg-[var(--gc-panel)] text-[var(--gc-text)] ring-0">
              {(["2K", "4K"] as const).map((size) => (
                <DropdownMenuItem key={size} onClick={() => connectTransform(nodeId, "upscale", { imageSize: size })} className="min-h-8 text-xs">
                  {size}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
      <IconAction label="复制" onClick={() => duplicateNode(nodeId)} disabled={toolbarDisabled}><CopyIcon aria-hidden="true" className="size-3.5" /></IconAction>
      <IconAction label="删除" onClick={() => deleteNode(nodeId)} disabled={toolbarDisabled} destructive><Trash2Icon aria-hidden="true" className="size-3.5" /></IconAction>
    </div>
  );
}

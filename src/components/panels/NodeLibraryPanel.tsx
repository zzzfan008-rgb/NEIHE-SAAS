import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NODE_SPECS, type NodeKind } from "@/types/workflow";
import {
  selectActiveNodes,
  selectActivePrimarySelectedNodeId,
  useFlowStore,
  type FlowNode,
} from "@/store/flowStore";
import { DND_MIME } from "../CanvasFlow";
import { cn } from "@/lib/utils";
import { requestCanvasLanding } from "@/lib/canvasLanding";

const KIND_ORDER: NodeKind[] = [
  "image-input",
  "background-extract",
  "sketch-optimize",
  "sketch-to-render",
  "ai-modify",
  "fabric-recolor",
  "upscale",
  "print-extract",
  "print-mutate",
  "virtual-try-on",
  "mask-redraw",
  "result",
];

export function nodeLibraryClickPosition(
  nodes: readonly FlowNode[],
  selectedNodeId: string | null,
): { x: number; y: number } {
  const anchor = nodes.find((node) => node.id === selectedNodeId) ?? nodes.at(-1);
  if (!anchor) return { x: 0, y: 0 };
  return { x: anchor.position.x + 380, y: anchor.position.y };
}

export function NodeLibraryPanel({ className }: { className?: string }) {
  return (
    <aside
      className={cn(
        "gc-panel flex w-72 shrink-0 flex-col border-r border-[var(--gc-border)] bg-[var(--gc-panel)]",
        className,
      )}
    >
      <div className="flex h-10 shrink-0 items-center border-b border-[var(--gc-border)] px-4">
        <h2 className="text-[10px] font-medium tracking-widest text-[var(--gc-text-muted)]">
          节点库
        </h2>
      </div>
      <NodeList />
      <div className="border-t border-[var(--gc-border)] px-3 py-2 text-[10px] leading-relaxed text-[var(--gc-text-muted)]">
        点击添加 · 也可拖拽到画布
        <br />
        左键框选 · 中/右键平移 · Delete 删除
      </div>
    </aside>
  );
}

function NodeList() {
  const addByClick = (kind: NodeKind) => {
    const state = useFlowStore.getState();
    const position = nodeLibraryClickPosition(
      selectActiveNodes(state),
      selectActivePrimarySelectedNodeId(state),
    );
    let nodeId: string | null = null;
    flushSync(() => {
      nodeId = useFlowStore.getState().addNode(kind, position);
    });
    if (!nodeId) return;
    requestCanvasLanding({
      tabId: useFlowStore.getState().activeTabId,
      nodeId,
      fitView: false,
      activateFilePicker: kind === "image-input" || kind === "background-extract",
      selectText: kind !== "image-input" && kind !== "result",
    });
  };

  return (
    <div className="flex-1 space-y-2 overflow-y-auto p-3">
      {KIND_ORDER.map((kind) => {
        const spec = NODE_SPECS[kind];
        return (
          <Card
            key={kind}
            size="sm"
            className="gc-node-library-card gap-0 rounded-lg bg-[var(--gc-panel)] py-0 ring-1 ring-[var(--gc-border)] transition-shadow hover:ring-[var(--gc-accent)]"
          >
            <Button
              type="button"
              variant="ghost"
              draggable
              onClick={() => addByClick(kind)}
              onDragStart={(event) => {
                event.dataTransfer.setData(DND_MIME, kind);
                event.dataTransfer.effectAllowed = "move";
              }}
              title={`点击添加${spec.title}，或拖拽到画布指定位置`}
              className="h-auto w-full cursor-grab select-none flex-col items-start gap-1 rounded-lg p-2.5 text-left whitespace-normal text-[var(--gc-node-text)] hover:bg-[var(--gc-node-inner-hover)] hover:text-[var(--gc-node-text)] active:cursor-grabbing"
            >
              <span className="text-xs font-medium text-[var(--gc-node-text)]">{spec.title}</span>
              <span className="text-[10px] leading-relaxed text-[var(--gc-node-muted)]">
                {spec.description}
              </span>
            </Button>
          </Card>
        );
      })}
    </div>
  );
}

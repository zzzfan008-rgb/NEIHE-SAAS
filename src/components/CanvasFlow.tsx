import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  ReactFlow,
  MiniMap,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type NodeChange,
} from "@xyflow/react";
import {
  beginHistoryTransaction,
  endHistoryTransaction,
  selectActiveEdges,
  selectActiveNodes,
  selectActiveReadOnly,
  selectActivePrimarySelectedNodeId,
  selectActiveDocumentTarget,
  useFlowStore,
  type FlowNode,
  type HistoryTransactionToken,
} from "@/store/flowStore";
import { DotWaveBackground } from "./DotWaveBackground";
import { PulseEdge } from "./edges/PulseEdge";
import { nodeTypes } from "./nodes";
import type { NodeKind } from "@/types/workflow";
import {
  CANVAS_LANDING_EVENT,
  consumeCanvasLanding,
  peekCanvasLanding,
  requestCanvasLanding,
  type CanvasLandingIntent,
} from "@/lib/canvasLanding";
import { CanvasZoomControls } from "./CanvasZoomControls";
import { CanvasMiniMapNode, minimapNodeColor } from "./CanvasMiniMapNode";
import { detectDesktopShortcutPlatform } from "@/lib/keyboardShortcuts";
import {
  CANVAS_CREATION_EVENT,
  CANVAS_CREATION_MIME,
  OPEN_BUILTIN_TEMPLATE_EVENT,
  documentTargetMatches,
  findNearestVisibleNodePosition,
  parseCanvasCreationDragPayload,
  type CanvasCreationRequest,
} from "@/lib/canvasCreation";
import { openDrawingTool } from "@/lib/drawingTool";
import { OPEN_ASSET_PICKER_EVENT, type AssetPickerRequest } from "@/lib/overlayEvents";
import type { CanvasCreationIntent } from "@/types/workbench";
import { directedPathNodeIds } from "@/lib/graphLayout";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UnlinkIcon } from "lucide-react";

export const DND_MIME = "application/garment-node";

const edgeTypes = { pulse: PulseEdge };

function landingControl(nodeId: string): HTMLElement | null {
  const node = document.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${CSS.escape(nodeId)}"]`,
  );
  if (!node) return null;
  return node.querySelector<HTMLElement>(
    'input[type="file"], textarea, input:not([type="hidden"]), select, button',
  );
}

function focusLandingControl(intent: CanvasLandingIntent, attempts = 8): void {
  if (!intent.nodeId) return;
  const control = landingControl(intent.nodeId);
  if (!control) {
    if (attempts > 0) requestAnimationFrame(() => focusLandingControl(intent, attempts - 1));
    return;
  }
  control.focus({ preventScroll: true });
  if (
    intent.selectText &&
    (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)
  ) control.select();
  if (
    intent.activateFilePicker &&
    control instanceof HTMLInputElement &&
    control.type === "file"
  ) control.click();
}

interface DragHistoryTransactionRef {
  current: HistoryTransactionToken | null;
  /** Native drag gesture identity; event.timeStamp is monotonic within the page. */
  startedAt: number | null;
}

const cancelledDragPositionRefs = new WeakSet<DragHistoryTransactionRef>();

/**
 * A tab/load transition can cancel a drag before React Flow emits dragStop.
 * Ignore only late position frames from that old gesture; selection changes
 * remain live, and the suppression ends at the gesture boundary.
 */
export function filterCancelledDragPositionChanges(
  ref: DragHistoryTransactionRef,
  changes: NodeChange<FlowNode>[],
): NodeChange<FlowNode>[] {
  return cancelledDragPositionRefs.has(ref)
    ? changes.filter((change) => change.type !== "position")
    : changes;
}

/**
 * 拖拽被浏览器中断时提交最后可见位置，保留一次可撤销的用户操作。
 * 页签/项目转换的取消与回滚仍由 flowStore 在转换前处理。
 */
export function finishDragHistoryTransaction(
  ref: DragHistoryTransactionRef,
  stoppedAt?: number,
): boolean {
  if (stoppedAt !== undefined && ref.startedAt !== null && stoppedAt < ref.startedAt) {
    return false;
  }
  const token = ref.current;
  cancelledDragPositionRefs.delete(ref);
  ref.startedAt = null;
  if (!token) return false;
  ref.current = null;
  return endHistoryTransaction(token);
}

/** 开始拖拽并让 store 侧的保存/撤销/切页命令能够同步清除本地 token。 */
export function beginDragHistoryTransaction(
  ref: DragHistoryTransactionRef,
  startedAt: number,
): void {
  if (ref.startedAt !== null && startedAt < ref.startedAt) return;
  finishDragHistoryTransaction(ref, startedAt);
  cancelledDragPositionRefs.delete(ref);
  ref.startedAt = startedAt;
  ref.current = beginHistoryTransaction("node-drag", (outcome, settledToken) => {
    if (ref.current !== settledToken) return;
    ref.current = null;
    if (outcome === "cancelled") cancelledDragPositionRefs.add(ref);
  });
}

/** 统一收束 blur、pointercancel 与组件卸载造成的拖拽中断。 */
export function registerDragInterruptionHandlers(
  ref: DragHistoryTransactionRef,
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
): () => void {
  const finishOnBlur = () => {
    finishDragHistoryTransaction(ref);
  };
  const finishOnPointerCancel = (event: Event) => {
    finishDragHistoryTransaction(ref, event.timeStamp);
  };
  target.addEventListener("blur", finishOnBlur);
  target.addEventListener("pointercancel", finishOnPointerCancel);
  return () => {
    target.removeEventListener("blur", finishOnBlur);
    target.removeEventListener("pointercancel", finishOnPointerCancel);
    finishDragHistoryTransaction(ref);
  };
}

/** 小地图配色随主题 */
const MINIMAP_COLORS = {
  current: { bg: "#e2e2e2", node: "#8a8a8a", mask: "rgba(191,191,191,0.58)" },
};

interface EdgeContextMenuState {
  edgeId: string;
  clientX: number;
  clientY: number;
}

export function CanvasFlow() {
  const nodes = useFlowStore(selectActiveNodes);
  const edges = useFlowStore(selectActiveEdges);
  const onNodesChange = useFlowStore((s) => s.onNodesChange);
  const onEdgesChange = useFlowStore((s) => s.onEdgesChange);
  const onConnect = useFlowStore((s) => s.onConnect);
  const isValidConnection = useFlowStore((s) => s.isValidConnection);
  const addNode = useFlowStore((s) => s.addNode);
  const setSelectedNodeIds = useFlowStore((s) => s.setSelectedNodeIds);
  const activeTabId = useFlowStore((s) => s.activeTabId);
  const readOnly = useFlowStore(selectActiveReadOnly);
  const primarySelectedNodeId = useFlowStore(selectActivePrimarySelectedNodeId);
  const { fitView, screenToFlowPosition } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const [landingVersion, setLandingVersion] = useState(0);
  const [compactMinimap, setCompactMinimap] = useState(false);
  const [edgeMenu, setEdgeMenu] = useState<EdgeContextMenuState | null>(null);
  const minimapWidth = compactMinimap ? 128 : 200;
  const minimapHeight = compactMinimap ? 96 : 150;
  const minimap = MINIMAP_COLORS.current;
  const multiSelectionKeyCode = detectDesktopShortcutPlatform() === "macos" ? "Meta" : "Control";
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const dragTransactionRef = useRef<DragHistoryTransactionRef>({
    current: null,
    startedAt: null,
  }).current;
  const renderedEdges = useMemo(() => {
    if (!primarySelectedNodeId) {
      return edges.map((edge) => ({
        ...edge,
        type: edge.type ?? "pulse",
        data: { ...edge.data, pathEmphasis: "quiet" },
      }));
    }
    const paths = directedPathNodeIds(primarySelectedNodeId, nodes, edges);
    return edges.map((edge) => {
      const pathEmphasis = paths.upstream.has(edge.source) && paths.upstream.has(edge.target)
        ? "upstream"
        : paths.downstream.has(edge.source) && paths.downstream.has(edge.target)
          ? "downstream"
          : "unrelated";
      return { ...edge, type: edge.type ?? "pulse", data: { ...edge.data, pathEmphasis } };
    });
  }, [edges, nodes, primarySelectedNodeId]);

  const createFromIntent = useCallback((
    intent: CanvasCreationIntent,
    mode: "click" | "drop",
    position?: { x: number; y: number },
  ) => {
    if (readOnly) return;
    if (intent.type === "workflow-template") {
      window.dispatchEvent(new CustomEvent(OPEN_BUILTIN_TEMPLATE_EVENT, {
        detail: { templateId: intent.templateId },
      }));
      return;
    }
    const container = canvasContainerRef.current;
    if (!container) return;
    const box = container.getBoundingClientRect();
    const dropPosition = position;
    const preferred = dropPosition ?? screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
    const topLeft = screenToFlowPosition({ x: box.left, y: box.top });
    const bottomRight = screenToFlowPosition({ x: box.right, y: box.bottom });
    const resolved = findNearestVisibleNodePosition({
      viewport: { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y },
      preferred,
      nodeSize: { width: 280, height: 180 },
      occupied: nodes.map((node) => ({
        left: node.position.x,
        top: node.position.y,
        right: node.position.x + (node.measured?.width ?? node.width ?? 280),
        bottom: node.position.y + (node.measured?.height ?? node.height ?? 180),
      })),
      preservePreferred: mode === "drop",
    });
    if (intent.type === "drawing-board") {
      openDrawingTool({
        target: selectActiveDocumentTarget(useFlowStore.getState()),
        position: resolved,
      });
      return;
    }
    const normalizedIntent = intent.type === "asset-picker"
      ? { type: "node", kind: "image-input" as const }
        : intent.type === "color-palette"
          ? { type: "node", kind: "color-palette" as const, preset: { swatches: intent.swatches } }
          : intent;
    if (normalizedIntent.type !== "node") return;
    const nodeId = addNode(normalizedIntent.kind, resolved, normalizedIntent.preset);
    if (!nodeId) return;
    const target = selectActiveDocumentTarget(useFlowStore.getState());
    if (intent.type === "asset-picker") {
      const detail: AssetPickerRequest = { target, nodeId };
      window.dispatchEvent(new CustomEvent(OPEN_ASSET_PICKER_EVENT, { detail }));
    } else if (intent.type === "node" && (intent.kind === "image-input" || intent.kind === "background-extract") && mode === "click") {
      requestCanvasLanding({ tabId: target.tabId, nodeId, fitView: false, activateFilePicker: true });
    }
  }, [addNode, nodes, readOnly, screenToFlowPosition]);

  useEffect(() => {
    const onCreation = (event: Event) => {
      const request = (event as CustomEvent<CanvasCreationRequest>).detail;
      if (!request?.target || !request.intent) return;
      const current = selectActiveDocumentTarget(useFlowStore.getState());
      if (!documentTargetMatches(request.target, current)) return;
      createFromIntent(request.intent, request.mode, request.position);
    };
    window.addEventListener(CANVAS_CREATION_EVENT, onCreation);
    return () => window.removeEventListener(CANVAS_CREATION_EVENT, onCreation);
  }, [createFromIntent]);

  useEffect(
    () => registerDragInterruptionHandlers(dragTransactionRef, window),
    [],
  );

  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setCompactMinimap(window.innerWidth <= 1024 || entry.contentRect.width < 760);
    });

    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const onLanding = (event: Event) => {
      const intent = (event as CustomEvent<CanvasLandingIntent>).detail;
      if (intent?.tabId === activeTabId) setLandingVersion((version) => version + 1);
    };
    window.addEventListener(CANVAS_LANDING_EVENT, onLanding);
    return () => window.removeEventListener(CANVAS_LANDING_EVENT, onLanding);
  }, [activeTabId]);

  useEffect(() => {
    if (!nodesInitialized || !peekCanvasLanding(activeTabId)) return;
    const intent = consumeCanvasLanding(activeTabId);
    if (!intent) return;
    let cancelled = false;
    void (async () => {
      if (intent.fitView) {
        await fitView({ padding: 0.16, minZoom: 0.35, maxZoom: 1, duration: 0 });
      }
      if (!cancelled) requestAnimationFrame(() => focusLandingControl(intent));
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTabId, fitView, landingVersion, nodesInitialized]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const intent = parseCanvasCreationDragPayload(e.dataTransfer.getData(CANVAS_CREATION_MIME));
      if (intent) {
        createFromIntent(intent, "drop", screenToFlowPosition({ x: e.clientX, y: e.clientY }));
        return;
      }
      const kind = e.dataTransfer.getData(DND_MIME) as NodeKind | "";
      if (!kind || readOnly) return;
      addNode(kind, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    },
    [addNode, createFromIntent, screenToFlowPosition, readOnly],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      const filtered = filterCancelledDragPositionChanges(dragTransactionRef, changes);
      if (filtered.length > 0) onNodesChange(filtered);
    },
    [onNodesChange],
  );


  const openEdgeContextMenu = useCallback((event: ReactMouseEvent, edge: Edge) => {
    event.preventDefault();
    setEdgeMenu({ edgeId: edge.id, clientX: event.clientX, clientY: event.clientY });
  }, []);
  return (
    <div ref={canvasContainerRef} className="min-h-0 flex-1">
      <ReactFlow
        aria-label="工作流画布"
        nodes={nodes}
        edges={renderedEdges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onEdgeContextMenu={openEdgeContextMenu}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onDrop={onDrop}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onNodeDragStart={(event) => {
          if (readOnly) return;
          beginDragHistoryTransaction(dragTransactionRef, event.timeStamp);
        }}
        onNodeDragStop={(event) => {
          finishDragHistoryTransaction(dragTransactionRef, event.timeStamp);
        }}
        onPaneClick={() => {
          setSelectedNodeIds([]);
          setEdgeMenu(null);
        }}
        deleteKeyCode={readOnly ? null : ["Delete", "Backspace"]}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        selectionOnDrag
        multiSelectionKeyCode={multiSelectionKeyCode}
        panOnDrag={[1, 2]}
        autoPanOnNodeDrag={false}
        minZoom={0.2}
        maxZoom={3}
        defaultViewport={{ x: 100, y: 200, zoom: 1 }}
        proOptions={{ hideAttribution: true }}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={{ type: "pulse" }}
      >
        <DotWaveBackground />
        <MiniMap<FlowNode>
          position="bottom-right"
          bgColor={minimap.bg}
          nodeColor={(node) => minimapNodeColor(node.data)}
          nodeComponent={CanvasMiniMapNode}
          maskColor={minimap.mask}
          style={{
            width: minimapWidth,
            height: minimapHeight,
            margin: 12,
          }}
          pannable
          zoomable
        />
        <CanvasZoomControls minimapWidth={minimapWidth} />
      </ReactFlow>
      {edgeMenu && (
        <DropdownMenu
          open
          onOpenChange={(open) => {
            if (!open) setEdgeMenu(null);
          }}
        >
          <DropdownMenuTrigger
            render={(
              <span
                aria-hidden="true"
                className="pointer-events-none fixed z-[71] size-px"
                style={{ left: edgeMenu.clientX, top: edgeMenu.clientY }}
              />
            )}
          />
          <DropdownMenuContent
            aria-label="连线操作"
            align="start"
            side="bottom"
            sideOffset={2}
            className="w-36 border border-[var(--gc-border)] bg-[var(--gc-panel)] text-[var(--gc-text)] ring-0"
          >
            <DropdownMenuItem
              variant="destructive"
              disabled={readOnly}
              onClick={() => {
                onEdgesChange([{ id: edgeMenu.edgeId, type: "remove" }]);
                setEdgeMenu(null);
              }}
            >
              <UnlinkIcon aria-hidden="true" />
              断开连线
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

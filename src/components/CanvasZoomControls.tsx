import { useEffect, useState } from "react";
import { Maximize2Icon, MinusIcon, NetworkIcon, PlusIcon } from "lucide-react";
import { Panel, useReactFlow, useViewport } from "@xyflow/react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  CANVAS_ZOOM_COMMAND_EVENT,
  type CanvasZoomCommand,
} from "@/lib/keyboardShortcuts";
import {
  selectActivePrimarySelectedNodeId,
  selectActiveReadOnly,
  useFlowStore,
} from "@/store/flowStore";

const MIN_ZOOM_PERCENT = 20;
const MAX_ZOOM_PERCENT = 300;
const FIT_CANVAS_ZOOM = 0.68;
const MINIMAP_EDGE_MARGIN = 12;
const MINIMAP_CONTROL_GAP = 28;

function ZoomButton({
  label,
  onClick,
  children,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            onClick={onClick}
            disabled={disabled}
            className="text-[var(--gc-text-muted)] hover:bg-[var(--gc-panel-hover)] hover:text-[var(--gc-text)]"
          />
        )}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

export function CanvasZoomControls({ minimapWidth }: { minimapWidth: number }) {
  const { fitView, zoomIn, zoomOut, zoomTo } = useReactFlow();
  const { zoom } = useViewport();
  const selectedNodeId = useFlowStore(selectActivePrimarySelectedNodeId);
  const readOnly = useFlowStore(selectActiveReadOnly);
  const autoLayoutSelectedWorkflow = useFlowStore((state) => state.autoLayoutSelectedWorkflow);
  const [layoutMessage, setLayoutMessage] = useState("");
  const zoomPercent = Math.round(zoom * 100);
  const sliderValue = Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, zoomPercent));

  useEffect(() => {
    const onZoomCommand = (event: Event) => {
      const command = (event as CustomEvent<CanvasZoomCommand>).detail;
      if (command === "in") void zoomIn({ duration: 120 });
      if (command === "out") void zoomOut({ duration: 120 });
    };
    window.addEventListener(CANVAS_ZOOM_COMMAND_EVENT, onZoomCommand);
    return () => window.removeEventListener(CANVAS_ZOOM_COMMAND_EVENT, onZoomCommand);
  }, [zoomIn, zoomOut]);

  return (
    <Panel
      position="bottom-right"
      className="nodrag nopan m-0 z-50"
      style={{
        margin: 0,
        right: minimapWidth + MINIMAP_EDGE_MARGIN + MINIMAP_CONTROL_GAP,
        bottom: MINIMAP_EDGE_MARGIN,
      }}
    >
      <TooltipProvider delay={250}>
        <Card
          size="sm"
          data-testid="canvas-zoom-controls"
          role="group"
          aria-label="画布缩放控制"
          className="gc-panel flex-row items-center gap-1 rounded-xl bg-[var(--gc-panel)] p-1 py-1 text-[var(--gc-text)] shadow-lg ring-1 ring-[var(--gc-border)]"
        >
          <ZoomButton label="缩小画布" onClick={() => void zoomOut({ duration: 120 })}>
            <MinusIcon aria-hidden="true" />
          </ZoomButton>

          <Slider
            aria-label="画布缩放比例"
            value={sliderValue}
            min={MIN_ZOOM_PERCENT}
            max={MAX_ZOOM_PERCENT}
            step={1}
            onValueChange={(nextZoom) => {
              if (Number.isFinite(nextZoom)) void zoomTo(nextZoom / 100, { duration: 0 });
            }}
            className="w-28"
          />

          <ZoomButton label="放大画布" onClick={() => void zoomIn({ duration: 120 })}>
            <PlusIcon aria-hidden="true" />
          </ZoomButton>

          <output
            aria-live="polite"
            aria-label={`当前缩放 ${zoomPercent}%`}
            className="min-w-11 text-center text-[10px] tabular-nums text-[var(--gc-text-muted)]"
          >
            {zoomPercent}%
          </output>

          <div aria-hidden="true" className="h-5 w-px bg-[var(--gc-border)]" />

          <ZoomButton
            label="适应画布"
            onClick={() => void fitView({
              padding: 0.16,
              minZoom: FIT_CANVAS_ZOOM,
              maxZoom: FIT_CANVAS_ZOOM,
              duration: 180,
            })}
          >
            <Maximize2Icon aria-hidden="true" />
          </ZoomButton>

          <ZoomButton
            label={selectedNodeId ? "整理所选工作流" : "请先选择工作流节点"}
            disabled={!selectedNodeId || readOnly}
            onClick={() => {
              const error = autoLayoutSelectedWorkflow();
              setLayoutMessage(error ?? "已整理所选工作流");
            }}
          >
            <NetworkIcon aria-hidden="true" />
          </ZoomButton>
          <span className="sr-only" role="status" aria-live="polite">{layoutMessage}</span>
        </Card>
      </TooltipProvider>
    </Panel>
  );
}

import type { Dispatch, DragEvent, KeyboardEvent } from "react";
import {
  BlendIcon,
  ClapperboardIcon,
  FrameIcon,
  ImagePlusIcon,
  ImagesIcon,
  LayersIcon,
  LibraryIcon,
  PaletteIcon,
  PencilRulerIcon,
  PipetteIcon,
  Rotate3dIcon,
  ScanIcon,
  ScissorsIcon,
  ShirtIcon,
  SparklesIcon,
  TypeIcon,
  UserRoundIcon,
  VideoIcon,
  WandSparklesIcon,
} from "lucide-react";
import { CANVAS_CREATION_MIME, serializeCanvasCreationDragPayload } from "@/lib/canvasCreation";
import type { CanvasCreationIntent, ToolGroup, ToolIconName } from "@/types/workbench";
import { cn } from "@/lib/utils";
import type { WorkbenchUiAction } from "./workbenchState";

const ITEM_ICONS: Record<string, typeof TypeIcon> = {
  type: TypeIcon,
  "image-plus": ImagePlusIcon,
  video: VideoIcon,
  library: LibraryIcon,
  "wand-sparkles": WandSparklesIcon,
  scissors: ScissorsIcon,
  layers: LayersIcon,
  palette: PaletteIcon,
  scan: ScanIcon,
  sparkles: SparklesIcon,
  frame: FrameIcon,
  shirt: ShirtIcon,
  blend: BlendIcon,
  "user-round": UserRoundIcon,
  clapperboard: ClapperboardIcon,
  images: ImagesIcon,
  "pencil-ruler": PencilRulerIcon,
  pipette: PipetteIcon,
  "rotate-3d": Rotate3dIcon,
};

function itemIcon(icon: ToolIconName) {
  return ITEM_ICONS[icon] ?? SparklesIcon;
}

export function ToolFlyout({
  group,
  dispatch,
  onIntent,
  onPointerEnter,
  onPointerLeave,
}: {
  group: ToolGroup;
  dispatch: Dispatch<WorkbenchUiAction>;
  onIntent: (intent: CanvasCreationIntent) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const select = (intent: CanvasCreationIntent) => {
    onIntent(intent);
    dispatch({ type: "close-group", groupId: group.id });
  };
  const drag = (event: DragEvent<HTMLButtonElement>, intent: CanvasCreationIntent) => {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(CANVAS_CREATION_MIME, serializeCanvasCreationDragPayload(intent));
  };
  const escape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    dispatch({ type: "escape" });
  };

  return (
    <div
      className="w-[19rem] p-2"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onKeyDown={escape}
    >
      <div className="px-2 pb-2 pt-1">
        <h2 className="text-sm font-semibold text-[var(--gc-text)]">{group.label}</h2>
        <p className="mt-0.5 text-[10px] text-[var(--gc-text-muted)]">点击添加到当前视口，或拖到指定位置</p>
      </div>
      <div role="menu" aria-label={group.label} className="grid gap-1">
        {group.items.map((item) => {
          const Icon = itemIcon(item.icon);
          const enabled = item.availability === "available" && Boolean(item.creationIntent);
          return (
            <div key={item.id} className="group/item rounded-lg">
              <button
                type="button"
                role="menuitem"
                draggable={enabled}
                aria-disabled={!enabled}
                data-video-capability-id={item.capabilityGate?.domain === "video" ? item.capabilityGate.capabilityId : undefined}
                data-approval-state={item.capabilityGate?.domain === "video" ? item.capabilityGate.approvalState : undefined}
                title={!enabled ? item.disabledReason : undefined}
                onDragStart={enabled ? (event) => drag(event, item.creationIntent!) : undefined}
                onClick={enabled ? () => select(item.creationIntent!) : undefined}
                className={cn(
                  "flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--gc-accent)]",
                  enabled
                    ? "cursor-grab hover:bg-[var(--gc-panel-hover)] focus-visible:bg-[var(--gc-panel-hover)]"
                    : "cursor-not-allowed opacity-55",
                )}
              >
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--gc-control)] text-[var(--gc-accent)] ring-1 ring-[var(--gc-border)]">
                  <Icon aria-hidden="true" className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium text-[var(--gc-text)]">{item.name}</span>
                    <span className="shrink-0 text-[9px] text-[var(--gc-text-muted)]">{enabled ? "可用" : "未开放"}</span>
                  </span>
                  <span className="mt-0.5 block text-[10px] leading-4 text-[var(--gc-text-muted)]">{item.description}</span>
                  {!enabled && <span className="mt-1 block text-[9px] leading-3 text-amber-500">{item.disabledReason}</span>}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

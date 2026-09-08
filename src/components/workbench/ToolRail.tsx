import { useEffect, useRef, useState, type Dispatch, type KeyboardEvent } from "react";
import {
  ClapperboardIcon,
  PaintbrushIcon,
  PlusIcon,
  ShirtIcon,
  UserRoundIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { requestCanvasCreation } from "@/lib/canvasCreation";
import { openColorTool } from "@/lib/colorTool";
import { TOOL_GROUPS } from "@/lib/toolCatalog";
import { selectActiveDocumentTarget, useFlowStore } from "@/store/flowStore";
import type { CanvasCreationIntent, ToolGroupId } from "@/types/workbench";
import { cn } from "@/lib/utils";
import { ShortcutMenu } from "./ShortcutMenu";
import { ToolFlyout } from "./ToolFlyout";
import type { WorkbenchUiAction, WorkbenchUiState } from "./workbenchState";

const GROUP_ICONS = {
  add: PlusIcon,
  apparel: ShirtIcon,
  "try-on": UserRoundIcon,
  video: ClapperboardIcon,
  create: PaintbrushIcon,
} as const;

const HOVER_CLOSE_MS = 140;

export function ToolRail({
  state,
  dispatch,
}: {
  state: WorkbenchUiState;
  dispatch: Dispatch<WorkbenchUiAction>;
}) {
  const [focusIndex, setFocusIndex] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const triggerRefs = useRef(new Map<ToolGroupId, HTMLButtonElement>());
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = (groupId: ToolGroupId) => {
    clearClose();
    dispatch({ type: "leave-group", groupId });
    closeTimer.current = setTimeout(() => dispatch({ type: "close-hover", groupId }), HOVER_CLOSE_MS);
  };
  const open = (groupId: ToolGroupId) => {
    clearClose();
    setShortcutsOpen(false);
    dispatch({ type: "hover-group", groupId });
  };
  const focusFirstItem = (groupId: ToolGroupId) => {
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[role="menu"][aria-label="${groupId === "try-on" ? "模特换装" : TOOL_GROUPS.find((group) => group.id === groupId)?.label}"] [role="menuitem"]:not([disabled])`)?.focus();
    });
  };
  const activateByKeyboard = (event: KeyboardEvent<HTMLButtonElement>, groupId: ToolGroupId) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setShortcutsOpen(false);
      dispatch({ type: "toggle-pin", groupId });
      focusFirstItem(groupId);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      dispatch({ type: "escape" });
      return;
    }
    let next = focusIndex;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (focusIndex + 1) % TOOL_GROUPS.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (focusIndex - 1 + TOOL_GROUPS.length) % TOOL_GROUPS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TOOL_GROUPS.length - 1;
    else return;
    event.preventDefault();
    setFocusIndex(next);
    triggerRefs.current.get(TOOL_GROUPS[next].id)?.focus();
  };

  useEffect(() => () => clearClose(), []);
  useEffect(() => {
    if (!state.focusReturnGroupId) return;
    triggerRefs.current.get(state.focusReturnGroupId)?.focus();
    dispatch({ type: "consume-focus-return" });
  }, [dispatch, state.focusReturnGroupId]);

  const selectIntent = (intent: CanvasCreationIntent) => {
    const target = selectActiveDocumentTarget(useFlowStore.getState());
    if (intent.type === "color-palette") {
      openColorTool(target);
      return;
    }
    requestCanvasCreation({
      target,
      intent,
      mode: "click",
    });
  };

  return (
    <nav aria-label="工作台左侧工具" className="flex flex-col gap-1 p-1">
      {TOOL_GROUPS.map((group, index) => {
        const Icon = GROUP_ICONS[group.id];
        const active = state.openToolGroupId === group.id;
        return (
          <Popover
            key={group.id}
            open={active}
            modal={false}
            onOpenChange={(nextOpen) => {
              if (!nextOpen && active) dispatch({ type: "close-group", groupId: group.id });
            }}
          >
            <PopoverTrigger
              render={(
                <Button
                  ref={(node) => {
                    if (node) triggerRefs.current.set(group.id, node);
                    else triggerRefs.current.delete(group.id);
                  }}
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  tabIndex={index === focusIndex ? 0 : -1}
                  aria-label={group.label}
                  aria-expanded={active}
                  aria-haspopup="menu"
                  aria-pressed={state.pinnedToolGroupId === group.id}
                  onFocus={() => setFocusIndex(index)}
                  onPointerEnter={() => open(group.id)}
                  onPointerLeave={() => scheduleClose(group.id)}
                  onClick={(event) => {
                    event.preventDefault();
                    event.preventBaseUIHandler();
                    setShortcutsOpen(false);
                    dispatch({ type: "toggle-pin", groupId: group.id });
                  }}
                  onKeyDown={(event) => activateByKeyboard(event, group.id)}
                  className={cn(
                    "text-[var(--gc-text-muted)] hover:bg-[var(--gc-panel-hover)] hover:text-[var(--gc-text)]",
                    active && "bg-[var(--gc-panel-hover)] text-[var(--gc-accent)]",
                  )}
                >
                  <Icon aria-hidden="true" />
                </Button>
              )}
            />
            <PopoverContent
              side="right"
              sideOffset={8}
              align="start"
              className="max-h-[min(42rem,var(--available-height))]"
            >
              <ToolFlyout
                group={group}
                dispatch={dispatch}
                onIntent={selectIntent}
                onPointerEnter={() => open(group.id)}
                onPointerLeave={() => scheduleClose(group.id)}
              />
            </PopoverContent>
          </Popover>
        );
      })}
      <ShortcutMenu
        open={shortcutsOpen}
        onOpenChange={(nextOpen) => {
          clearClose();
          if (nextOpen && state.openToolGroupId) {
            dispatch({ type: "close-group", groupId: state.openToolGroupId });
          }
          setShortcutsOpen(nextOpen);
        }}
      />
    </nav>
  );
}

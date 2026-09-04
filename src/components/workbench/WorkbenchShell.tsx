import { useEffect, useReducer, type ReactNode } from "react";
import { HistoryIcon, PanelRightCloseIcon, PanelRightOpenIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ToolRail } from "./ToolRail";
import { ColorToolPanel } from "./ColorToolPanel";
import { ConnectionRoleDialog } from "./ConnectionRoleDialog";
import { INITIAL_WORKBENCH_UI_STATE, workbenchUiReducer } from "./workbenchState";

const INSPECTOR_PANEL_ID = "workbench-inspector-panel";
const RESULTS_FLYOUT_PANEL_ID = "workbench-results-flyout";

interface WorkbenchShellProps {
  inspector: ReactNode;
  results: ReactNode;
  children: ReactNode;
}

/**
 * Single-mounted canvas and context trees with a five-group floating tool rail.
 * The retired node library has been replaced by the discoverable tool flyouts.
 */
export function WorkbenchShell({ inspector, results, children }: WorkbenchShellProps) {
  const [state, dispatch] = useReducer(workbenchUiReducer, INITIAL_WORKBENCH_UI_STATE);

  useEffect(() => {
    if (!state.resultsFlyoutOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      dispatch({ type: "close-results-flyout" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state.resultsFlyoutOpen]);

  return (
    <TooltipProvider delay={250}>
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <ConnectionRoleDialog />
        <ColorToolPanel />
        <Card
          size="sm"
          className="gc-panel absolute left-2 top-2 z-40 gap-0 rounded-xl bg-[var(--gc-panel)] p-0 shadow-lg ring-1 ring-[var(--gc-border)]"
        >
          <ToolRail state={state} dispatch={dispatch} />
        </Card>

        <Tooltip>
          <TooltipTrigger
            render={(
              <Button
                type="button"
                variant="ghost"
                size="icon-lg"
                aria-label="结果 / 记录"
                aria-controls={RESULTS_FLYOUT_PANEL_ID}
                aria-expanded={state.resultsFlyoutOpen}
                onClick={() => {
                  dispatch({ type: "escape" });
                  dispatch({ type: "toggle-results-flyout" });
                }}
                className="gc-panel absolute bottom-2 left-2 z-40 bg-[var(--gc-panel)] text-[var(--gc-text-muted)] shadow-lg ring-1 ring-[var(--gc-border)] hover:bg-[var(--gc-panel-hover)] hover:text-[var(--gc-accent)]"
              >
                <HistoryIcon aria-hidden="true" />
              </Button>
            )}
          />
          <TooltipContent side="right">结果 / 记录</TooltipContent>
        </Tooltip>

        <section
          id={RESULTS_FLYOUT_PANEL_ID}
          aria-label="结果 / 记录"
          aria-hidden={!state.resultsFlyoutOpen}
          inert={!state.resultsFlyoutOpen}
          className={cn(
            "gc-panel absolute inset-y-0 left-0 z-[60] flex w-[23rem] flex-col overflow-hidden border-r border-[var(--gc-border)] bg-[var(--gc-panel)] shadow-2xl transition-transform duration-200 motion-reduce:transition-none",
            state.resultsFlyoutOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <div className="flex h-11 shrink-0 items-center border-b border-[var(--gc-border)] px-3">
            <HistoryIcon aria-hidden="true" className="mr-2 size-4 text-[var(--gc-accent)]" />
            <h2 className="text-xs font-semibold text-[var(--gc-text)]">结果 / 记录</h2>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="收起结果与记录"
              onClick={() => dispatch({ type: "close-results-flyout" })}
              className="ml-auto text-[var(--gc-text-muted)] hover:text-[var(--gc-text)]"
            >
              <XIcon aria-hidden="true" />
            </Button>
          </div>
          <div className="min-h-0 flex-1">{results}</div>
        </section>

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
        </div>

        <aside
          id={INSPECTOR_PANEL_ID}
          aria-label="属性"
          aria-hidden={!state.rightDockOpen}
          inert={!state.rightDockOpen}
          className={cn(
            "gc-panel gc-context-dock relative z-30 flex shrink-0 overflow-hidden bg-[var(--gc-panel)] transition-[width,visibility] duration-200 motion-reduce:transition-none",
            state.rightDockOpen
              ? "visible w-80 border-l border-[var(--gc-border)]"
              : "invisible w-0 border-l-0",
          )}
        >
          <div className="gc-context-dock-content h-full min-h-0 w-full shrink-0">{inspector}</div>
        </aside>

        <Tooltip>
          <TooltipTrigger
            render={(
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="属性"
                aria-controls={INSPECTOR_PANEL_ID}
                aria-expanded={state.rightDockOpen}
                onClick={() => dispatch({ type: "toggle-right-dock" })}
                className="gc-panel absolute right-2 top-2 z-40 bg-[var(--gc-panel)] text-[var(--gc-text-muted)] shadow-lg ring-1 ring-[var(--gc-border)] hover:bg-[var(--gc-panel-hover)] hover:text-[var(--gc-text)]"
              >
                {state.rightDockOpen
                  ? <PanelRightCloseIcon aria-hidden="true" />
                  : <PanelRightOpenIcon aria-hidden="true" />}
              </Button>
            )}
          />
          <TooltipContent side="left">{state.rightDockOpen ? "收起属性" : "展开属性"}</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}

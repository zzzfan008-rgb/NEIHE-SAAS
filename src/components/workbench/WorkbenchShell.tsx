import { useReducer, type ReactNode } from "react";
import { LibraryBigIcon, SlidersHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  INITIAL_WORKBENCH_UI_STATE,
  workbenchUiReducer,
} from "./workbenchState";

const LIBRARY_PANEL_ID = "workbench-library-panel";
const INSPECTOR_PANEL_ID = "workbench-inspector-panel";

interface WorkbenchShellProps {
  library: ReactNode;
  inspector: ReactNode;
  children: ReactNode;
}

interface RailButtonProps {
  label: string;
  controls: string;
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
}

function RailButton({ label, controls, active, onClick, icon }: RailButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            aria-label={label}
            aria-controls={controls}
            aria-expanded={active}
            aria-pressed={active}
            onClick={onClick}
            className={cn(
              "text-[var(--gc-text-muted)] shadow-sm hover:bg-[var(--gc-panel-hover)] hover:text-[var(--gc-text)]",
              active && "bg-[var(--gc-panel-hover)] text-[var(--gc-accent)]",
            )}
          />
        )}
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * 桌面工作台始终保持同一棵中心内容树。左侧浮动入口控制唯一占位 Dock，
 * 面板开合不覆盖画布，也不重建 React Flow、节点库或 Results 业务子树。
 */
export function WorkbenchShell({ library, inspector, children }: WorkbenchShellProps) {
  const [state, dispatch] = useReducer(workbenchUiReducer, INITIAL_WORKBENCH_UI_STATE);
  const libraryOpen = state.activePanel === "library";
  const inspectorOpen = state.activePanel === "inspector";
  const panelOpen = state.activePanel !== null;

  return (
    <TooltipProvider delay={250}>
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <nav
          aria-label="工作台左侧工具"
          className={cn(
            "absolute top-3 z-40 flex flex-col items-start gap-2 transition-[left] duration-200 motion-reduce:transition-none",
            panelOpen ? "left-[20.75rem]" : "left-3",
          )}
        >
          <Card
            size="sm"
            className="gc-panel gap-0 rounded-xl bg-[var(--gc-panel)] p-1 py-1 shadow-lg ring-1 ring-[var(--gc-border)]"
          >
            <RailButton
              label="节点库"
              controls={LIBRARY_PANEL_ID}
              active={libraryOpen}
              onClick={() => dispatch({ type: "toggle-panel", panel: "library" })}
              icon={<LibraryBigIcon aria-hidden="true" />}
            />
          </Card>

          <Card
            size="sm"
            className="gc-panel gap-0 rounded-xl bg-[var(--gc-panel)] p-1 py-1 shadow-lg ring-1 ring-[var(--gc-border)]"
          >
            <RailButton
              label="属性 / 结果"
              controls={INSPECTOR_PANEL_ID}
              active={inspectorOpen}
              onClick={() => dispatch({ type: "toggle-panel", panel: "inspector" })}
              icon={<SlidersHorizontalIcon aria-hidden="true" />}
            />
          </Card>
        </nav>

        <aside
          aria-label="工作台左侧面板"
          aria-hidden={!panelOpen}
          inert={!panelOpen}
          className={cn(
            "gc-panel relative z-30 flex w-0 shrink-0 overflow-hidden bg-[var(--gc-panel)] transition-[width,visibility] duration-200 motion-reduce:transition-none",
            panelOpen
              ? "visible w-80 border-r border-[var(--gc-border)]"
              : "invisible w-0 border-r-0",
          )}
        >
          <div className="relative h-full min-h-0 w-80 shrink-0">
            <section
              id={LIBRARY_PANEL_ID}
              aria-label="节点库"
              aria-hidden={!libraryOpen}
              inert={!libraryOpen}
              className={cn(
                "absolute inset-0 flex min-h-0 transition-[opacity,visibility] duration-150 motion-reduce:transition-none",
                libraryOpen ? "visible opacity-100" : "invisible opacity-0",
              )}
            >
              {library}
            </section>
            <section
              id={INSPECTOR_PANEL_ID}
              aria-label="属性 / 结果"
              aria-hidden={!inspectorOpen}
              inert={!inspectorOpen}
              className={cn(
                "absolute inset-0 flex min-h-0 transition-[opacity,visibility] duration-150 motion-reduce:transition-none",
                inspectorOpen ? "visible opacity-100" : "invisible opacity-0",
              )}
            >
              {inspector}
            </section>
          </div>
        </aside>

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
            {children}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

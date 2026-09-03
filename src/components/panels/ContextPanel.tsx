import { useEffect, useRef, useState } from "react";
import { HistoryIcon, SlidersHorizontalIcon } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  selectActivePrimarySelectedNodeId,
  selectActiveSelectedResultId,
  useFlowStore,
} from "@/store/flowStore";
import { cn } from "@/lib/utils";
import { InspectorPanel } from "./InspectorPanel";
import { ResultsPanel } from "./ResultsPanel";

type ContextTab = "properties" | "results";

interface ContextPanelProps {
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  className?: string;
}

/**
 * 左侧上下文 Dock：属性和跨项目结果共用一个面板，但两个 Panel
 * 始终 keepMounted，切换 Tab 不会丢失滚动位置、加载状态或详情上下文。
 */
export function ContextPanel({
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  className,
}: ContextPanelProps) {
  const selectedNodeId = useFlowStore(selectActivePrimarySelectedNodeId);
  const selectedResultId = useFlowStore(selectActiveSelectedResultId);
  const [activeTab, setActiveTab] = useState<ContextTab>(
    selectedResultId ? "results" : "properties",
  );
  const previousSelection = useRef({ selectedNodeId, selectedResultId });

  useEffect(() => {
    const previous = previousSelection.current;
    if (selectedResultId && selectedResultId !== previous.selectedResultId) {
      setActiveTab("results");
    } else if (selectedNodeId && selectedNodeId !== previous.selectedNodeId) {
      setActiveTab("properties");
    }
    previousSelection.current = { selectedNodeId, selectedResultId };
  }, [selectedNodeId, selectedResultId]);

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setActiveTab(value === "results" ? "results" : "properties")}
      className={cn("gc-panel flex h-full min-h-0 w-full flex-col gap-0 bg-[var(--gc-panel)]", className)}
    >
      <TabsList
        aria-label="属性与结果"
        className="relative grid h-10 shrink-0 grid-cols-2 border-b border-[var(--gc-border)] bg-[var(--gc-panel)] p-1"
      >
        <TabsTrigger
          value="properties"
          className="flex items-center justify-center gap-1.5 rounded-sm text-[10px] font-medium text-[var(--gc-text-muted)] transition-colors hover:text-[var(--gc-text)] data-active:bg-[var(--gc-panel-hover)] data-active:text-[var(--gc-accent)]"
        >
          <SlidersHorizontalIcon aria-hidden="true" className="size-3.5" />
          属性
        </TabsTrigger>
        <TabsTrigger
          value="results"
          className="flex items-center justify-center gap-1.5 rounded-sm text-[10px] font-medium text-[var(--gc-text-muted)] transition-colors hover:text-[var(--gc-text)] data-active:bg-[var(--gc-panel-hover)] data-active:text-[var(--gc-accent)]"
        >
          <HistoryIcon aria-hidden="true" className="size-3.5" />
          结果 / 记录
        </TabsTrigger>
      </TabsList>

      <TabsContent value="properties" keepMounted className="min-h-0 flex-1">
        <InspectorPanel view="properties" className="h-full w-full border-0" />
      </TabsContent>
      <TabsContent value="results" keepMounted className="min-h-0 flex-1">
        <div className="flex h-full min-h-0 flex-col">
          <ResultsPanel
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={onLoadMore}
            className="min-h-40 max-h-[46%] shrink-0 border-b border-[var(--gc-border)]"
          />
          <InspectorPanel view="result" className="min-h-0 w-full flex-1 border-0" />
        </div>
      </TabsContent>
    </Tabs>
  );
}

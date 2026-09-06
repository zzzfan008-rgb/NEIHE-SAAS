import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { nanoid } from "nanoid";
import {
  addExistingNodes,
  flushActiveTextEdit,
  flushTabSessionPersistence,
  reconcileRunHistory,
  recentResultsPatch,
  resumeRecentResults,
  selectActiveNodes,
  selectActiveSelectedNodeIds,
  selectHasDirtyTabs,
  trimRecentResults,
  useFlowStore,
  type FlowNode,
  type RecentResult,
} from "@/store/flowStore";
import { CanvasFlow } from "@/components/CanvasFlow";
import { TopBar } from "@/components/panels/TopBar";
import { ProjectTabs } from "@/components/panels/ProjectTabs";
import { InspectorPanel } from "@/components/panels/InspectorPanel";
import { ResultsPanel } from "@/components/panels/ResultsPanel";
import { WorkbenchShell } from "@/components/workbench/WorkbenchShell";
import { TaskLauncher } from "@/components/TaskLauncher";
import { TutorialOverlay } from "@/components/tutorial/TutorialOverlay";
import { setGenerationSafetyBlockReason } from "@/store/generationSafety";
import {
  isWorkspaceUnloadWarningSuppressed,
  shouldWarnBeforeWorkspaceUnload,
} from "@/lib/workspaceUnload";
import { isWorkbenchTutorialBlocking } from "@/tutorials/tutorialRuntime";
import {
  InitialDraftSyncNotice,
  InitialDraftWorkspace,
} from "@/initialDraft/InitialDraftWorkspace";
import { isInitialDraftInteractionBlocking } from "@/initialDraft/initialDraftRuntime";
import {
  OPEN_ASSET_PICKER_EVENT,
  OPEN_COMPARE_EVENT,
  OPEN_GENERATION_RECORD_EVENT,
  type AssetPickerRequest,
  type GenerationRecordRequest,
} from "@/lib/overlayEvents";
import { requestCanvasZoom } from "@/lib/keyboardShortcuts";
import { OPEN_BUILTIN_TEMPLATE_EVENT } from "@/lib/canvasCreation";
import { launchTemplateInNewTab } from "@/lib/templateLaunch";
import type { WorkflowTemplate } from "@/types/workflow";

const LazyCompareOverlay = lazy(() => import("@/components/CompareOverlay").then((module) => ({
  default: module.CompareOverlay,
})));
const LazyImageViewer = lazy(() => import("@/components/ImageViewer").then((module) => ({
  default: module.ImageViewer,
})));
const LazyAssetPickerOverlay = lazy(() => import("@/components/AssetPickerOverlay").then((module) => ({
  default: module.AssetPickerOverlay,
})));
const LazyGenerationRecordDialog = lazy(() => import("@/components/GenerationRecordDialog").then((module) => ({
  default: module.GenerationRecordDialog,
})));

interface NodeClipboardEntry {
  data: FlowNode["data"];
  type: string;
  offset: { x: number; y: number };
}

/** 剪贴板里的节点快照（仅内存，跨项目/刷新不保留，不复制连线）。 */
let nodeClipboard: NodeClipboardEntry[] | null = null;

function copySelectedNodesToClipboard(): boolean {
  const state = useFlowStore.getState();
  const nodes = selectActiveNodes(state);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const selectedNodes = selectActiveSelectedNodeIds(state)
    .map((id) => nodesById.get(id))
    .filter((node): node is FlowNode => Boolean(node));
  if (selectedNodes.length === 0) return false;
  const origin = {
    x: Math.min(...selectedNodes.map((node) => node.position.x)),
    y: Math.min(...selectedNodes.map((node) => node.position.y)),
  };
  nodeClipboard = selectedNodes.map((node) => ({
    data: JSON.parse(JSON.stringify(node.data)) as FlowNode["data"],
    type: node.type ?? node.data.kind,
    offset: {
      x: node.position.x - origin.x,
      y: node.position.y - origin.y,
    },
  }));
  return true;
}

function pasteClipboardNodes(): string[] {
  if (!nodeClipboard?.length) return [];
  const state = useFlowStore.getState();
  const nodes = selectActiveNodes(state);
  const selectedIds = new Set(selectActiveSelectedNodeIds(state));
  const selectedNodes = nodes.filter((node) => selectedIds.has(node.id));
  const anchorNodes = selectedNodes.length > 0
    ? selectedNodes
    : nodes.length > 0
      ? [nodes[nodes.length - 1]]
      : [];
  const origin = anchorNodes.length > 0
    ? {
        x: Math.min(...anchorNodes.map((node) => node.position.x)) + 40,
        y: Math.min(...anchorNodes.map((node) => node.position.y)) + 40,
      }
    : { x: 0, y: 0 };
  const additions = nodeClipboard.map((entry) => {
    const data = JSON.parse(JSON.stringify(entry.data)) as FlowNode["data"];
    data.status = "idle";
    data.error = undefined;
    return {
      id: nanoid(8),
      type: entry.type,
      position: {
        x: origin.x + entry.offset.x,
        y: origin.y + entry.offset.y,
      },
      data,
    } satisfies FlowNode;
  });
  return addExistingNodes(additions);
}

interface HistoryPage {
  records: RecentResult[];
  nextCursor: string | null;
  hasMore: boolean;
}

function parseHistoryPage(value: unknown): HistoryPage {
  if (!value || typeof value !== "object") throw new Error("历史记录格式无效");
  const page = value as Partial<HistoryPage>;
  if (!Array.isArray(page.records) ||
      (page.nextCursor !== null && typeof page.nextCursor !== "string") ||
      typeof page.hasMore !== "boolean") {
    throw new Error("历史记录格式无效");
  }
  return { records: page.records, nextCursor: page.nextCursor ?? null, hasMore: page.hasMore };
}

function useGlobalShortcuts() {
  const undo = useFlowStore((s) => s.undo);
  const redo = useFlowStore((s) => s.redo);
  const saveProject = useFlowStore((s) => s.saveProject);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (isWorkbenchTutorialBlocking()) return;
      if (isInitialDraftInteractionBlocking()) return;
      // 蒙版编辑器使用独立撤销栈；打开或上传期间不能让全局快捷键修改底层画布。
      if (useFlowStore.getState().pendingMaskWorkCount > 0) return;
      const key = e.key.toLowerCase();
      // 可编辑文本内的组合键留给原生编辑；range 仍应响应画布缩放快捷键。
      const target = e.target as HTMLElement | null;
      const inTextField =
        target && (
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          (target.tagName === "INPUT" && (target as HTMLInputElement).type !== "range")
        );
      if (key === "s") {
        e.preventDefault();
        void saveProject();
        return;
      }
      if (inTextField) return;

      if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        redo();
      } else if (key === "z") {
        e.preventDefault();
        undo();
      } else if (key === "+" || key === "=" || key === "add") {
        e.preventDefault();
        requestCanvasZoom("in");
      } else if (key === "-" || key === "_" || key === "subtract") {
        e.preventDefault();
        requestCanvasZoom("out");
      } else if (key === "c") {
        copySelectedNodesToClipboard();
      } else if (key === "v") {
        if (!nodeClipboard?.length) return;
        e.preventDefault();
        pasteClipboardNodes();
      } else if (key === "d") {
        e.preventDefault();
        if (copySelectedNodesToClipboard()) pasteClipboardNodes();
      } else if (key === "a") {
        e.preventDefault();
        const state = useFlowStore.getState();
        state.setSelectedNodeIds(selectActiveNodes(state).map((node) => node.id));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo, saveProject]);
}

export default function App({ userId }: { userId: string }) {
  return (
    <InitialDraftWorkspace userId={userId}>
      <Workspace />
    </InitialDraftWorkspace>
  );
}

function Workspace() {
  useGlobalShortcuts();
  const activeTabId = useFlowStore((state) => state.activeTabId);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [initialHistoryState, setInitialHistoryState] = useState<"loading" | "ready" | "error">("loading");
  const [initialHistoryAttempt, setInitialHistoryAttempt] = useState(0);
  const historyPageSize = 20;
  const historyBefore = useRef(Date.now()).current;
  const viewerOpen = useFlowStore((state) => state.viewer !== null);
  const closeViewer = useFlowStore((state) => state.closeViewer);
  const clearCompare = useFlowStore((state) => state.clearCompare);
  const [compareOpen, setCompareOpen] = useState(false);
  const [assetPickerRequest, setAssetPickerRequest] = useState<AssetPickerRequest | null>(null);
  const [generationRecordResultId, setGenerationRecordResultId] = useState<string | null>(null);
  const [toolLaunchError, setToolLaunchError] = useState<string | null>(null);

  useEffect(() => {
    const openCompare = () => setCompareOpen(true);
    const openAssetPicker = (event: Event) => {
      const request = (event as CustomEvent<AssetPickerRequest>).detail;
      if (request?.target && request.nodeId) setAssetPickerRequest(request);
    };
    const openGenerationRecord = (event: Event) => {
      const request = (event as CustomEvent<GenerationRecordRequest>).detail;
      if (request?.resultId) setGenerationRecordResultId(request.resultId);
    };
    window.addEventListener(OPEN_COMPARE_EVENT, openCompare);
    window.addEventListener(OPEN_ASSET_PICKER_EVENT, openAssetPicker);
    window.addEventListener(OPEN_GENERATION_RECORD_EVENT, openGenerationRecord);
    return () => {
      window.removeEventListener(OPEN_COMPARE_EVENT, openCompare);
      window.removeEventListener(OPEN_ASSET_PICKER_EVENT, openAssetPicker);
      window.removeEventListener(OPEN_GENERATION_RECORD_EVENT, openGenerationRecord);
    };
  }, []);

  useEffect(() => {
    const openBuiltinTemplate = (event: Event) => {
      const templateId = (event as CustomEvent<{ templateId?: string }>).detail?.templateId;
      if (!templateId) return;
      setToolLaunchError(null);
      void fetch("/api/templates")
        .then(async (response) => {
          if (!response.ok) throw new Error(`模板加载失败 HTTP ${response.status}`);
          return await response.json() as WorkflowTemplate[];
        })
        .then((templates) => {
          const template = templates.find((candidate) => candidate.id === templateId);
          if (!template) throw new Error("未找到对应的内置工作流模板");
          launchTemplateInNewTab(template, "upload");
        })
        .catch((error) => setToolLaunchError(error instanceof Error ? error.message : "工作流模板打开失败"));
    };
    window.addEventListener(OPEN_BUILTIN_TEMPLATE_EVENT, openBuiltinTemplate);
    return () => window.removeEventListener(OPEN_BUILTIN_TEMPLATE_EVENT, openBuiltinTemplate);
  }, []);

  useEffect(() => {
    if (!assetPickerRequest && !viewerOpen && !compareOpen) return;
    const closeActiveOverlay = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (assetPickerRequest) {
        setAssetPickerRequest(null);
      } else if (viewerOpen) {
        closeViewer();
      } else if (compareOpen) {
        setCompareOpen(false);
        clearCompare();
      }
    };
    window.addEventListener("keydown", closeActiveOverlay);
    return () => window.removeEventListener("keydown", closeActiveOverlay);
  }, [assetPickerRequest, clearCompare, closeViewer, compareOpen, viewerOpen]);

  useEffect(() => {
    setGenerationSafetyBlockReason(
      initialHistoryState === "ready"
        ? null
        : initialHistoryState === "loading"
          ? "正在确认运行历史，完成前暂停新的生成任务"
          : "运行历史同步失败，为避免重复计费，新的生成任务已暂停",
    );
  }, [initialHistoryState]);

  useEffect(() => () => {
    setGenerationSafetyBlockReason("正在确认运行历史，完成前暂停新的生成任务");
  }, []);

  useEffect(() => {
    const flushDrafts = () => {
      flushActiveTextEdit();
      flushTabSessionPersistence();
    };
    const flushHiddenDrafts = () => {
      if (document.visibilityState === "hidden") flushDrafts();
    };
    window.addEventListener("pagehide", flushDrafts);
    document.addEventListener("visibilitychange", flushHiddenDrafts);
    return () => {
      window.removeEventListener("pagehide", flushDrafts);
      document.removeEventListener("visibilitychange", flushHiddenDrafts);
    };
  }, []);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      flushActiveTextEdit();
      flushTabSessionPersistence();
      if (isWorkspaceUnloadWarningSuppressed()) return;
      const latest = useFlowStore.getState();
      if (!shouldWarnBeforeWorkspaceUnload({
        hasDirtyTabs: selectHasDirtyTabs(latest),
        tabSessionPersistenceError: latest.tabSessionPersistenceError,
        pendingMaskWorkCount: latest.pendingMaskWorkCount,
      })) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, []);

  useEffect(() => {
    let active = true;
    setInitialHistoryState("loading");
    Promise.all([
      fetch(`/api/history?limit=${historyPageSize}&offset=0&before=${historyBefore}`),
      fetch("/api/history/active"),
    ])
      .then(async ([historyResponse, activeResponse]) => {
        if (!historyResponse.ok) throw new Error(`历史记录 HTTP ${historyResponse.status}`);
        if (!activeResponse.ok) throw new Error(`活动任务 HTTP ${activeResponse.status}`);
        return [await historyResponse.json(), await activeResponse.json()] as const;
      })
      .then(([historyValue, activeValue]) => {
        if (active) {
          const page = parseHistoryPage(historyValue);
          const activePage = parseHistoryPage(activeValue);
          // 完整活动集必须放在前且不得预先裁剪；终态输出仅影响最近结果展示。
          reconcileRunHistory([...activePage.records, ...page.records]);
          resumeRecentResults(activePage.records);
          setHistoryCursor(page.nextCursor);
          setHistoryHasMore(page.hasMore);
          setInitialHistoryState("ready");
        }
      })
      .catch(() => {
        if (active) setInitialHistoryState("error");
      });
    return () => { active = false; };
  }, [historyBefore, initialHistoryAttempt]);

  const loadMoreHistory = useCallback(async () => {
    if (historyLoading || !historyHasMore || !historyCursor) return;
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(historyPageSize), cursor: historyCursor });
      const response = await fetch(`/api/history?${params.toString()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const page = parseHistoryPage(await response.json());
      useFlowStore.setState((state) => {
        const existingIds = new Set(state.recentResults.map((record) => record.id));
        return recentResultsPatch(state, trimRecentResults([
          ...state.recentResults,
          ...page.records.filter((record) => !existingIds.has(record.id)),
        ]) as never);
      });
      resumeRecentResults(page.records);
      setHistoryCursor(page.nextCursor);
      setHistoryHasMore(page.hasMore);
    } catch {
      // 保留“加载更多”入口，瞬时网络错误后用户可以再次重试。
    } finally {
      setHistoryLoading(false);
    }
  }, [historyCursor, historyHasMore, historyLoading]);

  return (
    <div className="gc-app-shell relative flex h-full min-w-0 flex-col overflow-hidden bg-ink text-neutral-200">
      <TopBar />
      <ProjectTabs />
      <InitialDraftSyncNotice />
      {toolLaunchError && (
        <div role="alert" className="border-b border-[var(--gc-border)] bg-[var(--gc-panel)] px-3 py-1.5 text-center text-[10px] text-amber-500">
          {toolLaunchError}
        </div>
      )}
      {initialHistoryState !== "ready" && (
        <div
          role={initialHistoryState === "error" ? "alert" : "status"}
          className="gc-panel flex min-h-9 shrink-0 items-center justify-center gap-3 border-b border-[var(--gc-border)] bg-[var(--gc-panel)] px-3 py-1.5 text-center"
        >
          <p className={`text-[10px] ${initialHistoryState === "error" ? "text-amber-300" : "text-[var(--gc-text-muted)]"}`}>
            {initialHistoryState === "loading"
              ? "正在确认运行历史；画布仍可查看和编辑，新的生成任务暂不可用。"
              : "运行历史同步失败；画布仍可编辑和保存，为避免重复计费，新的生成任务已暂停。"}
          </p>
          {initialHistoryState === "error" && (
            <button
              type="button"
              onClick={() => setInitialHistoryAttempt((value) => value + 1)}
              className="shrink-0 rounded-sm border border-gold/60 px-2 py-1 text-[10px] text-gold hover:bg-gold/10"
            >
              重试同步
            </button>
          )}
        </div>
      )}
      <WorkbenchShell
        inspector={(
          <InspectorPanel view="properties" className="h-full w-full border-0" />
        )}
        results={(
          <ResultsPanel
            hasMore={historyHasMore}
            loadingMore={historyLoading}
            onLoadMore={() => void loadMoreHistory()}
            className="h-full"
          />
        )}
      >
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <ReactFlowProvider key={activeTabId}>
            <TaskLauncher />
            <CanvasFlow />
          </ReactFlowProvider>
        </div>
      </WorkbenchShell>
      {compareOpen && (
        <Suspense fallback={<OverlayLoadingStatus label="正在打开结果对比…" />}>
          <LazyCompareOverlay open onOpenChange={setCompareOpen} />
        </Suspense>
      )}
      {viewerOpen && (
        <Suspense fallback={<OverlayLoadingStatus label="正在打开图片…" />}>
          <LazyImageViewer />
        </Suspense>
      )}
      {assetPickerRequest && (
        <Suspense fallback={<OverlayLoadingStatus label="正在打开素材库…" />}>
          <LazyAssetPickerOverlay
            request={assetPickerRequest}
            onRequestChange={setAssetPickerRequest}
          />
        </Suspense>
      )}
      {generationRecordResultId && (
        <Suspense fallback={<OverlayLoadingStatus label="正在打开生成记录…" />}>
          <LazyGenerationRecordDialog
            resultId={generationRecordResultId}
            onOpenChange={(open) => { if (!open) setGenerationRecordResultId(null); }}
          />
        </Suspense>
      )}
      <TutorialOverlay />
    </div>
  );
}

function OverlayLoadingStatus({ label }: { label: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 text-xs text-neutral-400 backdrop-blur-xs">
      <span role="status">{label}</span>
    </div>
  );
}

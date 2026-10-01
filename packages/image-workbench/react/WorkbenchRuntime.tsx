import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  flushActiveTextEdit, flushTabSessionPersistence, reconcileRunHistory, recentResultsPatch,
  resumeRecentResults, selectHasDirtyTabs, trimRecentResults, useFlowStore, type RecentResult,
} from "../src/store/flowStore";
import { setGenerationSafetyBlockReason } from "../src/store/generationSafety";
import { isWorkspaceUnloadWarningSuppressed, shouldWarnBeforeWorkspaceUnload } from "../src/lib/workspaceUnload";
import { InitialDraftWorkspace, InitialDraftSyncNotice } from "../src/initialDraft/InitialDraftWorkspace";
import {
  OPEN_ASSET_PICKER_EVENT, OPEN_COMPARE_EVENT, OPEN_GENERATION_RECORD_EVENT,
  type AssetPickerRequest, type GenerationRecordRequest,
} from "../src/lib/overlayEvents";
import { ResultsPanel } from "../src/components/panels/ResultsPanel";
import { Button } from "../src/components/ui/button";
import { ConnectionRoleDialog } from "../src/components/workbench/ConnectionRoleDialog";
import { TooltipProvider } from "../src/components/ui/tooltip";

const CompareOverlay = lazy(() => import("../src/components/CompareOverlay").then((m) => ({ default: m.CompareOverlay })));
const ImageViewer = lazy(() => import("../src/components/ImageViewer").then((m) => ({ default: m.ImageViewer })));
const AssetPickerOverlay = lazy(() => import("../src/components/AssetPickerOverlay").then((m) => ({ default: m.AssetPickerOverlay })));
const GenerationRecordDialog = lazy(() => import("../src/components/GenerationRecordDialog").then((m) => ({ default: m.GenerationRecordDialog })));

type HistoryState = "loading" | "ready" | "error";
interface HistoryPage { records: RecentResult[]; nextCursor: string | null; hasMore: boolean }
interface RuntimeState {
  historyState: HistoryState;
  hasMore: boolean;
  loadingMore: boolean;
  retryHistory: () => void;
  loadMoreHistory: () => Promise<void>;
}
const RuntimeContext = createContext<RuntimeState | null>(null);

function parseHistoryPage(value: unknown): HistoryPage {
  if (!value || typeof value !== "object") throw new Error("历史记录格式无效");
  const page = value as Partial<HistoryPage>;
  if (!Array.isArray(page.records) ||
    (page.nextCursor !== null && typeof page.nextCursor !== "string") ||
    typeof page.hasMore !== "boolean") throw new Error("历史记录格式无效");
  return { records: page.records, nextCursor: page.nextCursor ?? null, hasMore: page.hasMore };
}

/** Mount once per authenticated workspace, outside tab-local ReactFlowProviders. */
export function WorkbenchRuntime({ userId, children }: { userId: string; children: ReactNode }) {
  return <InitialDraftWorkspace key={userId} userId={userId}><TooltipProvider delay={250}>
    <RuntimeEffects>{children}</RuntimeEffects>
  </TooltipProvider></InitialDraftWorkspace>;
}

export function useWorkbenchRuntime(): RuntimeState {
  const state = useContext(RuntimeContext);
  if (!state) throw new Error("WorkbenchRuntime is required");
  return state;
}

function RuntimeEffects({ children }: { children: ReactNode }) {
  const viewerOpen = useFlowStore((state) => state.viewer !== null);
  const closeViewer = useFlowStore((state) => state.closeViewer);
  const clearCompare = useFlowStore((state) => state.clearCompare);
  const [compareOpen, setCompareOpen] = useState(false);
  const [assetRequest, setAssetRequest] = useState<AssetPickerRequest | null>(null);
  const [recordId, setRecordId] = useState<string | null>(null);
  const [historyState, setHistoryState] = useState<HistoryState>("loading");
  const [attempt, setAttempt] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const historyBefore = useRef(Date.now()).current;
  const mounted = useRef(false);
  const loadingPage = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const compare = () => setCompareOpen(true);
    const asset = (event: Event) => {
      const request = (event as CustomEvent<AssetPickerRequest>).detail;
      if (request?.mode === "browse" || request?.mode === "conversation" || (request?.target && request.nodeId)) setAssetRequest(request);
    };
    const record = (event: Event) => {
      const request = (event as CustomEvent<GenerationRecordRequest>).detail;
      if (request?.resultId) setRecordId(request.resultId);
    };
    window.addEventListener(OPEN_COMPARE_EVENT, compare);
    window.addEventListener(OPEN_ASSET_PICKER_EVENT, asset);
    window.addEventListener(OPEN_GENERATION_RECORD_EVENT, record);
    return () => {
      window.removeEventListener(OPEN_COMPARE_EVENT, compare);
      window.removeEventListener(OPEN_ASSET_PICKER_EVENT, asset);
      window.removeEventListener(OPEN_GENERATION_RECORD_EVENT, record);
    };
  }, []);

  useEffect(() => {
    if (!assetRequest && !viewerOpen && !compareOpen) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (viewerOpen) closeViewer();
      else if (assetRequest) setAssetRequest(null);
      else { setCompareOpen(false); clearCompare(); }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [assetRequest, viewerOpen, compareOpen, closeViewer, clearCompare]);

  useEffect(() => {
    setGenerationSafetyBlockReason(historyState === "ready" ? null : historyState === "loading"
      ? "正在确认运行历史，完成前暂停新的生成任务"
      : "运行历史同步失败，为避免重复计费，新的生成任务已暂停");
  }, [historyState]);
  useEffect(() => () => setGenerationSafetyBlockReason("正在确认运行历史，完成前暂停新的生成任务"), []);

  useEffect(() => {
    const flush = () => { flushActiveTextEdit(); flushTabSessionPersistence(); };
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    const unload = (event: BeforeUnloadEvent) => {
      flush();
      if (isWorkspaceUnloadWarningSuppressed()) return;
      const state = useFlowStore.getState();
      if (!shouldWarnBeforeWorkspaceUnload({
        hasDirtyTabs: selectHasDirtyTabs(state),
        tabSessionPersistenceError: state.tabSessionPersistenceError,
        pendingMaskWorkCount: state.pendingMaskWorkCount,
      })) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", unload);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setHistoryState("loading");
    void Promise.all([
      fetch(`/api/history?limit=20&offset=0&before=${historyBefore}`, { signal: controller.signal }),
      fetch("/api/history/active", { signal: controller.signal }),
    ]).then(async ([history, running]) => {
      if (!history.ok || !running.ok) throw new Error("运行历史同步失败");
      return [parseHistoryPage(await history.json()), parseHistoryPage(await running.json())];
    }).then(([history, running]) => {
      if (!active) return;
      // Reconcile the complete active set before trimming terminal display results.
      reconcileRunHistory([...running.records, ...history.records]);
      resumeRecentResults(running.records);
      setCursor(history.nextCursor);
      setHasMore(history.hasMore);
      setHistoryState("ready");
    }).catch(() => { if (active) setHistoryState("error"); });
    return () => { active = false; controller.abort(); };
  }, [historyBefore, attempt]);

  const loadMoreHistory = useCallback(async () => {
    if (loadingPage.current || !hasMore || !cursor || historyState !== "ready") return;
    loadingPage.current = true;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: "20", cursor });
      const response = await fetch(`/api/history?${params}`);
      if (!response.ok) throw new Error(`历史记录 HTTP ${response.status}`);
      const page = parseHistoryPage(await response.json());
      if (!mounted.current) return;
      useFlowStore.setState((state) => {
        const ids = new Set(state.recentResults.map((record) => record.id));
        return recentResultsPatch(state, trimRecentResults([
          ...state.recentResults, ...page.records.filter((record) => !ids.has(record.id)),
        ]) as never);
      });
      resumeRecentResults(page.records);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch {
      // Leave the cursor and retry affordance intact after transient failures.
    } finally {
      loadingPage.current = false;
      if (mounted.current) setLoadingMore(false);
    }
  }, [cursor, hasMore, historyState]);

  const fallback = <span role="status">正在打开…</span>;
  return <RuntimeContext.Provider value={{ historyState, hasMore, loadingMore, loadMoreHistory, retryHistory: () => setAttempt((value) => value + 1) }}>
    {children}
    <ConnectionRoleDialog />
    {compareOpen && <Suspense fallback={fallback}><CompareOverlay open onOpenChange={setCompareOpen} /></Suspense>}
    {viewerOpen && <Suspense fallback={fallback}><ImageViewer /></Suspense>}
    {assetRequest && <Suspense fallback={fallback}><AssetPickerOverlay request={assetRequest} onRequestChange={setAssetRequest} /></Suspense>}
    {recordId && <Suspense fallback={fallback}><GenerationRecordDialog resultId={recordId} onOpenChange={(open) => { if (!open) setRecordId(null); }} /></Suspense>}
  </RuntimeContext.Provider>;
}

/** Place above the host's existing canvas. It does not own panel layout. */
export function WorkbenchRecoveryNotice() {
  const { historyState, retryHistory } = useWorkbenchRuntime();
  return <><InitialDraftSyncNotice />{historyState !== "ready" && <div role={historyState === "error" ? "alert" : "status"}
    className="gc-panel flex min-h-9 items-center justify-center gap-3 border-b border-[var(--gc-border)] bg-[var(--gc-panel)] px-3 py-1.5 text-center">
    <p className="text-[10px] text-[var(--gc-text-muted)]">{historyState === "loading"
      ? "正在确认运行历史；画布仍可查看和编辑，新的生成任务暂不可用。"
      : "运行历史同步失败；画布仍可编辑和保存，为避免重复计费，新的生成任务已暂停。"}</p>
    {historyState === "error" && <Button size="sm" variant="outline" onClick={retryHistory}>重试同步</Button>}
  </div>}</>;
}

export function WorkbenchResults({ className }: { className?: string }) {
  const { hasMore, loadingMore, loadMoreHistory } = useWorkbenchRuntime();
  return <ResultsPanel className={className} hasMore={hasMore} loadingMore={loadingMore} onLoadMore={() => void loadMoreHistory()} />;
}

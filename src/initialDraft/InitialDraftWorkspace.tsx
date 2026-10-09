import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangleIcon, CloudIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { readWorkspaceOwner } from "@/auth/session";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  clearProjectTabSessionStorage, PROJECT_TAB_STORAGE_KEY_PREFIX, PROJECT_TABS_STORAGE_KEY,
  suspendProjectTabSessionPersistence,
} from "@/lib/tabSessionStorage";
import {
  applyServerInitialDraftToTab,
  createFreshLocalTabForInitialDraft,
  didRestoreProjectTabSessionWorkspace,
  isPristineProjectTab,
  markInitialDraftSynced,
  persistedWorkflowForProjectTab,
  projectTabLifecycle,
  replaceAbandonedInitialDraftWithFreshLocalTab,
  selectActiveDocument,
  useFlowStore,
  type ProjectTab,
  type ServerInitialDraftSnapshot,
} from "@/store/flowStore";
import {
  abandonInitialDraft,
  bootstrapInitialDraft,
  copyProjectScopedMasks,
  fetchSavedProject,
  fetchSavedProjects,
  fetchInitialDraft,
  InitialDraftApiError,
  isServerInitialDraftPristine,
  syncInitialDraft,
} from "./initialDraftClient";
import {
  bootstrapNeedsFreshProjectIdentity,
  decideInitialDraftStartup,
  selectLocalInitialDraftCandidate,
  shouldRestoreSavedProjectOnStartup,
} from "./initialDraftMigration";
import {
  registerInitialDraftSaveBarrier,
  setInitialDraftInteractionBlocking,
} from "./initialDraftRuntime";

type SyncState = "idle" | "syncing" | "error";
type GateState = "loading" | "ready" | "error";

interface DraftConflict {
  localTabId: string;
  server: ServerInitialDraftSnapshot;
}

interface InitialDraftContextValue {
  syncState: SyncState;
  syncError: string | null;
  retrySync: () => void;
  abandon: (tabId: string) => Promise<boolean>;
  abandoningTabId: string | null;
}

const InitialDraftContext = createContext<InitialDraftContextValue | null>(null);

export function useInitialDraftWorkspace(): InitialDraftContextValue {
  const value = useContext(InitialDraftContext);
  if (!value) throw new Error("useInitialDraftWorkspace must be used inside InitialDraftWorkspace");
  return value;
}

function localDraftDirty(tab: ProjectTab): boolean {
  return projectTabLifecycle(tab) === "initial_draft"
    ? tab.dirty || !isPristineProjectTab(tab)
    : !isPristineProjectTab(tab);
}

interface LocalDraftBackup {
  savedAt: string;
  origin: string;
  manifest: string | null;
  tabs: Array<{ key: string; value: string }>;
}

/** 备份原始分片而不是解析结果，放弃后仍可逐字回读本机草稿。 */
function readLocalDraftBackup(storage: Storage): LocalDraftBackup {
  const tabs: Array<{ key: string; value: string }> = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || !key.startsWith(PROJECT_TAB_STORAGE_KEY_PREFIX)) continue;
    const value = storage.getItem(key);
    if (value !== null) tabs.push({ key, value });
  }
  return {
    savedAt: new Date().toISOString(),
    origin: window.location.origin,
    manifest: storage.getItem(PROJECT_TABS_STORAGE_KEY),
    tabs,
  };
}

function hasLocalDraftSnapshot(): boolean {
  try {
    return window.sessionStorage.getItem(PROJECT_TABS_STORAGE_KEY) !== null ||
      readLocalDraftBackup(window.sessionStorage).tabs.length > 0;
  } catch {
    return false;
  }
}

function downloadLocalDraftBackup(backup: LocalDraftBackup): void {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `garment-canvas-local-draft-${backup.savedAt.replace(/[:.]/g, "-")}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function applyDraft(
  tab: ProjectTab,
  draft: ServerInitialDraftSnapshot,
  options?: {
    preserveLocalBackup?: { projectId: string; flow: ReturnType<typeof persistedWorkflowForProjectTab> };
    forceDirty?: boolean;
  },
): boolean {
  const dirty = options?.forceDirty ?? (
    tab.projectId === draft.id && projectTabLifecycle(tab) === "initial_draft"
      ? localDraftDirty(tab)
      : !isServerInitialDraftPristine(draft)
  );
  return applyServerInitialDraftToTab(tab.id, draft, {
    dirty,
    localDocumentRevision: dirty ? Math.max(1, tab.revision, draft.revision) : 0,
    preserveReplacedAsBackup: options?.preserveLocalBackup,
  });
}

export async function settleInitialDraftBeforeAbandon(
  tabId: string,
  read: () => ProjectTab | undefined,
  synchronize: (tab: ProjectTab) => Promise<boolean>,
  hasSyncInFlight: () => boolean,
): Promise<ProjectTab | undefined> {
  for (let attemptIndex = 0; attemptIndex < 8; attemptIndex += 1) {
    const latest = read();
    if (!latest || latest.id !== tabId || projectTabLifecycle(latest) !== "initial_draft") {
      return undefined;
    }
    if (!hasSyncInFlight() && latest.revision <= (latest.draftSyncedRevision ?? 0)) return latest;
    if (!await synchronize(latest)) return undefined;
  }
  throw new Error("项目仍在持续修改，请停止编辑后再放弃");
}

function BlockingScreen({
  state,
  error,
  discardError,
  onRetry,
  onDiscardLocal,
}: {
  state: GateState;
  error: string | null;
  discardError: string | null;
  onRetry: () => void;
  onDiscardLocal?: () => void;
}) {
  return (
    <div className="flex h-full min-w-[1024px] items-center justify-center bg-ink px-8 text-neutral-200">
      <div className="gc-panel w-[34rem] rounded-xl border border-[var(--gc-border)] bg-[var(--gc-panel)] p-8 text-center shadow-2xl shadow-black/50">
        {state === "loading" ? (
          <LoaderCircleIcon aria-hidden="true" className="mx-auto size-8 animate-spin text-gold" />
        ) : (
          <AlertTriangleIcon aria-hidden="true" className="mx-auto size-8 text-amber-300" />
        )}
        <h1 className="mt-4 text-base font-semibold text-[var(--gc-text)]">
          {state === "loading" ? "正在恢复未保存项目" : "未保存项目暂时无法恢复"}
        </h1>
        <p className="mt-2 text-xs leading-6 text-[var(--gc-text-muted)]">
          {state === "loading"
            ? "正在核对本机与云端草稿，完成前画布不会进入可编辑状态。"
            : error ?? "请重试连接；本机草稿仍然保留。"}
        </p>
        {state === "error" && (
          <div className="mt-5 flex flex-col items-center gap-2">
            <Button type="button" onClick={onRetry}>
              <RefreshCwIcon aria-hidden="true" className="size-4" />
              重试恢复
            </Button>
            {onDiscardLocal && (
              <Button type="button" variant="outline" onClick={onDiscardLocal}>
                下载本机草稿备份并放弃本机草稿
              </Button>
            )}
          </div>
        )}
        {state === "error" && discardError && (
          <p role="alert" className="mt-3 text-xs leading-6 text-amber-300">{discardError}</p>
        )}
      </div>
    </div>
  );
}

function ConflictDialog({
  conflict,
  busy,
  onKeepLocal,
  onUseServer,
}: {
  conflict: DraftConflict;
  busy: boolean;
  onKeepLocal: () => void;
  onUseServer: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[80] flex min-w-[1024px] items-center justify-center bg-black/75 px-8 backdrop-blur-sm">
      <div role="alertdialog" aria-modal="true" aria-labelledby="initial-draft-conflict-title" className="gc-panel w-[38rem] rounded-xl border border-amber-400/40 bg-[var(--gc-panel)] p-7 shadow-2xl shadow-black/60">
        <div className="flex items-start gap-4">
          <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-6 shrink-0 text-amber-300" />
          <div>
            <h2 id="initial-draft-conflict-title" className="text-base font-semibold text-[var(--gc-text)]">本机与云端草稿同时有修改</h2>
            <p className="mt-2 text-xs leading-6 text-[var(--gc-text-muted)]">
              系统不会静默覆盖任何一份内容。保留本机会明确更新云端；使用云端时，当前本机内容会另存为“本机备份”页签。
            </p>
            <p className="mt-3 rounded-md bg-[var(--gc-control)] px-3 py-2 text-[11px] text-[var(--gc-text-muted)]">
              云端项目：{conflict.server.name} · revision {conflict.server.revision}
            </p>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <Button type="button" variant="outline" disabled={busy} onClick={onUseServer}>
            使用云端并保留本机备份
          </Button>
          <Button type="button" disabled={busy} onClick={onKeepLocal}>
            {busy && <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" />}
            保留本机并更新云端
          </Button>
        </div>
      </div>
    </div>
  );
}

export function InitialDraftWorkspace({ userId, children }: { userId: string; children: ReactNode }) {
  const [gateState, setGateState] = useState<GateState>("loading");
  const [gateError, setGateError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [conflict, setConflict] = useState<DraftConflict | null>(null);
  const [conflictBusy, setConflictBusy] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>("idle");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [abandoningTabId, setAbandoningTabId] = useState<string | null>(null);
  const [gateErrorStatus, setGateErrorStatus] = useState<number | null>(null);
  const [localDraftPresent, setLocalDraftPresent] = useState(false);
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const syncTimer = useRef<number | null>(null);
  const syncInFlight = useRef<Promise<boolean> | null>(null);
  const initialDraftSignal = useFlowStore((state) => {
    const tab = state.tabs.find((candidate) => projectTabLifecycle(candidate) === "initial_draft");
    return tab ? `${tab.id}\0${tab.projectId}\0${tab.documentEpoch}\0${tab.revision}\0${tab.draftSyncedRevision ?? 0}\0${tab.draftRevision ?? 0}` : "";
  });

  const synchronizeTab = useCallback((snapshot: ProjectTab, expectedRevision?: number): Promise<boolean> => {
    if (syncInFlight.current) return syncInFlight.current;
    setSyncState("syncing");
    setSyncError(null);
    const task = (async () => {
      try {
        const localRevision = snapshot.revision;
        const serverRevision = expectedRevision ?? snapshot.draftRevision ?? 0;
        const draft = await syncInitialDraft({
          id: snapshot.projectId,
          expectedRevision: serverRevision,
          name: snapshot.projectName,
          flow: persistedWorkflowForProjectTab(snapshot),
        });
        markInitialDraftSynced(
          { tabId: snapshot.id, projectId: snapshot.projectId, documentEpoch: snapshot.documentEpoch },
          localRevision,
          serverRevision,
          draft.revision,
        );
        setSyncState("idle");
        return true;
      } catch (error) {
        if (error instanceof InitialDraftApiError && error.status === 409) {
          const server = await fetchInitialDraft().catch(() => null);
          const latest = useFlowStore.getState().tabs.find((tab) => tab.id === snapshot.id);
          if (server && latest) setConflict({ localTabId: latest.id, server });
        }
        setSyncState("error");
        setSyncError(error instanceof Error ? error.message : String(error));
        return false;
      }
    })();
    syncInFlight.current = task;
    void task.finally(() => {
      if (syncInFlight.current === task) syncInFlight.current = null;
    });
    return task;
  }, []);

  const runInitialization = useCallback(async (signal: AbortSignal) => {
    setGateState("loading");
    setGateError(null);
    setGateErrorStatus(null);
    setDiscardError(null);
    setConflict(null);
    try {
      const state = useFlowStore.getState();
      const placeholder = selectActiveDocument(state);
      const restored = didRestoreProjectTabSessionWorkspace();
      const ownerVerified = restored && readWorkspaceOwner(window.sessionStorage) === userId;
      const local = selectLocalInitialDraftCandidate(state.tabs, state.activeTabId, ownerVerified);
      // 已验证的会话页签是最精确的恢复点；其中已有正式项目时不要再请求并创建初始空白页。
      const restoredSavedTab = ownerVerified && state.tabs.some(
        (tab) => projectTabLifecycle(tab) === "saved",
      );
      if (restoredSavedTab) {
        setGateState("ready");
        return;
      }
      const [server, savedProjects] = await Promise.all([
        fetchInitialDraft(signal),
        fetchSavedProjects(signal),
      ]);
      if (signal.aborted) return;
      if (shouldRestoreSavedProjectOnStartup(local, server, savedProjects.length)) {
        const summary = savedProjects[0];
        if (!summary) throw new Error("项目列表为空，请刷新后重试");
        const detail = await fetchSavedProject(summary.id, signal);
        if (signal.aborted) return;
        useFlowStore.getState().openFlowTab({
          projectId: detail.id,
          projectName: detail.name,
          nodes: detail.flow.nodes as never,
          edges: detail.flow.edges as never,
          readOnly: detail.readOnly ?? false,
        });
        setGateState("ready");
        return;
      }
      let decision = decideInitialDraftStartup(placeholder, local, server);

      if (decision.kind === "bootstrap-pristine" || decision.kind === "bootstrap-local") {
        const needsFreshIdentity = bootstrapNeedsFreshProjectIdentity(decision);
        const source = decision.kind === "bootstrap-pristine"
          ? createFreshLocalTabForInitialDraft(decision.local.id)
          : decision.local;
        if (!source) throw new Error("无法创建新的未保存项目，请刷新后重试");
        const prepared = decision.kind === "bootstrap-local" && needsFreshIdentity
          ? await copyProjectScopedMasks({
              sourceProjectId: source.projectId,
              createFreshTarget: true,
              flow: persistedWorkflowForProjectTab(source),
              signal,
            })
          : { targetProjectId: source.projectId, flow: persistedWorkflowForProjectTab(source) };
        const bootstrapped = await bootstrapInitialDraft({
          id: prepared.targetProjectId,
          ...(decision.kind === "bootstrap-local" ? { name: source.projectName } : {}),
          flow: prepared.flow,
          signal,
        });
        if (signal.aborted) return;
        if (!bootstrapped.created && decision.kind === "bootstrap-local") {
          decision = decideInitialDraftStartup(placeholder, source, bootstrapped.draft);
        } else {
          applyDraft(source, bootstrapped.draft, {
            forceDirty: decision.kind === "bootstrap-local" ? localDraftDirty(source) : false,
          });
          setGateState("ready");
          return;
        }
      }

      if (decision.kind === "restore-server") {
        applyDraft(decision.local ?? placeholder, decision.server);
        setGateState("ready");
        return;
      }
      if (decision.kind === "sync-local") {
        const prepared = await copyProjectScopedMasks({
          sourceProjectId: decision.local.projectId,
          targetProjectId: decision.server.id,
          flow: persistedWorkflowForProjectTab(decision.local),
          signal,
        });
        const draft = await syncInitialDraft({
          id: decision.server.id,
          expectedRevision: decision.server.revision,
          name: decision.local.projectName,
          flow: prepared.flow,
          signal,
        });
        if (signal.aborted) return;
        applyDraft(decision.local, draft, { forceDirty: true });
        setGateState("ready");
        return;
      }
      if (decision.kind === "conflict") {
        setConflict({ localTabId: decision.local.id, server: decision.server });
        setGateState("ready");
        return;
      }
      throw new Error("未保存项目恢复状态无效，请重试");
    } catch (error) {
      if (signal.aborted) return;
      setGateState("error");
      setGateError(error instanceof Error ? error.message : String(error));
      setGateErrorStatus(error instanceof InitialDraftApiError ? error.status : null);
      setLocalDraftPresent(hasLocalDraftSnapshot());
    }
  }, [userId]);

  useEffect(() => {
    const controller = new AbortController();
    void runInitialization(controller.signal);
    return () => controller.abort();
  }, [attempt, runInitialization]);

  useEffect(() => {
    if (gateState !== "ready" || conflict || !initialDraftSignal) return;
    const tab = useFlowStore.getState().tabs.find(
      (candidate) => projectTabLifecycle(candidate) === "initial_draft",
    );
    if (!tab || tab.revision <= (tab.draftSyncedRevision ?? 0)) return;
    if (syncTimer.current !== null) window.clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(() => {
      syncTimer.current = null;
      const latest = useFlowStore.getState().tabs.find((candidate) => candidate.id === tab.id);
      if (latest) void synchronizeTab(latest);
    }, 700);
    return () => {
      if (syncTimer.current !== null) window.clearTimeout(syncTimer.current);
      syncTimer.current = null;
    };
  }, [conflict, gateState, initialDraftSignal, synchronizeTab]);

  useEffect(() => registerInitialDraftSaveBarrier(async (target) => {
    if (syncTimer.current !== null) {
      window.clearTimeout(syncTimer.current);
      syncTimer.current = null;
    }
    for (let attemptIndex = 0; attemptIndex < 8; attemptIndex += 1) {
      const tab = useFlowStore.getState().tabs.find((candidate) => (
        candidate.id === target.tabId &&
        candidate.projectId === target.projectId &&
        candidate.documentEpoch === target.documentEpoch
      ));
      if (!tab || projectTabLifecycle(tab) !== "initial_draft") return;
      if (tab.revision <= (tab.draftSyncedRevision ?? 0) && !syncInFlight.current) return;
      const synchronized = await synchronizeTab(tab);
      if (!synchronized) throw new Error("未保存项目同步失败，尚未转为正式项目");
    }
    throw new Error("项目仍在持续修改，请停止编辑后重试保存");
  }), [synchronizeTab]);

  useEffect(() => {
    setInitialDraftInteractionBlocking(Boolean(conflict));
    return () => setInitialDraftInteractionBlocking(false);
  }, [conflict]);

  const retrySync = useCallback(() => {
    const tab = useFlowStore.getState().tabs.find(
      (candidate) => projectTabLifecycle(candidate) === "initial_draft",
    );
    if (tab) void synchronizeTab(tab);
  }, [synchronizeTab]);

  /**
   * 本机草稿引用了服务端已无法访问的图片时，同步永远不会成功。这里先产出可回读的
   * 逐字备份，再清除本机草稿并整页重载，让画布回到云端草稿。
   */
  const discardLocalDraft = useCallback(() => {
    setDiscardError(null);
    let backup: LocalDraftBackup;
    try {
      backup = readLocalDraftBackup(window.sessionStorage);
    } catch {
      setDiscardError("无法读取本机草稿，未执行放弃；请手动清除本站点数据后重试。");
      return;
    }
    try {
      downloadLocalDraftBackup(backup);
    } catch {
      setDiscardError("本机草稿备份未下载成功，未执行放弃。");
      return;
    }
    // 阻止卸载或整页重载把内存草稿重新写回存储。
    suspendProjectTabSessionPersistence();
    if (!clearProjectTabSessionStorage(window.sessionStorage)) {
      setDiscardError("本机草稿未能完整清除，请手动清除本站点数据后重试。");
      return;
    }
    window.location.reload();
  }, []);

  const resolveKeepLocal = useCallback(async () => {
    if (!conflict || conflictBusy) return;
    const local = useFlowStore.getState().tabs.find((tab) => tab.id === conflict.localTabId);
    if (!local) return;
    setConflictBusy(true);
    try {
      const prepared = await copyProjectScopedMasks({
        sourceProjectId: local.projectId,
        targetProjectId: conflict.server.id,
        flow: persistedWorkflowForProjectTab(local),
      });
      const draft = await syncInitialDraft({
        id: conflict.server.id,
        expectedRevision: conflict.server.revision,
        name: local.projectName,
        flow: prepared.flow,
      });
      applyDraft(local, draft, { forceDirty: true });
      setConflict(null);
      setSyncState("idle");
      setSyncError(null);
      setGateState("ready");
    } catch (error) {
      if (error instanceof InitialDraftApiError && error.status === 409) {
        const server = await fetchInitialDraft().catch(() => null);
        if (server) setConflict({ localTabId: local.id, server });
      }
      setSyncState("error");
      setSyncError(error instanceof Error ? error.message : String(error));
    } finally {
      setConflictBusy(false);
    }
  }, [conflict, conflictBusy]);

  const resolveUseServer = useCallback(async () => {
    if (!conflict || conflictBusy) return;
    const local = useFlowStore.getState().tabs.find((tab) => tab.id === conflict.localTabId);
    if (!local) return;
    setConflictBusy(true);
    try {
      const backup = await copyProjectScopedMasks({
        sourceProjectId: local.projectId,
        createFreshTarget: true,
        flow: persistedWorkflowForProjectTab(local),
      });
      applyDraft(local, conflict.server, {
        preserveLocalBackup: { projectId: backup.targetProjectId, flow: backup.flow },
      });
      setConflict(null);
      setSyncState("idle");
      setSyncError(null);
      setGateState("ready");
    } catch (error) {
      setSyncState("error");
      setSyncError(error instanceof Error ? error.message : String(error));
    } finally {
      setConflictBusy(false);
    }
  }, [conflict, conflictBusy]);

  const abandon = useCallback(async (tabId: string): Promise<boolean> => {
    if (abandoningTabId) return false;
    const tab = useFlowStore.getState().tabs.find((candidate) => candidate.id === tabId);
    if (!tab || projectTabLifecycle(tab) !== "initial_draft") return false;
    setAbandoningTabId(tabId);
    setSyncError(null);
    try {
      const settled = await settleInitialDraftBeforeAbandon(
        tabId,
        () => useFlowStore.getState().tabs.find((candidate) => candidate.id === tabId),
        synchronizeTab,
        () => syncInFlight.current !== null,
      );
      if (!settled) return false;
      await abandonInitialDraft({
        id: settled.projectId,
        expectedRevision: settled.draftRevision ?? 0,
      });
      const fresh = replaceAbandonedInitialDraftWithFreshLocalTab(tabId);
      if (!fresh) throw new Error("初始草稿已变化，请刷新后重试");
      const next = await bootstrapInitialDraft({
        id: fresh.projectId,
        flow: persistedWorkflowForProjectTab(fresh),
      });
      applyDraft(fresh, next.draft, { forceDirty: false });
      setSyncState("idle");
      return true;
    } catch (error) {
      if (error instanceof InitialDraftApiError && error.status === 409) {
        const server = await fetchInitialDraft().catch(() => null);
        const latest = useFlowStore.getState().tabs.find((candidate) => candidate.id === tabId);
        if (server && latest) setConflict({ localTabId: latest.id, server });
      }
      setSyncState("error");
      setSyncError(error instanceof Error ? error.message : String(error));
      const latest = useFlowStore.getState().tabs.find((candidate) => candidate.id === tabId);
      if (!latest || projectTabLifecycle(latest) !== "initial_draft") {
        setGateState("error");
        setGateError("旧草稿已放弃，但新的初始项目创建失败。请重试恢复；本机内容仍保留。 ");
      }
      return false;
    } finally {
      setAbandoningTabId(null);
    }
  }, [abandoningTabId, synchronizeTab]);

  const context = useMemo<InitialDraftContextValue>(() => ({
    syncState,
    syncError,
    retrySync,
    abandon,
    abandoningTabId,
  }), [abandon, abandoningTabId, retrySync, syncError, syncState]);

  const canDiscardLocalDraft =
    gateState === "error" && gateErrorStatus === 403 && localDraftPresent;

  if (gateState !== "ready") {
    return (
      <>
        <BlockingScreen
          state={gateState}
          error={gateError}
          discardError={discardError}
          onRetry={() => setAttempt((value) => value + 1)}
          onDiscardLocal={canDiscardLocalDraft ? () => setDiscardDialogOpen(true) : undefined}
        />
        <AlertDialog open={discardDialogOpen} onOpenChange={setDiscardDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>放弃本机草稿？</AlertDialogTitle>
              <AlertDialogDescription>
                将先下载本机草稿的 JSON 备份，随后清除本机草稿并载入云端草稿。本机尚未同步的修改不会进入云端草稿。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction onClick={discardLocalDraft}>下载备份并放弃</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }
  return (
    <InitialDraftContext.Provider value={context}>
      {children}
      {conflict && (
        <ConflictDialog
          conflict={conflict}
          busy={conflictBusy}
          onKeepLocal={() => void resolveKeepLocal()}
          onUseServer={() => void resolveUseServer()}
        />
      )}
    </InitialDraftContext.Provider>
  );
}

export function InitialDraftSyncNotice() {
  const { syncState, syncError, retrySync } = useInitialDraftWorkspace();
  if (syncState !== "error") {
    return syncState === "syncing" ? (
      <span role="status" aria-live="polite" className="sr-only">
        正在同步未保存项目
      </span>
    ) : null;
  }
  return (
    <Card
      role="alert"
      size="sm"
      className="gc-panel shrink-0 gap-0 rounded-none border-x-0 border-t-0 border-[var(--gc-border)] bg-[var(--gc-panel)] py-0 ring-0"
    >
      <CardContent className="flex min-h-9 items-center justify-center gap-3 px-3 py-1.5 text-center">
        <CloudIcon aria-hidden="true" className="size-3.5 text-amber-300" />
        <p className="text-[10px] text-amber-300">
          云端草稿同步失败；本机内容已保留。{syncError ?? ""}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={retrySync}>重试同步</Button>
      </CardContent>
    </Card>
  );
}

import { create } from "zustand";
import { temporal } from "zundo";
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
} from "@xyflow/react";
import { nanoid } from "nanoid";
import {
  markProjectTabSessionWorkspaceRestored,
} from "@/lib/workspaceRestoreState";

export { didRestoreProjectTabSessionWorkspace } from "@/lib/workspaceRestoreState";
import {
  NODE_SPECS,
  isNodeRunActive,
  isNodeRunTerminal,
  type Asset,
  type NodeKind,
  type WorkflowNodeData,
  type NodeRunStatus,
  type ImageInputNodeData,
  type VideoGenerateNodeData,
  type PersistedWorkflow,
  type WorkflowInputRole,
  type ColorSwatch,
} from "@/types/workflow";
import type { ConnectionDraft } from "@/types/workbench";
import {
  compatibleUnusedInputRoles,
  connectionCompatibilityError,
  imagesForSourceHandle,
  inputPortSpecs,
  isStagedTryOnData,
  STAGED_ROLE_LABELS,
} from "@/lib/workflowPorts";
import {
  DEFAULT_GENERATION_MODEL_ID,
  MASK_REDRAW_MODEL_ID,
  defaultImageModelOptions,
  isImageModelId,
  isModelAllowedForNode,
  normalizeImageModelOptions,
} from "@/types/imageModels";
import { getGenerationSafetyBlockReason } from "@/store/generationSafety";
import {
  createDocumentSnapshot,
  documentSnapshotToPersistedWorkflow,
} from "@/lib/documentSnapshot";
import {
  clearUnreferencedProjectTabSessionStorage,
  PROJECT_TABS_STORAGE_KEY,
  PROJECT_TABS_STORAGE_SCHEMA_VERSION,
  isProjectTabSessionPersistenceSuspended,
  parseProjectTabsStorageManifest,
  projectTabStorageKey,
  type ProjectTabsStorageManifest,
} from "@/lib/tabSessionStorage";
import { waitForInitialDraftSyncBeforeFormalSave } from "@/initialDraft/initialDraftRuntime";
import { layoutConnectedComponent } from "@/lib/graphLayout";
import { normalizeColorSwatches } from "@/lib/colorPalette";
import { effectiveIncomingSources } from "@/lib/maskRepair";
import {
  SEEDANCE_VIDEO_MODES,
  isSeedanceVideoModel,
  normalizedSeedanceSettings,
} from "@/lib/seedance";

export type FlowNode = Node<WorkflowNodeData>;
export type ConnectedNodeDirection = "upstream" | "downstream";
const SAFE_DOCUMENT_EDGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function createDocumentEdgeId(): string {
  return `edge-${nanoid(10)}`;
}

function addDocumentEdge(connection: Connection | Edge, edges: Edge[]): Edge[] {
  return addEdge(connection, edges, { getEdgeId: createDocumentEdgeId });
}

export interface ConnectedNodeOptions {
  preset?: Record<string, unknown>;
  sourceHandle?: string | null;
  targetHandle?: WorkflowInputRole | null;
}
export const DEFAULT_PROJECT_NAME = "未命名设计项目";
export type ProjectLifecycle = "local" | "initial_draft" | "saved";

/** 最近生成条目：生成图片 + 该次运行的完整记录（运行记录已合并到这里） */
export interface RecentResult {
  id: string;
  /** 生成图 URL；失败记录为空字符串 */
  image: string;
  /** 列表预览图；打开详情和继续生成仍使用 image 原图。 */
  thumbnail?: string;
  nodeId: string;
  nodeLabel: string;
  kind: NodeKind;
  projectId?: string;
  projectName?: string;
  /** 后端运行 ID，用于页面刷新后恢复仍在执行的任务。 */
  runId?: string;
  /** 付费提交请求号；用于响应丢失后与服务端历史精确对账。 */
  clientRequestId?: string;
  prompt?: string;
  model?: string;
  startedAt: number;
  finishedAt?: number;
  status: Exclude<NodeRunStatus, "idle">;
  error?: string;
  ownerId?: string;
  ownerName?: string;
  requestedCount?: number;
  successfulCount?: number;
  providerRequests?: number;
  providerOutputSize?: string;
  parameters?: Record<string, unknown>;
  referenceImages?: string[];
  executionMeta?: Record<string, unknown>;
}

type SaveState = "idle" | "saving" | "saved" | "error";

export interface ProjectTab {
  id: string;
  projectId: string;
  projectName: string;
  readOnly: boolean;
  nodes: FlowNode[];
  edges: Edge[];
  /** 节点选择唯一真相；selectedNodeId 仅为兼容派生字段。 */
  selectedNodeIds: string[];
  selectedNodeId: string | null;
  selectedResultId: string | null;
  compareIds: string[];
  saveState: SaveState;
  /** 是否至少被服务端确认保存或载入过；独立于瞬时保存状态。 */
  hasBeenPersisted: boolean;
  revision: number;
  savedRevision: number;
  dirty: boolean;
  documentEpoch: number;
  /** 旧会话没有此字段；归一化时按原有保存状态推断。 */
  lifecycle?: ProjectLifecycle;
  /** 服务端 initial_draft 的乐观锁版本。 */
  draftRevision?: number;
  /** 已被服务端草稿确认的本地 document revision。 */
  draftSyncedRevision?: number;
  draftCreatedAt?: string;
}

/** Immutable identity captured before async work starts. */
export interface DocumentTarget {
  tabId: string;
  projectId: string;
  documentEpoch: number;
}

export type CoalescedTextEditDescriptor =
  | { kind: "project-name" }
  | { kind: "node-data"; nodeId: string; field: "label" | "prompt" | "note" | "materialSpec" | "constructionSpec" };

export interface CoalescedTextEditToken {
  readonly id: symbol;
  readonly target: DocumentTarget;
  readonly descriptorKey: string;
}

export interface FlowState {
  /** 应用内项目页签；活动文档始终是 activeTabId 对应的页签。 */
  tabs: ProjectTab[];
  activeTabId: string;
  /** 最近生成（底部结果面板，含运行记录），新条目在前 */
  recentResults: RecentResult[];
  /** 全局图片查看器（单击任意图片弹出，滚轮缩放 1x~2x） */
  viewer: { url: string; title?: string; prompt?: string; meta?: string } | null;
  /** 浏览器会话草稿未能持久化；非空时刷新可能丢失尚未保存的修改。 */
  tabSessionPersistenceError: string | null;
  /** 仅内存：打开的蒙版编辑器与尚未结束的蒙版上传总数。 */
  pendingMaskWorkCount: number;
  /** 仅内存：分步节点拖线后、用户确认业务角色前的连接草稿。 */
  pendingConnectionDraft: ConnectionDraft | null;
  connectionDraftError: string | null;

  switchTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  openFlowTab: (opts: {
    projectId: string;
    projectName: string;
    nodes: FlowNode[];
    edges: Edge[];
    markDirty?: boolean;
    readOnly?: boolean;
  }) => void;
  createBlankTab: () => void;
  setProjectName: (name: string) => void;
  setSelectedNodeIds: (ids: string[]) => void;
  setSelectedNodeId: (id: string | null) => void;
  /** 只整理主选节点所在连通工作流；返回 null 表示成功，否则返回拒绝原因。 */
  autoLayoutSelectedWorkflow: () => string | null;
  setSelectedResultId: (id: string | null) => void;
  toggleCompareId: (id: string) => void;
  clearCompare: () => void;
  removeRecentResult: (id: string) => void;
  openViewer: (v: { url: string; title?: string; prompt?: string; meta?: string }) => void;
  closeViewer: () => void;
  onNodesChange: (changes: NodeChange<FlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<Edge>[]) => void;
  onConnect: (conn: Connection) => void;
  confirmPendingConnection: (targetHandle: WorkflowInputRole) => boolean;
  cancelPendingConnection: () => void;
  isValidConnection: (conn: Connection | Edge) => boolean;
  addNode: (kind: NodeKind, position: { x: number; y: number }, preset?: Record<string, unknown>) => string | null;
  /** 在选中节点的上游或下游原子新增节点并连线；一次撤销移除节点和边。 */
  addConnectedNode: (
    anchorId: string,
    kind: NodeKind,
    direction: ConnectedNodeDirection,
    options?: ConnectedNodeOptions,
  ) => string | null;
  /** 将素材以已完成的图片输入节点原子加入画布，一次撤销即可完整移除。 */
  addAssetNode: (
    asset: Pick<Asset, "name" | "image">,
    position: { x: number; y: number },
  ) => string | null;
  /** 复制/粘贴等调用方已有完整节点时，仍通过此入口维护 revision/dirty。 */
  addExistingNode: (node: FlowNode) => void;
  /** 画板会话完成时只提交一次项目历史；异步结果必须仍匹配原 DocumentTarget。 */
  commitDrawingBoard: (
    target: DocumentTarget,
    nodeId: string,
    refs: { contentRef: string; previewImageRef: string; exportImageRef?: string },
  ) => boolean;
  /** 将已提交画板预览导出为独立图片节点；画板自身保持可编辑。 */
  exportDrawingBoardImageNode: (target: DocumentTarget, nodeId: string) => string | null;
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  /** 原子更新视频设置，并移除新模式下不再存在的入边。 */
  updateVideoNodeSettings: (id: string, patch: Partial<VideoGenerateNodeData>) => void;
  updateNodeDataInTab: (target: DocumentTarget, id: string, patch: Record<string, unknown>) => void;
  /** 为目标图片节点赋值，并在同一次历史提交中补齐模板声明的后续连接。 */
  assignImageInputInTab: (target: DocumentTarget, id: string, imageUrl: string) => void;
  setNodeStatus: (id: string, status: NodeRunStatus, error?: string) => void;
  runNode: (id: string) => Promise<void>;
  /** 保存当前页签；返回服务端是否确认持久化成功。 */
  saveProject: () => Promise<boolean>;
  /**
   * 整组载入画布（打开项目 / 从模板新建）：
   * 替换 nodes/edges 并重置选择、对比、查看器与撤销历史。
   * 调用方决定 projectId（打开项目用原 id，模板派生用新 id）。
   */
  loadFlow: (opts: {
    projectId: string;
    projectName: string;
    nodes: FlowNode[];
    edges: Edge[];
    /** 从模板新建时为 true；打开已保存项目时保持 false。 */
    markDirty?: boolean;
  }) => void;
  undo: () => void;
  redo: () => void;
}

type FlowSet = (
  partial: Partial<FlowState> | ((state: FlowState) => Partial<FlowState>),
) => unknown;

type FlowTemporalState = Pick<ProjectTab, "projectName" | "nodes" | "edges">;

type DocumentMutation =
  | Partial<ProjectTab>
  | ((tab: ProjectTab) => Partial<ProjectTab>);

export type HistoryTransactionToken = symbol;
type HistoryTransactionOutcome = "ended" | "cancelled";
type HistoryTransactionSettledCallback = (
  outcome: HistoryTransactionOutcome,
  token: HistoryTransactionToken,
) => void;

interface DeferredHistoryTransactionAction {
  runOnCancel: boolean;
  requireActiveTab: boolean;
  run: () => void;
  discard?: () => void;
}

interface ActiveHistoryTransaction {
  tokens: Set<HistoryTransactionToken>;
  onSettledByToken: Map<HistoryTransactionToken, HistoryTransactionSettledCallback>;
  deferredActions: DeferredHistoryTransactionAction[];
  tabId: string;
  before: FlowTemporalState;
  positionBeforeByNodeId: Map<string, { x: number; y: number }>;
  documentChanged: boolean;
}

let historySuppressionDepth = 0;
let activeHistoryTransaction: ActiveHistoryTransaction | null = null;
let recordHistoryEntry: (pastState: FlowTemporalState, currentState: FlowTemporalState) => void = () => undefined;
let flushDeferredTabSessionPersistence = (): void => undefined;
let flushPendingTabSessionPersistence = (): boolean => true;
const DOCUMENT_HISTORY_LIMIT = 50;
export const COALESCED_TEXT_EDIT_IDLE_MS = 800;

interface ActiveTextEdit {
  token: CoalescedTextEditToken;
  descriptor: CoalescedTextEditDescriptor;
  before: FlowTemporalState;
  originalValue: string;
  originalFieldExisted: boolean;
  composing: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

let activeTextEdit: ActiveTextEdit | null = null;
let finalizingTextEdit = false;

interface TabTemporalHistory {
  pastStates: FlowTemporalState[];
  futureStates: FlowTemporalState[];
}

/** zundo 只挂在活动文档上；非活动页签的内存历史在切页时显式换入换出。 */
const temporalHistoryByTab = new Map<string, TabTemporalHistory>();

interface TabSaveQueue {
  promise: Promise<SaveTabResult>;
  /** 用户在当前 attempt 未完成时再次明确发起保存的世代号。 */
  explicitRetryGeneration: number;
}

interface SaveTabResult {
  ok: boolean;
  error?: string;
}

class AmbiguousRunSubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousRunSubmissionError";
  }
}

/** 每个页签独立串行保存；切页不会使旧页签的保存响应失效。 */
const saveQueueByDocument = new Map<string, TabSaveQueue>();

/** 节点处于“保存项目、尚未创建后端 Run”的短暂阶段时用于去重。 */
const runPreparations = new Set<string>();

/** 传输结果未知时保留原请求号；再次点击只会确认/复用同一后端 Run。 */
const AMBIGUOUS_RUN_STORAGE_KEY = "garment-canvas-ambiguous-run-requests";

function loadAmbiguousRunRequestIds(): Map<string, string> {
  if (typeof window === "undefined") return new Map();
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(AMBIGUOUS_RUN_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return new Map();
    return new Map(parsed.filter(
      (entry): entry is [string, string] =>
        Array.isArray(entry) && entry.length === 2 &&
        typeof entry[0] === "string" && typeof entry[1] === "string",
    ));
  } catch {
    return new Map();
  }
}

const ambiguousRunRequestIds = loadAmbiguousRunRequestIds();

function persistAmbiguousRunRequestIds(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      AMBIGUOUS_RUN_STORAGE_KEY,
      JSON.stringify([...ambiguousRunRequestIds]),
    );
  } catch {
    // 会话存储不可用时仍保留当前进程内的幂等请求号。
  }
}

function rememberAmbiguousRunRequest(key: string, clientRequestId: string): void {
  ambiguousRunRequestIds.set(key, clientRequestId);
  persistAmbiguousRunRequestIds();
}

function clearAmbiguousRunRequest(key: string): void {
  if (!ambiguousRunRequestIds.delete(key)) return;
  persistAmbiguousRunRequestIds();
}

function documentTargetKey(target: DocumentTarget): string {
  return JSON.stringify([target.tabId, target.projectId, target.documentEpoch]);
}

function runPreparationKey(target: DocumentTarget, nodeId: string): string {
  return JSON.stringify([documentTargetKey(target), nodeId]);
}

function runSubmissionKey(projectId: string, nodeId: string): string {
  return JSON.stringify([projectId, nodeId]);
}

function latestActiveRecordsByNode(
  records: RecentResult[],
  projectId: string,
): Map<string, RecentResult> {
  const result = new Map<string, RecentResult>();
  for (const record of records) {
    if (record.projectId !== projectId || !isNodeRunActive(record.status) || !record.runId) continue;
    const existing = result.get(record.nodeId);
    if (!existing || existing.startedAt < record.startedAt) result.set(record.nodeId, record);
  }
  return result;
}

/** 同一节点存在历史并发 Run 时，只有最新一次 Run 可以回写画布状态。 */
export function isLatestTrackedRun(
  records: RecentResult[],
  candidate: Pick<RecentResult, "projectId" | "nodeId" | "runId" | "startedAt">,
): boolean {
  if (!candidate.projectId || !candidate.runId) return false;
  let latest: RecentResult | undefined;
  for (const record of records) {
    if (
      record.projectId !== candidate.projectId ||
      record.nodeId !== candidate.nodeId ||
      !record.runId
    ) continue;
    if (!latest || latest.startedAt < record.startedAt) latest = record;
  }
  return latest?.runId === candidate.runId;
}

/** 历史分页可能重叠；同一后端 Run 同一时刻只允许一条恢复连接。 */
const resumingRecentRunIds = new Set<string>();

/**
 * 屏蔽一个同步运行态/UI mutation 的历史记录。不得把异步 Promise 包在这里，
 * 否则 await 期间的真实用户编辑也会被吞掉。
 */
export function runWithoutHistory<T>(run: () => T): T {
  historySuppressionDepth += 1;
  try {
    return run();
  } finally {
    historySuppressionDepth = Math.max(0, historySuppressionDepth - 1);
  }
}

const TRANSIENT_NODE_KEYS = new Set([
  "selected",
  "dragging",
  "measured",
  "width",
  "height",
]);

const PRESERVED_NODE_TRANSIENT_KEYS = ["dragging", "measured", "width", "height"] as const;

function preserveNodeRuntimeAndTransients(
  target: FlowNode,
  current?: FlowNode,
  options?: { preserveDragging?: boolean },
): FlowNode {
  if (!current) return target;
  const next = {
    ...target,
    data: {
      ...target.data,
      status: current.data.status,
      error: current.data.error,
    } as WorkflowNodeData,
  };
  const nextRecord = next as unknown as Record<string, unknown>;
  const currentRecord = current as unknown as Record<string, unknown>;
  for (const key of PRESERVED_NODE_TRANSIENT_KEYS) {
    if (key === "dragging" && options?.preserveDragging === false) continue;
    if (Object.prototype.hasOwnProperty.call(currentRecord, key)) nextRecord[key] = currentRecord[key];
    else delete nextRecord[key];
  }
  return next;
}

const DOCUMENT_NODE_SHELL_EXCLUDED_KEYS = new Set([
  ...TRANSIENT_NODE_KEYS,
  "id",
  "type",
  "position",
  "data",
]);

const RUNTIME_NODE_DATA_KEYS = new Set(["status", "error"]);

function sameRecordValues(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  excludedKeys: ReadonlySet<string>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (excludedKeys.has(key)) continue;
    const leftValue = left[key];
    const rightValue = right[key];
    if (Object.is(leftValue, rightValue)) continue;
    if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) return false;
  }
  return true;
}

function sameDocumentNode(left: FlowNode, right: FlowNode): boolean {
  if (left === right) return true;
  if (
    left.id !== right.id ||
    left.type !== right.type ||
    left.position.x !== right.position.x ||
    left.position.y !== right.position.y
  ) return false;
  if (!sameRecordValues(
    left as unknown as Record<string, unknown>,
    right as unknown as Record<string, unknown>,
    DOCUMENT_NODE_SHELL_EXCLUDED_KEYS,
  )) return false;
  if (left.data === right.data) return true;
  return sameRecordValues(
    left.data as unknown as Record<string, unknown>,
    right.data as unknown as Record<string, unknown>,
    RUNTIME_NODE_DATA_KEYS,
  );
}

function documentEdgeValue(edge: Edge): unknown {
  const { selected: _selected, ...documentEdge } = edge;
  return documentEdge;
}

function sameDocumentNodes(left: FlowNode[], right: FlowNode[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!sameDocumentNode(left[index], right[index])) return false;
  }
  return true;
}

function sameDocumentEdges(left: Edge[], right: Edge[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) continue;
    if (JSON.stringify(documentEdgeValue(left[index])) !== JSON.stringify(documentEdgeValue(right[index]))) {
      return false;
    }
  }
  return true;
}

function sameTemporalDocument(left: FlowTemporalState, right: FlowTemporalState): boolean {
  return left.projectName === right.projectName &&
    sameDocumentNodes(left.nodes, right.nodes) &&
    sameDocumentEdges(left.edges, right.edges);
}

function temporalDocument(tab: ProjectTab): FlowTemporalState {
  return { projectName: tab.projectName, nodes: tab.nodes, edges: tab.edges };
}

function stashActiveTemporalHistory(tabId: string): void {
  const temporalState = useFlowStore.temporal.getState();
  if (temporalState.pastStates.length === 0 && temporalState.futureStates.length === 0) {
    temporalHistoryByTab.delete(tabId);
    return;
  }
  temporalHistoryByTab.set(tabId, {
    pastStates: [...temporalState.pastStates] as FlowTemporalState[],
    futureStates: [...temporalState.futureStates] as FlowTemporalState[],
  });
}

function restoreTemporalHistory(tabId: string): void {
  const history = temporalHistoryByTab.get(tabId);
  useFlowStore.temporal.setState({
    pastStates: history ? [...history.pastStates] : [],
    futureStates: history ? [...history.futureStates] : [],
  });
}

function recordInactiveTabHistory(
  tabId: string,
  before: FlowTemporalState,
  current: FlowTemporalState,
): void {
  if (sameTemporalDocument(before, current)) return;
  const history = temporalHistoryByTab.get(tabId) ?? { pastStates: [], futureStates: [] };
  temporalHistoryByTab.set(tabId, {
    pastStates: [...history.pastStates, before].slice(-DOCUMENT_HISTORY_LIMIT),
    futureStates: [],
  });
}

function documentMutationChanged(tab: ProjectTab, patch: Partial<ProjectTab>): boolean {
  if (patch.projectName !== undefined && patch.projectName !== tab.projectName) return true;
  if (patch.nodes !== undefined && !sameDocumentNodes(tab.nodes, patch.nodes)) return true;
  if (patch.edges !== undefined && !sameDocumentEdges(tab.edges, patch.edges)) return true;
  return false;
}

function captureTransactionPositionChanges(
  transaction: ActiveHistoryTransaction,
  tab: ProjectTab,
  patch: Partial<ProjectTab>,
): void {
  if (!patch.nodes) return;
  const currentById = new Map(tab.nodes.map((node) => [node.id, node]));
  for (const nextNode of patch.nodes) {
    const currentNode = currentById.get(nextNode.id);
    if (
      !currentNode ||
      transaction.positionBeforeByNodeId.has(nextNode.id) ||
      (currentNode.position.x === nextNode.position.x && currentNode.position.y === nextNode.position.y)
    ) continue;
    transaction.positionBeforeByNodeId.set(nextNode.id, { ...currentNode.position });
  }
}

/**
 * 将事务中的实时拖拽位置还原到起点，同时保留期间发生的其他文档变化。
 * 这样后台 success/output 等并发提交可以获得独立、按时间排序的历史记录。
 */
function rebaseDocumentOutsideTransaction(
  document: FlowTemporalState,
  transaction: ActiveHistoryTransaction,
): FlowTemporalState {
  if (transaction.positionBeforeByNodeId.size === 0) return document;
  const baselineById = new Map(transaction.before.nodes.map((node) => [node.id, node]));
  let changed = false;
  const nodes = document.nodes.map((node) => {
    const position = transaction.positionBeforeByNodeId.get(node.id);
    if (!position) return node;
    const baseline = baselineById.get(node.id);
    if (
      node.position.x === position.x &&
      node.position.y === position.y &&
      node.dragging === baseline?.dragging
    ) return node;
    changed = true;
    return { ...node, position: { ...position }, dragging: baseline?.dragging };
  });
  return {
    projectName: document.projectName,
    nodes: changed ? nodes : document.nodes,
    edges: document.edges,
  };
}

function commitDocumentMutationWithSet(
  set: FlowSet,
  mutation: DocumentMutation,
  options?: { coalesceWithActiveTransaction?: boolean },
): boolean {
  if (!finalizingTextEdit) flushActiveTextEdit();
  let changed = false;
  const concurrent: {
    transaction: ActiveHistoryTransaction | null;
    before: FlowTemporalState | null;
  } = { transaction: null, before: null };
  set((state) => {
    const tab = selectActiveDocument(state);
    const patch = typeof mutation === "function" ? mutation(tab) : mutation;
    if (!documentMutationChanged(tab, patch)) {
      // 同一次 action 可能只更新运行态或选择投影；应用它，但不写 history/revision。
      // 完全同引用的真正 no-op 仍直接返回空 patch。
      const hasTransientChange = Object.entries(patch).some(([key, value]) => (
        value !== tab[key as keyof ProjectTab]
      ));
      return hasTransientChange
        ? { tabs: replaceTab(state.tabs, { ...tab, ...patch }) }
        : {};
    }
    changed = true;
    const transaction = activeHistoryTransaction?.tabId === state.activeTabId
      ? activeHistoryTransaction
      : null;
    if (transaction && options?.coalesceWithActiveTransaction) {
      captureTransactionPositionChanges(transaction, tab, patch);
      transaction.documentChanged = true;
      return { tabs: replaceTab(state.tabs, { ...tab, ...patch }) };
    }
    if (transaction) {
      concurrent.transaction = transaction;
      concurrent.before = rebaseDocumentOutsideTransaction(
        temporalDocument(tab),
        transaction,
      );
    }
    const nextTab: ProjectTab = {
      ...tab,
      ...patch,
      revision: tab.revision + 1,
      dirty: true,
      saveState: tab.saveState === "saving" ? "saving" : "idle",
    };
    return { tabs: replaceTab(state.tabs, nextTab) };
  });
  if (changed && concurrent.transaction && concurrent.before) {
    const latest = documentForTab(useFlowStore.getState(), concurrent.transaction.tabId);
    if (!latest) return changed;
    const concurrentAfter = rebaseDocumentOutsideTransaction(
      temporalDocument(latest),
      concurrent.transaction,
    );
    if (!sameTemporalDocument(concurrent.before, concurrentAfter)) {
      recordHistoryEntry(concurrent.before, concurrentAfter);
    }
    concurrent.transaction.before = concurrentAfter;
  }
  return changed;
}

/** 对当前项目文档执行一次原子、可撤销且具备 no-op 判定的修改。 */
export function commitDocumentMutation(mutation: DocumentMutation): boolean {
  return commitDocumentMutationWithSet(useFlowStore.setState, mutation);
}

/** 原子加入一组完整节点；复制多选节点时只写一次 revision 与撤销记录。 */
export function addExistingNodes(nodes: FlowNode[]): string[] {
  if (nodes.length === 0) return [];
  let addedIds: string[] = [];
  const changed = commitDocumentMutation((tab) => {
    if (tab.readOnly) return {};
    const knownIds = new Set(tab.nodes.map((node) => node.id));
    const additions = nodes.filter((node) => {
      if (knownIds.has(node.id)) return false;
      knownIds.add(node.id);
      return true;
    });
    if (additions.length === 0) return {};
    addedIds = additions.map((node) => node.id);
    const nextNodes = [...tab.nodes, ...additions];
    return {
      ...normalizeNodeSelection(nextNodes, addedIds),
      selectedResultId: null,
    };
  });
  return changed ? addedIds : [];
}

/** 开始一组实时可见、但只在结束时写入一次历史与 revision 的文档事务。 */
export function beginHistoryTransaction(
  label = "document-transaction",
  onSettled?: HistoryTransactionSettledCallback,
): HistoryTransactionToken {
  const token = Symbol(label);
  flushActiveTextEdit();
  // Debounced edits that predate the gesture are already stable. Persist them
  // before live drag frames begin so a pagehide during the gesture cannot lose them.
  if (!activeHistoryTransaction) flushPendingTabSessionPersistence();
  const state = useFlowStore.getState();
  if (!activeHistoryTransaction || activeHistoryTransaction.tabId !== state.activeTabId) {
    const tab = selectActiveDocument(state);
    activeHistoryTransaction = {
      tokens: new Set(),
      onSettledByToken: new Map(),
      deferredActions: [],
      tabId: state.activeTabId,
      before: temporalDocument(tab),
      positionBeforeByNodeId: new Map(),
      documentChanged: false,
    };
  }
  activeHistoryTransaction.tokens.add(token);
  if (onSettled) activeHistoryTransaction.onSettledByToken.set(token, onSettled);
  return token;
}

function notifyHistoryTransactionSettled(
  callbacks: Array<[HistoryTransactionToken, HistoryTransactionSettledCallback]>,
  outcome: HistoryTransactionOutcome,
): void {
  for (const [token, callback] of callbacks) {
    try {
      callback(outcome, token);
    } catch {
      // Settlement cleanup must not make the document command fail.
    }
  }
}

interface HistoryTransactionCompletion {
  tabId: string;
  callbacks: Array<[HistoryTransactionToken, HistoryTransactionSettledCallback]>;
  actions: DeferredHistoryTransactionAction[];
}

function detachHistoryTransaction(
  transaction: ActiveHistoryTransaction,
  callbacks = [...transaction.onSettledByToken.entries()],
): HistoryTransactionCompletion {
  const completion: HistoryTransactionCompletion = {
    tabId: transaction.tabId,
    callbacks,
    actions: [...transaction.deferredActions],
  };
  if (activeHistoryTransaction === transaction) activeHistoryTransaction = null;
  transaction.tokens.clear();
  transaction.onSettledByToken.clear();
  transaction.deferredActions.length = 0;
  return completion;
}

function finishHistoryTransactionCompletion(
  completion: HistoryTransactionCompletion,
  outcome: HistoryTransactionOutcome,
): void {
  notifyHistoryTransactionSettled(completion.callbacks, outcome);
  if (completion.actions.length === 0) return;
  queueMicrotask(() => {
    for (const action of completion.actions) {
      const allowed =
        (outcome === "ended" || action.runOnCancel) &&
        (!action.requireActiveTab || useFlowStore.getState().activeTabId === completion.tabId);
      if (!allowed) {
        action.discard?.();
        continue;
      }
      try {
        action.run();
      } catch {
        // One deferred command must not prevent later commands from settling.
        action.discard?.();
      }
    }
  });
}

function waitForHistoryTransactionSettlement(tabId: string): Promise<void> | null {
  const transaction = activeHistoryTransaction;
  if (!transaction || transaction.tabId !== tabId) return null;
  return new Promise((resolve) => {
    transaction.deferredActions.push({
      runOnCancel: true,
      requireActiveTab: false,
      run: () => {
        const nextSettlement = waitForHistoryTransactionSettlement(tabId);
        if (nextSettlement) void nextSettlement.then(resolve);
        else resolve();
      },
      discard: resolve,
    });
  });
}

function deferHistoryCommandUntilSettlement(command: "undo" | "redo"): boolean {
  const transaction = activeHistoryTransaction;
  if (!transaction || transaction.tabId !== useFlowStore.getState().activeTabId) return false;
  const tabId = transaction.tabId;
  transaction.deferredActions.push({
    runOnCancel: false,
    requireActiveTab: true,
    // Promise resolvers for save/run naturally schedule their continuations as
    // microtasks. Queue history commands the same way so the single action list
    // preserves the user's Save→Undo and Undo→Save registration order.
    run: () => queueMicrotask(() => {
      if (useFlowStore.getState().activeTabId !== tabId) return;
      useFlowStore.getState()[command]();
    }),
  });
  return true;
}

function commitHistoryTransaction(
  transaction: ActiveHistoryTransaction,
  callbacks?: Array<[HistoryTransactionToken, HistoryTransactionSettledCallback]>,
): boolean {
  let state = useFlowStore.getState();
  let tab = selectActiveDocument(state);
  const settledNodes = tab.nodes.map((node) => (
    node.dragging ? { ...node, dragging: false } : node
  ));
  if (settledNodes.some((node, index) => node !== tab.nodes[index])) {
    runWithoutHistory(() => patchTab(useFlowStore.setState, tab.id, { nodes: settledNodes }));
    state = useFlowStore.getState();
    tab = selectActiveDocument(state);
  }
  if (!transaction.documentChanged || transaction.tabId !== state.activeTabId) {
    const completion = detachHistoryTransaction(transaction, callbacks);
    flushDeferredTabSessionPersistence();
    finishHistoryTransactionCompletion(completion, "ended");
    return false;
  }
  const current = temporalDocument(tab);
  const temporalChanged = !sameTemporalDocument(transaction.before, current);
  if (!temporalChanged) {
    const completion = detachHistoryTransaction(transaction, callbacks);
    flushDeferredTabSessionPersistence();
    finishHistoryTransactionCompletion(completion, "ended");
    return false;
  }

  recordHistoryEntry(transaction.before, current);
  // Keep session persistence suppressed until the final coordinates and their
  // revision/dirty metadata can be observed in the same completed transaction.
  const completion = detachHistoryTransaction(transaction, callbacks);
  runWithoutHistory(() => {
    useFlowStore.setState((latest) => {
      const latestTab = selectActiveDocument(latest);
      return { tabs: replaceTab(latest.tabs, {
        ...latestTab,
        revision: latestTab.revision + 1,
        dirty: true,
        saveState: latestTab.saveState === "saving" ? "saving" : "idle",
      }) };
    });
  });
  flushDeferredTabSessionPersistence();
  finishHistoryTransactionCompletion(completion, "ended");
  return true;
}

/** 结束调用方持有的事务 token；返回是否产生了一次净文档提交。 */
export function endHistoryTransaction(token: HistoryTransactionToken): boolean {
  const transaction = activeHistoryTransaction;
  if (!transaction || !transaction.tokens.delete(token)) return false;
  const callback = transaction.onSettledByToken.get(token);
  transaction.onSettledByToken.delete(token);
  const callbacks: Array<[HistoryTransactionToken, HistoryTransactionSettledCallback]> = callback
    ? [[token, callback]]
    : [];
  if (transaction.tokens.size > 0) {
    notifyHistoryTransactionSettled(callbacks, "ended");
    return false;
  }
  return commitHistoryTransaction(transaction, callbacks);
}

function cancelHistoryTransaction(): void {
  const transaction = activeHistoryTransaction;
  if (!transaction) return;

  const state = useFlowStore.getState();
  if (transaction.tabId !== state.activeTabId) {
    const completion = detachHistoryTransaction(transaction);
    flushDeferredTabSessionPersistence();
    finishHistoryTransactionCompletion(completion, "cancelled");
    return;
  }

  const tab = selectActiveDocument(state);
  // A tab/load transition can invalidate a drag before React Flow emits dragStop.
  // Restore the document snapshot so an intermediate position is never persisted
  // without a history entry or revision. Runtime status and current selection are
  // transient, so keep those values while rolling the persisted document back.
  const currentById = new Map(tab.nodes.map((node) => [node.id, node]));
  const selectedEdges = new Map(tab.edges.map((edge) => [edge.id, edge.selected]));
  const nodes = transaction.before.nodes.map((node) => {
    const restored = preserveNodeRuntimeAndTransients(
      node,
      currentById.get(node.id),
      { preserveDragging: false },
    );
    return restored.dragging ? { ...restored, dragging: false } : restored;
  });
  const edges = transaction.before.edges.map((edge) => {
    const selected = selectedEdges.get(edge.id);
    return edge.selected === selected ? edge : { ...edge, selected };
  });
  runWithoutHistory(() => {
    const selection = normalizeNodeSelection(nodes, tab.selectedNodeIds);
    patchTab(useFlowStore.setState, tab.id, {
      ...selection,
      edges,
      projectName: transaction.before.projectName,
    });
  });
  const completion = detachHistoryTransaction(transaction);
  flushDeferredTabSessionPersistence();
  finishHistoryTransactionCompletion(completion, "cancelled");
}

/**
 * 直接执行受控的画布内容变更，并同步 revision/dirty。
 * 用于 App 等既有调用方尚未迁移到 store action 的兼容路径。
 */
export function markFlowDocumentChanged(partial: Pick<ProjectTab, "nodes"> | Pick<ProjectTab, "edges">): void {
  commitDocumentMutation(partial);
}

function defaultNodeData(kind: NodeKind): WorkflowNodeData {
  const spec = NODE_SPECS[kind];
  const base = { label: spec.title, status: "idle" as NodeRunStatus };
  switch (kind) {
    case "image-input":
      return { ...base, kind, imageRole: "default" };
    case "text-input":
      return { ...base, kind, text: "" };
    case "drawing-board":
      return { ...base, kind, boardVersion: 1, width: 1024, height: 1024, background: "#FFFFFF" };
    case "color-palette":
      return {
        ...base,
        kind,
        paletteVersion: 1,
        swatches: [{ id: "black", value: "#000000", source: "quick" }],
      };
    case "stage-approval":
      return { ...base, kind, approvalKind: "scene-baseline" };
    case "video-input":
      return { ...base, kind };
    case "audio-input":
      return { ...base, kind };
    case "video-generate":
      return {
        ...base,
        kind,
        mode: "text-to-video",
        prompt: "",
        videoModel: "doubao-seedance-2-5-260628",
        aspectRatio: "16:9",
        resolution: "720p",
        seconds: 5,
        generateAudio: true,
        outputFormat: "mp4",
        outputImages: [],
      };
    case "sketch-to-render":
      return {
        ...base, kind, prompt: "", aspectRatio: "3:4", batchSize: 1, outputImages: [],
        modelId: DEFAULT_GENERATION_MODEL_ID,
        modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID, "3:4"),
      };
    case "ai-modify":
      return {
        ...base, kind, prompt: "", aspectRatio: "1:1", batchSize: 1, outputImages: [],
        modelId: DEFAULT_GENERATION_MODEL_ID,
        modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID),
      };
    case "fabric-recolor":
      return {
        ...base, kind, operationMode: "combined", colors: [], prompt: "", outputImages: [],
        modelId: DEFAULT_GENERATION_MODEL_ID,
        modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID),
      };
    case "upscale":
      return {
        ...base, kind, imageSize: "2K", outputImages: [],
        modelId: DEFAULT_GENERATION_MODEL_ID,
        modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID),
      };
    case "print-extract":
      return {
        ...base, kind, prompt: "", outputImages: [], savedAsAssets: [],
        modelId: DEFAULT_GENERATION_MODEL_ID,
        modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID),
      };
    case "print-mutate":
      return {
        ...base, kind, prompt: "", count: 4, outputImages: [],
        modelId: DEFAULT_GENERATION_MODEL_ID,
        modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID),
      };
    case "virtual-try-on":
      return {
        ...base, kind, workflowStage: "standard", prompt: "", imageSize: "2K", aspectRatio: "3:4", basisRevision: 0,
        promptEnhancement: false, qualityMode: "fast", safetyFallback: false, stylePresetId: "faithful", outputImages: [],
        modelId: MASK_REDRAW_MODEL_ID, modelOptions: {},
      };
    case "mask-redraw":
      return {
        ...base, kind, repairFocus: "custom", executionMode: "repair", prompt: "", outputImages: [],
        modelId: MASK_REDRAW_MODEL_ID, modelOptions: {},
      };
    case "result":
      return { ...base, kind, images: [] };
  }
}

function defaultNodeDataWithPreset(kind: NodeKind, preset?: Record<string, unknown>): WorkflowNodeData {
  const data = defaultNodeData(kind);
  if (!preset) return data;
  if (data.kind === "fabric-recolor" && (preset.operationMode === "fabric" || preset.operationMode === "color")) {
    return { ...data, operationMode: preset.operationMode };
  }
  if (data.kind === "color-palette" && Array.isArray(preset.swatches)) {
    try {
      return {
        ...data,
        swatches: normalizeColorSwatches(preset.swatches as Array<{
          id?: string; value: string; name?: string; source: ColorSwatch["source"];
        }>),
      };
    } catch {
      return data;
    }
  }
  if ((data.kind === "ai-modify" || data.kind === "sketch-to-render") && typeof preset.prompt === "string") {
    return { ...data, prompt: preset.prompt };
  }
  if (data.kind === "upscale" && (preset.imageSize === "2K" || preset.imageSize === "4K")) {
    return { ...data, imageSize: preset.imageSize };
  }
  if (
    data.kind === "video-input"
    && typeof preset.videoUrl === "string"
    && typeof preset.mimeType === "string"
    && ["video/mp4", "video/webm", "video/quicktime"].includes(preset.mimeType)
  ) {
    return {
      ...data,
      label: typeof preset.label === "string" && preset.label.trim() ? preset.label.trim() : data.label,
      videoUrl: preset.videoUrl,
      mimeType: preset.mimeType as "video/mp4" | "video/webm" | "video/quicktime",
    };
  }
  if (
    data.kind === "audio-input"
    && typeof preset.audioUrl === "string"
    && typeof preset.mimeType === "string"
    && ["audio/mpeg", "audio/wav", "audio/mp4", "audio/ogg"].includes(preset.mimeType)
  ) {
    return {
      ...data,
      label: typeof preset.label === "string" && preset.label.trim() ? preset.label.trim() : data.label,
      audioUrl: preset.audioUrl,
      mimeType: preset.mimeType as "audio/mpeg" | "audio/wav" | "audio/mp4" | "audio/ogg",
    };
  }
  return data;
}

/** 从节点 data 中取它对外输出的图片 */
function nodeOutputImages(data: WorkflowNodeData, sourceHandle?: string | null): string[] {
  if (data.kind === "image-input") return data.imageUrl ? [data.imageUrl] : [];
  if (data.kind === "drawing-board") return data.previewImageRef ? [data.previewImageRef] : [];
  if (data.kind === "stage-approval") return data.approvedBaselineRef ? [data.approvedBaselineRef] : [];
  if (data.kind === "video-input") return data.videoUrl ? [data.videoUrl] : [];
  if (data.kind === "audio-input") return data.audioUrl ? [data.audioUrl] : [];
  if (data.kind === "result") {
    return imagesForSourceHandle(data.images ?? [], sourceHandle);
  }
  if (data.kind === "text-input" || data.kind === "color-palette") return [];
  return data.outputImages ?? [];
}

function virtualTryOnRunBlockReason(node: FlowNode, document: ProjectTab): string | undefined {
  if (node.data.kind !== "virtual-try-on" || node.data.workflowStage === "standard") return undefined;
  const incoming = document.edges.filter((edge) => edge.target === node.id);
  const edgesFor = (role: string) => incoming.filter((edge) => edge.targetHandle === role);
  const imageFor = (role: string) => {
    const edge = edgesFor(role)[0];
    const source = edge ? document.nodes.find((candidate) => candidate.id === edge.source) : undefined;
    return source ? nodeOutputImages(source.data)[0] : undefined;
  };
  const requireSingle = (role: string, label: string) => {
    const count = edgesFor(role).length;
    if (count !== 1) return `${label}必须且只能连接 1 张图片`;
    if (!imageFor(role)) return `${label}尚未提供可用图片`;
    return undefined;
  };

  if (node.data.workflowStage === "scene-stabilize") {
    if (node.data.modelId !== "gemini-3.1-flash-image-preview") return "第一轮必须使用 Gemini 3.1 Flash";
    const personEdges = edgesFor("person");
    if (personEdges.length < 1 || personEdges.length > 3) return "人物身份图必须连接 1 至 3 张";
    if (personEdges.some((edge) => {
      const source = document.nodes.find((candidate) => candidate.id === edge.source);
      return !source || nodeOutputImages(source.data).length === 0;
    })) return "人物身份图尚未全部提供可用图片";
    return requireSingle("scene", "场景/表演参考图")
      ?? requireSingle("outfit", "主穿搭图");
  }

  if (node.data.modelId !== MASK_REDRAW_MODEL_ID) return "第二轮必须使用 GPT Image 2";
  const baselineError = requireSingle("baseline", "已确认基准图");
  if (baselineError) return baselineError;
  const outfitError = requireSingle("outfit", "主穿搭图");
  if (outfitError) return outfitError;
  if (edgesFor("material").length > 1) return "面料参考图最多连接 1 张";
  const baselineEdge = edgesFor("baseline")[0];
  const approval = baselineEdge ? document.nodes.find((candidate) => candidate.id === baselineEdge.source) : undefined;
  const candidateEdge = approval?.data.kind === "stage-approval"
    ? document.edges.find((edge) => edge.target === approval.id && edge.targetHandle === "baseline-candidate")
    : undefined;
  const candidate = candidateEdge ? document.nodes.find((source) => source.id === candidateEdge.source) : undefined;
  const currentBaseline = candidate ? nodeOutputImages(candidate.data)[0] : undefined;
  const currentBasis = candidate?.data.kind === "virtual-try-on" && candidate.data.workflowStage === "scene-stabilize"
    ? candidate.data.basisRevision ?? 0
    : undefined;
  if (
    approval?.data.kind !== "stage-approval"
    || !currentBaseline
    || approval.data.approvedSourceNodeId !== candidate?.id
    || approval.data.approvedBaselineRef !== currentBaseline
    || approval.data.approvedBasisRevision !== currentBasis
  ) return "请先在独立确认节点检查并确认当前第一轮基准图";
  if (!node.data.garmentCategory) return "请选择服装品类";
  if (!node.data.materialSpec?.trim()) return "请填写面料或材料说明";
  if (!node.data.constructionSpec?.trim()) return "请填写针织、织造或加工工艺";
  return undefined;
}

function sameStringList(left: string[], right: string[]): boolean {
  return left === right || (
    left.length === right.length && left.every((value, index) => value === right[index])
  );
}

export function selectPrimarySelectedNodeId(
  document: Pick<ProjectTab, "selectedNodeIds">,
): string | null {
  return document.selectedNodeIds.at(-1) ?? null;
}

function normalizeNodeSelection(
  nodes: FlowNode[],
  requestedIds: readonly string[],
): Pick<ProjectTab, "nodes" | "selectedNodeIds" | "selectedNodeId"> {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const seen = new Set<string>();
  const selectedNodeIds = requestedIds.filter((id) => {
    if (!nodeIds.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const selected = new Set(selectedNodeIds);
  let changed = false;
  const normalizedNodes = nodes.map((node) => {
    const shouldSelect = selected.has(node.id);
    if (Boolean(node.selected) === shouldSelect) return node;
    changed = true;
    return { ...node, selected: shouldSelect };
  });
  return {
    nodes: changed ? normalizedNodes : nodes,
    selectedNodeIds,
    selectedNodeId: selectedNodeIds.at(-1) ?? null,
  };
}

function selectionIdsAfterNodeChanges(
  currentIds: readonly string[],
  nodes: FlowNode[],
  changes: readonly NodeChange<FlowNode>[],
): string[] {
  const selectedNodeIds = new Set(
    nodes.filter((node) => node.selected).map((node) => node.id),
  );
  let nextIds = currentIds.filter((id) => selectedNodeIds.has(id));
  const selectionChanges = changes.filter(
    (change): change is Extract<NodeChange<FlowNode>, { type: "select" }> => change.type === "select",
  );
  if (selectionChanges.length === 0) return nextIds;

  for (const change of selectionChanges) {
    nextIds = nextIds.filter((id) => id !== change.id);
    if (change.selected && selectedNodeIds.has(change.id)) nextIds.push(change.id);
  }
  // Defensive fallback for a React Flow version that batches a selected node
  // without an explicit select change; event order remains authoritative.
  for (const node of nodes) {
    if (node.selected && !nextIds.includes(node.id)) nextIds.push(node.id);
  }
  return nextIds;
}

function makeStarterNode(): FlowNode {
  return {
    id: nanoid(8),
    type: "image-input",
    position: { x: 0, y: 0 },
    data: defaultNodeData("image-input"),
  };
}

/**
 * Canonical active-document boundary. A valid store always has exactly one tab
 * matching activeTabId; fail fast if an invariant violation reaches a caller.
 */
export function selectActiveDocument(state: FlowState): ProjectTab {
  const document = state.tabs.find((tab) => tab.id === state.activeTabId);
  if (!document) throw new Error(`Active project tab not found: ${state.activeTabId}`);
  return document;
}

export function selectActiveDocumentTarget(state: FlowState): DocumentTarget {
  const document = selectActiveDocument(state);
  return documentTarget(document);
}

function documentTarget(document: ProjectTab): DocumentTarget {
  return {
    tabId: document.id,
    projectId: document.projectId,
    documentEpoch: document.documentEpoch,
  };
}

export function selectDocumentForTab(
  state: FlowState,
  tabId: string,
): ProjectTab | undefined {
  return documentForTab(state, tabId);
}

export function selectActiveProjectId(state: FlowState): string {
  return selectActiveDocument(state).projectId;
}

export function selectActiveProjectName(state: FlowState): string {
  return selectActiveDocument(state).projectName;
}

export function selectActiveReadOnly(state: FlowState): boolean {
  return selectActiveDocument(state).readOnly;
}

export function selectActiveNodes(state: FlowState): FlowNode[] {
  return selectActiveDocument(state).nodes;
}

export function selectActiveEdges(state: FlowState): Edge[] {
  return selectActiveDocument(state).edges;
}

export function selectActiveSelectedNodeIds(state: FlowState): string[] {
  return selectActiveDocument(state).selectedNodeIds;
}

export function selectActiveSelectedNodeId(state: FlowState): string | null {
  return selectActiveDocument(state).selectedNodeId;
}

export function selectActivePrimarySelectedNodeId(state: FlowState): string | null {
  return selectPrimarySelectedNodeId(selectActiveDocument(state));
}

export function selectActiveSelectedResultId(state: FlowState): string | null {
  return selectActiveDocument(state).selectedResultId;
}

export function selectActiveCompareIds(state: FlowState): string[] {
  return selectActiveDocument(state).compareIds;
}

export function selectActiveSaveState(state: FlowState): SaveState {
  return selectActiveDocument(state).saveState;
}

export function selectActiveRevision(state: FlowState): number {
  return selectActiveDocument(state).revision;
}

export function selectActiveSavedRevision(state: FlowState): number {
  return selectActiveDocument(state).savedRevision;
}

export function selectActiveDirty(state: FlowState): boolean {
  return selectActiveDocument(state).dirty;
}

export function selectActiveDocumentEpoch(state: FlowState): number {
  return selectActiveDocument(state).documentEpoch;
}

export function selectHasDirtyTabs(state: FlowState): boolean {
  return state.tabs.some((tab) => tab.dirty);
}

/** 只有从未编辑、未保存的初始空白项目才显示任务启动器。 */
export function isPristineProjectTab(tab: ProjectTab): boolean {
  const lifecycle = projectTabLifecycle(tab);
  if (
    tab.readOnly ||
    tab.dirty ||
    tab.hasBeenPersisted ||
    tab.saveState === "saving" ||
    tab.revision !== 0 ||
    tab.savedRevision !== 0 ||
    (lifecycle === "initial_draft"
      ? !/^\u672a\u4fee\u6539\u9879\u76ee\u540d\u79f0\d{8}000000$/.test(tab.projectName)
      : tab.projectName !== DEFAULT_PROJECT_NAME) ||
    tab.edges.length !== 0 ||
    tab.nodes.length !== 1
  ) return false;
  const node = tab.nodes[0];
  return node.data.kind === "image-input" &&
    node.data.status === "idle" &&
    !node.data.imageUrl;
}

export function projectTabLifecycle(tab: ProjectTab): ProjectLifecycle {
  if (tab.lifecycle === "initial_draft" || tab.lifecycle === "saved" || tab.lifecycle === "local") {
    return tab.lifecycle;
  }
  return tab.hasBeenPersisted || tab.saveState === "saved" ? "saved" : "local";
}

export function projectTabHasLocalDraftChanges(tab: ProjectTab): boolean {
  if (tab.readOnly || projectTabLifecycle(tab) === "saved") return false;
  if (projectTabLifecycle(tab) === "initial_draft") {
    return tab.revision > (tab.draftSyncedRevision ?? 0);
  }
  return !isPristineProjectTab(tab);
}

export function selectActiveProjectIsPristine(state: FlowState): boolean {
  return isPristineProjectTab(selectActiveDocument(state));
}

/** 连接规则的唯一纯函数；React Flow 拖线和快捷建图必须共用它。 */
export function isDocumentConnectionValid(
  document: Pick<ProjectTab, "nodes" | "edges">,
  connection: Connection | Edge,
): boolean {
  if (
    !connection.source ||
    !connection.target ||
    connection.source === connection.target ||
    !document.nodes.some((node) => node.id === connection.source)
  ) return false;
  const target = document.nodes.find((node) => node.id === connection.target);
  if (!target) return false;
  const source = document.nodes.find((node) => node.id === connection.source);
  if (!source) return false;
  if (
    source.data.kind === "drawing-board"
    && (!source.data.contentRef || !source.data.previewImageRef)
  ) return false;
  const spec = NODE_SPECS[target.data.kind];
  const incoming = document.edges.filter((edge) => edge.target === connection.target);
  if (incoming.length >= spec.inputs) return false;
  if (isStagedTryOnData(target.data) && !connection.targetHandle) {
    return compatibleUnusedInputRoles({
      source,
      target,
      sourceHandle: connection.sourceHandle,
      existingEdges: document.edges,
    }).length > 0;
  }
  return connectionCompatibilityError({
    source,
    target,
    sourceHandle: connection.sourceHandle,
    targetHandle: connection.targetHandle,
    existingEdges: document.edges,
  }) === undefined;
}

function incrementSceneBasis(nodes: FlowNode[], targetIds: ReadonlySet<string>): FlowNode[] {
  if (targetIds.size === 0) return nodes;
  return nodes.map((node) => node.data.kind === "virtual-try-on"
    && node.data.workflowStage === "scene-stabilize"
    && targetIds.has(node.id)
    ? {
        ...node,
        data: {
          ...node.data,
          basisRevision: (node.data.basisRevision ?? 0) + 1,
        },
      }
    : node);
}

function sceneBasisTargetsForSource(tab: Pick<ProjectTab, "nodes" | "edges">, sourceId: string): Set<string> {
  const stageIds = new Set(tab.nodes.flatMap((node) => (
    node.data.kind === "virtual-try-on" && node.data.workflowStage === "scene-stabilize" ? [node.id] : []
  )));
  return new Set(tab.edges.flatMap((edge) => edge.source === sourceId && stageIds.has(edge.target) ? [edge.target] : []));
}

function replaceTab(tabs: ProjectTab[], tab: ProjectTab): ProjectTab[] {
  const index = tabs.findIndex((candidate) => candidate.id === tab.id);
  if (index < 0 || tabs[index] === tab) return tabs;
  const next = [...tabs];
  next[index] = tab;
  return next;
}

function documentForTab(state: FlowState, tabId: string): ProjectTab | undefined {
  return state.tabs.find((tab) => tab.id === tabId);
}

function matchesDocumentTarget(tab: ProjectTab, target: DocumentTarget): boolean {
  return tab.id === target.tabId &&
    tab.projectId === target.projectId &&
    tab.documentEpoch === target.documentEpoch;
}

function documentForTarget(state: FlowState, target: DocumentTarget): ProjectTab | undefined {
  const tab = documentForTab(state, target.tabId);
  return tab && matchesDocumentTarget(tab, target) ? tab : undefined;
}

function patchTab(
  set: (partial: Partial<FlowState> | ((state: FlowState) => Partial<FlowState>)) => unknown,
  tabId: string,
  patch: Partial<ProjectTab> | ((tab: ProjectTab) => Partial<ProjectTab>),
): void {
  set((state) => {
    const tab = documentForTab(state, tabId);
    if (!tab) return {};
    const changes = typeof patch === "function" ? patch(tab) : patch;
    if (Object.entries(changes).every(([key, value]) => value === tab[key as keyof ProjectTab])) {
      return {};
    }
    const next = { ...tab, ...changes };
    return { tabs: replaceTab(state.tabs, next) };
  });
}

function patchDocumentTarget(
  set: FlowSet,
  target: DocumentTarget,
  patch: Partial<ProjectTab> | ((tab: ProjectTab) => Partial<ProjectTab>),
): boolean {
  let matched = false;
  patchTab(set, target.tabId, (tab) => {
    if (!matchesDocumentTarget(tab, target)) return {};
    matched = true;
    return typeof patch === "function" ? patch(tab) : patch;
  });
  return matched;
}

function textEditDescriptorKey(descriptor: CoalescedTextEditDescriptor): string {
  return descriptor.kind === "project-name"
    ? "project-name"
    : JSON.stringify(["node-data", descriptor.nodeId, descriptor.field]);
}

function readTextEditValue(
  tab: ProjectTab,
  descriptor: CoalescedTextEditDescriptor,
): { value: string; fieldExisted: boolean } | null {
  if (descriptor.kind === "project-name") {
    return { value: tab.projectName, fieldExisted: true };
  }
  const node = tab.nodes.find((candidate) => candidate.id === descriptor.nodeId);
  if (!node) return null;
  const fieldExisted = Object.prototype.hasOwnProperty.call(node.data, descriptor.field);
  const value = node.data[descriptor.field];
  return { value: typeof value === "string" ? value : "", fieldExisted };
}

function textEditPatch(
  tab: ProjectTab,
  descriptor: CoalescedTextEditDescriptor,
  value: string,
  fieldExisted = true,
): Partial<ProjectTab> {
  if (descriptor.kind === "project-name") return { projectName: value };
  let matched = false;
  const nodes = tab.nodes.map((node) => {
    if (node.id !== descriptor.nodeId) return node;
    matched = true;
    const data = { ...node.data } as WorkflowNodeData & Record<string, unknown>;
    if (fieldExisted) data[descriptor.field] = value;
    else delete data[descriptor.field];
    return { ...node, data };
  });
  return matched ? { nodes } : {};
}

function clearTextEditTimer(edit: ActiveTextEdit): void {
  if (edit.timer !== null) clearTimeout(edit.timer);
  edit.timer = null;
}

function scheduleTextEditCommit(edit: ActiveTextEdit): void {
  clearTextEditTimer(edit);
  if (edit.composing) return;
  edit.timer = setTimeout(() => {
    if (activeTextEdit?.token.id === edit.token.id) flushActiveTextEdit(edit.token);
  }, COALESCED_TEXT_EDIT_IDLE_MS);
}

/**
 * Commit the live value as one durable document mutation. A token makes delayed
 * blur/composition events harmless after a tab or project boundary has moved.
 */
export function flushActiveTextEdit(token?: CoalescedTextEditToken): boolean {
  const edit = activeTextEdit;
  if (!edit || (token && edit.token.id !== token.id)) return false;
  clearTextEditTimer(edit);
  activeTextEdit = null;
  const state = useFlowStore.getState();
  const tab = documentForTarget(state, edit.token.target);
  if (!tab) return false;
  const current = temporalDocument(tab);
  if (sameTemporalDocument(edit.before, current)) return false;

  if (state.activeTabId === edit.token.target.tabId) {
    recordHistoryEntry(edit.before, current);
  } else {
    recordInactiveTabHistory(edit.token.target.tabId, edit.before, current);
  }
  finalizingTextEdit = true;
  try {
    runWithoutHistory(() => {
      patchDocumentTarget(useFlowStore.setState, edit.token.target, (latest) => ({
        revision: latest.revision + 1,
        dirty: true,
        saveState: latest.saveState === "saving" ? "saving" : "idle",
      }));
    });
  } finally {
    finalizingTextEdit = false;
  }
  return true;
}

/**
 * Durable work for an inactive document must not split the foreground editor's
 * burst. Only the document that owns the edit may force its early commit.
 */
function flushActiveTextEditForTarget(target: DocumentTarget): boolean {
  const edit = activeTextEdit;
  if (
    !edit ||
    edit.token.target.tabId !== target.tabId ||
    edit.token.target.projectId !== target.projectId ||
    edit.token.target.documentEpoch !== target.documentEpoch
  ) return false;
  return flushActiveTextEdit(edit.token);
}

/** Restore only the field owned by the active editor, without creating history. */
export function cancelCoalescedTextEdit(token: CoalescedTextEditToken): boolean {
  const edit = activeTextEdit;
  if (!edit || edit.token.id !== token.id) return false;
  clearTextEditTimer(edit);
  activeTextEdit = null;
  runWithoutHistory(() => {
    patchDocumentTarget(useFlowStore.setState, edit.token.target, (tab) => textEditPatch(
      tab,
      edit.descriptor,
      edit.originalValue,
      edit.originalFieldExisted,
    ));
  });
  return true;
}

export function setCoalescedTextEditComposing(
  token: CoalescedTextEditToken,
  composing: boolean,
): boolean {
  const edit = activeTextEdit;
  if (!edit || edit.token.id !== token.id) return false;
  edit.composing = composing;
  if (composing) clearTextEditTimer(edit);
  else scheduleTextEditCommit(edit);
  return true;
}

/** Live-update one text field; history/revision/session persistence wait for the burst boundary. */
export function updateCoalescedTextEdit(
  descriptor: CoalescedTextEditDescriptor,
  value: string,
  token?: CoalescedTextEditToken | null,
  options?: { composing?: boolean },
): CoalescedTextEditToken | null {
  const state = useFlowStore.getState();
  const target = selectActiveDocumentTarget(state);
  const tab = documentForTarget(state, target);
  const descriptorKey = textEditDescriptorKey(descriptor);
  if (!tab || tab.readOnly) return null;
  if (token && (
    token.target.tabId !== target.tabId ||
    token.target.projectId !== target.projectId ||
    token.target.documentEpoch !== target.documentEpoch ||
    token.descriptorKey !== descriptorKey
  )) return null;

  if (activeTextEdit && token?.id !== activeTextEdit.token.id) {
    // A delayed event from an older editor must not terminate or overwrite the
    // currently focused field. A new editor without a token starts a new burst.
    if (token) return null;
    flushActiveTextEdit();
  }
  if (activeHistoryTransaction) commitHistoryTransaction(activeHistoryTransaction);

  let edit = activeTextEdit;
  if (!edit) {
    const initial = readTextEditValue(tab, descriptor);
    if (!initial || initial.value === value) return null;
    const nextToken: CoalescedTextEditToken = {
      id: Symbol(`text-edit:${descriptorKey}`),
      target,
      descriptorKey,
    };
    edit = {
      token: nextToken,
      descriptor,
      before: temporalDocument(tab),
      originalValue: initial.value,
      originalFieldExisted: initial.fieldExisted,
      composing: options?.composing === true,
      timer: null,
    };
    activeTextEdit = edit;
  } else if (token?.id !== edit.token.id) {
    return null;
  }

  edit.composing = options?.composing ?? edit.composing;
  runWithoutHistory(() => {
    patchDocumentTarget(useFlowStore.setState, edit.token.target, (latest) => {
      const current = readTextEditValue(latest, edit.descriptor);
      return current?.value === value ? {} : textEditPatch(latest, edit.descriptor, value);
    });
  });
  scheduleTextEditCommit(edit);
  return edit.token;
}

function newTab(opts?: {
  projectId?: string;
  projectName?: string;
  nodes?: FlowNode[];
  edges?: Edge[];
  markDirty?: boolean;
  readOnly?: boolean;
  /** 已由服务端载入；即使内容为空，也不是首次未保存项目。 */
  persisted?: boolean;
  lifecycle?: ProjectLifecycle;
}): ProjectTab {
  const markDirty = opts?.markDirty ?? false;
  const persisted = opts?.persisted === true && !markDirty;
  const selection = normalizeNodeSelection(opts?.nodes ?? [makeStarterNode()], []);
  return {
    id: nanoid(10),
    projectId: opts?.projectId ?? nanoid(10),
    projectName: opts?.projectName ?? DEFAULT_PROJECT_NAME,
    readOnly: opts?.readOnly ?? false,
    nodes: selection.nodes,
    edges: opts?.edges ?? [],
    selectedNodeIds: [],
    selectedNodeId: selection.selectedNodeId,
    selectedResultId: null,
    compareIds: [],
    saveState: persisted ? "saved" : "idle",
    hasBeenPersisted: persisted,
    revision: markDirty ? 1 : 0,
    savedRevision: 0,
    dirty: markDirty,
    documentEpoch: 0,
    lifecycle: opts?.lifecycle ?? (persisted ? "saved" : "local"),
  };
}

/** 在目标页签内更新节点。 */
function updateTabNodes(
  set: (partial: Partial<FlowState> | ((state: FlowState) => Partial<FlowState>)) => unknown,
  target: DocumentTarget,
  update: (nodes: FlowNode[]) => FlowNode[],
  opts?: { markDirty?: boolean },
): void {
  if (opts?.markDirty === true) flushActiveTextEditForTarget(target);
  const currentState = useFlowStore.getState();
  if (!documentForTarget(currentState, target)) return;
  if (opts?.markDirty === true && currentState.activeTabId === target.tabId) {
    commitDocumentMutationWithSet(set, (tab) => {
      if (!matchesDocumentTarget(tab, target)) return {};
      const nodes = update(tab.nodes);
      return nodes === tab.nodes ? {} : { nodes };
    });
    return;
  }
  const history: {
    before: FlowTemporalState | null;
    current: FlowTemporalState | null;
  } = { before: null, current: null };
  patchDocumentTarget(set, target, (tab) => {
    const nodes = update(tab.nodes);
    if (nodes === tab.nodes) return {};
    const documentChanged = opts?.markDirty === true && !sameDocumentNodes(tab.nodes, nodes);
    if (documentChanged) {
      history.before = { projectName: tab.projectName, nodes: tab.nodes, edges: tab.edges };
      history.current = { projectName: tab.projectName, nodes, edges: tab.edges };
    }
    return {
      nodes,
      revision: documentChanged ? tab.revision + 1 : tab.revision,
      dirty: documentChanged ? true : tab.dirty,
      saveState: documentChanged && tab.saveState !== "saving" ? "idle" : tab.saveState,
    };
  });
  if (history.before && history.current) {
    recordInactiveTabHistory(target.tabId, history.before, history.current);
  }
}

/** 在指定文档上提交一次原子修改；后台页签也保留独立撤销历史。 */
function commitDocumentMutationForTarget(
  set: FlowSet,
  target: DocumentTarget,
  mutation: DocumentMutation,
): boolean {
  flushActiveTextEditForTarget(target);
  const state = useFlowStore.getState();
  if (!documentForTarget(state, target)) return false;
  if (state.activeTabId === target.tabId) {
    return commitDocumentMutationWithSet(set, (tab) => (
      matchesDocumentTarget(tab, target)
        ? (typeof mutation === "function" ? mutation(tab) : mutation)
        : {}
    ));
  }

  const history: { before: FlowTemporalState | null; current: FlowTemporalState | null } = {
    before: null,
    current: null,
  };
  let changed = false;
  patchDocumentTarget(set, target, (tab) => {
    const patch = typeof mutation === "function" ? mutation(tab) : mutation;
    if (!documentMutationChanged(tab, patch)) return patch;
    changed = true;
    const next = { ...tab, ...patch };
    history.before = temporalDocument(tab);
    history.current = temporalDocument(next);
    return {
      ...patch,
      revision: tab.revision + 1,
      dirty: true,
      saveState: tab.saveState === "saving" ? "saving" : "idle",
    };
  });
  if (history.before && history.current) {
    recordInactiveTabHistory(target.tabId, history.before, history.current);
  }
  return changed;
}

/** 最近生成持久化（localStorage）：刷新/重开浏览器不丢 */
const RECENT_STORAGE_KEY = "garment-canvas-recent-results";
const TAB_SESSION_STORAGE_KEY = PROJECT_TABS_STORAGE_KEY;
export const TAB_SESSION_SCHEMA_VERSION = PROJECT_TABS_STORAGE_SCHEMA_VERSION;

export interface PersistedTabSession {
  schemaVersion: typeof TAB_SESSION_SCHEMA_VERSION;
  tabs: ProjectTab[];
  activeTabId: string;
}

export interface TabSessionWriteResult {
  ok: boolean;
  error?: string;
  failedTabIds?: string[];
}

const TAB_SESSION_WRITE_ERROR = "本地草稿未写入浏览器，请先保存项目或重新保存大蒙版；刷新会丢失本页修改";
const TAB_SESSION_READ_ERROR = "浏览器暂时无法读取完整草稿；为避免覆盖恢复点，本页不再写入会话缓存，请刷新后重试";

const NODE_KINDS = new Set<NodeKind>(Object.keys(NODE_SPECS) as NodeKind[]);
const NODE_STATUSES = new Set<NodeRunStatus>([
  "idle", "queued", "running", "retry_wait", "cancel_requested",
  "success", "error", "outcome_unknown", "cancelled",
]);

function finiteNonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function stringList(value: unknown, max = 100): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, max)
    : [];
}

/**
 * 会话缓存属于浏览器易失数据：逐节点容错迁移，坏节点/悬空边单独丢弃，
 * 不让一个历史字段缺失导致所有项目页签都无法恢复。
 */
function normalizeSessionNode(value: unknown): FlowNode | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    !raw.id ||
    typeof raw.type !== "string" ||
    !NODE_KINDS.has(raw.type as NodeKind) ||
    !raw.position ||
    typeof raw.position !== "object" ||
    !raw.data ||
    typeof raw.data !== "object"
  ) return undefined;
  const position = raw.position as Record<string, unknown>;
  if (
    typeof position.x !== "number" || !Number.isFinite(position.x) ||
    typeof position.y !== "number" || !Number.isFinite(position.y)
  ) return undefined;

  const kind = raw.type as NodeKind;
  const input = raw.data as Record<string, unknown>;
  const defaults = defaultNodeData(kind) as unknown as Record<string, unknown>;
  const status = typeof input.status === "string" && NODE_STATUSES.has(input.status as NodeRunStatus)
    ? input.status as NodeRunStatus
    : "idle";
  const data: Record<string, unknown> = {
    ...defaults,
    ...input,
    kind,
    label: typeof input.label === "string" && input.label.trim() ? input.label : defaults.label,
    status,
  };
  for (const transientKey of [
    "selectionRange", "editorSelection", "drawingRecoveryDraft", "recentColors",
    "confirmPopoverOpen", "approvalDialogOpen", "displayState",
  ]) delete data[transientKey];
  if (typeof input.error !== "string") delete data.error;
  if (NODE_SPECS[kind].providerId && kind !== "video-generate") {
    const modelId = isImageModelId(input.modelId) && isModelAllowedForNode(input.modelId, kind)
      ? input.modelId
      : kind === "mask-redraw" || kind === "virtual-try-on"
        ? MASK_REDRAW_MODEL_ID
        : DEFAULT_GENERATION_MODEL_ID;
    const preferredAspectRatio = typeof input.aspectRatio === "string" ? input.aspectRatio : "1:1";
    data.modelId = modelId;
    data.modelOptions = normalizeImageModelOptions(modelId, input.modelOptions, preferredAspectRatio);
  }

  switch (kind) {
    case "image-input":
      data.imageRole = typeof input.imageRole === "string" && ["default", "sketch", "garment", "fabric", "reference"].includes(input.imageRole)
        ? input.imageRole
        : "default";
      if (typeof input.imageUrl !== "string") delete data.imageUrl;
      break;
    case "text-input":
      data.text = typeof input.text === "string" ? input.text : "";
      break;
    case "drawing-board":
      data.boardVersion = 1;
      data.width = Number.isSafeInteger(input.width) && Number(input.width) >= 256 && Number(input.width) <= 4096
        ? input.width : 1024;
      data.height = Number.isSafeInteger(input.height) && Number(input.height) >= 256 && Number(input.height) <= 4096
        ? input.height : 1024;
      data.background = typeof input.background === "string" && input.background ? input.background : "#FFFFFF";
      if (typeof input.contentRef !== "string") delete data.contentRef;
      if (typeof input.previewImageRef !== "string") delete data.previewImageRef;
      if (typeof input.exportImageRef !== "string") delete data.exportImageRef;
      break;
    case "color-palette": {
      data.paletteVersion = 1;
      const seen = new Set<string>();
      data.swatches = Array.isArray(input.swatches)
        ? input.swatches.flatMap((value) => {
            if (!value || typeof value !== "object") return [];
            const swatch = value as Record<string, unknown>;
            if (typeof swatch.id !== "string" || typeof swatch.value !== "string") return [];
            const color = swatch.value.toUpperCase();
            if (!/^#[0-9A-F]{6}$/.test(color) || seen.has(color)) return [];
            const source = ["quick", "custom", "recent", "favorite", "eyedropper"].includes(String(swatch.source))
              ? swatch.source : "custom";
            seen.add(color);
            return [{ id: swatch.id, value: color, source, ...(typeof swatch.name === "string" ? { name: swatch.name } : {}) }];
          }).slice(0, 32)
        : defaults.swatches;
      if ((data.swatches as unknown[]).length === 0) data.swatches = defaults.swatches;
      break;
    }
    case "stage-approval":
      data.approvalKind = "scene-baseline";
      if (typeof input.approvedSourceNodeId !== "string") delete data.approvedSourceNodeId;
      if (typeof input.approvedBaselineRef !== "string") delete data.approvedBaselineRef;
      if (!Number.isSafeInteger(input.approvedBasisRevision) || Number(input.approvedBasisRevision) < 0) delete data.approvedBasisRevision;
      if (typeof input.approvedAt !== "string") delete data.approvedAt;
      break;
    case "video-input":
      if (typeof input.videoUrl !== "string") delete data.videoUrl;
      if (input.mimeType === "video/mp4" || input.mimeType === "video/webm" || input.mimeType === "video/quicktime") {
        data.mimeType = input.mimeType;
      } else {
        delete data.mimeType;
      }
      break;
    case "audio-input":
      if (typeof input.audioUrl !== "string") delete data.audioUrl;
      if (["audio/mpeg", "audio/wav", "audio/mp4", "audio/ogg"].includes(String(input.mimeType))) {
        data.mimeType = input.mimeType;
      } else {
        delete data.mimeType;
      }
      break;
    case "video-generate": {
      const mode = input.mode === "multi-image-video"
        ? "multimodal-reference"
        : input.mode === "video-to-video"
          ? "video-edit"
          : SEEDANCE_VIDEO_MODES.includes(input.mode as never)
            ? input.mode as (typeof SEEDANCE_VIDEO_MODES)[number]
            : "text-to-video";
      const model = isSeedanceVideoModel(input.videoModel)
        ? input.videoModel
        : "doubao-seedance-2-5-260628";
      const normalized = normalizedSeedanceSettings({
        model,
        mode,
        resolution: input.resolution === "480p" ? "480p"
          : input.resolution === "1080p" || input.resolution === "4k" ? "1080p" : "720p",
        ratio: typeof input.aspectRatio === "string" ? input.aspectRatio : "16:9",
        duration: Number.isSafeInteger(input.seconds) ? Number(input.seconds) : 5,
        outputFormat: input.outputFormat === "mov" ? "mov" : "mp4",
      });
      data.mode = normalized.mode;
      data.prompt = typeof input.prompt === "string" ? input.prompt : "";
      data.videoModel = normalized.model;
      data.aspectRatio = normalized.ratio;
      data.resolution = normalized.resolution;
      data.seconds = normalized.duration;
      data.generateAudio = typeof input.generateAudio === "boolean" ? input.generateAudio : true;
      data.outputFormat = normalized.outputFormat;
      delete data.quality;
      data.outputImages = stringList(input.outputImages);
      break;
    }
    case "sketch-to-render":
    case "ai-modify":
      data.prompt = typeof input.prompt === "string" ? input.prompt : "";
      data.aspectRatio = typeof input.aspectRatio === "string" && ["1:1", "3:4", "4:3", "9:16", "16:9"].includes(input.aspectRatio)
        ? input.aspectRatio
        : kind === "sketch-to-render" ? "3:4" : "1:1";
      data.batchSize = [1, 2, 4, 8].includes(Number(input.batchSize)) ? Number(input.batchSize) : 1;
      data.outputImages = stringList(input.outputImages);
      break;
    case "fabric-recolor":
      data.operationMode = input.operationMode === "fabric" || input.operationMode === "color"
        ? input.operationMode : "combined";
      data.colors = stringList(input.colors, 8).filter((color) => /^#[0-9a-fA-F]{6}$/.test(color));
      data.prompt = typeof input.prompt === "string" ? input.prompt : "";
      data.outputImages = stringList(input.outputImages);
      if (typeof input.fabricImageUrl !== "string") delete data.fabricImageUrl;
      break;
    case "upscale":
      data.imageSize = input.imageSize === "4K" ? "4K" : "2K";
      data.outputImages = stringList(input.outputImages);
      break;
    case "print-extract":
      data.prompt = typeof input.prompt === "string" ? input.prompt : "";
      data.outputImages = stringList(input.outputImages);
      data.savedAsAssets = stringList(input.savedAsAssets);
      break;
    case "print-mutate":
      data.prompt = typeof input.prompt === "string" ? input.prompt : "";
      data.count = Number.isInteger(input.count) && Number(input.count) >= 1 && Number(input.count) <= 8
        ? input.count
        : 4;
      data.outputImages = stringList(input.outputImages);
      break;
    case "virtual-try-on":
      data.workflowStage = input.workflowStage === "scene-stabilize" || input.workflowStage === "garment-refine"
        ? input.workflowStage
        : "standard";
      data.prompt = typeof input.prompt === "string" ? input.prompt : "";
      data.imageSize = input.imageSize === "4K" ? "4K" : "2K";
      data.aspectRatio = typeof input.aspectRatio === "string" && ["1:1", "4:5", "3:4", "2:3", "9:16", "16:9"].includes(input.aspectRatio)
        ? input.aspectRatio : "3:4";
      data.outputImages = stringList(input.outputImages);
      data.basisRevision = Number.isSafeInteger(input.basisRevision) && Number(input.basisRevision) >= 0
        ? input.basisRevision : 0;
      if (input.garmentCategory === "knit" || input.garmentCategory === "woven" || input.garmentCategory === "other") {
        data.garmentCategory = input.garmentCategory;
      } else {
        delete data.garmentCategory;
      }
      if (typeof input.materialSpec === "string") data.materialSpec = input.materialSpec;
      else delete data.materialSpec;
      if (typeof input.constructionSpec === "string") data.constructionSpec = input.constructionSpec;
      else delete data.constructionSpec;
      data.promptEnhancement = typeof input.promptEnhancement === "boolean" ? input.promptEnhancement : false;
      data.qualityMode = input.qualityMode === "balanced" || input.qualityMode === "best"
        ? input.qualityMode
        : "fast";
      data.safetyFallback = typeof input.safetyFallback === "boolean" ? input.safetyFallback : false;
      data.stylePresetId = typeof input.stylePresetId === "string" && input.stylePresetId.trim()
        ? input.stylePresetId.trim()
        : "faithful";
      if (typeof input.stylePresetName === "string") data.stylePresetName = input.stylePresetName;
      else delete data.stylePresetName;
      if (typeof input.stylePrompt === "string") data.stylePrompt = input.stylePrompt;
      else delete data.stylePrompt;
      if (typeof input.styleReferenceImage === "string") data.styleReferenceImage = input.styleReferenceImage;
      else delete data.styleReferenceImage;
      if (data.workflowStage === "scene-stabilize") data.modelId = "gemini-3.1-flash-image-preview";
      if (data.workflowStage === "garment-refine") data.modelId = MASK_REDRAW_MODEL_ID;
      if (data.modelId === "gemini-3.1-flash-image-preview") {
        data.modelOptions = normalizeImageModelOptions(data.modelId, {
          ...(typeof data.modelOptions === "object" && data.modelOptions ? data.modelOptions : {}),
          imageSize: data.imageSize,
        });
      } else {
        data.modelId = MASK_REDRAW_MODEL_ID;
        data.modelOptions = data.workflowStage === "garment-refine" ? { quality: "medium" } : {};
      }
      break;
    case "mask-redraw":
      data.modelId = MASK_REDRAW_MODEL_ID;
      data.modelOptions = {};
      data.repairFocus = input.repairFocus === "upper-garment" || input.repairFocus === "pants"
        || input.repairFocus === "accessories" || input.repairFocus === "logo-text"
        ? input.repairFocus : "custom";
      data.executionMode = input.executionMode === "bypass" ? "bypass" : "repair";
      data.prompt = typeof input.prompt === "string" ? input.prompt : "";
      data.outputImages = stringList(input.outputImages);
      if (typeof input.mask !== "string") delete data.mask;
      if (typeof input.maskSourceRef !== "string") delete data.maskSourceRef;
      break;
    case "result":
      data.images = stringList(input.images);
      if (typeof input.note !== "string") delete data.note;
      break;
  }

  const { dragging: _dragging, ...sessionNode } = raw;
  return {
    ...sessionNode,
    id: raw.id,
    type: kind,
    position: { x: position.x, y: position.y },
    data: data as unknown as WorkflowNodeData,
  } as FlowNode;
}

function normalizeSessionEdge(value: unknown, nodeIds: Set<string>): Edge | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" || !raw.id ||
    typeof raw.source !== "string" || !nodeIds.has(raw.source) ||
    typeof raw.target !== "string" || !nodeIds.has(raw.target)
  ) return undefined;
  const id = SAFE_DOCUMENT_EDGE_ID.test(raw.id)
    ? raw.id
    : raw.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return { ...raw, id, source: raw.source, target: raw.target } as Edge;
}

function recoverSessionStagedTryOnNodes(nodes: readonly FlowNode[], edges: readonly Edge[]): FlowNode[] {
  const incomingRoles = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!edge.targetHandle) continue;
    const roles = incomingRoles.get(edge.target) ?? new Set<string>();
    roles.add(edge.targetHandle);
    incomingRoles.set(edge.target, roles);
  }
  return nodes.map((node) => {
    if (node.data.kind !== "virtual-try-on" || node.data.workflowStage !== "standard") return node;
    const roles = incomingRoles.get(node.id);
    if (!roles) return node;
    if (
      node.data.modelId === "gemini-3.1-flash-image-preview"
      && roles.has("person") && roles.has("scene") && roles.has("outfit")
    ) {
      return { ...node, data: { ...node.data, workflowStage: "scene-stabilize" as const } };
    }
    if (node.data.modelId === MASK_REDRAW_MODEL_ID && roles.has("baseline") && roles.has("outfit")) {
      return {
        ...node,
        data: {
          ...node.data,
          workflowStage: "garment-refine" as const,
          modelOptions: { quality: "medium" as const },
        },
      };
    }
    return node;
  });
}

function migrateSessionLegacyDualModelAccessorySlot(
  nodes: readonly FlowNode[],
  edges: readonly Edge[],
): { nodes: FlowNode[]; edges: Edge[] } {
  const structure = nodes.find((node) => node.id === "structure" && node.data.kind === "image-input");
  if (
    !structure
    || structure.data.kind !== "image-input"
    || !nodes.some((node) => node.id === "accessory")
    || !nodes.some((node) => node.id === "person")
    || !nodes.some((node) => node.id === "scene")
    || !nodes.some((node) => node.id === "outfit")
    || !nodes.some((node) => node.id === "stabilize")
    || !nodes.some((node) => node.id === "refine")
  ) return { nodes: [...nodes], edges: [...edges] };

  const nextNodes = nodes.map((node): FlowNode => {
    if (node.id === "accessory" && node.data.kind === "image-input") {
      return {
        ...node,
        data: {
          ...node.data,
          label: "鞋履参考图（可选）",
          imageRole: "reference",
        },
      };
    }
    if (node.id === structure.id) {
      return {
        ...node,
        data: {
          ...structure.data,
          label: "包袋参考图（可选）",
          imageRole: "reference",
        },
      };
    }
    return node;
  });
  const accessoryNodes = [
    { id: "hat", label: "帽子参考图（可选）", y: 780 },
    { id: "ring", label: "戒指参考图（可选）", y: 1040 },
    { id: "earrings", label: "耳环参考图（可选）", y: 1300 },
    { id: "bracelet", label: "手镯参考图（可选）", y: 1560 },
  ] as const;
  for (const accessoryNode of accessoryNodes) {
    if (nextNodes.some((node) => node.id === accessoryNode.id)) continue;
    nextNodes.push({
      id: accessoryNode.id,
      type: "image-input",
      position: { x: 0, y: accessoryNode.y },
      data: {
        kind: "image-input",
        label: accessoryNode.label,
        status: "idle",
        imageRole: "reference",
      },
    });
  }
  if (!nextNodes.some((node) => node.id === "garment-detail")) {
    nextNodes.push({
      id: "garment-detail",
      type: "image-input",
      position: { x: 720, y: 260 },
      data: {
        kind: "image-input",
        label: "服装局部结构参考（可选）",
        status: "idle",
        imageRole: "garment",
      },
    });
  }

  const accessoryRoles = new Map<string, string>([
    ["accessory", "shoes"], ["structure", "bag"], ["hat", "hat"],
    ["ring", "ring"], ["earrings", "earrings"], ["bracelet", "bracelet"],
  ]);
  const seenAccessorySources = new Set<string>();
  const nextEdges = edges.flatMap((edge): Edge[] => {
    if (edge.source === "structure" && edge.target === "refine") return [];
    if (edge.source === "garment-detail" && edge.target === "stabilize") return [];
    if (edge.target === "stabilize" && accessoryRoles.has(edge.source)) {
      if (seenAccessorySources.has(edge.source)) return [];
      seenAccessorySources.add(edge.source);
      return [{ ...edge, targetHandle: accessoryRoles.get(edge.source) }];
    }
    return [edge];
  });
  for (const [source, targetHandle] of accessoryRoles) {
    if (seenAccessorySources.has(source)) continue;
    nextEdges.push({
      id: `${source}-stabilize`, source, target: "stabilize", targetHandle,
    });
  }
  if (!nextEdges.some((edge) => edge.id === "garment-detail-refine")) {
    nextEdges.push({
      id: "garment-detail-refine", source: "garment-detail", target: "refine", targetHandle: "detail",
    });
  }
  return { nodes: nextNodes, edges: nextEdges };
}

function discardUntypedStagedDuplicateEdges(nodes: readonly FlowNode[], edges: readonly Edge[]): Edge[] {
  const stagedNodeIds = new Set(nodes.flatMap((node) => (
    node.data.kind === "virtual-try-on" && node.data.workflowStage !== "standard" ? [node.id] : []
  )));
  const typedPairs = new Set(edges.flatMap((edge) => (
    stagedNodeIds.has(edge.target) && edge.targetHandle
      ? [`${edge.source}\u0000${edge.target}`]
      : []
  )));
  return edges.filter((edge) => !(
    stagedNodeIds.has(edge.target)
    && !edge.targetHandle
    && typedPairs.has(`${edge.source}\u0000${edge.target}`)
  ));
}

function migrateSessionLegacyVideoEdges(nodes: readonly FlowNode[], edges: readonly Edge[]): Edge[] {
  const multimodalIds = new Set(nodes.flatMap((node) => (
    node.data.kind === "video-generate" && node.data.mode === "multimodal-reference"
      ? [node.id]
      : []
  )));
  return edges.map((edge) => (
    multimodalIds.has(edge.target) && (edge.targetHandle === "first-frame" || edge.targetHandle === "last-frame")
      ? { ...edge, targetHandle: "reference-image" }
      : edge
  ));
}

function migrateSessionLegacyMaskEdges(nodes: readonly FlowNode[], edges: readonly Edge[]): Edge[] {
  const maskNodeIds = new Set(nodes.flatMap((node) => (
    node.data.kind === "mask-redraw" ? [node.id] : []
  )));
  const explicitSources = new Set(edges.flatMap((edge) => (
    maskNodeIds.has(edge.target) && edge.targetHandle === "repair-source" ? [edge.target] : []
  )));
  return edges.map((edge) => {
    if (
      !maskNodeIds.has(edge.target)
      || explicitSources.has(edge.target)
      || (edge.targetHandle !== undefined && edge.targetHandle !== null && edge.targetHandle !== "references")
    ) return edge;
    explicitSources.add(edge.target);
    return { ...edge, targetHandle: "repair-source" };
  });
}

function normalizeSessionTab(
  value: unknown,
  options: { migrateLegacyMaskEdges?: boolean } = {},
): ProjectTab | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<ProjectTab>;
  if (
    typeof raw.id !== "string" || !raw.id ||
    typeof raw.projectId !== "string" || !raw.projectId ||
    typeof raw.projectName !== "string" ||
    !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)
  ) return undefined;

  const seenNodeIds = new Set<string>();
  const nodes = raw.nodes.flatMap((node): FlowNode[] => {
    const normalized = normalizeSessionNode(node);
    if (!normalized || seenNodeIds.has(normalized.id)) return [];
    seenNodeIds.add(normalized.id);
    return [normalized];
  });
  // 一个原本非空的页签若没有任何节点能迁移，说明其结构整体不可恢复。
  if (raw.nodes.length > 0 && nodes.length === 0) return undefined;
  const seenEdgeIds = new Set<string>();
  const normalizedEdges = raw.edges.flatMap((edge): Edge[] => {
    const normalized = normalizeSessionEdge(edge, seenNodeIds);
    if (!normalized || seenEdgeIds.has(normalized.id)) return [];
    seenEdgeIds.add(normalized.id);
    return [normalized];
  });
  const videoEdges = migrateSessionLegacyVideoEdges(nodes, normalizedEdges);
  const upgraded = migrateSessionLegacyDualModelAccessorySlot(
    nodes,
    options.migrateLegacyMaskEdges ? migrateSessionLegacyMaskEdges(nodes, videoEdges) : videoEdges,
  );
  const recoveredNodes = recoverSessionStagedTryOnNodes(upgraded.nodes, upgraded.edges);
  const edges = discardUntypedStagedDuplicateEdges(recoveredNodes, upgraded.edges);
  const revision = finiteNonNegative(raw.revision, 0);
  const wasSaving = raw.saveState === "saving";
  const dirty = wasSaving || raw.dirty === true;
  const savedRevision = Math.min(finiteNonNegative(raw.savedRevision, 0), revision);
  const hasBeenPersisted = raw.hasBeenPersisted === true ||
    raw.saveState === "saved" ||
    savedRevision > 0;
  const lifecycle: ProjectLifecycle = raw.lifecycle === "initial_draft" ||
    raw.lifecycle === "saved" || raw.lifecycle === "local"
    ? raw.lifecycle
    : hasBeenPersisted ? "saved" : "local";
  const draftRevision = lifecycle === "initial_draft"
    ? finiteNonNegative(raw.draftRevision, 0)
    : undefined;
  const draftSyncedRevision = lifecycle === "initial_draft"
    ? Math.min(finiteNonNegative(raw.draftSyncedRevision, 0), revision)
    : undefined;
  const requestedSelection = Array.isArray(raw.selectedNodeIds)
    ? stringList(raw.selectedNodeIds, recoveredNodes.length)
    : typeof raw.selectedNodeId === "string"
      ? [raw.selectedNodeId]
      : [];
  const selection = normalizeNodeSelection(recoveredNodes, requestedSelection);

  return {
    id: raw.id,
    projectId: raw.projectId,
    projectName: raw.projectName,
    readOnly: raw.readOnly === true,
    nodes: selection.nodes,
    edges,
    selectedNodeIds: selection.selectedNodeIds,
    selectedNodeId: selection.selectedNodeId,
    // Recent results are deliberately reloaded from the authenticated server and
    // never restored from the browser session. Clear their view references here
    // so a failed/slow history request cannot leave a phantom detail or compare UI.
    selectedResultId: null,
    compareIds: [],
    // 刷新会中断 in-flight 请求；必须恢复成可再次保存，同时保守地视为未保存。
    saveState: raw.saveState === "saved" || raw.saveState === "error" ? raw.saveState : "idle",
    hasBeenPersisted,
    revision,
    savedRevision,
    dirty,
    documentEpoch: finiteNonNegative(raw.documentEpoch, 0),
    lifecycle,
    ...(draftRevision === undefined ? {} : { draftRevision }),
    ...(draftSyncedRevision === undefined ? {} : { draftSyncedRevision }),
    ...(lifecycle === "initial_draft" && typeof raw.draftCreatedAt === "string"
      ? { draftCreatedAt: raw.draftCreatedAt }
      : {}),
  };
}

export function normalizeTabSessionValue(value: unknown): PersistedTabSession | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { schemaVersion?: unknown; tabs?: unknown; activeTabId?: unknown };
  if (
    raw.schemaVersion !== undefined &&
    raw.schemaVersion !== 0 &&
    raw.schemaVersion !== 1 &&
    raw.schemaVersion !== TAB_SESSION_SCHEMA_VERSION
  ) return undefined;
  if (!Array.isArray(raw.tabs) || typeof raw.activeTabId !== "string") return undefined;
  const migrateLegacyMaskEdges = raw.schemaVersion !== TAB_SESSION_SCHEMA_VERSION;
  const tabs = raw.tabs.flatMap((tab): ProjectTab[] => {
    const normalized = normalizeSessionTab(tab, { migrateLegacyMaskEdges });
    return normalized ? [normalized] : [];
  });
  if (tabs.length === 0) return undefined;
  const activeTabId = tabs.some((tab) => tab.id === raw.activeTabId) ? raw.activeTabId : tabs[0].id;
  return { schemaVersion: TAB_SESSION_SCHEMA_VERSION, tabs, activeTabId };
}

export function readTabSessionSnapshot(
  storage: Pick<Storage, "getItem">,
): PersistedTabSession | undefined {
  return readTabSessionSnapshotResult(storage).snapshot;
}

export interface TabSessionReadResult {
  snapshot?: PersistedTabSession;
  manifest?: ProjectTabsStorageManifest;
  /**
   * Storage access threw while loading the root or a referenced shard. This is
   * deliberately different from a confirmed missing/corrupt shard: callers
   * must not repair the manifest or clean fragments from an incomplete view.
   */
  unreadable: boolean;
}

export function readTabSessionSnapshotResult(
  storage: Pick<Storage, "getItem">,
): TabSessionReadResult {
  let raw: string | null;
  try {
    raw = storage.getItem(TAB_SESSION_STORAGE_KEY);
  } catch {
    return { unreadable: true };
  }
  if (!raw) return { unreadable: false };

  const manifest = parseProjectTabsStorageManifest(raw);
  if (manifest) {
    const tabs: ProjectTab[] = [];
    let unreadable = false;
    for (const tabId of manifest.tabIds) {
      let tabRaw: string | null;
      try {
        tabRaw = storage.getItem(projectTabStorageKey(tabId));
      } catch {
        unreadable = true;
        continue;
      }
      if (!tabRaw) continue;
      try {
        const tab = normalizeSessionTab(JSON.parse(tabRaw));
        if (tab?.id === tabId) tabs.push(tab);
      } catch {
        // Confirmed malformed JSON is an isolated corrupt shard, not an
        // indeterminate Storage read.
      }
    }
    if (tabs.length === 0) return { manifest, unreadable };
    const activeTabId = tabs.some((tab) => tab.id === manifest.activeTabId)
      ? manifest.activeTabId
      : tabs[0].id;
    return {
      manifest,
      unreadable,
      snapshot: { schemaVersion: TAB_SESSION_SCHEMA_VERSION, tabs, activeTabId },
    };
  }

  try {
    return { unreadable: false, snapshot: normalizeTabSessionValue(JSON.parse(raw)) };
  } catch {
    return { unreadable: false };
  }
}

let initialTabSessionReadResult: TabSessionReadResult | undefined;

function loadTabSession(): { tabs: ProjectTab[]; activeTabId: string } | undefined {
  initialTabSessionReadResult = readTabSessionSnapshotResult(window.sessionStorage);
  markProjectTabSessionWorkspaceRestored(initialTabSessionReadResult.snapshot !== undefined);
  return initialTabSessionReadResult.snapshot;
}

interface TabSessionWriteOptions {
  writeTabIds?: ReadonlySet<string>;
  knownPersistedTabIds?: ReadonlySet<string>;
  unresolvedTabIds?: ReadonlySet<string>;
}

interface DetailedTabSessionWriteResult extends TabSessionWriteResult {
  persistedTabIds: string[];
  manifestWritten: boolean;
  /** Referenced shards whose Storage read threw. They remain known-good until
   * a later read proves absence or a write definitively fails. */
  indeterminateTabIds?: string[];
}

function sessionTabSnapshot(tab: ProjectTab): ProjectTab {
  const document = createDocumentSnapshot(tab);
  const flow = documentSnapshotToPersistedWorkflow(document);
  return {
    ...tab,
    projectName: document.projectName,
    nodes: flow.nodes as FlowNode[],
    edges: flow.edges as Edge[],
    selectedNodeIds: [],
    selectedNodeId: null,
    selectedResultId: null,
    compareIds: [],
  };
}

export function writeTabSessionSnapshot(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> &
    Partial<Pick<Storage, "key" | "length">>,
  value: PersistedTabSession,
  options?: TabSessionWriteOptions,
): DetailedTabSessionWriteResult {
  let previousRaw: string | null = null;
  let previousReadFailed = false;
  try { previousRaw = storage.getItem(TAB_SESSION_STORAGE_KEY); } catch { previousReadFailed = true; }
  const previousManifest = parseProjectTabsStorageManifest(previousRaw);
  let migratingLegacy = false;
  if (previousRaw && !previousManifest) {
    try { migratingLegacy = Boolean(normalizeTabSessionValue(JSON.parse(previousRaw))); } catch { /* invalid */ }
  }
  const writeTabIds = options?.writeTabIds;
  const knownPersistedTabIds = options?.knownPersistedTabIds ?? new Set<string>();
  const unresolvedTabIds = options?.unresolvedTabIds ?? new Set<string>();
  const persistedTabIds: string[] = [];
  const failedTabIds: string[] = [];
  const indeterminateTabIds: string[] = [];
  let indeterminateRead = false;
  const recordFailure = (tabId: string) => {
    if (!failedTabIds.includes(tabId)) failedTabIds.push(tabId);
  };

  for (const tab of value.tabs) {
    const key = projectTabStorageKey(tab.id);
    const shouldWrite = !writeTabIds || writeTabIds.has(tab.id);
    if (!shouldWrite) {
      if (unresolvedTabIds.has(tab.id)) {
        recordFailure(tab.id);
        continue;
      }
      if (knownPersistedTabIds.has(tab.id)) {
        try {
          if (storage.getItem(key) !== null) persistedTabIds.push(tab.id);
          else recordFailure(tab.id);
        } catch {
          recordFailure(tab.id);
          indeterminateTabIds.push(tab.id);
          indeterminateRead = true;
        }
      }
      continue;
    }
    try {
      storage.setItem(key, JSON.stringify(sessionTabSnapshot(tab)));
      persistedTabIds.push(tab.id);
    } catch {
      recordFailure(tab.id);
      // Never restore the stale version of the one tab whose latest write failed.
      try { storage.removeItem(key); } catch { /* best effort */ }
    }
  }

  // A legacy monolith remains the only complete recovery point until every tab
  // key succeeds. Never replace it with a partial v2 manifest.
  if (
    previousReadFailed ||
    indeterminateRead ||
    (migratingLegacy && (
      failedTabIds.length > 0 || persistedTabIds.length !== value.tabs.length
    ))
  ) {
    return {
      ok: false,
      error: TAB_SESSION_WRITE_ERROR,
      failedTabIds,
      ...(indeterminateTabIds.length > 0 ? { indeterminateTabIds } : {}),
      persistedTabIds,
      manifestWritten: false,
    };
  }

  if (persistedTabIds.length === 0) {
    if (!migratingLegacy) {
      try { storage.removeItem(TAB_SESSION_STORAGE_KEY); } catch { /* best effort */ }
    }
    return {
      ok: false,
      error: TAB_SESSION_WRITE_ERROR,
      failedTabIds,
      persistedTabIds,
      manifestWritten: false,
    };
  }

  const activeTabId = persistedTabIds.includes(value.activeTabId)
    ? value.activeTabId
    : persistedTabIds[0];
  try {
    storage.setItem(TAB_SESSION_STORAGE_KEY, JSON.stringify({
      schemaVersion: TAB_SESSION_SCHEMA_VERSION,
      activeTabId,
      tabIds: persistedTabIds,
    }));
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error && error.name !== "QuotaExceededError"
        ? `${TAB_SESSION_WRITE_ERROR}（${error.message}）`
        : TAB_SESSION_WRITE_ERROR,
      failedTabIds,
      persistedTabIds,
      manifestWritten: false,
    };
  }

  clearUnreferencedProjectTabSessionStorage(storage, new Set(persistedTabIds));
  return {
    ok: failedTabIds.length === 0,
    ...(failedTabIds.length > 0 ? { error: TAB_SESSION_WRITE_ERROR, failedTabIds } : {}),
    persistedTabIds,
    manifestWritten: true,
  };
}

function persistTabSession(
  state: FlowState,
  options?: TabSessionWriteOptions,
): DetailedTabSessionWriteResult {
  return writeTabSessionSnapshot(window.sessionStorage, {
    schemaVersion: TAB_SESSION_SCHEMA_VERSION,
    tabs: state.tabs,
    activeTabId: state.activeTabId,
  }, options);
}

/** 错误边界恢复：只丢弃当前损坏页签，其他页签与服务端项目都不受影响。 */
export function discardActiveTabSession(): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.sessionStorage.getItem(TAB_SESSION_STORAGE_KEY);
    if (!raw) return;
    const manifest = parseProjectTabsStorageManifest(raw);
    if (manifest) {
      const activeIndex = manifest.tabIds.indexOf(manifest.activeTabId);
      try {
        window.sessionStorage.removeItem(projectTabStorageKey(manifest.activeTabId));
      } catch { /* best effort */ }
      const tabIds = manifest.tabIds.filter((tabId) => tabId !== manifest.activeTabId);
      if (tabIds.length === 0) {
        window.sessionStorage.removeItem(TAB_SESSION_STORAGE_KEY);
        return;
      }
      const fallbackIndex = Math.max(0, Math.min(activeIndex, tabIds.length - 1));
      try {
        window.sessionStorage.setItem(TAB_SESSION_STORAGE_KEY, JSON.stringify({
          schemaVersion: TAB_SESSION_SCHEMA_VERSION,
          activeTabId: tabIds[fallbackIndex],
          tabIds,
        }));
      } catch {
        // The old manifest now references a missing active key; load filters it
        // and still recovers every remaining independently stored tab.
      }
      return;
    }
    const parsed = JSON.parse(raw) as { tabs?: unknown; activeTabId?: unknown };
    if (!Array.isArray(parsed.tabs) || typeof parsed.activeTabId !== "string") {
      window.sessionStorage.removeItem(TAB_SESSION_STORAGE_KEY);
      return;
    }
    const activeIndex = parsed.tabs.findIndex(
      (value) => Boolean(value && typeof value === "object" && (value as { id?: unknown }).id === parsed.activeTabId),
    );
    const remaining = parsed.tabs.filter(
      (value) => !(value && typeof value === "object" && (value as { id?: unknown }).id === parsed.activeTabId),
    );
    if (remaining.length === 0) {
      window.sessionStorage.removeItem(TAB_SESSION_STORAGE_KEY);
      return;
    }
    const fallbackIndex = Math.max(0, Math.min(activeIndex, remaining.length - 1));
    const fallback = remaining[fallbackIndex] as { id?: unknown };
    if (typeof fallback.id !== "string") {
      window.sessionStorage.removeItem(TAB_SESSION_STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(
      TAB_SESSION_STORAGE_KEY,
      JSON.stringify({ tabs: remaining, activeTabId: fallback.id }),
    );
  } catch {
    try { window.sessionStorage.removeItem(TAB_SESSION_STORAGE_KEY); } catch { /* best effort */ }
  }
}

function loadRecentResults(): RecentResult[] {
  try {
    const raw = window.localStorage.getItem(RECENT_STORAGE_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(arr)) return [];
    const now = Date.now();
    return (arr as RecentResult[]).map((record) => {
      if (isNodeRunActive(record.status) && !record.runId) {
        return {
          ...record,
          status: "error" as const,
          finishedAt: now,
          error: "页面刷新发生在任务提交完成前，无法自动恢复此次生成",
        };
      }
      return record;
    });
  } catch {
    return [];
  }
}

function persistRecentResults(list: RecentResult[]): void {
  try {
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // 存储不可用时静默降级
  }
}

interface RunFailure {
  prompt?: string;
  error: string;
}

interface RunEventMeta {
  seq?: number;
  error?: string;
  model?: string;
  prompts?: string[];
  providerOutputSizes?: Array<string | null>;
  failures?: RunFailure[];
  executionMeta?: Record<string, unknown>;
  startedAt?: number;
  finishedAt?: number;
}

export type NodeStatusRunEvent =
  | (RunEventMeta & {
      type: "node-status";
      nodeId: string;
      status: "queued" | "running" | "retry_wait" | "cancel_requested";
      images?: never;
    })
  | (RunEventMeta & {
      type: "node-status";
      nodeId: string;
      status: "success";
      /** 成功事件在客户端归一化后始终包含数组。 */
      images: string[];
    })
  | (Omit<RunEventMeta, "error"> & {
      type: "node-status";
      nodeId: string;
      status: "error" | "outcome_unknown" | "cancelled";
      error: string;
      images?: never;
    });

export type RunEvent =
  | NodeStatusRunEvent
  | { seq?: number; type: "done" }
  | { seq?: number; type: "run-error"; nodeId?: string; error: string; finishedAt?: number };

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function nullableStringArray(value: unknown): Array<string | null> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => optionalString(item) ?? null);
}

function runFailures(value: unknown): RunFailure[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const failures = value.flatMap((item): RunFailure[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as { prompt?: unknown; error?: unknown };
    const error = optionalString(candidate.error);
    if (!error) return [];
    return [{ error, ...(optionalString(candidate.prompt) ? { prompt: optionalString(candidate.prompt) } : {}) }];
  });
  return failures.length ? failures : undefined;
}

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** SSE 数据不可信：在进入状态层前归一为判别联合，缺失图片永远不会写成 undefined。 */
export function normalizeRunEvent(value: unknown): RunEvent {
  if (!value || typeof value !== "object") throw new Error("运行事件格式无效");
  const raw = value as Record<string, unknown>;
  const seq = optionalFiniteNumber(raw.seq);
  if (raw.type === "done") return { type: "done", ...(seq !== undefined ? { seq } : {}) };
  if (raw.type === "run-error") {
    return {
      type: "run-error",
      error: optionalString(raw.error) ?? "运行失败",
      ...(optionalString(raw.nodeId) ? { nodeId: optionalString(raw.nodeId) } : {}),
      ...(optionalFiniteNumber(raw.finishedAt) !== undefined ? { finishedAt: optionalFiniteNumber(raw.finishedAt) } : {}),
      ...(seq !== undefined ? { seq } : {}),
    };
  }
  if (raw.type !== "node-status") throw new Error("运行事件类型无效");
  const nodeId = optionalString(raw.nodeId);
  if (!nodeId) throw new Error("运行事件缺少节点标识");
  const common: RunEventMeta = {
    ...(seq !== undefined ? { seq } : {}),
    ...(optionalString(raw.error) ? { error: optionalString(raw.error) } : {}),
    ...(optionalString(raw.model) ? { model: optionalString(raw.model) } : {}),
    ...(stringArray(raw.prompts) ? { prompts: stringArray(raw.prompts) } : {}),
    ...(nullableStringArray(raw.providerOutputSizes)
      ? { providerOutputSizes: nullableStringArray(raw.providerOutputSizes) }
      : {}),
    ...(runFailures(raw.failures) ? { failures: runFailures(raw.failures) } : {}),
    ...(recordObject(raw.executionMeta) ? { executionMeta: recordObject(raw.executionMeta) } : {}),
    ...(optionalFiniteNumber(raw.startedAt) !== undefined ? { startedAt: optionalFiniteNumber(raw.startedAt) } : {}),
    ...(optionalFiniteNumber(raw.finishedAt) !== undefined ? { finishedAt: optionalFiniteNumber(raw.finishedAt) } : {}),
  };
  if (raw.status === "success") {
    return { ...common, type: "node-status", nodeId, status: "success", images: stringArray(raw.images) ?? [] };
  }
  if (raw.status === "error" || raw.status === "outcome_unknown" || raw.status === "cancelled") {
    const { error: commonError, ...meta } = common;
    const fallback = raw.status === "cancelled" ? "任务已取消" : raw.status === "outcome_unknown" ? "生成结果未知" : "生成失败";
    return { ...meta, type: "node-status", nodeId, status: raw.status, error: commonError ?? fallback };
  }
  if (raw.status === "queued" || raw.status === "running" || raw.status === "retry_wait" || raw.status === "cancel_requested") {
    return { ...common, type: "node-status", nodeId, status: raw.status };
  }
  throw new Error("运行事件状态无效");
}

/** 单一节点回写规则：失败保留旧图片，只有成功事件可以替换 outputImages。 */
export function applyRunEventToNode(
  data: WorkflowNodeData,
  event: NodeStatusRunEvent,
): WorkflowNodeData {
  if (event.status === "success") {
    return {
      ...data,
      ...(data.kind !== "image-input" && data.kind !== "result" ? { outputImages: event.images } : {}),
      status: "success",
      error: event.error,
    } as WorkflowNodeData;
  }
  return {
    ...data,
    status: event.status,
    error: event.error,
  } as WorkflowNodeData;
}

function recordPrompt(data: WorkflowNodeData): string | undefined {
  if ("prompt" in data && typeof data.prompt === "string" && data.prompt.trim()) {
    return data.prompt.trim();
  }
  return undefined;
}

export function requestedResultCount(data: WorkflowNodeData): number {
  switch (data.kind) {
    case "sketch-to-render":
    case "ai-modify":
      return Math.max(1, Math.min(8, Number(data.batchSize) || 1));
    case "print-mutate":
      return Math.max(1, Math.min(8, Number(data.count) || 1));
    case "fabric-recolor":
      return Math.max(1, Math.min(8, data.colors.length || 1));
    case "mask-redraw":
      return 1;
    default:
      return 1;
  }
}

function pendingResultCardId(recordId: string, index: number): string {
  return `${recordId}:pending:${index}`;
}

export function createQueuedResultCards(initial: RecentResult, count: number): RecentResult[] {
  const requestedCount = Math.max(1, Math.min(8, Math.floor(count) || 1));
  return Array.from({ length: requestedCount }, (_, index) => ({
    ...initial,
    id: index === 0 ? initial.id : pendingResultCardId(initial.id, index),
    requestedCount,
  }));
}

function terminalResultCardId(recordId: string, kind: "image" | "failure", index: number): string {
  return `${recordId}:terminal:${kind}:${index}`;
}

/** 用一次后端事件更新点击时创建的主卡片，并为额外图片/部分失败追加卡片。 */
export function applyRunEventToRecentResults(
  records: RecentResult[],
  recordId: string,
  event: RunEvent,
): RecentResult[] {
  if (event.type !== "node-status") return records;
  const current = records.find((record) => record.id === recordId);
  if (!current) return records;
  const pendingPrefix = `${recordId}:pending:`;
  const terminalPrefix = `${recordId}:terminal:`;
  const isBatchSibling = (record: RecentResult) =>
    record.id === recordId ||
    record.id.startsWith(pendingPrefix) ||
    record.id.startsWith(terminalPrefix) ||
    (Boolean(current.runId) && record.runId === current.runId);
  if (isNodeRunActive(event.status)) {
    const status = event.status;
    return records.map((record) =>
      isBatchSibling(record)
        ? {
            ...record,
            status,
            error: event.error,
            model: event.model ?? record.model,
            startedAt: event.startedAt ?? record.startedAt,
          }
        : record,
    );
  }
  if (!isNodeRunTerminal(event.status)) return records;

  const startedAt = event.startedAt ?? current.startedAt;
  const finishedAt = event.finishedAt ?? Date.now();
  const { providerOutputSize: _previousProviderOutputSize, ...currentWithoutProviderOutputSize } = current;
  const base = {
    ...currentWithoutProviderOutputSize,
    model: event.model ?? current.model,
    executionMeta: event.executionMeta ?? current.executionMeta,
    startedAt,
    finishedAt,
  };
  const images = event.images ?? [];
  const failures = event.failures ?? [];
  const targetCount = Math.max(1, Math.min(8,
    current.requestedCount ?? Math.max(images.length + failures.length, 1),
  ));
  const terminalCards: RecentResult[] = [];

  for (let index = 0; index < Math.min(images.length, targetCount); index += 1) {
    terminalCards.push({
      ...base,
      id: index === 0 ? recordId : terminalResultCardId(recordId, "image", index),
      image: images[index],
      thumbnail: undefined,
      prompt: event.prompts?.[index] ?? current.prompt,
      ...(event.providerOutputSizes?.[index]
        ? { providerOutputSize: event.providerOutputSizes[index] as string }
        : {}),
      status: "success",
      error: undefined,
    });
  }

  let failureIndex = 0;
  while (terminalCards.length < targetCount) {
    const failure = failures[failureIndex];
    const cardIndex = terminalCards.length;
    terminalCards.push({
      ...base,
      id: cardIndex === 0 ? recordId : terminalResultCardId(recordId, "failure", failureIndex),
      image: "",
      thumbnail: undefined,
      prompt: failure?.prompt ?? current.prompt,
      status: event.status === "success" ? "error" : event.status,
      error: failure?.error || event.error || (images.length > 0 ? "未返回图片" : "运行完成但未返回图片"),
    });
    failureIndex += 1;
  }

  const next: RecentResult[] = [];
  let inserted = false;
  for (const record of records) {
    if (isBatchSibling(record)) {
      if (!inserted) {
        next.push(...terminalCards);
        inserted = true;
      }
      continue;
    }
    next.push(record);
  }
  return trimRecentResults(next);
}

/**
 * 最近结果是展示列表，也是活动 Run 的付费去重门禁。裁剪时可以丢旧终态，
 * 但绝不能丢仍在后端执行的记录；活动记录超过展示上限时宁可临时扩容。
 */
export function trimRecentResults(
  records: RecentResult[],
  limit = 200,
): RecentResult[] {
  const activeCount = records.reduce(
    (count, record) => count + (isNodeRunActive(record.status) ? 1 : 0),
    0,
  );
  let terminalBudget = Math.max(0, limit - activeCount);
  return records.filter((record) => {
    if (isNodeRunActive(record.status)) return true;
    if (terminalBudget <= 0) return false;
    terminalBudget -= 1;
    return true;
  });
}

/** 合并服务器历史与请求期间新增的本地记录；同 id 以服务器终态为准。 */
export function mergeRecentResults(
  current: RecentResult[],
  incoming: RecentResult[],
  limit = 200,
): RecentResult[] {
  const incomingById = new Map(incoming.map((record) => [record.id, record]));
  const currentIds = new Set(current.map((record) => record.id));
  return trimRecentResults([
    ...current.map((record) => incomingById.get(record.id) ?? record),
    ...incoming.filter((record) => !currentIds.has(record.id)),
  ], limit);
}

function pruneResultReferences(
  tab: ProjectTab,
  validIds: Set<string>,
  comparableIds: Set<string>,
): ProjectTab {
  const selectedResultId = tab.selectedResultId && validIds.has(tab.selectedResultId)
    ? tab.selectedResultId
    : null;
  const compareIds = tab.compareIds.filter((id, index, ids) => (
    comparableIds.has(id) && ids.indexOf(id) === index
  )).slice(0, 4);
  if (selectedResultId === tab.selectedResultId && sameStringList(compareIds, tab.compareIds)) {
    return tab;
  }
  return { ...tab, selectedResultId, compareIds };
}

/**
 * recentResults 与所有页签引用必须在同一个 Zustand snapshot 中变化，避免
 * Inspector/CompareOverlay 短暂观察到已不存在的结果 ID。
 */
export function recentResultsPatch(
  state: FlowState,
  recentResults: RecentResult[],
): Partial<FlowState> {
  const validIds = new Set(recentResults.map((record) => record.id));
  const comparableIds = new Set(
    recentResults
      .filter((record) => record.status === "success" && Boolean(record.image))
      .map((record) => record.id),
  );
  let referencesChanged = false;
  const tabs = state.tabs.map((tab) => {
    const pruned = pruneResultReferences(tab, validIds, comparableIds);
    if (pruned !== tab) referencesChanged = true;
    return pruned;
  });
  if (!referencesChanged) return { recentResults };
  return { recentResults, tabs };
}

/**
 * 首屏历史确认后，用服务端仍在运行的记录恢复节点；会话里没有后端 Run 的
 * queued/running 属于刷新中断的孤儿状态，必须解除，避免页签永久卡死。
 */
export function reconcileRunHistory(records: RecentResult[]): void {
  const activeByNode = new Map<string, RecentResult>();
  const confirmedActiveRunIds = new Set<string>();
  const uniqueRecordsById = new Map<string, RecentResult>();
  for (const record of records) {
    uniqueRecordsById.set(record.id, record);
    if (record.projectId && record.clientRequestId) {
      const requestKey = runSubmissionKey(record.projectId, record.nodeId);
      if (ambiguousRunRequestIds.get(requestKey) === record.clientRequestId) {
        clearAmbiguousRunRequest(requestKey);
      }
    }
    if (!record.projectId || !isNodeRunActive(record.status) || !record.runId) continue;
    confirmedActiveRunIds.add(record.runId);
    const key = `${record.projectId}\u0000${record.nodeId}`;
    const existing = activeByNode.get(key);
    if (!existing || existing.startedAt < record.startedAt) activeByNode.set(key, record);
  }
  runWithoutHistory(() => {
    useFlowStore.setState((state) => {
      const tabs = state.tabs.map((tab) => ({
        ...tab,
        nodes: tab.nodes.map((node) => {
          const active = activeByNode.get(`${tab.projectId}\u0000${node.id}`);
          if (active) {
            return {
              ...node,
              data: { ...node.data, status: active.status, error: active.error } as WorkflowNodeData,
            };
          }
          if (!isNodeRunActive(node.data.status)) return node;
          const data = { ...node.data, status: "idle" as const } as WorkflowNodeData;
          delete data.error;
          return { ...node, data };
        }),
      }));
      const retainedResults = state.recentResults.filter((record) =>
        !isNodeRunActive(record.status) ||
        (Boolean(record.runId) && confirmedActiveRunIds.has(record.runId!)),
      );
      const resultPatch = recentResultsPatch(
        { ...state, tabs },
        mergeRecentResults(retainedResults, [...uniqueRecordsById.values()]),
      );
      return { tabs, ...resultPatch };
    });
  });
}

export function appendSavedAsset(current: string[] | undefined, url: string): string[] {
  const existing = current ?? [];
  return existing.includes(url) ? existing : [...existing, url];
}

function responseErrorMessage(status: number, body: unknown): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return `HTTP ${status}`;
}

/** 等待后端 DAG Run 的 SSE 终态；事件自身可重放，因此晚连接不会丢状态。 */
function consumeRunEvents(
  runId: string,
  targetNodeId: string,
  onEvent: (event: RunEvent) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const source = new EventSource(`/api/run-plan/${encodeURIComponent(runId)}/events`);
    const seenEvents = new Set<string>();
    let lastSeq = 0;
    let targetTerminalSeen = false;
    // 绝对兜底上限覆盖 8 色/多批次串行重试的最坏合法耗时。
    const timeout = window.setTimeout(
      () => finish(new Error("运行状态等待超时，请稍后在项目中确认结果")),
      2 * 60 * 60 * 1000,
    );
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      source.close();
      if (error) reject(error);
      else resolve();
    };
    source.onmessage = (message) => {
      try {
        if (message.lastEventId && seenEvents.has(message.lastEventId)) return;
        const event = normalizeRunEvent(JSON.parse(message.data) as unknown);
        if (event.seq !== undefined && event.seq <= lastSeq) return;
        if (message.lastEventId) seenEvents.add(message.lastEventId);
        if (event.seq !== undefined) lastSeq = event.seq;
        onEvent(event);
        if (
          event.type === "node-status" &&
          event.nodeId === targetNodeId &&
          isNodeRunTerminal(event.status)
        ) {
          targetTerminalSeen = true;
        }
        if (event.type === "done") {
          finish(targetTerminalSeen ? undefined : new Error("运行已结束，但目标节点未返回终态"));
        }
        if (event.type === "run-error") finish(new Error(event.error || "运行失败"));
      } catch {
        finish(new Error("运行事件格式无效"));
      }
    };
    source.onerror = () => {
      // 保留原生 EventSource 重连；服务端按 Last-Event-ID 只重放尚未收到的事件。
      // 超过总等待时限才失败，避免瞬时断网导致用户重复发起付费任务。
    };
  });
}

function updateTabFromRunEvent(
  set: (partial: Partial<FlowState> | ((state: FlowState) => Partial<FlowState>)) => unknown,
  target: DocumentTarget,
  nodeId: string,
  event: NodeStatusRunEvent,
): void {
  const commitsOutput = event.status === "success" && event.images.length > 0;
  const updateNodes = (nodes: FlowNode[]) => nodes.map((node) =>
    node.id === nodeId
      ? {
          ...node,
          data: (() => {
            const updated = applyRunEventToNode(node.data, event);
            return event.status === "success"
              && node.data.kind === "virtual-try-on"
              && node.data.workflowStage === "scene-stabilize"
              ? { ...updated, basisRevision: (node.data.basisRevision ?? 0) + 1 }
              : updated;
          })(),
        }
      : node,
  );
  const currentState = useFlowStore.getState();
  // A tab container can be reused for another project. Reject its old run
  // before any durable branch can flush the replacement document's editor.
  if (!documentForTarget(currentState, target)) return;
  if (commitsOutput) {
    // 先把自动结果节点放入当前文档但不写撤销历史。随后单独提交生成
    // 输出，使用户仍可撤销/重做生成内容，而结果节点本身不会被误删。
    runWithoutHistory(() => {
      patchDocumentTarget(set, target, (tab) => {
        const generated = ensureGeneratedResultNode(
          tab.nodes,
          tab.edges,
          nodeId,
          event.images,
        );
        return {
          nodes: generated.nodes,
          edges: generated.edges,
        };
      });
    });
    // A system result may arrive while a drag transaction is still live. Keep
    // that result outside undo history, but rebase the transaction snapshot so
    // cancelling the drag cannot roll the generated output/result node back.
    const transaction = activeHistoryTransaction;
    if (transaction?.tabId === target.tabId) {
      const updatedTab = documentForTab(useFlowStore.getState(), target.tabId);
      if (updatedTab && matchesDocumentTarget(updatedTab, target)) {
        transaction.before = rebaseDocumentOutsideTransaction(
          temporalDocument(updatedTab),
          transaction,
        );
      }
    }
    updateTabNodes(set, target, updateNodes, { markDirty: true });
    return;
  }
  const update = () => updateTabNodes(
    set,
    target,
    updateNodes,
    { markDirty: commitsOutput },
  );
  runWithoutHistory(update);
}

/**
 * 每次成功生成均创建独立结果节点并连线。调用方必须包在 runWithoutHistory
 * 中，使系统回写可保存但不会被“撤销”误删或恢复。
 */
export function ensureGeneratedResultNode(
  nodes: FlowNode[],
  edges: Edge[],
  sourceNodeId: string,
  media: string[],
): { nodes: FlowNode[]; edges: Edge[]; resultNodeId: string } {
  const source = nodes.find((node) => node.id === sourceNodeId);
  if (!source || media.length === 0) return { nodes, edges, resultNodeId: "" };
  const resultNodeId = `result-${nanoid(8)}`;
  const siblingCount = edges.filter((edge) => edge.source === sourceNodeId && edge.target.startsWith("result-")).length;
  const resultNode: FlowNode = {
    id: resultNodeId,
    type: "result",
    position: {
      x: source.position.x + 380,
      y: source.position.y + siblingCount * 48,
    },
    data: {
      ...defaultNodeData("result"),
      label: `结果 ${siblingCount + 1}`,
      status: "success",
      images: [...media],
    },
  };
  const sourceHandle = source.data.kind === "video-generate" ? "video" : "image";
  const edge: Edge = {
    id: `edge-${nanoid(10)}`,
    source: sourceNodeId,
    sourceHandle,
    target: resultNodeId,
    targetHandle: "references",
    type: "pulse",
  };
  return { nodes: [...nodes, resultNode], edges: [...edges, edge], resultNodeId };
}

function applyActiveTemporalHistory(direction: "undo" | "redo"): void {
  const temporal = useFlowStore.temporal.getState();
  const source = direction === "undo" ? temporal.pastStates : temporal.futureStates;
  if (source.length === 0) return;

  const state = useFlowStore.getState();
  const tab = selectActiveDocument(state);
  const current = temporalDocument(tab);
  const target = source[source.length - 1] as FlowTemporalState;
  const currentById = new Map(tab.nodes.map((node) => [node.id, node]));
  const selectedEdges = new Map(tab.edges.map((edge) => [edge.id, edge.selected]));
  const nodesWithRuntime = target.nodes.map((node) => {
    return preserveNodeRuntimeAndTransients(node, currentById.get(node.id));
  });
  const selection = normalizeNodeSelection(nodesWithRuntime, tab.selectedNodeIds);
  const edges = target.edges.map((edge) => {
    const selected = selectedEdges.get(edge.id);
    return edge.selected === selected ? edge : { ...edge, selected };
  });
  const changed = !sameTemporalDocument(current, target);

  runWithoutHistory(() => {
    if (changed) {
      useFlowStore.setState((latest) => {
        if (latest.activeTabId !== tab.id) return {};
        const latestTab = selectActiveDocument(latest);
        return { tabs: replaceTab(latest.tabs, {
          ...latestTab,
          projectName: target.projectName,
          ...selection,
          edges,
          revision: latestTab.revision + 1,
          dirty: true,
          saveState: latestTab.saveState === "saving" ? "saving" : "idle",
        }) };
      });
    }
    useFlowStore.temporal.setState(direction === "undo"
      ? {
        pastStates: temporal.pastStates.slice(0, -1),
        futureStates: [...temporal.futureStates, current],
      }
      : {
        pastStates: [...temporal.pastStates, current].slice(-DOCUMENT_HISTORY_LIMIT),
        futureStates: temporal.futureStates.slice(0, -1),
      });
  });
}

export const useFlowStore = create<FlowState>()(
  temporal<FlowState, [], [], FlowTemporalState>(
    (set, get) => {
      const restored = typeof window === "undefined" ? undefined : loadTabSession();
      const initialTab =
        restored?.tabs.find((tab) => tab.id === restored.activeTabId) ?? newTab();
      const saveTab = async (target: DocumentTarget): Promise<SaveTabResult> => {
        const tabId = target.tabId;
        const queueKey = documentTargetKey(target);
        // Register an explicit retry before joining the transaction barrier. A
        // failed response may already be ahead of this save in the settlement
        // FIFO and must still observe the user's later retry intent.
        const existingBeforeSettlement = saveQueueByDocument.get(queueKey);
        if (existingBeforeSettlement) {
          existingBeforeSettlement.explicitRetryGeneration += 1;
          const pendingSettlement = waitForHistoryTransactionSettlement(tabId);
          if (pendingSettlement) await pendingSettlement;
          return existingBeforeSettlement.promise;
        }

        const initialSettlement = waitForHistoryTransactionSettlement(tabId);
        if (initialSettlement) await initialSettlement;
        const firstSnapshot = documentForTarget(get(), target);
        if (!firstSnapshot || firstSnapshot.readOnly) {
          return { ok: false, error: "项目已切换、不存在或当前页签为只读" };
        }

        const existing = saveQueueByDocument.get(queueKey);
        if (existing) {
          existing.explicitRetryGeneration += 1;
          return existing.promise;
        }

        const queue: TabSaveQueue = {
          promise: Promise.resolve({ ok: false }),
          explicitRetryGeneration: 0,
        };
        queue.promise = (async () => {
          while (true) {
            const pendingSettlement = waitForHistoryTransactionSettlement(tabId);
            if (pendingSettlement) await pendingSettlement;
            const attemptGeneration = queue.explicitRetryGeneration;
            const snapshot = documentForTarget(get(), target);
            if (!snapshot || snapshot.readOnly) {
              return { ok: false, error: "项目已切换、不存在或当前页签为只读" };
            }
            patchDocumentTarget(set, target, { saveState: "saving" });
            try {
              if (projectTabLifecycle(snapshot) === "initial_draft") {
                await waitForInitialDraftSyncBeforeFormalSave(target);
              }
              const synchronizedSnapshot = documentForTarget(get(), target);
              if (!synchronizedSnapshot || synchronizedSnapshot.readOnly) {
                return { ok: false, error: "项目已切换、不存在或当前页签为只读" };
              }
              const document = createDocumentSnapshot(synchronizedSnapshot);
              const flow = documentSnapshotToPersistedWorkflow(document);
              const res = await fetch("/api/projects", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  id: synchronizedSnapshot.projectId,
                  name: document.projectName,
                  flow,
                  ...(projectTabLifecycle(synchronizedSnapshot) === "initial_draft"
                    ? { expectedDraftRevision: synchronizedSnapshot.draftRevision ?? 0 }
                    : {}),
                }),
              });
              if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(responseErrorMessage(res.status, body));
              }
              const responseSettlement = waitForHistoryTransactionSettlement(tabId);
              if (responseSettlement) await responseSettlement;
              let needsRevisionFollowup = false;
              const matched = patchDocumentTarget(set, target, (latest) => {
                const clean = latest.revision === synchronizedSnapshot.revision;
                needsRevisionFollowup = !clean;
                return {
                  savedRevision: Math.max(latest.savedRevision, synchronizedSnapshot.revision),
                  dirty: !clean,
                  saveState: clean ? "saved" : "saving",
                  hasBeenPersisted: true,
                  lifecycle: "saved",
                  draftRevision: undefined,
                  draftSyncedRevision: undefined,
                  draftCreatedAt: undefined,
                };
              });
              if (!matched) return { ok: false, error: "项目已切换，旧保存响应已忽略" };
              if (!needsRevisionFollowup) return { ok: true };
            } catch (error) {
              const failureSettlement = waitForHistoryTransactionSettlement(tabId);
              if (failureSettlement) await failureSettlement;
              if (queue.explicitRetryGeneration > attemptGeneration) continue;
              const matched = patchDocumentTarget(set, target, (latest) => ({
                saveState: "error",
                dirty: latest.revision !== latest.savedRevision,
              }));
              if (!matched) return { ok: false, error: "项目已切换，旧保存失败已忽略" };
              return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          }
        })();
        saveQueueByDocument.set(queueKey, queue);
        try {
          return await queue.promise;
        } finally {
          if (saveQueueByDocument.get(queueKey) === queue) saveQueueByDocument.delete(queueKey);
        }
      };
      return ({
        tabs: restored?.tabs ?? [initialTab],
        activeTabId: initialTab.id,
        tabSessionPersistenceError: null,
        pendingMaskWorkCount: 0,
        pendingConnectionDraft: null,
        connectionDraftError: null,
        // 服务端历史在登录成功后注入；不能从浏览器本地缓存恢复其他账号的记录。
        recentResults: [],
        viewer: null,

      switchTab: (tabId) => {
        const initialState = get();
        if (tabId === initialState.activeTabId) return;
        if (!initialState.tabs.some((tab) => tab.id === tabId)) return;
        flushActiveTextEdit();
        cancelHistoryTransaction();
        const state = get();
        const target = state.tabs.find((tab) => tab.id === tabId);
        if (!target) return;
        stashActiveTemporalHistory(state.activeTabId);
        runWithoutHistory(() => set({
          activeTabId: target.id,
          viewer: null,
          pendingConnectionDraft: null,
          connectionDraftError: null,
        }));
        restoreTemporalHistory(target.id);
      },
      closeTab: (tabId) => {
        flushActiveTextEdit();
        // Session snapshots intentionally strip runtime status. Until active
        // runs reconcile, an apparently-idle restored tab may still own paid work.
        if (getGenerationSafetyBlockReason()) return;
        const initialState = get();
        const initialClosingTab = initialState.tabs.find((tab) => tab.id === tabId);
        if (!initialClosingTab) return;
        const closingTab = initialClosingTab;
        if (closingTab.nodes.some((node) => isNodeRunActive(node.data.status))) {
          return;
        }
        if (tabId === initialState.activeTabId) cancelHistoryTransaction();
        const state = get();
        const closingIndex = state.tabs.findIndex((tab) => tab.id === tabId);
        if (closingIndex < 0) return;
        const remaining = state.tabs.filter((tab) => tab.id !== tabId);
        if (remaining.length === 0) remaining.push(newTab());
        if (tabId !== state.activeTabId) {
          temporalHistoryByTab.delete(tabId);
          set({ tabs: remaining, pendingConnectionDraft: null, connectionDraftError: null });
          return;
        }
        temporalHistoryByTab.delete(tabId);
        const target = remaining[Math.min(closingIndex, remaining.length - 1)];
        runWithoutHistory(() => set({
          tabs: remaining,
          activeTabId: target.id,
          viewer: null,
          pendingConnectionDraft: null,
          connectionDraftError: null,
        }));
        restoreTemporalHistory(target.id);
      },
      openFlowTab: ({ projectId, projectName, nodes, edges, markDirty = false, readOnly = false }) => {
        flushActiveTextEdit();
        cancelHistoryTransaction();
        const state = get();
        const applyActiveHistory = (inputNodes: FlowNode[]) => {
          const activeByNode = latestActiveRecordsByNode(state.recentResults, projectId);
          return inputNodes.map((node) => {
            const active = activeByNode.get(node.id);
            return active
              ? {
                ...node,
                data: { ...node.data, status: active.status, error: active.error } as WorkflowNodeData,
              }
              : node;
          });
        };
        const found = state.tabs.find((tab) => tab.projectId === projectId);
        const existing = found ? { ...found, nodes: applyActiveHistory(found.nodes) } : undefined;
        if (existing) {
          const switchesTab = existing.id !== state.activeTabId;
          if (switchesTab) stashActiveTemporalHistory(state.activeTabId);
          const tabs = replaceTab(state.tabs, existing);
          runWithoutHistory(() => set({
            tabs,
            activeTabId: existing.id,
            viewer: null,
            pendingConnectionDraft: null,
            connectionDraftError: null,
          }));
          if (switchesTab) restoreTemporalHistory(existing.id);
        } else {
          stashActiveTemporalHistory(state.activeTabId);
          const tab = newTab({
            projectId,
            projectName,
            nodes: applyActiveHistory(nodes),
            edges,
            markDirty,
            readOnly,
            persisted: !markDirty,
          });
          runWithoutHistory(() => set({
            tabs: [...state.tabs, tab],
            activeTabId: tab.id,
            viewer: null,
            pendingConnectionDraft: null,
            connectionDraftError: null,
          }));
          temporalHistoryByTab.delete(tab.id);
          restoreTemporalHistory(tab.id);
        }
      },
      createBlankTab: () => {
        flushActiveTextEdit();
        cancelHistoryTransaction();
        const tab = newTab();
        const state = get();
        stashActiveTemporalHistory(state.activeTabId);
        runWithoutHistory(() => set({
          tabs: [...state.tabs, tab],
          activeTabId: tab.id,
          viewer: null,
          pendingConnectionDraft: null,
          connectionDraftError: null,
        }));
        temporalHistoryByTab.delete(tab.id);
        restoreTemporalHistory(tab.id);
      },

      setProjectName: (name) => {
        const tab = selectActiveDocument(get());
        if (tab.readOnly || name === tab.projectName) return;
        commitDocumentMutationWithSet(set, { projectName: name });
      },
      setSelectedNodeIds: (ids) => {
        runWithoutHistory(() => {
          set((state) => {
            const tab = selectActiveDocument(state);
            const selection = normalizeNodeSelection(tab.nodes, ids);
            if (
              sameStringList(selection.selectedNodeIds, tab.selectedNodeIds) &&
              selection.nodes === tab.nodes &&
              tab.selectedResultId === null
            ) return {};
            return { tabs: replaceTab(state.tabs, {
              ...tab,
              ...selection,
              selectedResultId: null,
            }) };
          });
        });
      },
      setSelectedNodeId: (id) => get().setSelectedNodeIds(id ? [id] : []),
      autoLayoutSelectedWorkflow: () => {
        const tab = selectActiveDocument(get());
        if (tab.readOnly) return "当前项目为只读状态";
        const selectedNodeId = selectPrimarySelectedNodeId(tab);
        if (!selectedNodeId) return "请先选择需要整理的工作流节点";
        let nodes: FlowNode[];
        try {
          nodes = layoutConnectedComponent(selectedNodeId, tab.nodes, tab.edges);
        } catch (error) {
          return error instanceof Error ? error.message : "自动整理失败";
        }
        commitDocumentMutationWithSet(set, { nodes });
        return null;
      },
      setSelectedResultId: (id) => {
        const nextId = id && get().recentResults.some((record) => record.id === id) ? id : null;
        runWithoutHistory(() => {
          set((state) => {
            const tab = selectActiveDocument(state);
            return { tabs: replaceTab(state.tabs, {
              ...tab,
              ...normalizeNodeSelection(tab.nodes, []),
              selectedResultId: nextId,
            }) };
          });
        });
      },
      toggleCompareId: (id) => {
        const document = selectActiveDocument(get());
        const comparableIds = new Set(
          get().recentResults
            .filter((record) => record.status === "success" && Boolean(record.image))
            .map((record) => record.id),
        );
        const cur = document.compareIds.filter((candidate, index, ids) => (
          comparableIds.has(candidate) && ids.indexOf(candidate) === index
        ));
        if (!comparableIds.has(id)) {
          if (!sameStringList(cur, document.compareIds)) patchTab(set, document.id, { compareIds: cur });
          return;
        }
        if (cur.includes(id)) {
          runWithoutHistory(() => patchTab(set, document.id, { compareIds: cur.filter((c) => c !== id) }));
        } else if (cur.length < 4) {
          runWithoutHistory(() => patchTab(set, document.id, (tab) => ({
            compareIds: [...cur, id],
            selectedResultId: null,
            ...normalizeNodeSelection(tab.nodes, []),
          })));
        } else if (typeof window !== "undefined") {
          window.alert("最多选择 4 张图片进行对比");
        }
      },
      clearCompare: () => runWithoutHistory(() => {
        const tab = selectActiveDocument(get());
        patchTab(set, tab.id, { compareIds: [] });
      }),
      removeRecentResult: (id) => {
        runWithoutHistory(() => set((state) => recentResultsPatch(
          state,
          state.recentResults.filter((record) => record.id !== id),
        )));
      },
      openViewer: (v) => set({ viewer: v }),
      closeViewer: () => set({ viewer: null }),

      onNodesChange: (changes) => {
        const state = get();
        const tab = selectActiveDocument(state);
        const allowed = tab.readOnly ? changes.filter((change) => change.type === "select" || change.type === "dimensions") : changes;
        const nodes = applyNodeChanges(allowed, tab.nodes);
        if (nodes === tab.nodes) return;
        const selection = normalizeNodeSelection(
          nodes,
          selectionIdsAfterNodeChanges(tab.selectedNodeIds, nodes, allowed),
        );
        const patch = {
          ...selection,
          ...(selection.selectedNodeIds.length > 0 ? { selectedResultId: null } : {}),
        };
        const changesDocument = allowed.some(
          (change) => change.type !== "select" && change.type !== "dimensions",
        );
        const onlyMovesNodes = changesDocument && allowed.every(
          (change) => change.type === "select" || change.type === "dimensions" || change.type === "position",
        );
        if (changesDocument) {
          commitDocumentMutationWithSet(set, patch, {
            coalesceWithActiveTransaction: onlyMovesNodes,
          });
        }
        else runWithoutHistory(() => patchTab(set, tab.id, patch));
      },
      onEdgesChange: (changes) => {
        const tab = selectActiveDocument(get());
        const allowed = tab.readOnly ? changes.filter((change) => change.type === "select") : changes;
        const edges = applyEdgeChanges(allowed, tab.edges);
        if (edges === tab.edges) return;
        const changesDocument = allowed.some((change) => change.type !== "select");
        if (changesDocument) {
          const changedStageIds = new Set<string>();
          for (const edge of [...tab.edges, ...edges]) {
            const target = tab.nodes.find((node) => node.id === edge.target);
            if (target?.data.kind === "virtual-try-on" && target.data.workflowStage === "scene-stabilize") {
              const before = tab.edges.some((candidate) => candidate.id === edge.id);
              const after = edges.some((candidate) => candidate.id === edge.id);
              if (before !== after) changedStageIds.add(edge.target);
            }
          }
          commitDocumentMutationWithSet(set, { edges, nodes: incrementSceneBasis(tab.nodes, changedStageIds) });
        }
        else runWithoutHistory(() => patchTab(set, tab.id, { edges }));
      },

      isValidConnection: (conn) => {
        const tab = selectActiveDocument(get());
        return isDocumentConnectionValid(tab, conn);
      },

      onConnect: (conn) => {
        const tab = selectActiveDocument(get());
        if (tab.readOnly) return;
        const targetNode = tab.nodes.find((node) => node.id === conn.target);
        if (targetNode && isStagedTryOnData(targetNode.data) && conn.source && conn.target) {
          const target = selectActiveDocumentTarget(get());
          runWithoutHistory(() => set({
            pendingConnectionDraft: {
              target,
              sourceNodeId: conn.source,
              targetNodeId: conn.target,
              sourceHandle: conn.sourceHandle ?? null,
              proposedTargetHandle: (conn.targetHandle as WorkflowInputRole | null | undefined) ?? null,
            },
            connectionDraftError: null,
          }));
          return;
        }
        if (!get().isValidConnection(conn)) return;
        commitDocumentMutationWithSet(set, { edges: addDocumentEdge(conn, tab.edges) });
      },

      confirmPendingConnection: (targetHandle) => {
        const state = get();
        const draft = state.pendingConnectionDraft;
        if (!draft) return false;
        const tab = documentForTarget(state, draft.target);
        if (!tab || tab.readOnly) {
          set({ pendingConnectionDraft: null, connectionDraftError: null });
          return false;
        }
        const source = tab.nodes.find((node) => node.id === draft.sourceNodeId);
        const target = tab.nodes.find((node) => node.id === draft.targetNodeId);
        if (!source || !target || !isStagedTryOnData(target.data)) {
          set({ connectionDraftError: "连接对象已变化，请重新拖线" });
          return false;
        }
        if (draft.proposedTargetHandle && draft.proposedTargetHandle !== targetHandle) {
          const proposed = STAGED_ROLE_LABELS[draft.proposedTargetHandle] ?? draft.proposedTargetHandle;
          const selected = STAGED_ROLE_LABELS[targetHandle] ?? targetHandle;
          set({ connectionDraftError: `该连线已指定为${proposed}，不能改为${selected}` });
          return false;
        }
        const connection: Connection = {
          source: draft.sourceNodeId,
          target: draft.targetNodeId,
          sourceHandle: draft.sourceHandle,
          targetHandle,
        };
        const compatibilityError = connectionCompatibilityError({
          source,
          target,
          sourceHandle: connection.sourceHandle,
          targetHandle,
          existingEdges: tab.edges,
        });
        if (compatibilityError) {
          set({ connectionDraftError: compatibilityError });
          return false;
        }
        const nextEdges = addDocumentEdge(connection, tab.edges);
        commitDocumentMutationWithSet(set, {
          edges: nextEdges,
          nodes: incrementSceneBasis(tab.nodes, new Set([target.id])),
        });
        runWithoutHistory(() => set({ pendingConnectionDraft: null, connectionDraftError: null }));
        return true;
      },

      cancelPendingConnection: () => runWithoutHistory(() => set({
        pendingConnectionDraft: null,
        connectionDraftError: null,
      })),

      addNode: (kind, position, preset) => {
        const tab = selectActiveDocument(get());
        if (tab.readOnly) return null;
        const node: FlowNode = {
          id: nanoid(8),
          type: kind,
          position,
          data: defaultNodeDataWithPreset(kind, preset),
        };
        const selection = normalizeNodeSelection([...tab.nodes, node], [node.id]);
        commitDocumentMutationWithSet(set, { ...selection, selectedResultId: null });
        return node.id;
      },

      addConnectedNode: (anchorId, kind, direction, options) => {
        const tab = selectActiveDocument(get());
        if (tab.readOnly) return null;
        const anchor = tab.nodes.find((node) => node.id === anchorId);
        if (!anchor) return null;
        const id = nanoid(8);
        const horizontalGap = 380;
        const node: FlowNode = {
          id,
          type: kind,
          position: {
            x: anchor.position.x + (direction === "downstream" ? horizontalGap : -horizontalGap),
            y: anchor.position.y,
          },
          data: defaultNodeDataWithPreset(kind, options?.preset),
        };
        const nodes = [...tab.nodes, node];
        const connection: Connection = direction === "downstream"
          ? {
              source: anchor.id,
              target: id,
              sourceHandle: options?.sourceHandle ?? null,
              targetHandle: options?.targetHandle ?? null,
            }
          : { source: id, target: anchor.id, sourceHandle: null, targetHandle: null };
        const draft = { nodes, edges: tab.edges };
        if (!isDocumentConnectionValid(draft, connection)) return null;
        const selection = normalizeNodeSelection(nodes, [id]);
        commitDocumentMutationWithSet(set, {
          ...selection,
          edges: addDocumentEdge(connection, tab.edges),
          selectedResultId: null,
        });
        return id;
      },

      addAssetNode: (asset, position) => {
        const state = get();
        const tab = selectActiveDocument(state);
        if (tab.readOnly) return null;
        const id = nanoid(8);
        const node: FlowNode = {
          id,
          type: "image-input",
          position,
          data: {
            ...defaultNodeData("image-input"),
            label: asset.name,
            status: "success",
            imageUrl: asset.image,
          } as ImageInputNodeData,
        };
        const selection = normalizeNodeSelection([...tab.nodes, node], [id]);
        commitDocumentMutationWithSet(set, { ...selection, selectedResultId: null });
        return id;
      },

      addExistingNode: (node) => {
        const tab = selectActiveDocument(get());
        if (tab.readOnly) return;
        const selection = normalizeNodeSelection([...tab.nodes, node], [node.id]);
        commitDocumentMutationWithSet(set, { ...selection, selectedResultId: null });
      },

      commitDrawingBoard: (target, nodeId, refs) => {
        const state = get();
        const tab = documentForTarget(state, target);
        if (!tab || tab.readOnly || state.activeTabId !== target.tabId) return false;
        const node = tab.nodes.find((candidate) => candidate.id === nodeId);
        if (!node || node.data.kind !== "drawing-board") return false;
        return commitDocumentMutationWithSet(set, (latest) => {
          if (!matchesDocumentTarget(latest, target)) return {};
          const nodes = latest.nodes.map((candidate) => candidate.id === nodeId && candidate.data.kind === "drawing-board"
            ? {
                ...candidate,
                data: {
                  ...candidate.data,
                  ...refs,
                  status: "success" as const,
                  error: undefined,
                },
              }
            : candidate);
          return { nodes };
        });
      },

      exportDrawingBoardImageNode: (target, nodeId) => {
        const state = get();
        const tab = documentForTarget(state, target);
        if (!tab || tab.readOnly || state.activeTabId !== target.tabId) return null;
        const board = tab.nodes.find((candidate) => candidate.id === nodeId);
        if (!board || board.data.kind !== "drawing-board" || !board.data.previewImageRef || !board.data.contentRef) return null;
        const id = nanoid(8);
        const imageNode: FlowNode = {
          id,
          type: "image-input",
          position: { x: board.position.x + 380, y: board.position.y },
          data: {
            ...defaultNodeData("image-input"),
            label: `${board.data.label} 导出`,
            status: "success",
            imageUrl: board.data.previewImageRef,
          } as ImageInputNodeData,
        };
        const nextBoard = {
          ...board,
          data: { ...board.data, exportImageRef: board.data.previewImageRef },
        };
        const nodes = [...tab.nodes.map((candidate) => candidate.id === nodeId ? nextBoard : candidate), imageNode];
        const selection = normalizeNodeSelection(nodes, [id]);
        const changed = commitDocumentMutationWithSet(set, { ...selection, selectedResultId: null });
        return changed ? id : null;
      },

      updateNodeData: (id, patch) => {
        const tab = selectActiveDocument(get());
        if (tab.readOnly) return;
        if (!tab.nodes.some((n) => n.id === id)) return;
        const edited = tab.nodes.find((node) => node.id === id)!;
        const basisKeys = new Set(["prompt", "imageSize", "modelId", "modelOptions", "outputImages"]);
        const sourceOutputKeys = new Set(["imageUrl", "outputImages", "previewImageRef", "exportImageRef"]);
        const stageTargets = new Set<string>();
        if (
          edited.data.kind === "virtual-try-on"
          && edited.data.workflowStage === "scene-stabilize"
          && Object.keys(patch).some((key) => basisKeys.has(key) && !Object.is(edited.data[key], patch[key]))
        ) stageTargets.add(id);
        if (Object.keys(patch).some((key) => sourceOutputKeys.has(key) && !Object.is(edited.data[key], patch[key]))) {
          for (const targetId of sceneBasisTargetsForSource(tab, id)) stageTargets.add(targetId);
        }
        const patchedNodes = tab.nodes.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, ...patch } as WorkflowNodeData } : n,
        );
        commitDocumentMutationWithSet(set, {
          nodes: incrementSceneBasis(patchedNodes, stageTargets),
        });
      },
      updateVideoNodeSettings: (id, patch) => {
        const tab = selectActiveDocument(get());
        if (tab.readOnly) return;
        const edited = tab.nodes.find((node) => node.id === id);
        if (!edited || edited.data.kind !== "video-generate") return;

        const nextData = { ...edited.data, ...patch } as VideoGenerateNodeData;
        const validInputPorts = inputPortSpecs(nextData);
        const validHandles = new Set(validInputPorts.map((port) => port.id));
        const nodes = tab.nodes.map((node) => node.id === id
          ? { ...node, data: nextData }
          : node);
        const edges = tab.edges.filter((edge) => {
          if (edge.target !== id) return true;
          if (edge.targetHandle) return validHandles.has(edge.targetHandle);
          return validInputPorts.length === 1;
        });
        commitDocumentMutationWithSet(set, { nodes, edges });
      },
      updateNodeDataInTab: (target, id, patch) => {
        if (documentForTarget(get(), target)?.readOnly !== false) return;
        updateTabNodes(
          set,
          target,
          (nodes) => {
            if (!nodes.some((node) => node.id === id)) return nodes;
            return nodes.map((node) =>
              node.id === id
                ? { ...node, data: { ...node.data, ...patch } as WorkflowNodeData }
                : node,
            );
          },
          { markDirty: true },
        );
      },

      assignImageInputInTab: (target, id, imageUrl) => {
        if (!imageUrl || documentForTarget(get(), target)?.readOnly !== false) return;
        commitDocumentMutationForTarget(set, target, (tab) => {
          const source = tab.nodes.find((node) => node.id === id);
          if (!source || source.data.kind !== "image-input") return {};

          const imageChanged = source.data.imageUrl !== imageUrl;
          let nodes = tab.nodes.map((node) => node.id === id
            ? {
                ...node,
                data: {
                  ...node.data,
                  imageUrl,
                  status: "success" as const,
                  error: undefined,
                },
              }
            : node);
          let edges = tab.edges;
          const changedStageIds = imageChanged
            ? sceneBasisTargetsForSource(tab, id)
            : new Set<string>();

          for (const declaredTarget of source.data.autoConnectTargets ?? []) {
            const connection: Connection = {
              source: id,
              sourceHandle: "image",
              target: declaredTarget.targetNodeId,
              targetHandle: declaredTarget.targetHandle,
            };
            const exactEdgeExists = edges.some((edge) => (
              edge.source === connection.source
              && edge.sourceHandle === connection.sourceHandle
              && edge.target === connection.target
              && edge.targetHandle === connection.targetHandle
            ));
            if (exactEdgeExists || !isDocumentConnectionValid({ nodes, edges }, connection)) continue;
            edges = addDocumentEdge(connection, edges);
            const targetNode = nodes.find((node) => node.id === connection.target);
            if (targetNode?.data.kind === "virtual-try-on" && targetNode.data.workflowStage === "scene-stabilize") {
              changedStageIds.add(targetNode.id);
            }
          }

          nodes = incrementSceneBasis(nodes, changedStageIds);
          return { nodes, edges };
        });
      },

      setNodeStatus: (id, status, error) =>
        (() => {
          runWithoutHistory(() => {
            const tab = selectActiveDocument(get());
            patchTab(set, tab.id, {
              nodes: tab.nodes.map((n) =>
                n.id === id ? { ...n, data: { ...n.data, status, error } } : n,
              ),
            });
          });
        })(),

      runNode: async (id) => {
        // UI 禁用只是反馈层；所有付费运行仍必须在唯一 action 入口二次校验。
        if (getGenerationSafetyBlockReason()) return;
        flushActiveTextEdit();
        const target = selectActiveDocumentTarget(get());
        const tabId = target.tabId;
        const pendingSettlement = waitForHistoryTransactionSettlement(tabId);
        if (pendingSettlement) await pendingSettlement;
        if (getGenerationSafetyBlockReason()) return;
        const initialState = get();
        const initialDocument = documentForTarget(initialState, target);
        if (!initialDocument || initialState.activeTabId !== tabId) return;
        if (initialDocument.readOnly) return;
        const node = initialDocument.nodes.find((n) => n.id === id);
        if (
          !node ||
          isNodeRunActive(node.data.status) ||
          initialState.recentResults.some((record) =>
            record.projectId === initialDocument.projectId &&
            record.nodeId === id &&
            isNodeRunActive(record.status) &&
            Boolean(record.runId),
          )
        ) return;
        const kind = node.data.kind;
        if (node.data.kind === "mask-redraw" && node.data.executionMode === "bypass") return;
        const spec = NODE_SPECS[kind];
        if (!spec.providerId) return;
        const preparationError = virtualTryOnRunBlockReason(node, initialDocument);
        if (preparationError) {
          runWithoutHistory(() => {
            updateTabNodes(set, target, (nodes) => nodes.map((candidate) =>
              candidate.id === id
                ? { ...candidate, data: { ...candidate.data, status: "error", error: preparationError } }
                : candidate,
            ));
          });
          return;
        }
        if (node.data.kind === "virtual-try-on" && node.data.workflowStage === "scene-stabilize") {
          commitDocumentMutationWithSet(set, {
            nodes: incrementSceneBasis(initialDocument.nodes, new Set([node.id])),
          });
        }

        const preparationKey = runPreparationKey(target, id);
        const submissionKey = runSubmissionKey(initialDocument.projectId, id);
        if (runPreparations.has(preparationKey)) return;
        runPreparations.add(preparationKey);
        const localStartedAt = Date.now();
        const recordId = nanoid(8);
        const ambiguousClientRequestId = ambiguousRunRequestIds.get(submissionKey);
        const clientRequestId = ambiguousClientRequestId ?? nanoid(16);
        const retryingAmbiguousSubmission = ambiguousClientRequestId !== undefined;
        const requestedCount = requestedResultCount(node.data);
        let terminalRecorded = false;
        let knownRunId: string | undefined;

        // 先记录用户的这次生成操作，再请求后端；即使请求失败或页面刷新也不会丢记录。
        const initialRecord: RecentResult = {
          id: recordId,
          image: "",
          nodeId: id,
          nodeLabel: node.data.label,
          kind,
          projectId: initialDocument.projectId,
          projectName: initialDocument.projectName,
          prompt: recordPrompt(node.data),
          startedAt: localStartedAt,
          status: "queued",
          clientRequestId,
          requestedCount,
        };
        const queuedRecords = createQueuedResultCards(initialRecord, requestedCount);
        set((state) => recentResultsPatch(state, trimRecentResults([
            ...queuedRecords,
            ...initialState.recentResults,
          ])));

        try {
          runWithoutHistory(() => {
            updateTabNodes(set, target, (nodes) =>
              nodes.map((candidate) =>
                candidate.id === id
                  ? { ...candidate, data: { ...candidate.data, status: "queued", error: undefined } }
                  : candidate,
              ),
            );
          });
          // 付费动作严格绑定点击时的不可变快照；保存期间发生编辑时服务端会以 409 拒绝旧快照。
          const submissionSnapshot = documentForTarget(get(), target);
          if (!submissionSnapshot) throw new Error("项目或节点已关闭，未调用生图服务");
          const submissionDocument = createDocumentSnapshot(submissionSnapshot);
          const submissionFlow = documentSnapshotToPersistedWorkflow(submissionDocument);
          const saveResult = await saveTab(target);
          if (!saveResult.ok) {
            throw new Error(`项目保存失败，未调用生图服务：${saveResult.error ?? "未知错误"}`);
          }
          if (!submissionFlow.nodes.some((candidate) => candidate.id === id)) {
            throw new Error("项目或节点已关闭，未调用生图服务");
          }
          let response: Response;
          try {
            response = await fetch("/api/run-plan", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                nodes: submissionFlow.nodes,
                edges: submissionFlow.edges,
                onlyNodeId: id,
                includeDownstream: false,
                projectId: submissionSnapshot.projectId,
                clientRequestId,
              }),
            });
          } catch (error) {
            rememberAmbiguousRunRequest(submissionKey, clientRequestId);
            const message = error instanceof Error ? error.message : String(error);
            throw new AmbiguousRunSubmissionError(`生成请求已发出，但响应未送达：${message}`);
          }
          let payload: { runId?: string; error?: string };
          try {
            payload = await response.json() as { runId?: string; error?: string };
          } catch {
            if (response.ok) {
              rememberAmbiguousRunRequest(submissionKey, clientRequestId);
              throw new AmbiguousRunSubmissionError("生成服务已接收请求，但返回内容无法确认");
            }
            payload = {};
          }
          if (
            !response.ok &&
            (response.status === 408 || (response.status === 409 && retryingAmbiguousSubmission))
          ) {
            rememberAmbiguousRunRequest(submissionKey, clientRequestId);
            throw new AmbiguousRunSubmissionError(
              `生成服务返回 HTTP ${response.status}，旧请求可能已创建任务但当前参数已变化`,
            );
          }
          if (!response.ok && response.status < 500) clearAmbiguousRunRequest(submissionKey);
          if (!response.ok && response.status >= 500) {
            rememberAmbiguousRunRequest(submissionKey, clientRequestId);
            throw new AmbiguousRunSubmissionError(
              `生成服务返回 HTTP ${response.status}，无法确认是否已创建任务`,
            );
          }
          if (response.ok && !payload.runId) {
            rememberAmbiguousRunRequest(submissionKey, clientRequestId);
            throw new AmbiguousRunSubmissionError("生成服务已接收请求，但未返回可确认的运行编号");
          }
          if (!response.ok || !payload.runId) {
            throw new Error(responseErrorMessage(response.status, payload));
          }
          clearAmbiguousRunRequest(submissionKey);
          knownRunId = payload.runId;

          set((state) => recentResultsPatch(
            state,
            state.recentResults.map((record) =>
              record.id === recordId || record.id.startsWith(`${recordId}:pending:`)
                ? { ...record, runId: payload.runId }
              : record,
            ),
          ));
          runPreparations.delete(preparationKey);

          const runStatus = await fetch(`/api/run-plan/${encodeURIComponent(payload.runId)}`);
          if (!runStatus.ok) {
            throw new Error(
              runStatus.status === 404
                ? "服务已重启或运行状态已丢失，请重新发起任务"
                : `确认运行状态失败（HTTP ${runStatus.status}）`,
            );
          }

          await consumeRunEvents(payload.runId, id, (event) => {
            if (event.type !== "node-status" || event.nodeId !== id) return;
            set((state) => recentResultsPatch(
              state,
              applyRunEventToRecentResults(state.recentResults, recordId, event),
            ));
            updateTabFromRunEvent(set, target, id, event);
            if (isNodeRunTerminal(event.status)) terminalRecorded = true;
          });
        } catch (err) {
          if (!terminalRecorded) {
            const message = err instanceof Error ? err.message : String(err);
            const status: "retry_wait" | "outcome_unknown" | "error" = knownRunId
              ? "retry_wait"
              : err instanceof AmbiguousRunSubmissionError ? "outcome_unknown" : "error";
            const safeMessage = knownRunId
              ? `运行 ${knownRunId} 已创建，但状态同步中断：${message}；请刷新页面继续同步，勿重复提交`
              : err instanceof AmbiguousRunSubmissionError
                ? `${message}；再次点击会使用同一请求号安全确认，请勿新建重复任务`
                : message;
            const event: NodeStatusRunEvent = {
                type: "node-status",
                nodeId: id,
                status,
                error: safeMessage,
                startedAt: localStartedAt,
                ...(isNodeRunTerminal(status) ? { finishedAt: Date.now() } : {}),
              };
            set((state) => recentResultsPatch(
              state,
              applyRunEventToRecentResults(state.recentResults, recordId, event),
            ));
            updateTabFromRunEvent(set, target, id, event);
          }
        } finally {
          runPreparations.delete(preparationKey);
        }
      },

      saveProject: async () => {
        // Capture the invoking tab before awaiting a real dragStop/cancel. A tab
        // switch must save the rolled-back source tab, never the new active tab.
        flushActiveTextEdit();
        const target = selectActiveDocumentTarget(get());
        return (await saveTab(target)).ok;
      },

      undo: () => {
        flushActiveTextEdit();
        if (deferHistoryCommandUntilSettlement("undo")) return;
        applyActiveTemporalHistory("undo");
      },
      redo: () => {
        flushActiveTextEdit();
        if (deferHistoryCommandUntilSettlement("redo")) return;
        applyActiveTemporalHistory("redo");
      },

      loadFlow: ({ projectId, projectName, nodes, edges, markDirty = false }) => {
        flushActiveTextEdit();
        cancelHistoryTransaction();
        const state = get();
        const activeByNode = latestActiveRecordsByNode(state.recentResults, projectId);
        const loadedNodes = nodes.map((node) => {
          const active = activeByNode.get(node.id);
          return active
            ? {
              ...node,
              data: { ...node.data, status: active.status, error: active.error } as WorkflowNodeData,
            }
            : node;
        });
        const selection = normalizeNodeSelection(loadedNodes, []);
        const current = selectActiveDocument(state);
        const tab: ProjectTab = {
          ...current,
          projectId,
          projectName,
          readOnly: false,
          nodes: selection.nodes,
          edges,
          selectedNodeIds: selection.selectedNodeIds,
          selectedNodeId: selection.selectedNodeId,
          selectedResultId: null,
          compareIds: [],
          saveState: markDirty ? "idle" : "saved",
          hasBeenPersisted: !markDirty,
          revision: markDirty ? 1 : 0,
          savedRevision: 0,
          dirty: markDirty,
          documentEpoch: current.documentEpoch + 1,
          lifecycle: markDirty ? "local" : "saved",
          draftRevision: undefined,
          draftSyncedRevision: undefined,
          draftCreatedAt: undefined,
        };
        runWithoutHistory(() => set({
          tabs: replaceTab(state.tabs, tab),
          viewer: null,
          pendingConnectionDraft: null,
          connectionDraftError: null,
        }));
        // 清空撤销历史，避免撤销回上一个项目的画布状态
        temporalHistoryByTab.delete(state.activeTabId);
        useFlowStore.temporal.getState().clear();
      },
    });
    },
    {
      limit: DOCUMENT_HISTORY_LIMIT,
      partialize: (state): FlowTemporalState => ({
        projectName: selectActiveDocument(state).projectName,
        nodes: selectActiveDocument(state).nodes,
        edges: selectActiveDocument(state).edges,
      }),
      equality: sameTemporalDocument,
      handleSet: (handleSet) => {
        // zundo 2.2 的公开类型把内部 recorder 标成 Zustand setState，运行时契约
        // 实际为 (past, replace, current, delta)；Context7 与本地实现均已核对。
        const saveHistory = handleSet as unknown as (
          pastState: FlowTemporalState,
          replace: boolean | undefined,
          currentState: FlowTemporalState,
          deltaState?: Partial<FlowTemporalState> | null,
        ) => void;
        recordHistoryEntry = (pastState, currentState) => {
          saveHistory(pastState, undefined, currentState);
        };
        return (pastState, replace, currentState, deltaState) => {
          if (historySuppressionDepth > 0 || activeHistoryTransaction) return;
          saveHistory(
            pastState as unknown as FlowTemporalState,
            replace,
            currentState,
            deltaState,
          );
        };
      },
    },
  ),
);

export interface ServerInitialDraftSnapshot {
  id: string;
  name: string;
  flow: PersistedWorkflow;
  revision: number;
  lifecycle: "initial_draft";
  createdAt: string;
  updatedAt: string;
}

export function persistedWorkflowForProjectTab(tab: ProjectTab): PersistedWorkflow {
  return documentSnapshotToPersistedWorkflow(createDocumentSnapshot(tab));
}

/** 初始化/冲突解决的单一入口：只替换指定页签的文档，不改写普通新建与打开语义。 */
export function applyServerInitialDraftToTab(
  tabId: string,
  draft: ServerInitialDraftSnapshot,
  options?: {
    dirty?: boolean;
    localDocumentRevision?: number;
    preserveReplacedAsBackup?: { projectId: string; flow: PersistedWorkflow };
  },
): boolean {
  flushActiveTextEdit();
  cancelHistoryTransaction();
  const state = useFlowStore.getState();
  const source = state.tabs.find((tab) => tab.id === tabId);
  if (!source || source.readOnly) return false;
  const dirty = options?.dirty === true;
  const revision = Math.max(
    dirty ? 1 : 0,
    finiteNonNegative(options?.localDocumentRevision, draft.revision),
  );
  const selection = normalizeNodeSelection(draft.flow.nodes as FlowNode[], []);
  const serverTab: ProjectTab = {
    ...source,
    projectId: draft.id,
    projectName: draft.name,
    readOnly: false,
    nodes: selection.nodes,
    edges: draft.flow.edges as Edge[],
    selectedNodeIds: selection.selectedNodeIds,
    selectedNodeId: selection.selectedNodeId,
    selectedResultId: null,
    compareIds: [],
    saveState: "idle",
    hasBeenPersisted: false,
    revision,
    savedRevision: 0,
    dirty,
    documentEpoch: source.documentEpoch + (source.projectId === draft.id ? 0 : 1),
    lifecycle: "initial_draft",
    draftRevision: draft.revision,
    draftSyncedRevision: revision,
    draftCreatedAt: draft.createdAt,
  };
  let tabs = state.tabs
    .filter((tab) => tab.id === tabId || tab.projectId !== draft.id)
    .map((tab) => tab.id === tabId ? serverTab : tab);
  if (options?.preserveReplacedAsBackup) {
    const prepared = options.preserveReplacedAsBackup;
    const selection = normalizeNodeSelection(prepared.flow.nodes as FlowNode[], source.selectedNodeIds);
    const backup: ProjectTab = {
      ...source,
      id: nanoid(10),
      projectId: prepared.projectId,
      projectName: `${source.projectName}（本机备份）`,
      nodes: selection.nodes,
      edges: prepared.flow.edges as Edge[],
      selectedNodeIds: selection.selectedNodeIds,
      selectedNodeId: selection.selectedNodeId,
      selectedResultId: null,
      compareIds: [],
      saveState: "idle",
      hasBeenPersisted: false,
      revision: Math.max(1, source.revision),
      savedRevision: 0,
      dirty: true,
      documentEpoch: source.documentEpoch + 1,
      lifecycle: "local",
      draftRevision: undefined,
      draftSyncedRevision: undefined,
      draftCreatedAt: undefined,
    };
    const index = tabs.findIndex((tab) => tab.id === tabId);
    tabs = [...tabs.slice(0, index + 1), backup, ...tabs.slice(index + 1)];
  }
  runWithoutHistory(() => useFlowStore.setState({ tabs, activeTabId: tabId, viewer: null }));
  temporalHistoryByTab.delete(tabId);
  useFlowStore.temporal.getState().clear();
  return true;
}

export function markInitialDraftSynced(
  target: DocumentTarget,
  localRevision: number,
  expectedDraftRevision: number,
  nextDraftRevision: number,
): boolean {
  let matched = false;
  runWithoutHistory(() => {
    patchDocumentTarget(useFlowStore.setState, target, (tab) => {
      if (
        projectTabLifecycle(tab) !== "initial_draft" ||
        (tab.draftRevision ?? 0) !== expectedDraftRevision
      ) return {};
      matched = true;
      return {
        draftRevision: nextDraftRevision,
        draftSyncedRevision: Math.max(tab.draftSyncedRevision ?? 0, localRevision),
      };
    });
  });
  return matched;
}

export function replaceAbandonedInitialDraftWithFreshLocalTab(tabId: string): ProjectTab | undefined {
  flushActiveTextEdit();
  cancelHistoryTransaction();
  const state = useFlowStore.getState();
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0 || projectTabLifecycle(state.tabs[index]) !== "initial_draft") return undefined;
  const fresh = newTab();
  const tabs = [...state.tabs];
  tabs[index] = fresh;
  runWithoutHistory(() => useFlowStore.setState({
    tabs,
    activeTabId: state.activeTabId === tabId ? fresh.id : state.activeTabId,
    viewer: null,
  }));
  temporalHistoryByTab.delete(tabId);
  temporalHistoryByTab.delete(fresh.id);
  if (state.activeTabId === tabId) useFlowStore.temporal.getState().clear();
  return fresh;
}

/**
 * 服务器尚无初始草稿时创建全新身份。只替换真正空白的本地占位页签；
 * 已保存或有意义的页签会被保留，并在旁边追加初始草稿。
 */
export function createFreshLocalTabForInitialDraft(placeholderTabId: string): ProjectTab | undefined {
  flushActiveTextEdit();
  cancelHistoryTransaction();
  const state = useFlowStore.getState();
  const index = state.tabs.findIndex((tab) => tab.id === placeholderTabId);
  if (index < 0) return undefined;
  const placeholder = state.tabs[index];
  const fresh = newTab();
  const replacePlaceholder = (
    projectTabLifecycle(placeholder) === "local" &&
    !placeholder.hasBeenPersisted &&
    isPristineProjectTab(placeholder)
  );
  const tabs = replacePlaceholder
    ? state.tabs.map((tab) => tab.id === placeholderTabId ? fresh : tab)
    : [...state.tabs, fresh];
  stashActiveTemporalHistory(state.activeTabId);
  runWithoutHistory(() => useFlowStore.setState({
    tabs,
    activeTabId: fresh.id,
    viewer: null,
  }));
  if (replacePlaceholder) temporalHistoryByTab.delete(placeholderTabId);
  temporalHistoryByTab.delete(fresh.id);
  useFlowStore.temporal.getState().clear();
  return fresh;
}

// zundo's native replay merges the partialized value into the root Zustand
// store. Our partial value is an active-tab document, so expose the same public
// API through the canonical FlowState commands instead of permitting orphaned
// root projectName/nodes/edges keys to be written.
useFlowStore.temporal.setState({
  undo: (steps = 1) => {
    const count = Number.isFinite(steps) ? Math.max(0, Math.floor(steps)) : 1;
    for (let index = 0; index < count; index += 1) useFlowStore.getState().undo();
  },
  redo: (steps = 1) => {
    const count = Number.isFinite(steps) ? Math.max(0, Math.floor(steps)) : 1;
    for (let index = 0; index < count; index += 1) useFlowStore.getState().redo();
  },
});

/**
 * 登记不会进入项目快照的蒙版临时工作。返回值可重复调用，确保 React effect
 * cleanup 与异步 finally 竞态时不会把计数减成负数。
 */
export function beginMaskWork(): () => void {
  useFlowStore.setState((state) => ({
    pendingMaskWorkCount: state.pendingMaskWorkCount + 1,
  }));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    useFlowStore.setState((state) => ({
      pendingMaskWorkCount: Math.max(0, state.pendingMaskWorkCount - 1),
    }));
  };
}

let retryTabSessionPersistenceImpl = (): boolean => false;
let flushTabSessionPersistenceImpl = (): boolean => false;

/** 用户显式重试当前完整页签快照；返回本次是否成功写入浏览器会话。 */
export function retryTabSessionPersistence(): boolean {
  return retryTabSessionPersistenceImpl();
}

/** 生命周期收口：同步写入最新稳定草稿，不等待 debounce / idle。 */
export function flushTabSessionPersistence(): boolean {
  return flushTabSessionPersistenceImpl();
}

if (typeof window !== "undefined") {
  const bootstrapStorageUnreadable = initialTabSessionReadResult?.unreadable === true;
  const storedTabMarkers = new Map<string, string>();
  const attemptedTabMarkers = new Map<string, string>();
  const failedTabIds = new Set<string>();
  let tabSessionPersistenceDeferred = false;
  let tabSessionPersistencePending = false;
  let forceRetryPending = false;
  let idleHandle: number | null = null;
  let debounceHandle: number | null = null;

  const tabMarker = (tab: ProjectTab): string => [
    tab.projectId,
    tab.documentEpoch,
    tab.revision,
    tab.savedRevision,
    tab.dirty ? 1 : 0,
    tab.readOnly ? 1 : 0,
    tab.saveState,
    tab.hasBeenPersisted ? 1 : 0,
    projectTabLifecycle(tab),
    tab.draftRevision ?? "",
    tab.draftSyncedRevision ?? "",
    tab.draftCreatedAt ?? "",
  ].join("\u0000");
  const persistenceSignalChanged = (state: FlowState, previous: FlowState): boolean => {
    if (state.activeTabId !== previous.activeTabId || state.tabs.length !== previous.tabs.length) {
      return true;
    }
    return state.tabs.some((tab, index) => {
      const previousTab = previous.tabs[index];
      return !previousTab || tab.id !== previousTab.id || tabMarker(tab) !== tabMarker(previousTab);
    });
  };
  const publishPersistenceResult = (result: TabSessionWriteResult): void => {
    const nextError = result.ok ? null : result.error ?? TAB_SESSION_WRITE_ERROR;
    if (useFlowStore.getState().tabSessionPersistenceError !== nextError) {
      useFlowStore.setState({ tabSessionPersistenceError: nextError });
    }
  };

  const cancelScheduledPersistence = () => {
    if (idleHandle !== null && typeof window.cancelIdleCallback === "function") {
      window.cancelIdleCallback(idleHandle);
    }
    if (debounceHandle !== null) window.clearTimeout(debounceHandle);
    idleHandle = null;
    debounceHandle = null;
  };

  const persistLatestStableState = (
    forceRetry: boolean,
    allowTransactionRebase = false,
  ): boolean => {
    cancelScheduledPersistence();
    const currentState = useFlowStore.getState();
    if (bootstrapStorageUnreadable) {
      tabSessionPersistenceDeferred = false;
      tabSessionPersistencePending = false;
      forceRetryPending = false;
      publishPersistenceResult({ ok: false, error: TAB_SESSION_READ_ERROR });
      return false;
    }
    if (isProjectTabSessionPersistenceSuspended()) {
      tabSessionPersistenceDeferred = false;
      tabSessionPersistencePending = false;
      forceRetryPending = false;
      return false;
    }
    const transaction = activeHistoryTransaction;
    if (transaction && !allowTransactionRebase) {
      if (forceRetry) forceRetryPending = true;
      tabSessionPersistenceDeferred = true;
      tabSessionPersistencePending = true;
      return false;
    }
    const retryAllTabs = forceRetry || forceRetryPending;
    forceRetryPending = false;
    const state = transaction
      ? {
          ...currentState,
          tabs: currentState.tabs.map((tab) => {
            if (tab.id !== transaction.tabId) return tab;
            const stableDocument = rebaseDocumentOutsideTransaction(
              temporalDocument(tab),
              transaction,
            );
            return { ...tab, ...stableDocument };
          }),
        }
      : currentState;
    tabSessionPersistenceDeferred = false;
    tabSessionPersistencePending = false;

    const currentIds = new Set(state.tabs.map((tab) => tab.id));
    for (const tabId of [...storedTabMarkers.keys()]) {
      if (!currentIds.has(tabId)) storedTabMarkers.delete(tabId);
    }
    for (const tabId of [...attemptedTabMarkers.keys()]) {
      if (!currentIds.has(tabId)) attemptedTabMarkers.delete(tabId);
    }
    for (const tabId of [...failedTabIds]) {
      if (!currentIds.has(tabId)) failedTabIds.delete(tabId);
    }

    const writeTabIds = new Set<string>();
    for (const tab of state.tabs) {
      const marker = tabMarker(tab);
      if (retryAllTabs || attemptedTabMarkers.get(tab.id) !== marker) writeTabIds.add(tab.id);
    }
    const result = persistTabSession(state, {
      writeTabIds,
      knownPersistedTabIds: new Set(storedTabMarkers.keys()),
      unresolvedTabIds: new Set(failedTabIds),
    });
    const persistedIds = new Set(result.persistedTabIds);
    const indeterminateThisAttempt = new Set(result.indeterminateTabIds ?? []);
    const failedThisAttempt = new Set(
      (result.failedTabIds ?? []).filter((tabId) => !indeterminateThisAttempt.has(tabId)),
    );
    for (const tabId of failedThisAttempt) {
      failedTabIds.add(tabId);
      storedTabMarkers.delete(tabId);
    }
    for (const tab of state.tabs) {
      if (!writeTabIds.has(tab.id)) continue;
      const marker = tabMarker(tab);
      attemptedTabMarkers.set(tab.id, marker);
      if (!failedThisAttempt.has(tab.id) && persistedIds.has(tab.id)) {
        failedTabIds.delete(tab.id);
        storedTabMarkers.set(tab.id, marker);
      }
    }
    const unresolvedFailure = [...failedTabIds].some((tabId) => currentIds.has(tabId));
    const ok = result.manifestWritten && !unresolvedFailure;
    publishPersistenceResult({
      ok,
      ...(!ok ? { error: result.error ?? TAB_SESSION_WRITE_ERROR } : {}),
    });
    return ok;
  };

  const runScheduledPersistence = () => {
    idleHandle = null;
    if (!tabSessionPersistencePending) return;
    persistLatestStableState(false);
  };
  const scheduleIdlePersistence = () => {
    if (typeof window.requestIdleCallback === "function") {
      let ranSynchronously = false;
      const handle = window.requestIdleCallback(() => {
        ranSynchronously = true;
        runScheduledPersistence();
      }, { timeout: 500 });
      if (!ranSynchronously) idleHandle = handle;
      return;
    }
    runScheduledPersistence();
  };
  const scheduleTabSessionPersistence = () => {
    if (bootstrapStorageUnreadable) return;
    if (isProjectTabSessionPersistenceSuspended()) return;
    tabSessionPersistencePending = true;
    cancelScheduledPersistence();
    let ranSynchronously = false;
    const handle = window.setTimeout(() => {
      ranSynchronously = true;
      debounceHandle = null;
      scheduleIdlePersistence();
    }, 250);
    if (!ranSynchronously) debounceHandle = handle;
  };

  flushDeferredTabSessionPersistence = () => {
    if (activeHistoryTransaction) {
      tabSessionPersistenceDeferred = true;
      return;
    }
    if (!tabSessionPersistenceDeferred && !tabSessionPersistencePending) return;
    tabSessionPersistenceDeferred = false;
    scheduleTabSessionPersistence();
  };
  retryTabSessionPersistenceImpl = () => persistLatestStableState(true);
  flushTabSessionPersistenceImpl = () => persistLatestStableState(false, true);
  flushPendingTabSessionPersistence = () => {
    if (!tabSessionPersistencePending && !tabSessionPersistenceDeferred) return true;
    return persistLatestStableState(false);
  };

  useFlowStore.subscribe((state, previousState) => {
    if (!persistenceSignalChanged(state, previousState)) return;
    if (activeHistoryTransaction) {
      tabSessionPersistenceDeferred = true;
      tabSessionPersistencePending = true;
      return;
    }
    scheduleTabSessionPersistence();
  });

  const initialState = useFlowStore.getState();
  const restoredManifest = initialTabSessionReadResult?.manifest;
  if (bootstrapStorageUnreadable) {
    publishPersistenceResult({ ok: false, error: TAB_SESSION_READ_ERROR });
  } else if (restoredManifest) {
    clearUnreferencedProjectTabSessionStorage(
      window.sessionStorage,
      new Set(restoredManifest.tabIds),
    );
    for (const tab of initialState.tabs) {
      if (!restoredManifest.tabIds.includes(tab.id)) continue;
      const marker = tabMarker(tab);
      storedTabMarkers.set(tab.id, marker);
      attemptedTabMarkers.set(tab.id, marker);
    }
    const recoveredIds = initialState.tabs.map((tab) => tab.id);
    const manifestMatches = (
      restoredManifest.activeTabId === initialState.activeTabId &&
      restoredManifest.tabIds.length === recoveredIds.length &&
      restoredManifest.tabIds.every((tabId, index) => tabId === recoveredIds[index])
    );
    if (!manifestMatches) scheduleTabSessionPersistence();
  } else {
    persistLatestStableState(true);
  }
}

/** 登录后以服务器历史为准，恢复仍在当前服务进程中执行的任务。 */
export function resumeRecentResults(records: RecentResult[]): void {
  const resumable = records.filter(
    (record) =>
      isNodeRunActive(record.status) && Boolean(record.runId),
  );
  for (const record of resumable) {
    const runId = record.runId!;
    if (resumingRecentRunIds.has(runId)) continue;
    resumingRecentRunIds.add(runId);
    void (async () => {
      let terminalRecorded = false;
      try {
        const response = await fetch(`/api/run-plan/${encodeURIComponent(runId)}`);
        if (!response.ok) {
          throw new Error(
            response.status === 404
              ? "服务已重启或恢复窗口已过，无法继续跟踪此任务"
              : `恢复任务失败（HTTP ${response.status}）`,
          );
        }
        await consumeRunEvents(runId, record.nodeId, (event) => {
          if (event.type !== "node-status" || event.nodeId !== record.nodeId) return;
          useFlowStore.setState((state) => recentResultsPatch(
            state,
            applyRunEventToRecentResults(state.recentResults, record.id, event),
          ));
          const tab = useFlowStore
            .getState()
            .tabs.find((candidate) => candidate.projectId === record.projectId);
          if (tab && event.status && isLatestTrackedRun(useFlowStore.getState().recentResults, record)) {
            updateTabFromRunEvent(useFlowStore.setState, documentTarget(tab), record.nodeId, event);
          }
          if (isNodeRunTerminal(event.status)) terminalRecorded = true;
        });
      } catch (error) {
        if (terminalRecorded) return;
        const message = error instanceof Error ? error.message : String(error);
        const recoveryMessage = `运行 ${runId} 的状态同步中断：${message}；请稍后重试同步，勿重复提交`;
        useFlowStore.setState((state) => recentResultsPatch(
          state,
          applyRunEventToRecentResults(state.recentResults, record.id, {
            type: "node-status",
            nodeId: record.nodeId,
            status: "retry_wait",
            error: recoveryMessage,
            startedAt: record.startedAt,
          }),
        ));
        const tab = useFlowStore
          .getState()
          .tabs.find((candidate) => candidate.projectId === record.projectId);
        if (tab && isLatestTrackedRun(useFlowStore.getState().recentResults, record)) {
          updateTabFromRunEvent(useFlowStore.setState, documentTarget(tab), record.nodeId, {
            type: "node-status",
            nodeId: record.nodeId,
            status: "retry_wait",
            error: recoveryMessage,
            startedAt: record.startedAt,
          });
        }
      } finally {
        // 成功、后端失败、恢复查询失败都必须释放，允许后续重试。
        resumingRecentRunIds.delete(runId);
      }
    })();
  }
}

/** 测试与外部恢复入口也必须复用同一套节点回写规则。 */
export function applyRunEventToTab(
  target: DocumentTarget,
  nodeId: string,
  event: NodeStatusRunEvent,
): void {
  updateTabFromRunEvent(useFlowStore.setState, target, nodeId, event);
}

/** 优先读取 result 快照；旧的空快照节点继续聚合直接上游媒体。 */
export function selectResultImages(state: FlowState, nodeId: string): string[] {
  const document = selectActiveDocument(state);
  const result = document.nodes.find((node) => node.id === nodeId);
  if (result?.data.kind === "result" && result.data.images.length > 0) return result.data.images;
  const urls: string[] = [];
  for (const e of document.edges) {
    if (e.target !== nodeId) continue;
    const src = document.nodes.find((n) => n.id === e.source);
    if (src) urls.push(...nodeOutputImages(src.data, e.sourceHandle));
  }
  return urls;
}

/** 按连线顺序读取节点当前可见的上游图片，蒙版编辑器以第一张作为原图。 */
export function selectNodeInputImages(
  document: Pick<ProjectTab, "nodes" | "edges">,
  nodeId: string,
): string[] {
  return effectiveIncomingSources(document.nodes, document.edges, nodeId)
    .flatMap(({ node, sourceHandle }) => nodeOutputImages(node.data, sourceHandle));
}

/** Active-tab wrapper used by React subscriptions; the leaf result stays stable. */
export function selectActiveNodeInputImages(state: FlowState, nodeId: string): string[] {
  return selectNodeInputImages(selectActiveDocument(state), nodeId);
}

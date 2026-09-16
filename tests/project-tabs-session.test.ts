import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prepareWorkspaceForLogin } from "../src/auth/session";
import { setGenerationSafetyBlockReason } from "../src/store/generationSafety";
import type { DocumentTarget } from "../src/store/flowStore";
import {
  clearUnreferencedProjectTabSessionStorage,
  PROJECT_TAB_STORAGE_KEY_PREFIX,
  projectTabStorageKey,
} from "../src/lib/tabSessionStorage";

interface MemoryStorage {
  readonly length: number;
  getItem(key: string): string | null;
  key(index: number): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  has(key: string): boolean;
}

function memoryStorage(
  initial: Record<string, string> = {},
  onSet?: (key: string) => void,
  shouldFail?: (key: string, value: string) => boolean,
): MemoryStorage {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    setItem: (key, value) => {
      onSet?.(key);
      if (shouldFail?.(key, value)) {
        const error = new Error("quota exceeded");
        error.name = "QuotaExceededError";
        throw error;
      }
      values.set(key, value);
    },
    removeItem: (key) => values.delete(key),
    has: (key) => values.has(key),
  };
}

function storedSelectionNode(id: string, selected?: boolean) {
  return {
    id,
    type: "image-input",
    position: { x: 0, y: 0 },
    data: {
      kind: "image-input",
      label: id,
      status: "idle",
      imageRole: "default",
    },
    ...(selected === undefined ? {} : { selected }),
  };
}

function storedSelectionTab(
  id: string,
  nodes: ReturnType<typeof storedSelectionNode>[],
  selection: {
    selectedNodeIds?: unknown;
    selectedNodeId?: unknown;
  } = {},
) {
  return {
    id,
    projectId: `project-${id}`,
    projectName: `项目 ${id}`,
    nodes,
    edges: [],
    selectedResultId: null,
    compareIds: [],
    saveState: "idle",
    revision: 0,
    savedRevision: 0,
    dirty: false,
    documentEpoch: 0,
    ...selection,
  };
}

const sessionKey = "garment-canvas-project-tabs";
const recentKey = "garment-canvas-recent-results";
const restoredEdge = { id: "edge-a-b", source: "node-a", target: "node-b" };
const storedSession = {
  activeTabId: "tab-a",
  tabs: [
    {
      id: "tab-a",
      projectId: "project-a",
      projectName: "项目 A",
      nodes: [
        {
          id: "node-a",
          type: "image-input",
          position: { x: 0, y: 0 },
          data: {
            kind: "image-input",
            label: "输入",
            status: "idle",
            imageRole: "default",
          },
        },
        {
          id: "node-b",
          type: "result",
          position: { x: 300, y: 0 },
          data: { kind: "result", label: "结果", status: "idle", images: [] },
        },
      ],
      edges: [restoredEdge],
      selectedNodeId: null,
      selectedResultId: null,
      compareIds: [],
      saveState: "saving",
      revision: 3,
      savedRevision: 2,
      dirty: true,
      documentEpoch: 0,
    },
  ],
};

const storedRecentResults = [
  {
    id: "record-project-b",
    image: "/api/files/project-b.png",
    nodeId: "node-project-b",
    nodeLabel: "项目 B 的生成记录",
    kind: "ai-modify",
    projectId: "project-b",
    projectName: "项目 B",
    startedAt: 1_000,
    finishedAt: 2_000,
    status: "success",
  },
  {
    id: "record-legacy",
    image: "/api/files/legacy.png",
    nodeId: "node-legacy",
    nodeLabel: "旧版生成记录",
    kind: "sketch-to-render",
    startedAt: 3_000,
    finishedAt: 4_000,
    status: "success",
  },
];

let sessionWrites = 0;
const sessionWriteKeys: string[] = [];
let failSessionWrites = false;
let failedSessionTabId: string | null = null;
const sessionStorage = memoryStorage(
  { [sessionKey]: JSON.stringify(storedSession) },
  (key) => {
    if (key === sessionKey || key.startsWith(PROJECT_TAB_STORAGE_KEY_PREFIX)) {
      sessionWrites += 1;
      sessionWriteKeys.push(key);
    }
  },
  (key) => failSessionWrites && key === (
    failedSessionTabId ? projectTabStorageKey(failedSessionTabId) : sessionKey
  ),
);
const localStorage = memoryStorage({ [recentKey]: JSON.stringify(storedRecentResults) });
let deferIdleWrites = false;
let nextScheduledCallbackId = 0;
const idleCallbacks = new Map<number, IdleRequestCallback>();
const timeoutCallbacks = new Map<number, () => void>();
const runIdleCallback = (callback: IdleRequestCallback) => callback({
  didTimeout: false,
  timeRemaining: () => 50,
});
const requestIdleCallback = (callback: IdleRequestCallback): number => {
  const id = ++nextScheduledCallbackId;
  if (deferIdleWrites) idleCallbacks.set(id, callback);
  else runIdleCallback(callback);
  return id;
};
const cancelIdleCallback = (id: number) => { idleCallbacks.delete(id); };
const setWindowTimeout = (callback: () => void): number => {
  const id = ++nextScheduledCallbackId;
  if (deferIdleWrites) timeoutCallbacks.set(id, callback);
  else callback();
  return id;
};
const clearWindowTimeout = (id: number) => { timeoutCallbacks.delete(id); };
function flushIdleCallbacks(): void {
  while (timeoutCallbacks.size > 0 || idleCallbacks.size > 0) {
    const pendingTimeouts = [...timeoutCallbacks.values()];
    timeoutCallbacks.clear();
    for (const callback of pendingTimeouts) callback();
    const pendingIdle = [...idleCallbacks.values()];
    idleCallbacks.clear();
    for (const callback of pendingIdle) runIdleCallback(callback);
  }
}
Object.assign(globalThis, {
  window: {
    sessionStorage,
    localStorage,
    requestIdleCallback,
    cancelIdleCallback,
    setTimeout: setWindowTimeout,
    clearTimeout: clearWindowTimeout,
  },
});

const {
  applyRunEventToRecentResults,
  applyRunEventToTab,
  beginHistoryTransaction,
  discardActiveTabSession,
  endHistoryTransaction,
  flushActiveTextEdit,
  flushTabSessionPersistence,
  normalizeTabSessionValue,
  readTabSessionSnapshot,
  readTabSessionSnapshotResult,
  reconcileRunHistory,
  retryTabSessionPersistence,
  selectActiveDocument,
  TAB_SESSION_SCHEMA_VERSION,
  updateCoalescedTextEdit,
  useFlowStore,
  writeTabSessionSnapshot,
} = await import("../src/store/flowStore");
const { createTemplateRequestPayload } = await import(
  "../src/components/panels/TemplatesDock"
);

function activeDocument(state = useFlowStore.getState()) {
  return selectActiveDocument(state);
}

function persistedSession() {
  const session = readTabSessionSnapshot(sessionStorage);
  assert.ok(session, "应存在可恢复的项目页签会话");
  return session;
}

function persistedSessionJson(): string {
  return JSON.stringify(persistedSession());
}

function documentTargetForTab(tabId: string): DocumentTarget {
  const tab = useFlowStore.getState().tabs.find((candidate) => candidate.id === tabId);
  assert.ok(tab, `找不到页签 ${tabId}`);
  return { tabId, projectId: tab.projectId, documentEpoch: tab.documentEpoch };
}

// 本文件模拟的是历史已经完成对账后的会话恢复路径。
setGenerationSafetyBlockReason(null);
const state = useFlowStore.getState();
const document = activeDocument(state);

console.log("项目页签会话恢复测试");

assert.deepEqual(document.edges, [restoredEdge]);
assert.deepEqual(state.tabs[0].edges, [restoredEdge]);
console.log("  ✓ 刷新恢复活动页签的完整连线");

assert.equal(document.saveState, "idle");
assert.equal(state.tabs[0].saveState, "idle");
assert.equal(document.dirty, true);
console.log("  ✓ 刷新将中断的 saving 状态归一为 idle 并保留未保存标记");

const persisted = persistedSession();
assert.deepEqual(persisted.tabs[0].edges, [restoredEdge]);
assert.equal(persisted.tabs[0].saveState, "idle");
assert.equal((persisted as typeof storedSession & { schemaVersion: number }).schemaVersion, TAB_SESSION_SCHEMA_VERSION);
console.log("  ✓ 初始化持久化不会再次覆盖恢复后的连线或保存状态");

const migratedLegacySelection = normalizeTabSessionValue({
  activeTabId: "legacy-selection-tab",
  tabs: [storedSelectionTab(
    "legacy-selection-tab",
    [storedSelectionNode("legacy-node-a"), storedSelectionNode("legacy-node-b")],
    { selectedNodeId: "legacy-node-b" },
  )],
});
assert.ok(migratedLegacySelection);
assert.deepEqual(migratedLegacySelection.tabs[0].selectedNodeIds, ["legacy-node-b"]);
assert.equal(migratedLegacySelection.tabs[0].selectedNodeId, "legacy-node-b");
assert.deepEqual(
  migratedLegacySelection.tabs[0].nodes.map((node) => [node.id, Boolean(node.selected)]),
  [["legacy-node-a", false], ["legacy-node-b", true]],
);
console.log("  ✓ 旧 selectedNodeId 会迁移为 canonical selectedNodeIds");

const filteredInvalidSelection = normalizeTabSessionValue({
  activeTabId: "invalid-selection-tab",
  tabs: [storedSelectionTab(
    "invalid-selection-tab",
    [storedSelectionNode("valid-node-a"), storedSelectionNode("valid-node-b")],
    { selectedNodeIds: ["missing-node", "valid-node-b"] },
  )],
});
assert.ok(filteredInvalidSelection);
assert.deepEqual(filteredInvalidSelection.tabs[0].selectedNodeIds, ["valid-node-b"]);
assert.equal(filteredInvalidSelection.tabs[0].selectedNodeId, "valid-node-b");
assert.deepEqual(
  filteredInvalidSelection.tabs[0].nodes.map((node) => [node.id, Boolean(node.selected)]),
  [["valid-node-a", false], ["valid-node-b", true]],
);
console.log("  ✓ canonical selectedNodeIds 会过滤当前页签不存在的节点");

const canonicalSelectionWins = normalizeTabSessionValue({
  activeTabId: "canonical-selection-tab",
  tabs: [storedSelectionTab(
    "canonical-selection-tab",
    [storedSelectionNode("raw-selected-node", true), storedSelectionNode("canonical-node", false)],
    {
      selectedNodeIds: ["canonical-node"],
      selectedNodeId: "raw-selected-node",
    },
  )],
});
assert.ok(canonicalSelectionWins);
assert.deepEqual(canonicalSelectionWins.tabs[0].selectedNodeIds, ["canonical-node"]);
assert.equal(canonicalSelectionWins.tabs[0].selectedNodeId, "canonical-node");
assert.deepEqual(
  canonicalSelectionWins.tabs[0].nodes.map((node) => [node.id, Boolean(node.selected)]),
  [["raw-selected-node", false], ["canonical-node", true]],
);
console.log("  ✓ canonical selectedNodeIds 覆盖旧 selectedNodeId 与原始 node.selected");

const transientDraggingIsDiscarded = normalizeTabSessionValue({
  activeTabId: "dragging-session-tab",
  tabs: [storedSelectionTab(
    "dragging-session-tab",
    [{ ...storedSelectionNode("dragging-node"), dragging: true }],
  )],
});
assert.ok(transientDraggingIsDiscarded);
assert.equal(transientDraggingIsDiscarded.tabs[0].nodes[0].dragging, undefined);
console.log("  ✓ 会话恢复丢弃中断拖拽遗留的 dragging 瞬态");

const isolatedTabSelections = normalizeTabSessionValue({
  activeTabId: "selection-tab-b",
  tabs: [
    storedSelectionTab(
      "selection-tab-a",
      [storedSelectionNode("tab-a-node-1", true), storedSelectionNode("tab-a-node-2", false)],
      { selectedNodeIds: ["tab-a-node-2"] },
    ),
    storedSelectionTab(
      "selection-tab-b",
      [storedSelectionNode("tab-b-node-1", false), storedSelectionNode("tab-b-node-2", true)],
      { selectedNodeIds: ["tab-b-node-1"] },
    ),
  ],
});
assert.ok(isolatedTabSelections);
assert.equal(isolatedTabSelections.activeTabId, "selection-tab-b");
assert.deepEqual(
  isolatedTabSelections.tabs.map((tab) => ({
    id: tab.id,
    selectedNodeIds: tab.selectedNodeIds,
    selectedNodeId: tab.selectedNodeId,
    selectedFlags: tab.nodes.map((node) => [node.id, Boolean(node.selected)]),
  })),
  [
    {
      id: "selection-tab-a",
      selectedNodeIds: ["tab-a-node-2"],
      selectedNodeId: "tab-a-node-2",
      selectedFlags: [["tab-a-node-1", false], ["tab-a-node-2", true]],
    },
    {
      id: "selection-tab-b",
      selectedNodeIds: ["tab-b-node-1"],
      selectedNodeId: "tab-b-node-1",
      selectedFlags: [["tab-b-node-1", true], ["tab-b-node-2", false]],
    },
  ],
);
console.log("  ✓ canonical 节点选择按页签隔离恢复且不会串页");

const clearedResultReferences = normalizeTabSessionValue({
  activeTabId: "stale-result-reference-tab",
  tabs: [{
    ...storedSelectionTab(
      "stale-result-reference-tab",
      [storedSelectionNode("reference-node")],
    ),
    selectedResultId: "result-from-previous-session",
    compareIds: ["result-from-previous-session", "another-stale-result"],
  }],
});
assert.ok(clearedResultReferences);
assert.equal(clearedResultReferences.tabs[0].selectedResultId, null);
assert.deepEqual(clearedResultReferences.tabs[0].compareIds, []);
console.log("  ✓ 会话不恢复尚未通过当前账号服务器历史确认的结果引用");

const migrated = normalizeTabSessionValue({
  activeTabId: "legacy-tab",
  tabs: [{
    id: "legacy-tab",
    projectId: "legacy-project",
    projectName: "旧项目",
    nodes: [
      {
        id: "legacy-ai",
        type: "ai-modify",
        position: { x: 10, y: 20 },
        data: { kind: "ai-modify", label: "改款", status: "idle", prompt: "换领型" },
      },
      { id: "broken", type: "unknown", position: { x: 0, y: 0 }, data: {} },
      {
        id: "legacy-result",
        type: "result",
        position: { x: 300, y: 20 },
        data: { kind: "result", label: "结果", status: "idle" },
      },
    ],
    edges: [
      { id: "valid-edge", source: "legacy-ai", target: "legacy-result" },
      { id: "dangling-edge", source: "broken", target: "legacy-result" },
    ],
    saveState: "saving",
    revision: 4,
    savedRevision: 4,
    dirty: false,
  }],
});
assert.ok(migrated);
assert.equal(migrated.schemaVersion, TAB_SESSION_SCHEMA_VERSION);
assert.deepEqual(migrated.tabs[0].nodes.map((node) => node.id), ["legacy-ai", "legacy-result"]);
assert.deepEqual(migrated.tabs[0].edges.map((edge) => edge.id), ["valid-edge"]);
const migratedAi = migrated.tabs[0].nodes[0].data;
assert.equal(migratedAi.kind, "ai-modify");
if (migratedAi.kind !== "ai-modify") throw new Error("unexpected node kind");
assert.equal(migratedAi.aspectRatio, "1:1");
assert.equal(migratedAi.batchSize, 1);
assert.deepEqual(migratedAi.outputImages, []);
assert.equal(migrated.tabs[0].saveState, "idle");
assert.equal(migrated.tabs[0].dirty, true);
console.log("  ✓ 旧会话逐节点补齐必需字段，并隔离坏节点和悬空边");

const recoveredStagedSession = normalizeTabSessionValue({
  activeTabId: "staged-session-tab",
  tabs: [{
    id: "staged-session-tab",
    projectId: "staged-session-project",
    projectName: "旧页面分步换装",
    nodes: [
      ...["person", "scene", "outfit"].map((id) => ({
        id, type: "image-input", position: { x: 0, y: 0 },
        data: { kind: "image-input", label: id, status: "idle", imageRole: "reference" },
      })),
      {
        id: "accessory", type: "image-input", position: { x: 0, y: 0 },
        data: { kind: "image-input", label: "配饰参考图", status: "idle", imageRole: "reference" },
      },
      {
        id: "structure", type: "image-input", position: { x: 0, y: 0 },
        data: {
          kind: "image-input", label: "服装结构细节（可选）", status: "idle",
          imageRole: "garment", imageUrl: "/api/files/handbag.png",
        },
      },
      {
        id: "stabilize", type: "virtual-try-on", position: { x: 300, y: 0 },
        data: {
          kind: "virtual-try-on", label: "第一轮", status: "idle", prompt: "", imageSize: "2K",
          modelId: "gemini-3.1-flash-image-preview", modelOptions: { aspectRatio: "3:4", imageSize: "2K" }, outputImages: [],
        },
      },
      {
        id: "refine", type: "virtual-try-on", position: { x: 600, y: 0 },
        data: {
          kind: "virtual-try-on", label: "第二轮", status: "idle", workflowStage: "standard",
          prompt: "", imageSize: "2K", modelId: "gpt-image-2", modelOptions: {}, outputImages: [],
        },
      },
    ],
    edges: [
      { id: "person-stage", source: "person", target: "stabilize", targetHandle: "person" },
      { id: "scene-stage", source: "scene", target: "stabilize", targetHandle: "scene" },
      { id: "outfit-stage", source: "outfit", target: "stabilize", targetHandle: "outfit" },
      { id: "accessory-stage", source: "accessory", target: "stabilize", targetHandle: "accessory" },
      { id: "structure-stabilize", source: "structure", target: "stabilize", targetHandle: "detail" },
      { id: "structure-refine", source: "structure", target: "refine", targetHandle: "detail" },
      { id: "baseline-refine", source: "stabilize", target: "refine", targetHandle: "baseline" },
      { id: "outfit-refine", source: "outfit", target: "refine", targetHandle: "outfit" },
      { id: "stale-person-stage", source: "person", target: "stabilize" },
    ],
  }],
});
assert.ok(recoveredStagedSession);
const recoveredStages = recoveredStagedSession.tabs[0].nodes
  .filter((node) => node.data.kind === "virtual-try-on")
  .map((node) => node.data.kind === "virtual-try-on" && node.data.workflowStage);
assert.deepEqual(recoveredStages, ["scene-stabilize", "garment-refine"]);
const recoveredGemini = recoveredStagedSession.tabs[0].nodes.find((node) => node.id === "stabilize")?.data;
assert.equal(recoveredGemini?.modelId, "gemini-3.1-flash-image");
assert.deepEqual(recoveredGemini?.modelOptions, { aspectRatio: "3:4", imageSize: "2K" });
assert.ok(!recoveredStagedSession.tabs[0].edges.some((edge) => edge.id === "stale-person-stage"));
const recoveredHandbag = recoveredStagedSession.tabs[0].nodes.find((node) => node.id === "structure");
assert.equal(recoveredStagedSession.tabs[0].nodes.find((node) => node.id === "accessory")?.data.label, "鞋履参考图（可选）");
assert.equal(recoveredHandbag?.data.label, "包袋参考图（可选）");
assert.equal(recoveredHandbag?.data.kind === "image-input" && recoveredHandbag.data.imageUrl, "/api/files/handbag.png");
for (const nodeId of ["hat", "ring", "earrings", "bracelet"]) {
  assert.ok(recoveredStagedSession.tabs[0].nodes.some((node) => node.id === nodeId));
}
assert.ok(recoveredStagedSession.tabs[0].nodes.some((node) => node.id === "garment-detail"));
assert.equal(recoveredStagedSession.tabs[0].edges.find((edge) => edge.id === "accessory-stage")?.targetHandle, "shoes");
assert.equal(recoveredStagedSession.tabs[0].edges.find((edge) => edge.id === "structure-stabilize")?.targetHandle, "bag");
assert.ok(recoveredStagedSession.tabs[0].edges.some((edge) => edge.id === "hat-stabilize" && edge.targetHandle === "hat"));
assert.ok(recoveredStagedSession.tabs[0].edges.some((edge) => edge.id === "ring-stabilize" && edge.targetHandle === "ring"));
assert.ok(recoveredStagedSession.tabs[0].edges.some((edge) => edge.id === "earrings-stabilize" && edge.targetHandle === "earrings"));
assert.ok(recoveredStagedSession.tabs[0].edges.some((edge) => edge.id === "bracelet-stabilize" && edge.targetHandle === "bracelet"));
assert.ok(!recoveredStagedSession.tabs[0].edges.some((edge) => edge.id === "structure-refine"));
assert.ok(!recoveredStagedSession.tabs[0].edges.some((edge) => edge.id === "garment-detail-stabilize"));
console.log("  ✓ 旧浏览器会话按角色连线恢复双模型分步节点");

const recoveredPoseRoleSession = normalizeTabSessionValue({
  schemaVersion: TAB_SESSION_SCHEMA_VERSION,
  activeTabId: "pose-role-session",
  tabs: [{
    ...storedSelectionTab("pose-role-session", []),
    nodes: [
      {
        id: "pose", type: "image-input", position: { x: 0, y: 0 },
        data: {
          kind: "image-input", label: "人物姿势参考图（必需）", status: "success",
          imageRole: "reference", imageUrl: "/api/files/pose.png",
          autoConnectTargets: [{ targetNodeId: "stabilize", targetHandle: "pose" }],
        },
      },
      {
        id: "stabilize", type: "virtual-try-on", position: { x: 300, y: 0 },
        data: {
          kind: "virtual-try-on", label: "第一轮", status: "idle",
          workflowStage: "scene-stabilize", prompt: "", imageSize: "2K", aspectRatio: "3:4",
          basisRevision: 0, modelId: "gemini-3.1-flash-image",
          modelOptions: { aspectRatio: "3:4", imageSize: "2K" }, outputImages: [],
        },
      },
    ],
    edges: [{
      id: "pose-role-lost", source: "pose", sourceHandle: "image",
      target: "stabilize", targetHandle: null,
    }],
  }],
});
assert.ok(recoveredPoseRoleSession);
assert.equal(
  recoveredPoseRoleSession.tabs[0].edges[0]?.targetHandle,
  "pose",
  "已声明唯一自动连接目标的姿势边应从旧草稿恢复角色",
);
console.log("  ✓ 姿势参考图草稿可从显式自动连接声明恢复丢失的输入角色");

const recoveredV5NodeFields = normalizeTabSessionValue({
  activeTabId: "v5-node-fields",
  tabs: [{
    ...storedSelectionTab("v5-node-fields", []),
    nodes: [
      { id: "text-v5", type: "text-input", position: { x: 0, y: 0 }, data: { kind: "text-input", label: "说明", status: "idle", text: "面料说明", selectionRange: [0, 2] } },
      { id: "board-v5", type: "drawing-board", position: { x: 100, y: 0 }, data: { kind: "drawing-board", label: "画板", status: "idle", boardVersion: 1, width: 1200, height: 900, background: "#FFFFFF", contentRef: "/api/drawings/content-1", previewImageRef: "/api/files/preview.png", exportImageRef: "/api/files/export.png", drawingRecoveryDraft: { private: true } } },
      {
        id: "palette-v5", type: "color-palette", position: { x: 200, y: 0 },
        data: {
          kind: "color-palette", label: "色板", status: "idle", paletteVersion: 2,
          swatches: [
            {
              id: "pantone", value: "#FF0000", source: "pantone",
              pantone: {
                catalogId: "a".repeat(64), releaseId: "release-a",
                libraryKey: "pantone-tcx", code: "11-1000 TCX",
              },
            },
            { id: "red", value: "#FF0000", source: "custom" },
          ],
          recentColors: ["#000000"],
        },
      },
      { id: "approval-v5", type: "stage-approval", position: { x: 300, y: 0 }, data: { kind: "stage-approval", label: "确认基准", status: "idle", approvalKind: "scene-baseline", approvedSourceNodeId: "stabilize-v5", approvedBaselineRef: "/api/files/baseline.png", approvedBasisRevision: 2, approvedAt: "2026-09-03T00:00:00.000Z", confirmPopoverOpen: true } },
      { id: "stabilize-v5", type: "virtual-try-on", position: { x: 400, y: 0 }, data: { kind: "virtual-try-on", label: "第一轮", status: "idle", workflowStage: "scene-stabilize", prompt: "", modelId: "gemini-3.1-flash-image", modelOptions: { aspectRatio: "3:4", imageSize: "2K" }, imageSize: "2K", basisRevision: 2, outputImages: ["/api/files/baseline.png"], displayState: "ready" } },
      { id: "fabric-v5", type: "fabric-recolor", position: { x: 500, y: 0 }, data: { kind: "fabric-recolor", label: "配色替换", status: "idle", operationMode: "color", colors: ["#FF0000"], prompt: "", outputImages: [], modelId: "gpt-image-2-vip", modelOptions: { size: "2048x2048" } } },
    ],
    edges: [
      { id: "board-approval", source: "board-v5", sourceHandle: "image", target: "approval-v5", targetHandle: "baseline-candidate" },
      { id: "palette-fabric", source: "palette-v5", sourceHandle: "colors", target: "fabric-v5", targetHandle: "palette" },
    ],
    connectionDraft: { sourceNodeId: "board-v5", targetNodeId: "approval-v5" },
    rightDockOpen: true,
    openToolGroupId: "create",
    drawingRecoveryState: { nodeId: "board-v5" },
  }],
});
assert.ok(recoveredV5NodeFields);
assert.deepEqual(recoveredV5NodeFields.tabs[0].nodes.map((node) => node.data.kind), ["text-input", "drawing-board", "color-palette", "stage-approval", "virtual-try-on", "fabric-recolor"]);
const recoveredV5Palette = recoveredV5NodeFields.tabs[0].nodes[2].data;
assert.equal(recoveredV5Palette.kind, "color-palette");
if (recoveredV5Palette.kind === "color-palette") {
  assert.equal(recoveredV5Palette.paletteVersion, 2);
  assert.equal(recoveredV5Palette.swatches.length, 2);
  assert.equal(recoveredV5Palette.swatches[0].pantone?.catalogId, "a".repeat(64));
}
const recoveredV5Tab = recoveredV5NodeFields.tabs[0] as unknown as Record<string, unknown>;
assert.equal(recoveredV5Tab.connectionDraft, undefined);
assert.equal(recoveredV5Tab.rightDockOpen, undefined);
assert.equal(recoveredV5Tab.openToolGroupId, undefined);
assert.equal(recoveredV5Tab.drawingRecoveryState, undefined);
for (const node of recoveredV5NodeFields.tabs[0].nodes) {
  const data = node.data as unknown as Record<string, unknown>;
  assert.equal(data.selectionRange, undefined);
  assert.equal(data.drawingRecoveryDraft, undefined);
  assert.equal(data.recentColors, undefined);
  assert.equal(data.confirmPopoverOpen, undefined);
  assert.equal(data.displayState, undefined);
}
console.log("  ✓ v5 节点字段可恢复且 UI、连接与画板恢复瞬态不会进入页签会话");

const generalModelPairs = [
  { modelId: "gpt-image-2-vip", modelOptions: { size: "2048x1152" }, aspectRatio: "16:9" },
  {
    modelId: "gemini-3.1-flash-image",
    modelOptions: { aspectRatio: "16:9", imageSize: "4K" },
    aspectRatio: "16:9",
  },
  {
    modelId: "flux-2-pro",
    modelOptions: { width: 2048, height: 1152, outputFormat: "png" },
    aspectRatio: "16:9",
  },
  { modelId: "seedream-5-0-260128", modelOptions: { size: "3K" }, aspectRatio: "1:1" },
  {
    modelId: "grok-imagine-image",
    modelOptions: { aspectRatio: "4:3", resolution: "1k" },
    aspectRatio: "4:3",
  },
] as const;
const restoredModels = normalizeTabSessionValue(JSON.parse(JSON.stringify({
  activeTabId: "model-pairs-tab",
  tabs: [{
    id: "model-pairs-tab",
    projectId: "model-pairs-project",
    projectName: "通用模型恢复",
    nodes: generalModelPairs.map((pair, index) => ({
      id: `model-pair-${index}`,
      type: "ai-modify",
      position: { x: index * 80, y: 0 },
      data: {
        kind: "ai-modify",
        label: pair.modelId,
        status: "idle",
        prompt: "保留模型参数",
        aspectRatio: pair.aspectRatio,
        batchSize: 1,
        outputImages: [],
        modelId: pair.modelId,
        modelOptions: pair.modelOptions,
      },
    })),
    edges: [],
  }],
})))!;
assert.ok(restoredModels);
for (const [index, pair] of generalModelPairs.entries()) {
  const restoredNode = restoredModels.tabs[0].nodes.find((node) => node.id === `model-pair-${index}`);
  assert.ok(restoredNode, pair.modelId);
  assert.equal(restoredNode.data.modelId, pair.modelId);
  assert.deepEqual(restoredNode.data.modelOptions, pair.modelOptions);
}
console.log("  ✓ 五个通用模型的合法 modelId/modelOptions 会话恢复保真");

assert.deepEqual(state.recentResults, [], "登录后的历史必须以服务器为准，不能泄露上一账号的 localStorage");
const writesBeforeHistory = sessionWrites;
useFlowStore.setState({ recentResults: storedRecentResults as never });
assert.deepEqual(useFlowStore.getState().recentResults.map((record) => record.id), ["record-project-b", "record-legacy"]);
assert.equal(sessionWrites, writesBeforeHistory, "历史/SSE 更新不应重新序列化项目页签");
console.log("  ✓ 忽略本地跨账号缓存，并能渲染服务器恢复的全局历史");

useFlowStore.getState().openFlowTab({
  projectId: "run-recovery-project",
  projectName: "运行恢复项目",
  nodes: [{
    id: "run-recovery-node",
    type: "ai-modify",
    position: { x: 0, y: 0 },
    data: {
      kind: "ai-modify",
      label: "运行恢复节点",
      status: "queued",
      prompt: "换领型",
      aspectRatio: "1:1",
      batchSize: 1,
      modelId: "gpt-image-2-vip",
      modelOptions: { size: "2048x2048" },
      outputImages: [],
    },
  }],
  edges: [],
});
reconcileRunHistory([]);
assert.equal(activeDocument().nodes[0].data.status, "idle");
useFlowStore.getState().setNodeStatus("run-recovery-node", "queued");
reconcileRunHistory([{
  id: "server-active-record",
  runId: "server-active-run",
  clientRequestId: "server-active-request",
  image: "",
  nodeId: "run-recovery-node",
  nodeLabel: "运行恢复节点",
  kind: "ai-modify",
  projectId: "run-recovery-project",
  projectName: "运行恢复项目",
  startedAt: 5_000,
  status: "running",
}]);
assert.equal(activeDocument().nodes[0].data.status, "running");
assert.equal(
  useFlowStore.getState().recentResults.find((record) => record.id === "server-active-record")?.runId,
  "server-active-run",
);
reconcileRunHistory([{
  id: "late-open-active-record",
  runId: "late-open-active-run",
  image: "",
  nodeId: "late-open-node",
  nodeLabel: "稍后打开节点",
  kind: "ai-modify",
  projectId: "late-open-project",
  projectName: "稍后打开项目",
  startedAt: 6_000,
  status: "running",
}, {
  id: "late-open-older-record",
  runId: "late-open-older-run",
  image: "",
  nodeId: "late-open-node",
  nodeLabel: "稍后打开节点",
  kind: "ai-modify",
  projectId: "late-open-project",
  projectName: "稍后打开项目",
  startedAt: 5_500,
  status: "retry_wait",
}]);
useFlowStore.getState().openFlowTab({
  projectId: "late-open-project",
  projectName: "稍后打开项目",
  nodes: [{
    id: "late-open-node",
    type: "ai-modify",
    position: { x: 0, y: 0 },
    data: {
      kind: "ai-modify",
      label: "稍后打开节点",
      status: "idle",
      prompt: "换袖型",
      aspectRatio: "1:1",
      batchSize: 1,
      modelId: "gpt-image-2-vip",
      modelOptions: { size: "2048x2048" },
      outputImages: [],
    },
  }],
  edges: [],
});
assert.equal(activeDocument().nodes[0].data.status, "running");
console.log("  ✓ 历史确认会解除孤儿运行态，并恢复真实服务端任务");

const overflowActiveRecords = Array.from({ length: 180 }, (_, index) => ({
  id: `overflow-active-${index}`,
  runId: `overflow-run-${index}`,
  image: "",
  nodeId: `overflow-node-${index}`,
  nodeLabel: `活动节点 ${index}`,
  kind: "ai-modify" as const,
  projectId: `overflow-project-${index}`,
  projectName: `活动项目 ${index}`,
  startedAt: 10_000 - index,
  status: "running" as const,
}));
const overflowTerminalRecords = Array.from({ length: 160 }, (_, index) => ({
  id: `overflow-terminal-${index}`,
  runId: `overflow-terminal-run-${Math.floor(index / 8)}`,
  image: `/api/files/overflow-${index}.png`,
  nodeId: `terminal-node-${index}`,
  nodeLabel: "终态输出",
  kind: "ai-modify" as const,
  projectId: "terminal-project",
  projectName: "终态项目",
  startedAt: 20_000 - index,
  finishedAt: 21_000 - index,
  status: "success" as const,
}));
useFlowStore.getState().openFlowTab({
  projectId: "overflow-project-179",
  projectName: "最旧活动项目",
  nodes: [{
    id: "overflow-node-179",
    type: "ai-modify",
    position: { x: 0, y: 0 },
    data: {
      kind: "ai-modify",
      label: "最旧活动节点",
      status: "idle",
      prompt: "保持运行",
      aspectRatio: "1:1",
      batchSize: 1,
      modelId: "gpt-image-2-vip",
      modelOptions: { size: "2048x2048" },
      outputImages: [],
    },
  }],
  edges: [],
});
reconcileRunHistory([...overflowActiveRecords, ...overflowTerminalRecords]);
assert.equal(activeDocument().nodes[0].data.status, "running");
assert.equal(
  useFlowStore.getState().recentResults.some((record) => record.runId === "overflow-run-179"),
  true,
);
assert.equal(useFlowStore.getState().recentResults.length, 200);

useFlowStore.setState((current) => ({
  recentResults: applyRunEventToRecentResults(current.recentResults, "overflow-active-0", {
    type: "node-status",
    nodeId: "overflow-node-0",
    status: "success",
    images: ["/api/files/overflow-active-0.png"],
    finishedAt: 30_000,
  }),
}));
assert.equal(
  useFlowStore.getState().recentResults.some((record) => record.runId === "overflow-run-179"),
  true,
  "其他任务终态更新后，最旧活动 Run 仍须保留",
);
useFlowStore.getState().setNodeStatus("overflow-node-179", "idle");
const previousFetch = globalThis.fetch;
let generationRequests = 0;
try {
  globalThis.fetch = (async () => {
    generationRequests += 1;
    return Response.json({ error: "不应发出请求" }, { status: 500 });
  }) as typeof fetch;
  await useFlowStore.getState().runNode("overflow-node-179");
  assert.equal(generationRequests, 0, "活动历史门禁不得因展示裁剪而失效");
} finally {
  globalThis.fetch = previousFetch;
}
console.log("  ✓ 20 个八图终态叠加 180 个活动任务时仍保留完整活动门禁");

useFlowStore.getState().openFlowTab({
  projectId: "quota-project",
  projectName: "容量恢复项目",
  nodes: [{
    id: "quota-source",
    type: "image-input",
    position: { x: 0, y: 0 },
    data: {
      kind: "image-input", label: "原图", status: "idle", imageRole: "default",
      imageUrl: "/api/files/quota-source.png",
    },
  }, {
    id: "quota-mask",
    type: "mask-redraw",
    position: { x: 300, y: 0 },
    data: {
      kind: "mask-redraw", label: "局部重绘", status: "idle", prompt: "改色",
      modelId: "gpt-image-2", modelOptions: {}, outputImages: [],
      mask: "/api/files/old-mask.png", maskSourceRef: "/api/files/quota-source.png",
    },
  }],
  edges: [{ id: "quota-edge", source: "quota-source", target: "quota-mask" }],
});
const quotaTabId = useFlowStore.getState().activeTabId;
const preservedTab = useFlowStore.getState().tabs.find((tab) => tab.id !== quotaTabId);
assert.ok(preservedTab);
const preservedTabKey = projectTabStorageKey(preservedTab.id);
const preservedBeforeQuotaFailure = sessionStorage.getItem(preservedTabKey);
assert.ok(preservedBeforeQuotaFailure);
assert.match(sessionStorage.getItem(projectTabStorageKey(quotaTabId)) ?? "", /old-mask\.png/);
failedSessionTabId = quotaTabId;
failSessionWrites = true;
const oversizedInlineMask = `data:image/png;base64,${"x".repeat(300_000)}`;
useFlowStore.getState().updateNodeData("quota-mask", { mask: oversizedInlineMask });
assert.equal(
  sessionStorage.getItem(projectTabStorageKey(quotaTabId)),
  null,
  "失败页签必须移除旧快照，不能刷新恢复旧蒙版",
);
assert.equal(sessionStorage.getItem(preservedTabKey), preservedBeforeQuotaFailure);
assert.ok(persistedSession().tabs.some((tab) => tab.id === preservedTab.id));
assert.equal(persistedSession().tabs.some((tab) => tab.id === quotaTabId), false);
assert.match(useFlowStore.getState().tabSessionPersistenceError ?? "", /刷新会丢失/);

useFlowStore.getState().switchTab(preservedTab.id);
useFlowStore.getState().setProjectName(`${preservedTab.projectName}（仍可恢复）`);
assert.match(
  useFlowStore.getState().tabSessionPersistenceError ?? "",
  /刷新会丢失/,
  "其他页签成功写入不能掩盖失败页签错误",
);
assert.equal(sessionStorage.getItem(projectTabStorageKey(quotaTabId)), null);
useFlowStore.getState().openFlowTab({
  projectId: "quota-healthy-new-project",
  projectName: "容量故障后的健康新页签",
  nodes: [storedSelectionNode("quota-healthy-new-node")],
  edges: [],
});
const healthyNewTabId = useFlowStore.getState().activeTabId;
const healthyTopologyAfterQuotaFailure = readTabSessionSnapshot(sessionStorage);
assert.ok(healthyTopologyAfterQuotaFailure);
assert.equal(
  healthyTopologyAfterQuotaFailure.tabs.some((tab) => tab.id === quotaTabId),
  false,
  "确定写失败页签不应重新进入 manifest",
);
assert.equal(
  healthyTopologyAfterQuotaFailure.tabs.some((tab) => tab.id === healthyNewTabId),
  true,
  "失败页签不得阻止健康新页签发布到 manifest",
);
assert.ok(sessionStorage.has(projectTabStorageKey(healthyNewTabId)));
assert.match(
  useFlowStore.getState().tabSessionPersistenceError ?? "",
  /刷新会丢失/,
  "健康新页签成功仍不能掩盖原页签错误",
);
useFlowStore.getState().switchTab(quotaTabId);

failSessionWrites = false;
useFlowStore.getState().updateNodeData("quota-mask", { mask: "/api/files/old-mask.png" });
assert.match(
  sessionStorage.getItem(projectTabStorageKey(quotaTabId)) ?? "",
  /old-mask\.png/,
  "失败后改回旧内容也必须重新写入已被移除的页签 key",
);
assert.equal(useFlowStore.getState().tabSessionPersistenceError, null);

failSessionWrites = true;
useFlowStore.getState().updateNodeData("quota-mask", { mask: oversizedInlineMask });
assert.equal(sessionStorage.getItem(projectTabStorageKey(quotaTabId)), null);
failSessionWrites = false;
assert.equal(retryTabSessionPersistence(), true, "同一份未变化快照必须能够显式重试");
assert.match(sessionStorage.getItem(projectTabStorageKey(quotaTabId)) ?? "", /data:image\/png;base64/);
assert.equal(useFlowStore.getState().tabSessionPersistenceError, null);
useFlowStore.getState().updateNodeData("quota-mask", { mask: "/api/files/latest-mask.png" });
const compactSession = sessionStorage.getItem(projectTabStorageKey(quotaTabId)) ?? "";
assert.match(compactSession, /latest-mask\.png/);
assert.doesNotMatch(compactSession, /data:image\/png;base64/);
failedSessionTabId = null;

const originalSessionGetItem = sessionStorage.getItem;
const preservedBeforeTransientKnownRead = originalSessionGetItem(preservedTabKey);
const manifestBeforeTransientKnownRead = originalSessionGetItem(sessionKey);
let throwPreservedKnownReadOnce = true;
sessionStorage.getItem = (key: string) => {
  if (key === preservedTabKey && throwPreservedKnownReadOnce) {
    throwPreservedKnownReadOnce = false;
    throw new Error("transient known shard read failure");
  }
  return originalSessionGetItem(key);
};
useFlowStore.getState().updateNodeData("quota-mask", { prompt: "瞬时读失败期间更新 A" });
assert.equal(throwPreservedKnownReadOnce, false);
assert.equal(sessionStorage.getItem(sessionKey), manifestBeforeTransientKnownRead);
assert.equal(sessionStorage.getItem(preservedTabKey), preservedBeforeTransientKnownRead);
assert.match(useFlowStore.getState().tabSessionPersistenceError ?? "", /刷新会丢失/);
sessionStorage.getItem = originalSessionGetItem;

useFlowStore.getState().openFlowTab({
  projectId: "transient-read-followup-project",
  projectName: "瞬时读失败后的新页签",
  nodes: [storedSelectionNode("transient-read-followup-node")],
  edges: [],
});
const transientReadFollowupTabId = useFlowStore.getState().activeTabId;
const recoveredAfterTransientKnownRead = readTabSessionSnapshot(sessionStorage);
assert.ok(recoveredAfterTransientKnownRead);
assert.equal(
  recoveredAfterTransientKnownRead.tabs.some((tab) => tab.id === preservedTab.id),
  true,
  "瞬时读失败不得把实际存在的健康分片降级为确定失败",
);
assert.equal(
  recoveredAfterTransientKnownRead.tabs.some((tab) => tab.id === transientReadFollowupTabId),
  true,
  "下一次无关写入应重新确认旧分片并安全发布新拓扑",
);
assert.equal(sessionStorage.getItem(preservedTabKey), preservedBeforeTransientKnownRead);
assert.equal(useFlowStore.getState().tabSessionPersistenceError, null);
console.log("  ✓ 单页签容量失败隔离其他草稿，且支持同内容重试恢复");

useFlowStore.getState().loadFlow({
  projectId: "drag-session-project",
  projectName: "拖拽会话项目",
  nodes: [{
    id: "drag-session-node",
    type: "image-input",
    position: { x: 0, y: 0 },
    data: { kind: "image-input", label: "拖拽节点", status: "idle", imageRole: "default" },
  }],
  edges: [],
});
const durableBeforeDrag = persistedSessionJson();
const writesBeforeDrag = sessionWrites;
const dragTransaction = beginHistoryTransaction("session-crash-contract");
useFlowStore.getState().onNodesChange([{
  id: "drag-session-node",
  type: "position",
  position: { x: 180, y: 72 },
  dragging: true,
}]);
assert.equal(sessionWrites, writesBeforeDrag, "未提交拖拽帧不得写入 session");
assert.equal(
  persistedSessionJson(),
  durableBeforeDrag,
  "崩溃或刷新必须恢复拖拽前的 durable snapshot",
);
assert.equal(retryTabSessionPersistence(), false, "事务中显式重试也不得固化中间帧");
assert.equal(persistedSessionJson(), durableBeforeDrag);

assert.equal(endHistoryTransaction(dragTransaction), true);
const durableAfterDrag = persistedSession();
const committedDragTab = durableAfterDrag.tabs.find((tab) => tab.projectId === "drag-session-project");
assert.deepEqual(
  committedDragTab?.nodes.find((node) => node.id === "drag-session-node")?.position,
  { x: 180, y: 72 },
);
assert.equal(committedDragTab?.revision, 1);
assert.equal(committedDragTab?.dirty, true);

useFlowStore.getState().loadFlow({
  projectId: "drag-session-no-move-success",
  projectName: "无位移成功项目",
  nodes: [{
    id: "drag-session-no-move-node",
    type: "ai-modify",
    position: { x: 0, y: 0 },
    data: {
      kind: "ai-modify",
      label: "无位移生成节点",
      status: "idle",
      prompt: "生成成功",
      aspectRatio: "1:1",
      batchSize: 1,
      outputImages: ["/api/files/before-no-move.png"],
    },
  }],
  edges: [],
});
const noMoveTabId = useFlowStore.getState().activeTabId;
const durableBeforeNoMoveSuccess = persistedSessionJson();
const writesBeforeNoMoveSuccess = sessionWrites;
const noMoveTransaction = beginHistoryTransaction("session-no-move-success");
applyRunEventToTab(documentTargetForTab(noMoveTabId), "drag-session-no-move-node", {
  type: "node-status",
  nodeId: "drag-session-no-move-node",
  status: "success",
  images: ["/api/files/no-move-success.png"],
});
assert.equal(sessionWrites, writesBeforeNoMoveSuccess, "无位移事务中的 success 必须延迟落盘");
assert.equal(persistedSessionJson(), durableBeforeNoMoveSuccess);
assert.equal(endHistoryTransaction(noMoveTransaction), false);
const durableAfterNoMoveSuccess = persistedSession();
const noMoveSuccessTab = durableAfterNoMoveSuccess.tabs.find(
  (tab) => tab.projectId === "drag-session-no-move-success",
);
assert.deepEqual(
  noMoveSuccessTab?.nodes.find((node) => node.id === "drag-session-no-move-node")?.data.outputImages,
  ["/api/files/no-move-success.png"],
);
assert.equal(noMoveSuccessTab?.revision, 1);
assert.equal(noMoveSuccessTab?.dirty, true);

useFlowStore.getState().loadFlow({
  projectId: "drag-session-net-zero-success",
  projectName: "净零位移成功项目",
  nodes: [{
    id: "drag-session-net-zero-node",
    type: "ai-modify",
    position: { x: 0, y: 0 },
    data: {
      kind: "ai-modify",
      label: "净零位移生成节点",
      status: "idle",
      prompt: "生成成功",
      aspectRatio: "1:1",
      batchSize: 1,
      outputImages: ["/api/files/before-net-zero.png"],
    },
  }],
  edges: [],
});
const netZeroTabId = useFlowStore.getState().activeTabId;
const durableBeforeNetZeroSuccess = persistedSessionJson();
const writesBeforeNetZeroSuccess = sessionWrites;
const netZeroTransaction = beginHistoryTransaction("session-net-zero-success");
useFlowStore.getState().onNodesChange([{
  id: "drag-session-net-zero-node",
  type: "position",
  position: { x: 160, y: 64 },
  dragging: true,
}]);
applyRunEventToTab(documentTargetForTab(netZeroTabId), "drag-session-net-zero-node", {
  type: "node-status",
  nodeId: "drag-session-net-zero-node",
  status: "success",
  images: ["/api/files/net-zero-success.png"],
});
useFlowStore.getState().onNodesChange([{
  id: "drag-session-net-zero-node",
  type: "position",
  position: { x: 0, y: 0 },
  dragging: false,
}]);
assert.equal(sessionWrites, writesBeforeNetZeroSuccess, "净零位移事务中的 success 必须延迟落盘");
assert.equal(persistedSessionJson(), durableBeforeNetZeroSuccess);
assert.equal(endHistoryTransaction(netZeroTransaction), false);
const durableAfterNetZeroSuccess = persistedSession();
const netZeroSuccessTab = durableAfterNetZeroSuccess.tabs.find(
  (tab) => tab.projectId === "drag-session-net-zero-success",
);
const durableNetZeroNode = netZeroSuccessTab?.nodes.find(
  (node) => node.id === "drag-session-net-zero-node",
);
assert.deepEqual(durableNetZeroNode?.position, { x: 0, y: 0 });
assert.deepEqual(durableNetZeroNode?.data.outputImages, ["/api/files/net-zero-success.png"]);
assert.equal(netZeroSuccessTab?.revision, 1);
assert.equal(netZeroSuccessTab?.dirty, true);
console.log("  ✓ 无位移与净零位移事务结束后补写期间完成的 success 输出");

useFlowStore.getState().loadFlow({
  projectId: "drag-session-project",
  projectName: "拖拽会话项目",
  nodes: [{
    id: "drag-session-node",
    type: "image-input",
    position: { x: 0, y: 0 },
    data: { kind: "image-input", label: "拖拽节点", status: "idle", imageRole: "default" },
  }],
  edges: [],
});
const firstDragTabId = useFlowStore.getState().activeTabId;
useFlowStore.getState().openFlowTab({
  projectId: "drag-session-switch-target",
  projectName: "切换目标",
  nodes: [{
    id: "drag-session-target-node",
    type: "image-input",
    position: { x: 0, y: 0 },
    data: { kind: "image-input", label: "目标节点", status: "idle", imageRole: "default" },
  }],
  edges: [],
});
const secondDragTabId = useFlowStore.getState().activeTabId;
useFlowStore.getState().switchTab(firstDragTabId);
const cancelledDrag = beginHistoryTransaction("session-switch-cancel");
useFlowStore.getState().onNodesChange([{
  id: "drag-session-node",
  type: "position",
  position: { x: 240, y: 96 },
  dragging: true,
}]);
useFlowStore.getState().switchTab(secondDragTabId);
assert.equal(endHistoryTransaction(cancelledDrag), false);
const durableAfterSwitch = persistedSession();
const cancelledDragTab = durableAfterSwitch.tabs.find((tab) => tab.projectId === "drag-session-project");
assert.deepEqual(
  cancelledDragTab?.nodes.find((node) => node.id === "drag-session-node")?.position,
  { x: 0, y: 0 },
);
assert.equal(cancelledDragTab?.revision, 0);
assert.equal(cancelledDragTab?.dirty, false);
console.log("  ✓ 拖拽中间帧不落 session，提交原子持久化，切页取消恢复 durable snapshot");

const unsafeDocumentNode = {
  id: "pure-boundary-node",
  type: "ai-modify",
  position: { x: 120, y: 48 },
  selected: true,
  dragging: true,
  measured: { width: 320, height: 180 },
  width: 320,
  height: 180,
  unknownNodeShell: "不得持久化",
  data: {
    kind: "ai-modify",
    label: "纯文档边界",
    status: "error",
    error: "旧运行错误不得持久化",
    prompt: "保留衣身，只修改领型",
    aspectRatio: "1:1",
    batchSize: 1,
    outputImages: ["/api/files/pure-boundary-before.png"],
    modelId: "gpt-image-2-vip",
    modelOptions: { size: "2048x2048" },
    unknownData: "不得持久化",
  },
} as import("../src/store/flowStore").FlowNode;
const unsafeDocumentEdge = {
  id: "pure-boundary-edge",
  source: "pure-boundary-node",
  target: "pure-boundary-node",
  sourceHandle: "output",
  targetHandle: "input",
  selected: true,
  unknownEdgeShell: "不得持久化",
};
useFlowStore.getState().openFlowTab({
  projectId: "pure-boundary-project",
  projectName: "纯文档边界项目",
  nodes: [unsafeDocumentNode],
  edges: [unsafeDocumentEdge],
});
useFlowStore.getState().setSelectedNodeId(unsafeDocumentNode.id);

const boundaryState = useFlowStore.getState();
const boundaryDocument = activeDocument(boundaryState);
const templatePayload = createTemplateRequestPayload({
  name: "纯文档边界模板",
  description: "四条持久化路径必须共享同一序列化器",
  projectName: boundaryDocument.projectName,
  nodes: boundaryDocument.nodes,
  edges: boundaryDocument.edges,
});
const boundaryRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
const fetchBeforeBoundaryTest = globalThis.fetch;
try {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    boundaryRequests.push({ url, body });
    if (url === "/api/projects") return Response.json({ ok: true });
    if (url === "/api/run-plan") {
      return Response.json({ error: "测试在 Provider 调用前终止" }, { status: 400 });
    }
    throw new Error(`意外请求：${url}`);
  };
  await useFlowStore.getState().runNode(unsafeDocumentNode.id);
} finally {
  globalThis.fetch = fetchBeforeBoundaryTest;
}

assert.deepEqual(
  boundaryRequests.map((request) => request.url),
  ["/api/projects", "/api/run-plan"],
);
const projectPayload = boundaryRequests[0].body as {
  flow: { schemaVersion: number; nodes: unknown[]; edges: unknown[] };
};
const runPayload = boundaryRequests[1].body as { nodes: unknown[]; edges: unknown[] };
const runWorkflow = {
  schemaVersion: projectPayload.flow.schemaVersion,
  nodes: runPayload.nodes,
  edges: runPayload.edges,
};
const boundarySession = persistedSession();
const sessionTab = boundarySession.tabs.find(
  (tab) => tab.projectId === "pure-boundary-project",
);
assert.ok(sessionTab);
const sessionWorkflow = {
  schemaVersion: projectPayload.flow.schemaVersion,
  nodes: sessionTab.nodes,
  edges: sessionTab.edges,
};

assert.deepEqual(templatePayload.flow, projectPayload.flow);
assert.deepEqual(runWorkflow, projectPayload.flow);
assert.deepEqual(sessionWorkflow, projectPayload.flow);
const persistedBoundaryNode = projectPayload.flow.nodes[0] as Record<string, unknown>;
const persistedBoundaryData = persistedBoundaryNode.data as Record<string, unknown>;
assert.deepEqual(Object.keys(persistedBoundaryNode).sort(), ["data", "id", "position", "type"]);
assert.equal(persistedBoundaryData.status, "idle");
assert.equal("error" in persistedBoundaryData, false);
assert.equal("unknownData" in persistedBoundaryData, false);
assert.deepEqual(
  Object.keys(projectPayload.flow.edges[0] as Record<string, unknown>).sort(),
  ["id", "source", "sourceHandle", "target", "targetHandle"],
);
assert.deepEqual(sessionTab.selectedNodeIds, []);
assert.equal(sessionTab.selectedNodeId, null);
assert.equal(sessionTab.selectedResultId, null);
assert.deepEqual(sessionTab.compareIds, []);
console.log("  ✓ 项目、模板、运行与 v1 会话共享纯文档序列化边界");

flushTabSessionPersistence();
deferIdleWrites = true;
sessionWriteKeys.length = 0;
const writesBeforeTransientChanges = sessionWrites;
const revisionBeforeTransientChanges = activeDocument().revision;
useFlowStore.getState().setSelectedNodeId(null);
useFlowStore.getState().setSelectedNodeId(unsafeDocumentNode.id);
useFlowStore.getState().setNodeStatus(unsafeDocumentNode.id, "running");
useFlowStore.getState().setNodeStatus(unsafeDocumentNode.id, "idle");
useFlowStore.getState().onNodesChange([{
  id: unsafeDocumentNode.id,
  type: "dimensions",
  dimensions: { width: 360, height: 220 },
  setAttributes: true,
}]);
assert.equal(activeDocument().revision, revisionBeforeTransientChanges);
assert.equal(sessionWrites, writesBeforeTransientChanges);
assert.equal(timeoutCallbacks.size, 0);
assert.equal(idleCallbacks.size, 0);

const debouncedTabId = useFlowStore.getState().activeTabId;
const originalSaveState = activeDocument().saveState;
const changedSaveState = originalSaveState === "saved" ? "error" : "saved";
useFlowStore.setState((current) => ({
  tabs: current.tabs.map((tab) => tab.id === debouncedTabId
    ? { ...tab, saveState: changedSaveState }
    : tab),
}));
assert.equal(timeoutCallbacks.size, 1, "saveState 单独变化也必须进入 durable signal");
flushIdleCallbacks();
assert.equal(
  persistedSession().tabs.find((tab) => tab.id === debouncedTabId)?.saveState,
  changedSaveState,
);
useFlowStore.setState((current) => ({
  tabs: current.tabs.map((tab) => tab.id === debouncedTabId
    ? { ...tab, saveState: originalSaveState }
    : tab),
}));
flushIdleCallbacks();
console.log("  ✓ saveState 即使不改变 revision/dirty 也会更新可恢复草稿元数据");

sessionWriteKeys.length = 0;
const writesBeforeDebouncedChanges = sessionWrites;
useFlowStore.getState().updateNodeData(unsafeDocumentNode.id, { prompt: "保留衣身" });
useFlowStore.getState().updateNodeData(unsafeDocumentNode.id, { prompt: "保留衣身，只修改" });
useFlowStore.getState().updateNodeData(unsafeDocumentNode.id, { prompt: "保留衣身，只修改袖型" });
assert.equal(sessionWrites, writesBeforeDebouncedChanges, "连续文档修改在 debounce 前不得同步写盘");
assert.equal(timeoutCallbacks.size, 1, "连续修改必须重置为同一个 debounce 任务");
assert.equal(idleCallbacks.size, 0);
flushIdleCallbacks();
assert.equal(
  sessionWriteKeys.filter((key) => key === projectTabStorageKey(debouncedTabId)).length,
  1,
  "一次修改 burst 只写一次活动页签快照",
);
assert.equal(
  sessionWriteKeys.filter((key) => key === sessionKey).length,
  1,
  "一次修改 burst 只发布一次 manifest",
);
assert.equal(
  persistedSession().tabs
    .find((tab) => tab.id === debouncedTabId)
    ?.nodes.find((node) => node.id === unsafeDocumentNode.id)
    ?.data.prompt,
  "保留衣身，只修改袖型",
);
console.log("  ✓ revision/topology 驱动持久化：瞬态零写入，连续修改 debounce 为单次分片写入");

sessionWriteKeys.length = 0;
const revisionBeforeTextBurst = activeDocument().revision;
const writesBeforeTextBurst = sessionWrites;
let textToken = updateCoalescedTextEdit(
  { kind: "node-data", nodeId: unsafeDocumentNode.id, field: "prompt" },
  "合并输入第一段",
);
assert.ok(textToken);
textToken = updateCoalescedTextEdit(
  { kind: "node-data", nodeId: unsafeDocumentNode.id, field: "prompt" },
  "合并输入最终内容",
  textToken,
);
assert.ok(textToken);
assert.equal(activeDocument().revision, revisionBeforeTextBurst, "输入中不能逐键增加 revision");
assert.equal(sessionWrites, writesBeforeTextBurst, "输入中不能逐键写 session");
assert.equal(timeoutCallbacks.size, 0, "输入未提交前不能触发草稿持久化 debounce");
assert.equal(flushActiveTextEdit(textToken), true);
assert.equal(activeDocument().revision, revisionBeforeTextBurst + 1, "一次输入 burst 只增加一次 revision");
assert.equal(timeoutCallbacks.size, 1);
flushIdleCallbacks();
assert.equal(
  sessionWriteKeys.filter((key) => key === projectTabStorageKey(debouncedTabId)).length,
  1,
  "一次文本 burst 只写一次活动页签分片",
);
assert.equal(
  persistedSession().tabs
    .find((tab) => tab.id === debouncedTabId)
    ?.nodes.find((node) => node.id === unsafeDocumentNode.id)
    ?.data.prompt,
  "合并输入最终内容",
);
console.log("  ✓ 连续文本输入实时可见，但每个 burst 只提交一次 revision/session 分片");

sessionWriteKeys.length = 0;
useFlowStore.getState().updateNodeData(unsafeDocumentNode.id, { prompt: "页面隐藏前的最后内容" });
assert.equal(timeoutCallbacks.size, 1);
assert.equal(flushTabSessionPersistence(), true);
assert.equal(timeoutCallbacks.size, 0, "生命周期同步 flush 必须取消尚未执行的 debounce");
assert.equal(idleCallbacks.size, 0);
assert.equal(
  persistedSession().tabs
    .find((tab) => tab.id === debouncedTabId)
    ?.nodes.find((node) => node.id === unsafeDocumentNode.id)
    ?.data.prompt,
  "页面隐藏前的最后内容",
);
const writesAfterLifecycleFlush = sessionWrites;
flushIdleCallbacks();
assert.equal(sessionWrites, writesAfterLifecycleFlush, "已取消的延迟任务不得重复覆盖生命周期快照");
deferIdleWrites = false;

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
assert.match(appSource, /addEventListener\("pagehide", flushDrafts\)/);
assert.match(appSource, /addEventListener\("visibilitychange", flushHiddenDrafts\)/);
assert.match(appSource, /document\.visibilityState === "hidden"/);
console.log("  ✓ pagehide / hidden 生命周期同步收口最新草稿且不会重复延迟写入");

useFlowStore.getState().openFlowTab({
  projectId: "background-session-project",
  projectName: "后台持久化项目",
  nodes: [{
    id: "background-session-node",
    type: "ai-modify",
    position: { x: 0, y: 0 },
    data: {
      kind: "ai-modify",
      label: "后台生成节点",
      status: "idle",
      prompt: "后台成功",
      aspectRatio: "1:1",
      batchSize: 1,
      outputImages: ["/api/files/background-before.png"],
    },
  }],
  edges: [],
});
const backgroundTabId = useFlowStore.getState().activeTabId;
const backgroundTarget = documentTargetForTab(backgroundTabId);
useFlowStore.getState().switchTab(debouncedTabId);
flushTabSessionPersistence();

deferIdleWrites = true;
useFlowStore.getState().updateNodeData(unsafeDocumentNode.id, { prompt: "拖拽前稳定编辑" });
assert.equal(timeoutCallbacks.size, 1);
const lifecycleDrag = beginHistoryTransaction("lifecycle-stable-rebase");
assert.equal(timeoutCallbacks.size, 0, "开始实时事务前必须同步落盘已稳定的 debounce 编辑");
assert.equal(
  persistedSession().tabs
    .find((tab) => tab.id === debouncedTabId)
    ?.nodes.find((node) => node.id === unsafeDocumentNode.id)
    ?.data.prompt,
  "拖拽前稳定编辑",
);
const writesAfterTransactionBaseline = sessionWrites;
useFlowStore.getState().onNodesChange([{
  id: unsafeDocumentNode.id,
  type: "position",
  position: { x: 999, y: 777 },
  dragging: true,
}]);
applyRunEventToTab(backgroundTarget, "background-session-node", {
  type: "node-status",
  nodeId: "background-session-node",
  status: "success",
  images: ["/api/files/background-success.png"],
});
assert.equal(sessionWrites, writesAfterTransactionBaseline, "事务中后台 success 先保持 pending");
assert.equal(flushTabSessionPersistence(), true);
const transactionLifecycleSnapshot = persistedSession();
assert.deepEqual(
  transactionLifecycleSnapshot.tabs
    .find((tab) => tab.id === debouncedTabId)
    ?.nodes.find((node) => node.id === unsafeDocumentNode.id)
    ?.position,
  { x: 120, y: 48 },
  "生命周期 flush 不得固化拖拽中间坐标",
);
assert.deepEqual(
  transactionLifecycleSnapshot.tabs
    .find((tab) => tab.id === backgroundTabId)
    ?.nodes.find((node) => node.id === "background-session-node")
    ?.data.outputImages,
  ["/api/files/background-success.png"],
  "生命周期 flush 必须保存事务期间其他页签的稳定 success",
);
useFlowStore.getState().onNodesChange([{
  id: unsafeDocumentNode.id,
  type: "position",
  position: { x: 120, y: 48 },
  dragging: false,
}]);
assert.equal(endHistoryTransaction(lifecycleDrag), false);
deferIdleWrites = false;
flushIdleCallbacks();
console.log("  ✓ 实时事务前 flush 稳定编辑；事务期生命周期只写稳定坐标与后台结果");

failedSessionTabId = debouncedTabId;
failSessionWrites = true;
useFlowStore.getState().updateNodeData(unsafeDocumentNode.id, { prompt: "等待事务后重试" });
assert.equal(sessionStorage.getItem(projectTabStorageKey(debouncedTabId)), null);
assert.match(useFlowStore.getState().tabSessionPersistenceError ?? "", /刷新会丢失/);
const deferredRetryTransaction = beginHistoryTransaction("deferred-session-retry");
assert.equal(retryTabSessionPersistence(), false, "事务中的显式重试必须等待稳定边界");
failSessionWrites = false;
useFlowStore.getState().onNodesChange([{
  id: unsafeDocumentNode.id,
  type: "position",
  position: { x: 400, y: 300 },
  dragging: true,
}]);
useFlowStore.getState().onNodesChange([{
  id: unsafeDocumentNode.id,
  type: "position",
  position: { x: 120, y: 48 },
  dragging: false,
}]);
assert.equal(endHistoryTransaction(deferredRetryTransaction), false);
assert.match(
  sessionStorage.getItem(projectTabStorageKey(debouncedTabId)) ?? "",
  /等待事务后重试/,
  "净零事务结束后必须保留并执行用户的 force retry",
);
assert.equal(useFlowStore.getState().tabSessionPersistenceError, null);
failedSessionTabId = null;
console.log("  ✓ 显式 force retry 跨净零事务保留，稳定后重写失败分片并清错");

const readerTabs = normalizeTabSessionValue({
  activeTabId: "reader-good",
  tabs: [
    storedSelectionTab("reader-good", [storedSelectionNode("reader-good-node")]),
    storedSelectionTab("reader-other", [storedSelectionNode("reader-other-node")]),
  ],
});
assert.ok(readerTabs);
const corruptedV2Storage = memoryStorage({
  [sessionKey]: JSON.stringify({
    schemaVersion: TAB_SESSION_SCHEMA_VERSION,
    activeTabId: "reader-missing",
    tabIds: ["reader-missing", "reader-corrupt", "reader-mismatch", "reader-good"],
  }),
  [projectTabStorageKey("reader-corrupt")]: "{bad json",
  [projectTabStorageKey("reader-mismatch")]: JSON.stringify(readerTabs.tabs[1]),
  [projectTabStorageKey("reader-good")]: JSON.stringify(readerTabs.tabs[0]),
});
const recoveredV2 = readTabSessionSnapshot(corruptedV2Storage);
assert.ok(recoveredV2);
assert.equal(recoveredV2.activeTabId, "reader-good");
assert.deepEqual(recoveredV2.tabs.map((tab) => tab.id), ["reader-good"]);
console.log("  ✓ v2 读取隔离缺失、损坏与 id 不匹配的页签，并安全回退活动页签");

const bootstrapReadStorage = memoryStorage({
  [sessionKey]: JSON.stringify({
    schemaVersion: TAB_SESSION_SCHEMA_VERSION,
    activeTabId: "reader-good",
    tabIds: ["reader-good", "reader-other"],
  }),
  [projectTabStorageKey("reader-good")]: JSON.stringify(readerTabs.tabs[0]),
  [projectTabStorageKey("reader-other")]: JSON.stringify(readerTabs.tabs[1]),
});
let throwBootstrapShardOnce = true;
const bootstrapReadResult = readTabSessionSnapshotResult({
  getItem: (key: string) => {
    if (key === projectTabStorageKey("reader-other") && throwBootstrapShardOnce) {
      throwBootstrapShardOnce = false;
      throw new Error("transient bootstrap shard read failure");
    }
    return bootstrapReadStorage.getItem(key);
  },
});
assert.equal(bootstrapReadResult.unreadable, true);
assert.deepEqual(bootstrapReadResult.snapshot?.tabs.map((tab) => tab.id), ["reader-good"]);
assert.deepEqual(bootstrapReadResult.manifest?.tabIds, ["reader-good", "reader-other"]);
const bootstrapRootReadResult = readTabSessionSnapshotResult({
  getItem: () => { throw new Error("transient bootstrap root read failure"); },
});
assert.equal(bootstrapRootReadResult.unreadable, true);
assert.equal(bootstrapRootReadResult.snapshot, undefined);
const flowStoreSource = readFileSync(new URL("../src/store/flowStore.ts", import.meta.url), "utf8");
assert.match(
  flowStoreSource,
  /if \(bootstrapStorageUnreadable\)[\s\S]{0,500}?publishPersistenceResult\(\{ ok: false, error: TAB_SESSION_READ_ERROR \}\)[\s\S]{0,500}?else if \(restoredManifest\)/,
  "启动读异常必须阻断 manifest repair 与 orphan cleanup",
);
console.log("  ✓ 启动 root/shard 瞬时读异常保留旧拓扑并停用本页写入修复");

const malformedSessionTabId = "\ud800";
const malformedSession = normalizeTabSessionValue({
  activeTabId: malformedSessionTabId,
  tabs: [storedSelectionTab(
    malformedSessionTabId,
    [storedSelectionNode("malformed-session-node")],
  )],
});
assert.ok(malformedSession);
const malformedSessionStorage = memoryStorage();
assert.equal(writeTabSessionSnapshot(malformedSessionStorage, malformedSession).ok, true);
assert.equal(readTabSessionSnapshot(malformedSessionStorage)?.activeTabId, malformedSessionTabId);
assert.ok(malformedSessionStorage.has(projectTabStorageKey(malformedSessionTabId)));
console.log("  ✓ lone-surrogate tabId 使用无碰撞降级键，读写与清理均不抛错");

const externallyMissingFragmentStorage = memoryStorage({
  [sessionKey]: JSON.stringify({
    schemaVersion: TAB_SESSION_SCHEMA_VERSION,
    activeTabId: "reader-good",
    tabIds: ["reader-good", "reader-other"],
  }),
  [projectTabStorageKey("reader-good")]: JSON.stringify(readerTabs.tabs[0]),
});
const missingKnownFragment = writeTabSessionSnapshot(
  externallyMissingFragmentStorage,
  readerTabs,
  {
    writeTabIds: new Set(["reader-good"]),
    knownPersistedTabIds: new Set(["reader-good", "reader-other"]),
  },
);
assert.equal(missingKnownFragment.ok, false);
assert.deepEqual(missingKnownFragment.failedTabIds, ["reader-other"]);
assert.deepEqual(
  readTabSessionSnapshot(externallyMissingFragmentStorage)?.tabs.map((tab) => tab.id),
  ["reader-good"],
);
console.log("  ✓ 进程外消失的 known 分片会转为显式失败，不能被 manifest 伪装为已保存");

const transientReadStorage = memoryStorage();
assert.equal(writeTabSessionSnapshot(transientReadStorage, readerTabs).ok, true);
const manifestBeforeTransientRead = transientReadStorage.getItem(sessionKey);
const readerOtherBeforeTransientRead = transientReadStorage.getItem(
  projectTabStorageKey("reader-other"),
);
let throwReaderOtherOnce = true;
const transientReadWrapper = {
  get length() { return transientReadStorage.length; },
  getItem: (key: string) => {
    if (key === projectTabStorageKey("reader-other") && throwReaderOtherOnce) {
      throwReaderOtherOnce = false;
      throw new Error("transient shard read failure");
    }
    return transientReadStorage.getItem(key);
  },
  key: (index: number) => transientReadStorage.key(index),
  setItem: (key: string, value: string) => transientReadStorage.setItem(key, value),
  removeItem: (key: string) => transientReadStorage.removeItem(key),
};
const readerTabsWithUpdatedA = {
  ...readerTabs,
  tabs: readerTabs.tabs.map((tab) => tab.id === "reader-good"
    ? { ...tab, projectName: "reader A updated", revision: tab.revision + 1, dirty: true }
    : tab),
};
const transientKnownReadFailure = writeTabSessionSnapshot(
  transientReadWrapper,
  readerTabsWithUpdatedA,
  {
    writeTabIds: new Set(["reader-good"]),
    knownPersistedTabIds: new Set(["reader-good", "reader-other"]),
  },
);
assert.equal(transientKnownReadFailure.ok, false);
assert.equal(transientKnownReadFailure.manifestWritten, false);
assert.deepEqual(transientKnownReadFailure.indeterminateTabIds, ["reader-other"]);
assert.equal(transientReadStorage.getItem(sessionKey), manifestBeforeTransientRead);
assert.equal(
  transientReadStorage.getItem(projectTabStorageKey("reader-other")),
  readerOtherBeforeTransientRead,
  "读异常不同于确认缺失，必须保留旧 manifest 与实际分片",
);
assert.equal(writeTabSessionSnapshot(
  transientReadWrapper,
  readerTabsWithUpdatedA,
  {
    writeTabIds: new Set(["reader-good"]),
    knownPersistedTabIds: new Set(["reader-good", "reader-other"]),
  },
).ok, true);
console.log("  ✓ known 分片瞬时读异常阻止 manifest/cleanup，重试后完整恢复");

const migrationTabs = normalizeTabSessionValue({
  activeTabId: "migration-a",
  tabs: [
    storedSelectionTab("migration-a", [storedSelectionNode("migration-a-node")]),
    storedSelectionTab("migration-b", [storedSelectionNode("migration-b-node")]),
  ],
});
assert.ok(migrationTabs);
const legacyMigrationRaw = JSON.stringify({
  activeTabId: migrationTabs.activeTabId,
  tabs: migrationTabs.tabs,
});
let failMigrationB = true;
let migrationBWrites = 0;
const migrationStorage = memoryStorage(
  { [sessionKey]: legacyMigrationRaw },
  (key) => { if (key === projectTabStorageKey("migration-b")) migrationBWrites += 1; },
  (key) => failMigrationB && key === projectTabStorageKey("migration-b"),
);
const failedMigration = writeTabSessionSnapshot(migrationStorage, migrationTabs);
assert.equal(failedMigration.ok, false);
assert.equal(failedMigration.manifestWritten, false);
assert.equal(migrationStorage.getItem(sessionKey), legacyMigrationRaw);
assert.deepEqual(
  readTabSessionSnapshot(migrationStorage)?.tabs.map((tab) => tab.id),
  ["migration-a", "migration-b"],
  "迁移失败必须继续从完整 legacy 单体恢复",
);

const updatedMigrationTabs = {
  ...migrationTabs,
  tabs: migrationTabs.tabs.map((tab) => tab.id === "migration-a"
    ? { ...tab, projectName: "迁移 A 新内容", revision: tab.revision + 1, dirty: true }
    : tab),
};
const migrationBWritesAfterFailure = migrationBWrites;
const unrelatedMigrationWrite = writeTabSessionSnapshot(migrationStorage, updatedMigrationTabs, {
  writeTabIds: new Set(["migration-a"]),
  knownPersistedTabIds: new Set(["migration-a"]),
});
assert.equal(unrelatedMigrationWrite.ok, false);
assert.equal(unrelatedMigrationWrite.manifestWritten, false);
assert.equal(migrationBWrites, migrationBWritesAfterFailure, "A 的变化不得反复重试未变化的失败页签 B");
assert.equal(migrationStorage.getItem(sessionKey), legacyMigrationRaw);

failMigrationB = false;
const recoveredMigration = writeTabSessionSnapshot(migrationStorage, updatedMigrationTabs, {
  writeTabIds: new Set(["migration-b"]),
  knownPersistedTabIds: new Set(["migration-a"]),
});
assert.equal(recoveredMigration.ok, true);
assert.equal(recoveredMigration.manifestWritten, true);
assert.equal(readTabSessionSnapshot(migrationStorage)?.tabs[0].projectName, "迁移 A 新内容");
console.log("  ✓ legacy → v2 迁移保持完整恢复点，并隔离失败页签的重试节奏");

const rootReadFailureStorage = memoryStorage({ [sessionKey]: legacyMigrationRaw });
let throwRootReadOnce = true;
const rootReadFailureWrapper = {
  get length() { return rootReadFailureStorage.length; },
  getItem: (key: string) => {
    if (key === sessionKey && throwRootReadOnce) {
      throwRootReadOnce = false;
      throw new Error("transient root read failure");
    }
    return rootReadFailureStorage.getItem(key);
  },
  key: (index: number) => rootReadFailureStorage.key(index),
  setItem: (key: string, value: string) => {
    if (key === projectTabStorageKey("migration-b")) throw new Error("quota exceeded");
    rootReadFailureStorage.setItem(key, value);
  },
  removeItem: (key: string) => rootReadFailureStorage.removeItem(key),
};
const rootReadFailure = writeTabSessionSnapshot(rootReadFailureWrapper, migrationTabs);
assert.equal(rootReadFailure.ok, false);
assert.equal(rootReadFailure.manifestWritten, false);
assert.equal(rootReadFailureStorage.getItem(sessionKey), legacyMigrationRaw);
assert.deepEqual(
  readTabSessionSnapshot(rootReadFailureStorage)?.tabs.map((tab) => tab.id),
  ["migration-a", "migration-b"],
);
console.log("  ✓ root 读取异常与分片失败并发时不会覆盖未知 legacy 恢复点");

let failManifestWrite = true;
const manifestFailureStorage = memoryStorage(
  { [sessionKey]: legacyMigrationRaw },
  undefined,
  (key) => failManifestWrite && key === sessionKey,
);
const manifestFailure = writeTabSessionSnapshot(manifestFailureStorage, migrationTabs);
assert.equal(manifestFailure.ok, false);
assert.equal(manifestFailure.manifestWritten, false);
assert.equal(manifestFailureStorage.getItem(sessionKey), legacyMigrationRaw);
assert.ok(manifestFailureStorage.has(projectTabStorageKey("migration-a")));
assert.ok(manifestFailureStorage.has(projectTabStorageKey("migration-b")));
failManifestWrite = false;
const manifestRetry = writeTabSessionSnapshot(manifestFailureStorage, migrationTabs, {
  writeTabIds: new Set(),
  knownPersistedTabIds: new Set(["migration-a", "migration-b"]),
});
assert.equal(manifestRetry.ok, true);
assert.deepEqual(
  readTabSessionSnapshot(manifestFailureStorage)?.tabs.map((tab) => tab.id),
  ["migration-a", "migration-b"],
);
console.log("  ✓ manifest 发布失败不覆盖 legacy 恢复点，重试无需重写成功分片");

let failNewTabManifest = false;
const orphanRecoveryStorage = memoryStorage(
  {},
  undefined,
  (key) => failNewTabManifest && key === sessionKey,
);
assert.equal(writeTabSessionSnapshot(orphanRecoveryStorage, {
  ...readerTabs,
  tabs: [readerTabs.tabs[0]],
  activeTabId: "reader-good",
}).ok, true);
failNewTabManifest = true;
const orphanedNewTab = writeTabSessionSnapshot(orphanRecoveryStorage, readerTabs, {
  writeTabIds: new Set(["reader-other"]),
  knownPersistedTabIds: new Set(["reader-good"]),
});
assert.equal(orphanedNewTab.ok, false);
assert.equal(orphanRecoveryStorage.has(projectTabStorageKey("reader-other")), true);
assert.deepEqual(
  readTabSessionSnapshot(orphanRecoveryStorage)?.tabs.map((tab) => tab.id),
  ["reader-good"],
);
clearUnreferencedProjectTabSessionStorage(
  orphanRecoveryStorage,
  new Set(["reader-good"]),
);
assert.equal(orphanRecoveryStorage.has(projectTabStorageKey("reader-other")), false);
console.log("  ✓ v2 新页签 manifest 失败产生的不可达分片会在重载初始化时回收");

const v2DiscardStorage = memoryStorage();
assert.equal(writeTabSessionSnapshot(v2DiscardStorage, {
  ...readerTabs,
  activeTabId: "reader-other",
}).ok, true);
const originalWindowSessionStorage = window.sessionStorage;
try {
  Object.assign(window, { sessionStorage: v2DiscardStorage });
  discardActiveTabSession();
} finally {
  Object.assign(window, { sessionStorage: originalWindowSessionStorage });
}
const afterV2Discard = readTabSessionSnapshot(v2DiscardStorage);
assert.ok(afterV2Discard);
assert.equal(afterV2Discard.activeTabId, "reader-good");
assert.deepEqual(afterV2Discard.tabs.map((tab) => tab.id), ["reader-good"]);
assert.equal(v2DiscardStorage.has(projectTabStorageKey("reader-other")), false);
console.log("  ✓ v2 错误恢复只删除活动页签分片并保留其他草稿");

sessionStorage.setItem(sessionKey, JSON.stringify({
  activeTabId: "bad-tab",
  tabs: [
    { id: "good-tab", projectId: "good-project", projectName: "可恢复项目", nodes: [], edges: [] },
    { id: "bad-tab", projectId: "bad-project", projectName: "损坏项目", nodes: [], edges: [] },
  ],
}));
discardActiveTabSession();
const recovered = persistedSession();
assert.equal(recovered.activeTabId, "good-tab");
assert.deepEqual(recovered.tabs.map((tab) => tab.id), ["good-tab"]);
console.log("  ✓ 错误恢复只清除当前损坏页签并保留其他页签");

const oldAccountTabKeys = useFlowStore.getState().tabs.map((tab) => projectTabStorageKey(tab.id));
const writesBeforeAccountUnbind = sessionWrites;
assert.equal(prepareWorkspaceForLogin(sessionStorage, localStorage, "new-account"), "cleared");
assert.equal(sessionStorage.getItem(sessionKey), null);
for (const key of oldAccountTabKeys) assert.equal(sessionStorage.getItem(key), null);
useFlowStore.getState().setProjectName("旧账号解绑后不得回写");
assert.equal(flushTabSessionPersistence(), false);
flushIdleCallbacks();
assert.equal(sessionWrites, writesBeforeAccountUnbind);
assert.equal(sessionStorage.getItem(sessionKey), null);
for (const key of oldAccountTabKeys) assert.equal(sessionStorage.getItem(key), null);
console.log("  ✓ 跨账号解绑会永久失效当前页写入器，pagehide 不能复活旧账号草稿");

console.log("\n通过 28 项");

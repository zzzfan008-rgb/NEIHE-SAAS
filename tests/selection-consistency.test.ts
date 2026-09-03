import assert from "node:assert/strict";
import fs from "node:fs";
import {
  recentResultsPatch,
  reconcileRunHistory,
  selectActiveDocument,
  selectPrimarySelectedNodeId,
  trimRecentResults,
  useFlowStore,
  type FlowNode,
  type RecentResult,
} from "../src/store/flowStore";

let passed = 0;

function activeDocument(state = useFlowStore.getState()) {
  return selectActiveDocument(state);
}

function patchActiveDocument(
  patch: Partial<ReturnType<typeof activeDocument>>,
): void {
  useFlowStore.setState((state) => ({
    tabs: state.tabs.map((tab) => (
      tab.id === state.activeTabId ? { ...tab, ...patch } : tab
    )),
  }));
}

function setRecentResultsAndPatchActiveDocument(
  recentResults: RecentResult[],
  patch: Partial<ReturnType<typeof activeDocument>>,
): void {
  useFlowStore.setState((state) => ({
    recentResults,
    tabs: state.tabs.map((tab) => (
      tab.id === state.activeTabId ? { ...tab, ...patch } : tab
    )),
  }));
}

function test(name: string, run: () => void): void {
  try {
    run();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function node(id: string, selected = false): FlowNode {
  return {
    id,
    type: "image-input",
    position: { x: id === "a" ? 0 : 320, y: 0 },
    selected,
    data: { kind: "image-input", label: id, status: "idle", imageRole: "default" },
  };
}

function result(id: string, status: "success" | "error" = "success"): RecentResult {
  return {
    id,
    image: status === "success" ? `/api/files/${id}.png` : "",
    nodeId: `node-${id}`,
    nodeLabel: id,
    kind: "ai-modify",
    projectId: "selection-project",
    startedAt: Number(id.replace(/\D/g, "")) || 1,
    finishedAt: 2,
    status,
  };
}

function reset(): void {
  useFlowStore.getState().loadFlow({
    projectId: "selection-project",
    projectName: "选择一致性测试",
    nodes: [node("a", true), node("b", true)],
    edges: [],
  });
  useFlowStore.setState((state) => recentResultsPatch(state, []));
  useFlowStore.temporal.getState().clear();
}

function selectedFlags(): Array<[string, boolean]> {
  return activeDocument().nodes.map((candidate) => [candidate.id, Boolean(candidate.selected)]);
}

console.log("节点与结果选择一致性测试");

test("程序化单选同步 canonical IDs、primary 与 React Flow flags", () => {
  reset();
  const beforeRevision = activeDocument().revision;
  useFlowStore.getState().setSelectedNodeId("b");
  const state = activeDocument();

  assert.deepEqual(state.selectedNodeIds, ["b"]);
  assert.equal(selectPrimarySelectedNodeId(state), "b");
  assert.equal(state.selectedNodeId, "b", "兼容字段必须严格派生自 canonical IDs");
  assert.deepEqual(selectedFlags(), [["a", false], ["b", true]]);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 0);
  assert.equal(state.revision, beforeRevision);
});

test("React Flow 框选和取消选择同步业务 primary", () => {
  reset();
  useFlowStore.getState().onNodesChange([
    { id: "a", type: "select", selected: true },
    { id: "b", type: "select", selected: true },
  ]);
  assert.deepEqual(activeDocument().selectedNodeIds, ["a", "b"]);
  assert.equal(selectPrimarySelectedNodeId(activeDocument()), "b");

  useFlowStore.getState().onNodesChange([
    { id: "b", type: "select", selected: false },
  ]);
  assert.deepEqual(activeDocument().selectedNodeIds, ["a"]);
  assert.equal(selectPrimarySelectedNodeId(activeDocument()), "a");
  assert.deepEqual(selectedFlags(), [["a", true], ["b", false]]);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 0);
});

test("增选顺序决定 primary，普通移动不会重排 canonical selection", () => {
  reset();
  useFlowStore.getState().onNodesChange([{ id: "b", type: "select", selected: true }]);
  useFlowStore.getState().onNodesChange([{ id: "a", type: "select", selected: true }]);
  assert.deepEqual(activeDocument().selectedNodeIds, ["b", "a"]);
  assert.equal(selectPrimarySelectedNodeId(activeDocument()), "a");

  useFlowStore.getState().onNodesChange([{
    id: "a",
    type: "position",
    position: { x: 96, y: 48 },
    dragging: false,
  }]);
  assert.deepEqual(activeDocument().selectedNodeIds, ["b", "a"]);
  assert.equal(selectPrimarySelectedNodeId(activeDocument()), "a");
});

test("新增、删除和撤销始终清理 dangling selection", () => {
  reset();
  useFlowStore.getState().addExistingNode(node("c"));
  assert.deepEqual(activeDocument().selectedNodeIds, ["c"]);
  assert.deepEqual(selectedFlags(), [["a", false], ["b", false], ["c", true]]);

  useFlowStore.getState().onNodesChange([{ id: "c", type: "remove" }]);
  assert.deepEqual(activeDocument().selectedNodeIds, []);
  assert.equal(selectPrimarySelectedNodeId(activeDocument()), null);

  useFlowStore.getState().undo();
  assert.deepEqual(activeDocument().selectedNodeIds, []);
  assert.equal(activeDocument().nodes.some((candidate) => candidate.selected), false);
});

test("选择结果会清空全部节点选择且不写文档历史", () => {
  reset();
  const kept = result("kept");
  useFlowStore.setState((state) => recentResultsPatch(state, [kept]));
  useFlowStore.getState().setSelectedNodeIds(["a", "b"]);
  useFlowStore.getState().setSelectedResultId(kept.id);

  const state = activeDocument();
  assert.deepEqual(state.selectedNodeIds, []);
  assert.equal(selectPrimarySelectedNodeId(state), null);
  assert.equal(state.selectedResultId, kept.id);
  assert.equal(state.nodes.some((candidate) => candidate.selected), false);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 0);
});

test("画布空白 canonical command 会清除节点 IDs、primary 与 React Flow flags", () => {
  reset();
  useFlowStore.getState().setSelectedNodeIds(["a", "b"]);

  const selected = activeDocument();
  assert.deepEqual(selected.selectedNodeIds, ["a", "b"]);
  assert.equal(selectPrimarySelectedNodeId(selected), "b");
  assert.equal(selected.selectedNodeId, "b");
  assert.deepEqual(selectedFlags(), [["a", true], ["b", true]]);
  const beforeRevision = activeDocument().revision;

  useFlowStore.getState().setSelectedNodeIds([]);

  const state = activeDocument();
  assert.deepEqual(state.selectedNodeIds, []);
  assert.equal(selectPrimarySelectedNodeId(state), null);
  assert.equal(state.selectedNodeId, null);
  assert.deepEqual(selectedFlags(), [["a", false], ["b", false]]);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 0);
  assert.equal(state.revision, beforeRevision);

  const canvasSource = fs.readFileSync(
    new URL("../src/components/CanvasFlow.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    canvasSource,
    /useFlowStore\(\s*\(s\)\s*=>\s*s\.onNodesChange\s*\)/,
    "CanvasFlow 必须读取 canonical store onNodesChange action",
  );
  assert.match(
    canvasSource,
    /filterCancelledDragPositionChanges\(\s*dragTransactionRef\s*,\s*changes\s*\)/,
    "wrapper 必须先过滤已取消手势的晚到位置帧",
  );
  assert.match(
    canvasSource,
    /onNodesChange\(\s*filtered\s*\)/,
    "wrapper 必须将过滤结果委托给 canonical store action",
  );
  assert.match(
    canvasSource,
    /onNodesChange\s*=\s*\{\s*handleNodesChange\s*\}/,
    "ReactFlow 必须接入过滤 wrapper",
  );
  assert.match(
    canvasSource,
    /onPaneClick\s*=\s*\{\s*\(\)\s*=>\s*setSelectedNodeIds\(\s*\[\s*\]\s*\)\s*\}/,
    "点击画布空白处必须通过 canonical selection action 清空选择",
  );
});

test("画布空白 canonical command 会清除结果选择但保留 compareIds", () => {
  reset();
  const selectedResult = result("pane-selected-result");
  const comparedResult = result("pane-compared-result");
  useFlowStore.setState((state) => recentResultsPatch(state, [selectedResult, comparedResult]));
  useFlowStore.getState().toggleCompareId(comparedResult.id);
  useFlowStore.getState().setSelectedResultId(selectedResult.id);

  const selected = activeDocument();
  assert.equal(selected.selectedResultId, selectedResult.id);
  assert.deepEqual(selected.compareIds, [comparedResult.id]);
  const beforeRevision = selected.revision;

  useFlowStore.getState().setSelectedNodeIds([]);

  const state = activeDocument();
  assert.equal(state.selectedResultId, null);
  assert.deepEqual(state.compareIds, [comparedResult.id]);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 0);
  assert.equal(state.revision, beforeRevision);
});

test("历史同步、裁剪与删除原子清理失效结果引用", () => {
  reset();
  const keep = result("keep");
  setRecentResultsAndPatchActiveDocument([keep], {
    selectedResultId: "stale",
    compareIds: ["stale", keep.id],
  });
  reconcileRunHistory([keep]);
  assert.equal(activeDocument().selectedResultId, null);
  assert.deepEqual(activeDocument().compareIds, [keep.id]);

  const records = Array.from({ length: 201 }, (_, index) => result(`result-${index}`));
  setRecentResultsAndPatchActiveDocument(records, {
    selectedResultId: records[200].id,
    compareIds: [records[200].id, records[0].id],
  });
  useFlowStore.setState((state) => recentResultsPatch(state, trimRecentResults(state.recentResults, 200)));
  assert.equal(activeDocument().selectedResultId, null);
  assert.deepEqual(activeDocument().compareIds, [records[0].id]);

  useFlowStore.getState().removeRecentResult(records[0].id);
  assert.deepEqual(activeDocument().compareIds, []);
  assert.equal(useFlowStore.getState().recentResults.some((record) => record.id === records[0].id), false);
});

test("结果裁剪会在同一快照清理活动与后台页签引用", () => {
  reset();
  const keep = result("cross-tab-keep");
  const drop = result("cross-tab-drop");
  setRecentResultsAndPatchActiveDocument([keep, drop], {
    selectedResultId: drop.id,
    compareIds: [keep.id, drop.id],
  });
  useFlowStore.getState().openFlowTab({
    projectId: "selection-second-project",
    projectName: "第二个选择页签",
    nodes: [node("second-tab-node")],
    edges: [],
  });
  patchActiveDocument({ selectedResultId: drop.id, compareIds: [drop.id] });

  const observed: Array<{
    activeReferencesValid: boolean;
    tabReferencesValid: boolean;
    activeDocumentIsCanonical: boolean;
  }> = [];
  const unsubscribe = useFlowStore.subscribe((state) => {
    const ids = new Set(state.recentResults.map((record) => record.id));
    const comparableIds = new Set(
      state.recentResults
        .filter((record) => record.status === "success" && Boolean(record.image))
        .map((record) => record.id),
    );
    const document = activeDocument(state);
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    observed.push({
      activeReferencesValid: (
        (!document.selectedResultId || ids.has(document.selectedResultId)) &&
        document.compareIds.every((id) => comparableIds.has(id))
      ),
      tabReferencesValid: state.tabs.every((tab) => (
        (!tab.selectedResultId || ids.has(tab.selectedResultId)) &&
        tab.compareIds.every((id) => comparableIds.has(id))
      )),
      activeDocumentIsCanonical: activeTab === document,
    });
  });
  useFlowStore.setState((state) => recentResultsPatch(state, [keep]));
  unsubscribe();

  const state = useFlowStore.getState();
  assert.ok(observed.length > 0, "必须实际观察到 Zustand subscription snapshot");
  assert.equal(
    observed.every((snapshot) => (
      snapshot.activeReferencesValid &&
      snapshot.tabReferencesValid &&
      snapshot.activeDocumentIsCanonical
    )),
    true,
    "每个可见快照的活动文档与全部 tabs 都必须同时只引用现存结果",
  );
  assert.equal(activeDocument(state).selectedResultId, null);
  assert.deepEqual(activeDocument(state).compareIds, []);
  assert.equal(state.tabs.every((tab) => tab.selectedResultId === null), true);
  assert.equal(state.tabs.every((tab) => !tab.compareIds.includes(drop.id)), true);
});

test("实时页签切换恢复各自 canonical selection 与 primary", () => {
  useFlowStore.getState().openFlowTab({
    projectId: "live-selection-project-a",
    projectName: "实时选择页签 A",
    nodes: [node("live-a-1"), node("live-a-2")],
    edges: [],
  });
  const tabA = useFlowStore.getState().activeTabId;
  useFlowStore.getState().setSelectedNodeIds(["live-a-2", "live-a-1"]);

  useFlowStore.getState().openFlowTab({
    projectId: "live-selection-project-b",
    projectName: "实时选择页签 B",
    nodes: [node("live-b-1"), node("live-b-2")],
    edges: [],
  });
  const tabB = useFlowStore.getState().activeTabId;
  useFlowStore.getState().setSelectedNodeIds(["live-b-1", "live-b-2"]);

  useFlowStore.getState().switchTab(tabA);
  let state = activeDocument();
  assert.deepEqual(state.selectedNodeIds, ["live-a-2", "live-a-1"]);
  assert.equal(state.selectedNodeId, "live-a-1");
  assert.equal(selectPrimarySelectedNodeId(state), "live-a-1");
  assert.deepEqual(
    state.nodes.map((candidate) => [candidate.id, Boolean(candidate.selected)]),
    [["live-a-1", true], ["live-a-2", true]],
  );

  useFlowStore.getState().switchTab(tabB);
  state = activeDocument();
  assert.deepEqual(state.selectedNodeIds, ["live-b-1", "live-b-2"]);
  assert.equal(state.selectedNodeId, "live-b-2");
  assert.equal(selectPrimarySelectedNodeId(state), "live-b-2");
  assert.deepEqual(
    state.nodes.map((candidate) => [candidate.id, Boolean(candidate.selected)]),
    [["live-b-1", true], ["live-b-2", true]],
  );
});

test("复制读取 canonical 多选集合，属性面板保持 primary selector", () => {
  reset();
  useFlowStore.getState().onNodesChange([{ id: "b", type: "select", selected: true }]);
  useFlowStore.getState().onNodesChange([{ id: "a", type: "select", selected: true }]);
  const state = activeDocument();
  const inspectorNodeId = selectPrimarySelectedNodeId(state);
  assert.equal(inspectorNodeId, "a", "Inspector selector 必须指向最后增选的节点");

  const appSource = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const inspectorSource = fs.readFileSync(
    new URL("../src/components/panels/InspectorPanel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(appSource, /selectActiveSelectedNodeIds/);
  assert.match(inspectorSource, /useFlowStore\(selectActivePrimarySelectedNodeId\)/);
  assert.doesNotMatch(appSource, /getState\(\)\.selectedNodeId/);
});

console.log(`\n通过 ${passed} 项`);

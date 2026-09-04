import assert from "node:assert/strict";
import {
  beginDragHistoryTransaction,
  filterCancelledDragPositionChanges,
  finishDragHistoryTransaction,
  registerDragInterruptionHandlers,
} from "../src/components/CanvasFlow";
import {
  applyRunEventToTab,
  beginHistoryTransaction,
  endHistoryTransaction,
  reconcileRunHistory,
  selectActiveDocument,
  useFlowStore,
  type DocumentTarget,
  type FlowNode,
} from "../src/store/flowStore";
import type { WorkflowNodeData } from "../src/types/workflow";
import { setGenerationSafetyBlockReason } from "../src/store/generationSafety";

let passed = 0;

function activeDocument(state = useFlowStore.getState()) {
  return selectActiveDocument(state);
}

function documentTargetForTab(tabId: string): DocumentTarget {
  const tab = useFlowStore.getState().tabs.find((candidate) => candidate.id === tabId);
  assert.ok(tab, `找不到页签 ${tabId}`);
  return { tabId, projectId: tab.projectId, documentEpoch: tab.documentEpoch };
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

async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function aiNode(id = "history-node"): FlowNode {
  return {
    id,
    type: "ai-modify",
    position: { x: 0, y: 0 },
    data: {
      kind: "ai-modify",
      label: "历史事务节点",
      status: "idle",
      prompt: "保留衣身，修改领型",
      aspectRatio: "1:1",
      batchSize: 1,
      outputImages: ["/api/files/previous.png"],
    },
  };
}

function resetDocument(node = aiNode()): { tabId: string; nodeId: string } {
  useFlowStore.getState().loadFlow({
    projectId: `history-project-${node.id}`,
    projectName: "历史事务测试",
    nodes: [node],
    edges: [],
  });
  useFlowStore.temporal.getState().clear();
  return { tabId: useFlowStore.getState().activeTabId, nodeId: node.id };
}

console.log("画布文档历史事务测试");
// 这些用例验证已完成活动任务对账后的历史行为；冷启动关闭门禁另有契约测试。
setGenerationSafetyBlockReason(null);

await test("queued/running/retry/cancel 运行态不进入撤销历史", () => {
  const { tabId, nodeId } = resetDocument();
  const before = activeDocument();

  for (const status of [
    "queued",
    "running",
    "retry_wait",
    "cancel_requested",
    "cancelled",
    "error",
    "outcome_unknown",
  ] as const) {
    applyRunEventToTab(documentTargetForTab(tabId), nodeId, {
      type: "node-status",
      nodeId,
      status,
      ...(["retry_wait", "error", "outcome_unknown"].includes(status)
        ? { error: "状态同步中断" }
        : {}),
    });
  }

  const after = activeDocument();
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 0);
  assert.equal(after.revision, before.revision);
  assert.equal(after.dirty, before.dirty);
  assert.equal(after.saveState, before.saveState);
  assert.equal(after.nodes[0].data.status, "outcome_unknown");
});

await test("历史对账的运行态修复不进入撤销历史", () => {
  resetDocument();
  useFlowStore.getState().setNodeStatus("history-node", "queued");
  useFlowStore.temporal.getState().clear();
  const beforeRevision = activeDocument().revision;

  reconcileRunHistory([]);

  assert.equal(activeDocument().nodes[0].data.status, "idle");
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 0);
  assert.equal(activeDocument().revision, beforeRevision);
});

await test("一次节点拖拽只形成一条记录并一次撤销到起点", () => {
  const { nodeId } = resetDocument();
  const before = activeDocument();

  const transaction = beginHistoryTransaction("node-drag");
  for (const x of [24, 48, 96]) {
    useFlowStore.getState().onNodesChange([{
      id: nodeId,
      type: "position",
      position: { x, y: 16 },
      dragging: true,
    }]);
  }
  endHistoryTransaction(transaction);

  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);
  assert.equal(activeDocument().revision, before.revision + 1);
  assert.deepEqual(activeDocument().nodes[0].position, { x: 96, y: 16 });

  useFlowStore.getState().undo();
  assert.deepEqual(activeDocument().nodes[0].position, { x: 0, y: 0 });

  useFlowStore.getState().redo();
  assert.deepEqual(activeDocument().nodes[0].position, { x: 96, y: 16 });
});

await test("自动整理只移动主选连通工作流并形成一条可撤销历史", () => {
  const make = (id: string, x: number, y: number): FlowNode => ({
    ...aiNode(id),
    position: { x, y },
    measured: { width: 280, height: 180 },
  });
  useFlowStore.getState().loadFlow({
    projectId: "layout-history-project",
    projectName: "自动整理历史测试",
    nodes: [make("layout-a", 0, 0), make("layout-b", 20, 10), make("layout-c", 40, 20), make("layout-other", 900, 700)],
    edges: [
      { id: "layout-ab", source: "layout-a", target: "layout-b" },
      { id: "layout-bc", source: "layout-b", target: "layout-c" },
    ],
  });
  useFlowStore.temporal.getState().clear();
  useFlowStore.getState().setSelectedNodeId("layout-b");
  const before = activeDocument().nodes.map((node) => ({ id: node.id, position: { ...node.position } }));

  assert.equal(useFlowStore.getState().autoLayoutSelectedWorkflow(), null);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);
  assert.deepEqual(activeDocument().nodes.find((node) => node.id === "layout-other")?.position, { x: 900, y: 700 });

  useFlowStore.getState().undo();
  assert.deepEqual(
    activeDocument().nodes.map((node) => ({ id: node.id, position: node.position })),
    before,
  );

  useFlowStore.getState().setSelectedNodeIds([]);
  const historyCount = useFlowStore.temporal.getState().pastStates.length;
  assert.match(useFlowStore.getState().autoLayoutSelectedWorkflow() ?? "", /选择/);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, historyCount);
});

await test("拖拽中的 undo 与 redo 会在自然结束后真正执行", async () => {
  const { nodeId } = resetDocument(aiNode("deferred-history-commands"));
  const transaction = beginHistoryTransaction("deferred-undo-redo");
  useFlowStore.getState().onNodesChange([{
    id: nodeId,
    type: "position",
    position: { x: 112, y: 28 },
    dragging: true,
  }]);

  useFlowStore.getState().undo();
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 0);
  assert.deepEqual(activeDocument().nodes[0].position, { x: 112, y: 28 });

  assert.equal(endHistoryTransaction(transaction), true);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(activeDocument().nodes[0].position, { x: 0, y: 0 });
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 0);
  assert.equal(useFlowStore.temporal.getState().futureStates.length, 1);

  const redoTransaction = beginHistoryTransaction("deferred-redo");
  useFlowStore.getState().redo();
  assert.deepEqual(activeDocument().nodes[0].position, { x: 0, y: 0 });
  assert.equal(endHistoryTransaction(redoTransaction), false);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(activeDocument().nodes[0].position, { x: 112, y: 28 });
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);
  assert.equal(useFlowStore.temporal.getState().futureStates.length, 0);
});

await test("拖拽位置检测不会序列化共享的大型节点数据", () => {
  const { nodeId } = resetDocument(aiNode("large-mask-drag"));
  const data = activeDocument().nodes[0].data as WorkflowNodeData & {
    toJSON?: () => unknown;
  };
  let serializationCount = 0;
  Object.defineProperty(data, "toJSON", {
    configurable: true,
    enumerable: true,
    value: () => {
      serializationCount += 1;
      return { mask: "should-not-be-serialized-during-drag" };
    },
  });

  const transaction = beginHistoryTransaction("large-mask-node-drag");
  useFlowStore.getState().onNodesChange([{
    id: nodeId,
    type: "position",
    position: { x: 80, y: 40 },
    dragging: true,
  }]);
  endHistoryTransaction(transaction);

  assert.equal(serializationCount, 0);
  assert.deepEqual(activeDocument().nodes[0].position, { x: 80, y: 40 });
  delete data.toJSON;
});

await test("blur、pointercancel 与卸载都会提交最后可见拖拽位置", () => {
  for (const [reason, x] of [
    ["blur", 48],
    ["pointercancel", 96],
    ["unmount", 144],
  ] as const) {
    const { nodeId } = resetDocument(aiNode(`interrupted-${reason}`));
    const beforeRevision = activeDocument().revision;
    const transactionRef = {
      current: beginHistoryTransaction(`node-drag-${reason}`),
      startedAt: null,
    };
    const target = new EventTarget();
    const cleanup = registerDragInterruptionHandlers(transactionRef, target);

    useFlowStore.getState().onNodesChange([{
      id: nodeId,
      type: "position",
      position: { x, y: 32 },
      dragging: true,
    }]);
    if (reason === "unmount") cleanup();
    else {
      target.dispatchEvent(new Event(reason));
      cleanup();
    }

    assert.equal(transactionRef.current, null, `${reason} 后不得遗留事务 token`);
    assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);
    assert.equal(activeDocument().revision, beforeRevision + 1);
    assert.deepEqual(activeDocument().nodes[0].position, { x, y: 32 });
    assert.notEqual(activeDocument().nodes[0].dragging, true);

    useFlowStore.getState().undo();
    assert.deepEqual(activeDocument().nodes[0].position, { x: 0, y: 0 });
    assert.notEqual(activeDocument().nodes[0].dragging, true);
    useFlowStore.getState().redo();
    assert.deepEqual(activeDocument().nodes[0].position, { x, y: 32 });
    assert.notEqual(activeDocument().nodes[0].dragging, true);
  }
});

await test("拖拽回原位是净零事务", () => {
  const { nodeId } = resetDocument();
  const before = activeDocument();
  const transaction = beginHistoryTransaction("node-drag-net-zero");
  useFlowStore.getState().onNodesChange([{
    id: nodeId,
    type: "position",
    position: { x: 64, y: 32 },
    dragging: true,
  }]);
  useFlowStore.getState().onNodesChange([{
    id: nodeId,
    type: "position",
    position: { x: 0, y: 0 },
    dragging: false,
  }]);
  endHistoryTransaction(transaction);

  assert.equal(useFlowStore.temporal.getState().pastStates.length, 0);
  assert.equal(activeDocument().revision, before.revision);
  assert.equal(activeDocument().dirty, before.dirty);
});

await test("切换页签会回滚尚未结束的拖拽事务", () => {
  const { tabId: firstTabId, nodeId } = resetDocument(aiNode("transaction-cancelled"));
  useFlowStore.getState().openFlowTab({
    projectId: "history-second-project",
    projectName: "另一个项目",
    nodes: [aiNode("second-tab-node")],
    edges: [],
  });
  const secondTabId = useFlowStore.getState().activeTabId;
  useFlowStore.getState().switchTab(firstTabId);
  useFlowStore.temporal.getState().clear();
  const beforeRevision = activeDocument().revision;

  const transaction = beginHistoryTransaction("node-drag-cancelled-by-tab-switch");
  useFlowStore.getState().onNodesChange([{
    id: nodeId,
    type: "position",
    position: { x: 180, y: 64 },
    dragging: true,
  }]);
  applyRunEventToTab(documentTargetForTab(firstTabId), nodeId, {
    type: "node-status",
    nodeId,
    status: "success",
    images: ["/api/files/success-before-switch.png"],
  });
  assert.deepEqual(activeDocument().nodes[0].position, { x: 180, y: 64 });

  useFlowStore.getState().switchTab(secondTabId);
  assert.equal(endHistoryTransaction(transaction), false, "失效 token 不能提交到新页签");
  const firstTab = useFlowStore.getState().tabs.find((tab) => tab.id === firstTabId);
  assert.deepEqual(firstTab?.nodes[0].position, { x: 0, y: 0 });
  assert.notEqual(firstTab?.nodes[0].dragging, true, "切页取消后后台页签不得残留拖拽态");
  assert.deepEqual(
    firstTab?.nodes[0].data.kind === "ai-modify" ? firstTab.nodes[0].data.outputImages : [],
    ["/api/files/success-before-switch.png"],
    "事务回滚不能丢掉期间完成的生成输出",
  );
  assert.equal(firstTab?.revision, beforeRevision + 1);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 0);

  useFlowStore.getState().switchTab(firstTabId);
  assert.deepEqual(activeDocument().nodes[0].position, { x: 0, y: 0 });
});

await test("切页取消会丢弃排队的 undo/redo 命令", async () => {
  const { tabId: firstTabId, nodeId } = resetDocument(aiNode("cancelled-history-commands"));
  useFlowStore.getState().updateNodeData(nodeId, { prompt: "保留这次修改" });
  useFlowStore.getState().openFlowTab({
    projectId: "cancelled-history-command-target",
    projectName: "切页目标",
    nodes: [aiNode("cancelled-history-command-target-node")],
    edges: [],
  });
  const secondTabId = useFlowStore.getState().activeTabId;
  useFlowStore.getState().switchTab(firstTabId);

  const transaction = beginHistoryTransaction("cancel-deferred-undo-redo");
  useFlowStore.getState().onNodesChange([{
    id: nodeId,
    type: "position",
    position: { x: 160, y: 40 },
    dragging: true,
  }]);
  useFlowStore.getState().undo();
  useFlowStore.getState().redo();
  useFlowStore.getState().switchTab(secondTabId);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(endHistoryTransaction(transaction), false);
  useFlowStore.getState().switchTab(firstTabId);
  const data = activeDocument().nodes[0].data;
  assert.equal(data.kind === "ai-modify" ? data.prompt : "", "保留这次修改");
  assert.deepEqual(activeDocument().nodes[0].position, { x: 0, y: 0 });
});

await test("关闭后台页签不会取消前台拖拽事务", () => {
  const { tabId: firstTabId, nodeId } = resetDocument(aiNode("close-background-drag"));
  useFlowStore.getState().openFlowTab({
    projectId: "close-background-tab",
    projectName: "待关闭后台页签",
    nodes: [aiNode("close-background-node")],
    edges: [],
  });
  const backgroundTabId = useFlowStore.getState().activeTabId;
  useFlowStore.getState().switchTab(firstTabId);
  useFlowStore.temporal.getState().clear();
  const beforeRevision = activeDocument().revision;

  const transaction = beginHistoryTransaction("close-background-during-drag");
  useFlowStore.getState().onNodesChange([{
    id: nodeId,
    type: "position",
    position: { x: 88, y: 22 },
    dragging: true,
  }]);
  useFlowStore.getState().closeTab(backgroundTabId);

  assert.equal(useFlowStore.getState().activeTabId, firstTabId);
  assert.equal(useFlowStore.getState().tabs.some((tab) => tab.id === backgroundTabId), false);
  assert.deepEqual(activeDocument().nodes[0].position, { x: 88, y: 22 });
  assert.equal(endHistoryTransaction(transaction), true);
  assert.equal(activeDocument().revision, beforeRevision + 1);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);
});

await test("取消后的旧 stop 不会结束新手势，新拖拽仍只产生一条历史", () => {
  const sharedNodeId = "late-position-shared-node";
  const { tabId: firstTabId } = resetDocument(aiNode(sharedNodeId));
  useFlowStore.getState().openFlowTab({
    projectId: "late-position-second-project",
    projectName: "晚到帧目标",
    nodes: [aiNode(sharedNodeId)],
    edges: [],
  });
  const secondTabId = useFlowStore.getState().activeTabId;
  useFlowStore.getState().switchTab(firstTabId);
  const transactionRef = { current: null, startedAt: null };

  beginDragHistoryTransaction(transactionRef, 100);
  useFlowStore.getState().onNodesChange([{
    id: sharedNodeId,
    type: "position",
    position: { x: 180, y: 64 },
    dragging: true,
  }]);
  useFlowStore.getState().switchTab(secondTabId);
  assert.equal(transactionRef.current, null);

  const filtered = filterCancelledDragPositionChanges(transactionRef, [
    {
      id: sharedNodeId,
      type: "position",
      position: { x: 999, y: 999 },
      dragging: true,
    },
    { id: sharedNodeId, type: "select", selected: true },
  ]);
  useFlowStore.getState().onNodesChange(filtered);
  assert.equal(filtered.length, 1, "只保留非 position 变化");
  assert.deepEqual(activeDocument().nodes[0].position, { x: 0, y: 0 });
  assert.equal(activeDocument().nodes[0].selected, true);

  beginDragHistoryTransaction(transactionRef, 200);
  const newToken = transactionRef.current;
  assert.ok(newToken);
  assert.equal(
    finishDragHistoryTransaction(transactionRef, 150),
    false,
    "旧手势的晚到 stop 不得结束新 token",
  );
  assert.equal(transactionRef.current, newToken);

  for (const [x, y] of [[40, 12], [72, 20], [104, 28]] as const) {
    const nextGesture = filterCancelledDragPositionChanges(transactionRef, [{
      id: sharedNodeId,
      type: "position",
      position: { x, y },
      dragging: true,
    }]);
    assert.equal(nextGesture.length, 1, "新手势开始后必须解除 quarantine");
    useFlowStore.getState().onNodesChange(nextGesture);
  }
  assert.equal(finishDragHistoryTransaction(transactionRef, 250), true);
  assert.deepEqual(activeDocument().nodes[0].position, { x: 104, y: 28 });
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);
  useFlowStore.getState().undo();
  assert.deepEqual(activeDocument().nodes[0].position, { x: 0, y: 0 });
});

await test("无历史的 undo/redo 与同值更新不改变文档元数据", () => {
  const { nodeId } = resetDocument();
  patchActiveDocument({
    dirty: false,
    saveState: "saved",
    savedRevision: activeDocument().revision,
  });
  const before = activeDocument();

  useFlowStore.getState().updateNodeData(nodeId, { label: before.nodes[0].data.label });
  useFlowStore.getState().undo();
  let after = activeDocument();
  assert.equal(after.revision, before.revision);
  assert.equal(after.savedRevision, before.savedRevision);
  assert.equal(after.dirty, before.dirty);
  assert.equal(after.saveState, before.saveState);

  useFlowStore.getState().redo();

  after = activeDocument();
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 0);
  assert.equal(useFlowStore.temporal.getState().futureStates.length, 0);
  assert.equal(after.revision, before.revision);
  assert.equal(after.savedRevision, before.savedRevision);
  assert.equal(after.dirty, before.dirty);
  assert.equal(after.saveState, before.saveState);
});

await test("项目名称作为文档字段可撤销重做且不回退运行态", () => {
  const { tabId, nodeId } = resetDocument(aiNode("project-name-history"));
  const before = activeDocument();

  useFlowStore.getState().setProjectName("重命名后的项目");
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);
  assert.equal(activeDocument().revision, before.revision + 1);

  applyRunEventToTab(documentTargetForTab(tabId), nodeId, {
    type: "node-status",
    nodeId,
    status: "running",
  });
  useFlowStore.getState().undo();
  assert.equal(activeDocument().projectName, before.projectName);
  assert.equal(activeDocument().nodes[0].data.status, "running");

  useFlowStore.getState().redo();
  assert.equal(activeDocument().projectName, "重命名后的项目");
  assert.equal(activeDocument().nodes[0].data.status, "running");
});

await test("项目名称的撤销栈按页签隔离", () => {
  const { tabId: firstTabId } = resetDocument(aiNode("project-name-tab-a"));
  useFlowStore.getState().setProjectName("A 重命名");
  useFlowStore.getState().openFlowTab({
    projectId: "project-name-tab-b",
    projectName: "B 原名",
    nodes: [aiNode("project-name-tab-b-node")],
    edges: [],
  });
  const secondTabId = useFlowStore.getState().activeTabId;
  useFlowStore.getState().setProjectName("B 重命名");

  useFlowStore.getState().switchTab(firstTabId);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);
  useFlowStore.getState().undo();
  assert.equal(activeDocument().projectName, "历史事务测试");

  useFlowStore.getState().switchTab(secondTabId);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);
  useFlowStore.getState().undo();
  assert.equal(activeDocument().projectName, "B 原名");
});

await test("成功生成输出作为一次提交，撤销输出时保留最新运行态", () => {
  const { tabId, nodeId } = resetDocument();
  const beforeRevision = activeDocument().revision;

  applyRunEventToTab(documentTargetForTab(tabId), nodeId, {
    type: "node-status",
    nodeId,
    status: "running",
  });
  applyRunEventToTab(documentTargetForTab(tabId), nodeId, {
    type: "node-status",
    nodeId,
    status: "success",
    images: ["/api/files/final-a.png", "/api/files/final-b.png"],
    finishedAt: 2_000,
  });

  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);
  assert.equal(activeDocument().revision, beforeRevision + 1);
  assert.deepEqual(
    activeDocument().nodes[0].data.kind === "ai-modify"
      ? activeDocument().nodes[0].data.outputImages
      : [],
    ["/api/files/final-a.png", "/api/files/final-b.png"],
  );
  const generatedResultId = activeDocument().nodes.find((node) => node.data.kind === "result")?.id;
  assert.ok(generatedResultId, "成功生成必须自动创建结果节点");
  assert.ok(activeDocument().edges.some((edge) => edge.source === nodeId && edge.target === generatedResultId));

  useFlowStore.getState().undo();
  const undone = activeDocument().nodes[0].data;
  assert.equal(undone.status, "success", "undo 只撤销文档输出，不倒退服务端运行态");
  assert.deepEqual(undone.kind === "ai-modify" ? undone.outputImages : [], ["/api/files/previous.png"]);
  assert.ok(activeDocument().nodes.some((node) => node.id === generatedResultId), "自动结果节点不得进入撤销历史");

  useFlowStore.getState().redo();
  const redone = activeDocument().nodes[0].data;
  assert.equal(redone.status, "success");
  assert.deepEqual(
    redone.kind === "ai-modify" ? redone.outputImages : [],
    ["/api/files/final-a.png", "/api/files/final-b.png"],
  );
});

await test("拖拽期间的成功输出与位置历史彼此独立", () => {
  const { tabId, nodeId } = resetDocument(aiNode("concurrent-success"));
  const beforeRevision = activeDocument().revision;
  const transaction = beginHistoryTransaction("node-drag-with-success");
  useFlowStore.getState().onNodesChange([{
    id: nodeId,
    type: "position",
    position: { x: 120, y: 48 },
    dragging: true,
  }]);
  applyRunEventToTab(documentTargetForTab(tabId), nodeId, {
    type: "node-status",
    nodeId,
    status: "success",
    images: ["/api/files/concurrent.png"],
  });
  endHistoryTransaction(transaction);

  assert.equal(useFlowStore.temporal.getState().pastStates.length, 2);
  assert.equal(activeDocument().revision, beforeRevision + 2);
  assert.deepEqual(activeDocument().nodes[0].position, { x: 120, y: 48 });

  useFlowStore.getState().undo();
  let data = activeDocument().nodes[0].data;
  assert.deepEqual(activeDocument().nodes[0].position, { x: 0, y: 0 });
  assert.deepEqual(data.kind === "ai-modify" ? data.outputImages : [], ["/api/files/concurrent.png"]);

  useFlowStore.getState().undo();
  data = activeDocument().nodes[0].data;
  assert.deepEqual(activeDocument().nodes[0].position, { x: 0, y: 0 });
  assert.deepEqual(data.kind === "ai-modify" ? data.outputImages : [], ["/api/files/previous.png"]);
});

await test("后台页签的成功输出在切回后仍可独立撤销", () => {
  const { tabId: firstTabId, nodeId } = resetDocument(aiNode("background-success"));
  useFlowStore.getState().openFlowTab({
    projectId: "background-success-second-project",
    projectName: "前台项目",
    nodes: [aiNode("foreground-node")],
    edges: [],
  });
  const secondTabId = useFlowStore.getState().activeTabId;

  applyRunEventToTab(documentTargetForTab(firstTabId), nodeId, {
    type: "node-status",
    nodeId,
    status: "success",
    images: ["/api/files/background-success.png"],
  });
  const backgroundTab = useFlowStore.getState().tabs.find((tab) => tab.id === firstTabId);
  assert.deepEqual(
    backgroundTab?.nodes[0].data.kind === "ai-modify"
      ? backgroundTab.nodes[0].data.outputImages
      : [],
    ["/api/files/background-success.png"],
  );

  useFlowStore.getState().switchTab(firstTabId);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);
  useFlowStore.getState().undo();
  const undone = activeDocument().nodes[0].data;
  assert.equal(undone.status, "success");
  assert.deepEqual(undone.kind === "ai-modify" ? undone.outputImages : [], ["/api/files/previous.png"]);

  useFlowStore.getState().switchTab(secondTabId);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 0);
  useFlowStore.getState().switchTab(firstTabId);
  assert.equal(useFlowStore.temporal.getState().futureStates.length, 1, "页签切换不能丢失 redo");
  useFlowStore.getState().redo();
  const redone = activeDocument().nodes[0].data;
  assert.deepEqual(
    redone.kind === "ai-modify" ? redone.outputImages : [],
    ["/api/files/background-success.png"],
  );
});

await test("每个项目页签保留独立的撤销与重做栈", () => {
  const { tabId: firstTabId, nodeId: firstNodeId } = resetDocument(aiNode("tab-history-a"));
  useFlowStore.getState().updateNodeData(firstNodeId, { prompt: "A 的新提示词" });
  useFlowStore.getState().openFlowTab({
    projectId: "tab-history-project-b",
    projectName: "页签 B",
    nodes: [aiNode("tab-history-b")],
    edges: [],
  });
  const secondTabId = useFlowStore.getState().activeTabId;
  useFlowStore.getState().updateNodeData("tab-history-b", { prompt: "B 的新提示词" });

  useFlowStore.getState().switchTab(firstTabId);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);
  useFlowStore.getState().undo();
  const firstData = activeDocument().nodes[0].data;
  assert.equal(firstData.kind === "ai-modify" ? firstData.prompt : "", "保留衣身，修改领型");

  useFlowStore.getState().switchTab(secondTabId);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);
  useFlowStore.getState().undo();
  const secondData = activeDocument().nodes[0].data;
  assert.equal(secondData.kind === "ai-modify" ? secondData.prompt : "", "保留衣身，修改领型");
});

await test("运行态写入不清除已有 redo，成功事件重放不新增历史", () => {
  const { tabId, nodeId } = resetDocument();
  useFlowStore.getState().updateNodeData(nodeId, { prompt: "第一次修改" });
  useFlowStore.getState().undo();
  assert.equal(useFlowStore.temporal.getState().futureStates.length, 1);

  applyRunEventToTab(documentTargetForTab(tabId), nodeId, {
    type: "node-status",
    nodeId,
    status: "running",
  });
  assert.equal(useFlowStore.temporal.getState().futureStates.length, 1);
  useFlowStore.getState().redo();
  assert.equal(
    activeDocument().nodes[0].data.kind === "ai-modify"
      ? activeDocument().nodes[0].data.prompt
      : "",
    "第一次修改",
  );

  applyRunEventToTab(documentTargetForTab(tabId), nodeId, {
    type: "node-status",
    nodeId,
    status: "success",
    images: ["/api/files/replayed.png"],
  });
  const historyCount = useFlowStore.temporal.getState().pastStates.length;
  const revision = activeDocument().revision;
  applyRunEventToTab(documentTargetForTab(tabId), nodeId, {
    type: "node-status",
    nodeId,
    status: "success",
    images: ["/api/files/replayed.png"],
  });
  assert.equal(useFlowStore.temporal.getState().pastStates.length, historyCount);
  assert.equal(activeDocument().revision, revision);
});

await test("zundo 公开 undo/redo 按多步顺序回放 canonical 页签", () => {
  const { nodeId } = resetDocument(aiNode("public-temporal-api"));
  for (const prompt of ["第一步", "第二步", "第三步"]) {
    useFlowStore.getState().updateNodeData(nodeId, { prompt });
  }
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 3);

  useFlowStore.temporal.getState().undo(3);
  let data = activeDocument().nodes[0].data;
  assert.equal(data.kind === "ai-modify" ? data.prompt : "", "保留衣身，修改领型");
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 0);
  assert.equal(useFlowStore.temporal.getState().futureStates.length, 3);
  assert.equal(Object.prototype.hasOwnProperty.call(useFlowStore.getState(), "projectName"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(useFlowStore.getState(), "nodes"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(useFlowStore.getState(), "edges"), false);

  useFlowStore.temporal.getState().redo(3);
  data = activeDocument().nodes[0].data;
  assert.equal(data.kind === "ai-modify" ? data.prompt : "", "第三步");
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 3);
  assert.equal(useFlowStore.temporal.getState().futureStates.length, 0);
});

await test("撤销文档不回退 React Flow 测量瞬态与服务端运行态", () => {
  const measuredNode: FlowNode = {
    ...aiNode("preserved-transients"),
    measured: { width: 240, height: 160 },
    width: 240,
    height: 160,
  };
  const { nodeId } = resetDocument(measuredNode);
  useFlowStore.getState().updateNodeData(nodeId, { prompt: "会被撤销的提示词" });
  patchActiveDocument({
    nodes: activeDocument().nodes.map((node) => node.id === nodeId
      ? {
        ...node,
        measured: { width: 480, height: 320 },
        width: 480,
        height: 320,
        data: { ...node.data, status: "success", error: undefined },
      }
      : node),
  });

  useFlowStore.getState().undo();
  const restored = activeDocument().nodes[0];
  assert.deepEqual(restored.measured, { width: 480, height: 320 });
  assert.equal(restored.width, 480);
  assert.equal(restored.height, 320);
  assert.equal(restored.data.status, "success");
  assert.equal(restored.data.kind === "ai-modify" ? restored.data.prompt : "", "保留衣身，修改领型");
});

await test("画板保存与导出各只形成一次全局历史且拒绝过期 DocumentTarget", () => {
  const board: FlowNode = {
    id: "atomic-board",
    type: "drawing-board",
    position: { x: 0, y: 0 },
    data: {
      kind: "drawing-board", label: "画板", status: "idle", boardVersion: 1,
      width: 1024, height: 1024, background: "#FFFFFF",
    },
  };
  const { tabId, nodeId } = resetDocument(board);
  const target = documentTargetForTab(tabId);
  assert.equal(useFlowStore.getState().commitDrawingBoard(target, nodeId, {
    contentRef: "draw_atomic_v1",
    previewImageRef: "/api/files/draw-atomic.png",
  }), true);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);
  assert.equal(activeDocument().nodes[0].data.kind === "drawing-board" && activeDocument().nodes[0].data.contentRef, "draw_atomic_v1");

  const exportedId = useFlowStore.getState().exportDrawingBoardImageNode(target, nodeId);
  assert.ok(exportedId);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 2);
  assert.equal(activeDocument().nodes.find((node) => node.id === exportedId)?.data.kind, "image-input");
  assert.equal(activeDocument().nodes[0].data.kind === "drawing-board" && activeDocument().nodes[0].data.exportImageRef, "/api/files/draw-atomic.png");

  assert.equal(useFlowStore.getState().commitDrawingBoard({ ...target, documentEpoch: target.documentEpoch + 1 }, nodeId, {
    contentRef: "draw_stale",
    previewImageRef: "/api/files/stale.png",
  }), false);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 2);
});

console.log(`\n通过 ${passed} 项`);

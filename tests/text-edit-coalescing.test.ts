import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  COALESCED_TEXT_EDIT_IDLE_MS,
  applyRunEventToTab,
  flushActiveTextEdit,
  selectActiveDocument,
  setCoalescedTextEditComposing,
  updateCoalescedTextEdit,
  useFlowStore,
  type DocumentTarget,
  type FlowNode,
} from "../src/store/flowStore";
import { createCompositionEnterGuard } from "../src/hooks/useCoalescedTextEdit";

let passed = 0;

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

function aiNode(id = "coalesced-text-node"): FlowNode {
  return {
    id,
    type: "ai-modify",
    position: { x: 0, y: 0 },
    data: {
      kind: "ai-modify",
      label: "连续文本节点",
      status: "idle",
      prompt: "初始提示词",
      aspectRatio: "1:1",
      batchSize: 1,
      outputImages: [],
    },
  };
}

function activeDocument() {
  return selectActiveDocument(useFlowStore.getState());
}

function activeTarget(): DocumentTarget {
  const state = useFlowStore.getState();
  const tab = activeDocument();
  return { tabId: state.activeTabId, projectId: tab.projectId, documentEpoch: tab.documentEpoch };
}

function prompt(): string {
  const data = activeDocument().nodes[0].data;
  return data.kind === "ai-modify" ? data.prompt : "";
}

function resetDocument(id = "coalesced-text-node") {
  flushActiveTextEdit();
  useFlowStore.getState().loadFlow({
    projectId: `coalesced-project-${id}`,
    projectName: "连续文本测试",
    nodes: [aiNode(id)],
    edges: [],
  });
  useFlowStore.temporal.getState().clear();
}

console.log("连续文本编辑事务测试");

await test("一个输入 burst 实时更新，但只提交一次 history/revision", () => {
  resetDocument("single-burst");
  const beforeRevision = activeDocument().revision;
  let token = updateCoalescedTextEdit(
    { kind: "node-data", nodeId: "single-burst", field: "prompt" },
    "第",
  );
  assert.ok(token);
  token = updateCoalescedTextEdit(
    { kind: "node-data", nodeId: "single-burst", field: "prompt" },
    "第一版完整提示词",
    token,
  );
  assert.ok(token);
  assert.equal(prompt(), "第一版完整提示词");
  assert.equal(activeDocument().revision, beforeRevision);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 0);

  assert.equal(flushActiveTextEdit(token), true);
  assert.equal(activeDocument().revision, beforeRevision + 1);
  assert.equal(activeDocument().dirty, true);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);

  useFlowStore.getState().undo();
  assert.equal(prompt(), "初始提示词");
  useFlowStore.getState().redo();
  assert.equal(prompt(), "第一版完整提示词");
});

await test("800ms 空闲自动收口，下一次输入形成独立撤销步", async () => {
  resetDocument("idle-boundary");
  const descriptor = { kind: "node-data", nodeId: "idle-boundary", field: "prompt" } as const;
  const token = updateCoalescedTextEdit(descriptor, "第一次 burst");
  assert.ok(token);
  await new Promise((resolve) => setTimeout(resolve, COALESCED_TEXT_EDIT_IDLE_MS + 40));
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);

  const nextToken = updateCoalescedTextEdit(descriptor, "第二次 burst", token);
  assert.ok(nextToken);
  assert.notEqual(nextToken.id, token.id);
  flushActiveTextEdit(nextToken);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 2);
  useFlowStore.getState().undo();
  assert.equal(prompt(), "第一次 burst");
});

await test("IME 组合输入期间不会被空闲计时器中途提交", async () => {
  resetDocument("ime-boundary");
  const descriptor = { kind: "node-data", nodeId: "ime-boundary", field: "prompt" } as const;
  const token = updateCoalescedTextEdit(descriptor, "衣", null, { composing: true });
  assert.ok(token);
  await new Promise((resolve) => setTimeout(resolve, COALESCED_TEXT_EDIT_IDLE_MS + 40));
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 0);
  assert.equal(activeDocument().revision, 0);

  const finalToken = updateCoalescedTextEdit(descriptor, "衣身保持不变", token, { composing: true });
  assert.ok(finalToken);
  assert.equal(setCoalescedTextEditComposing(finalToken, false), true);
  flushActiveTextEdit(finalToken);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);
  assert.equal(prompt(), "衣身保持不变");
});

await test("IME 候选确认 Enter 的 compositionend 后 keyup 不成为多行提交边界", () => {
  const guard = createCompositionEnterGuard();
  guard.markKeyDown("Enter", true);
  // compositionend happens here and intentionally does not clear the guard.
  assert.equal(guard.consumeKeyUp("Enter"), true);
  assert.equal(guard.consumeKeyUp("Enter"), false);

  guard.markKeyDown("Enter", false);
  assert.equal(guard.consumeKeyUp("Enter"), false);
  guard.markKeyDown("Enter", true);
  guard.markKeyDown("Enter", false);
  assert.equal(guard.consumeKeyUp("Enter"), false);
  guard.markKeyDown("Enter", true);
  guard.reset();
  assert.equal(guard.consumeKeyUp("Enter"), false);
});

await test("标签切换先提交源标签文本，旧 token 不能写入新项目", () => {
  resetDocument("tab-source");
  const sourceTabId = useFlowStore.getState().activeTabId;
  const token = updateCoalescedTextEdit(
    { kind: "node-data", nodeId: "tab-source", field: "prompt" },
    "切换前必须保留",
  );
  assert.ok(token);
  useFlowStore.getState().createBlankTab();
  const newProjectName = activeDocument().projectName;
  assert.notEqual(useFlowStore.getState().activeTabId, sourceTabId);
  const source = useFlowStore.getState().tabs.find((tab) => tab.id === sourceTabId);
  assert.equal(source?.revision, 1);
  assert.equal(source?.dirty, true);
  assert.equal(
    updateCoalescedTextEdit({ kind: "project-name" }, "旧事件污染", token),
    null,
  );
  assert.equal(activeDocument().projectName, newProjectName);
});

await test("异步成功回写前先提交文本，撤销顺序保持为 success→text", () => {
  resetDocument("async-success-order");
  const token = updateCoalescedTextEdit(
    { kind: "node-data", nodeId: "async-success-order", field: "prompt" },
    "运行前最终提示词",
  );
  assert.ok(token);
  applyRunEventToTab(activeTarget(), "async-success-order", {
    type: "node-status",
    nodeId: "async-success-order",
    status: "success",
    images: ["/api/files/success.png"],
  });
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 2);
  assert.deepEqual(activeDocument().nodes[0].data.outputImages, ["/api/files/success.png"]);

  useFlowStore.getState().undo();
  assert.equal(prompt(), "运行前最终提示词");
  assert.deepEqual(activeDocument().nodes[0].data.outputImages, []);
  useFlowStore.getState().undo();
  assert.equal(prompt(), "初始提示词");
});

await test("AI 搭配运行中编辑补充要求不会让后续撤销清空固定结果", () => {
  flushActiveTextEdit();
  const stylingNode: FlowNode = {
    id: "styling-edit",
    type: "ai-styling",
    position: { x: 0, y: 0 },
    data: {
      kind: "ai-styling",
      label: "AI 搭配",
      status: "running",
      prompt: "初始要求",
      aspectRatio: "3:4",
      batchSize: 1,
      preserve: "upper",
      extras: { outerwear: false, shoes: false, bag: false, accessories: false, hat: false },
      resultNodeId: "styling-result",
      outputImages: [],
      modelId: "gpt-image-2-vip",
      modelOptions: {},
    },
  };
  const resultNode: FlowNode = {
    id: "styling-result",
    type: "result",
    position: { x: 400, y: 0 },
    data: { kind: "result", label: "搭配结果", status: "running", images: [] },
  };
  useFlowStore.getState().loadFlow({
    projectId: "styling-edit-project",
    projectName: "AI 搭配文本回写",
    nodes: [stylingNode, resultNode],
    edges: [{
      id: "styling-result-edge",
      source: stylingNode.id,
      sourceHandle: "image",
      target: resultNode.id,
      targetHandle: "references",
    }],
  });
  useFlowStore.temporal.getState().clear();
  const token = updateCoalescedTextEdit(
    { kind: "node-data", nodeId: stylingNode.id, field: "prompt" },
    "下一轮使用的新要求",
  );
  assert.ok(token);
  applyRunEventToTab(activeTarget(), stylingNode.id, {
    type: "node-status",
    nodeId: stylingNode.id,
    status: "success",
    images: ["/api/files/styling-success.png"],
  });

  useFlowStore.getState().undo();
  useFlowStore.getState().undo();
  const document = activeDocument();
  const styling = document.nodes.find((node) => node.id === stylingNode.id);
  const result = document.nodes.find((node) => node.id === resultNode.id);
  assert.equal(styling?.data.kind === "ai-styling" && styling.data.prompt, "初始要求");
  assert.deepEqual(result?.data.kind === "result" ? result.data.images : [], ["/api/files/styling-success.png"]);
});

await test("AI 搭配固定结果连线已删除时不会把运行结果注入文本撤销基线", () => {
  flushActiveTextEdit();
  const stylingNode: FlowNode = {
    id: "styling-disconnected",
    type: "ai-styling",
    position: { x: 0, y: 0 },
    data: {
      kind: "ai-styling",
      label: "AI 搭配",
      status: "running",
      prompt: "初始要求",
      aspectRatio: "3:4",
      batchSize: 1,
      preserve: "upper",
      extras: { outerwear: false, shoes: false, bag: false, accessories: false, hat: false },
      resultNodeId: "disconnected-result",
      outputImages: [],
      modelId: "gpt-image-2-vip",
      modelOptions: {},
    },
  };
  const resultNode: FlowNode = {
    id: "disconnected-result",
    type: "result",
    position: { x: 400, y: 0 },
    data: { kind: "result", label: "已断开结果", status: "idle", images: ["/api/files/old.png"] },
  };
  useFlowStore.getState().loadFlow({
    projectId: "styling-disconnected-project",
    projectName: "AI 搭配断开结果",
    nodes: [stylingNode, resultNode],
    edges: [],
  });
  useFlowStore.temporal.getState().clear();
  updateCoalescedTextEdit(
    { kind: "node-data", nodeId: stylingNode.id, field: "prompt" },
    "下一轮使用的新要求",
  );
  applyRunEventToTab(activeTarget(), stylingNode.id, {
    type: "node-status",
    nodeId: stylingNode.id,
    status: "success",
    images: ["/api/files/should-not-enter-result.png"],
  });

  useFlowStore.getState().undo();
  useFlowStore.getState().undo();
  const result = activeDocument().nodes.find((node) => node.id === resultNode.id);
  assert.deepEqual(result?.data.kind === "result" ? result.data.images : [], ["/api/files/old.png"]);
});

await test("后台页签 success 不会拆分前台页签的输入或 IME 事务", () => {
  resetDocument("background-success");
  const backgroundTarget = activeTarget();
  const backgroundTabId = backgroundTarget.tabId;
  useFlowStore.getState().createBlankTab();
  useFlowStore.getState().loadFlow({
    projectId: "coalesced-project-foreground-edit",
    projectName: "前台连续输入",
    nodes: [aiNode("foreground-edit")],
    edges: [],
  });
  useFlowStore.temporal.getState().clear();

  const foregroundBeforeRevision = activeDocument().revision;
  const token = updateCoalescedTextEdit(
    { kind: "node-data", nodeId: "foreground-edit", field: "prompt" },
    "衣身",
    null,
    { composing: true },
  );
  assert.ok(token);

  applyRunEventToTab(backgroundTarget, "background-success", {
    type: "node-status",
    nodeId: "background-success",
    status: "success",
    images: ["/api/files/background-success.png"],
  });

  assert.equal(prompt(), "衣身");
  assert.equal(activeDocument().revision, foregroundBeforeRevision);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 0);
  const backgroundTab = useFlowStore.getState().tabs.find((tab) => tab.id === backgroundTabId);
  assert.deepEqual(
    backgroundTab?.nodes[0].data.outputImages,
    ["/api/files/background-success.png"],
  );

  const finalToken = updateCoalescedTextEdit(
    { kind: "node-data", nodeId: "foreground-edit", field: "prompt" },
    "衣身保持不变",
    token,
    { composing: true },
  );
  assert.ok(finalToken);
  assert.equal(setCoalescedTextEditComposing(finalToken, false), true);
  assert.equal(flushActiveTextEdit(finalToken), true);
  assert.equal(prompt(), "衣身保持不变");
  assert.equal(activeDocument().revision, foregroundBeforeRevision + 1);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);
});

await test("同页签换项目后迟到的旧 success 不会提交新文档 IME 事务", () => {
  resetDocument("stale-run-source");
  const staleTarget = activeTarget();
  useFlowStore.getState().loadFlow({
    projectId: "coalesced-project-reused-tab",
    projectName: "同页签新项目",
    nodes: [aiNode("reused-tab-edit")],
    edges: [],
  });
  useFlowStore.temporal.getState().clear();

  const beforeRevision = activeDocument().revision;
  const token = updateCoalescedTextEdit(
    { kind: "node-data", nodeId: "reused-tab-edit", field: "prompt" },
    "新项目正在组合",
    null,
    { composing: true },
  );
  assert.ok(token);
  applyRunEventToTab(staleTarget, "stale-run-source", {
    type: "node-status",
    nodeId: "stale-run-source",
    status: "success",
    images: ["/api/files/stale-success.png"],
  });

  assert.equal(prompt(), "新项目正在组合");
  assert.equal(activeDocument().revision, beforeRevision);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 0);
  assert.equal(activeDocument().nodes[0].data.outputImages.length, 0);

  assert.equal(setCoalescedTextEditComposing(token, false), true);
  assert.equal(flushActiveTextEdit(token), true);
  assert.equal(activeDocument().revision, beforeRevision + 1);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);
});

await test("页面退出、关闭页签和所有文本入口都接入统一提交边界", async () => {
  const [app, projectTabs, topBar, inspector, nodeFrame, textEditHook] = await Promise.all([
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/panels/ProjectTabs.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/panels/TopBar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/panels/InspectorPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/nodes/NodeFrame.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/hooks/useCoalescedTextEdit.ts", import.meta.url), "utf8"),
  ]);
  assert.match(app, /flushActiveTextEdit\(\);\s*flushTabSessionPersistence\(\);/);
  assert.match(projectTabs, /flushActiveTextEdit\(\);[\s\S]*useFlowStore\.getState\(\)\.tabs\.find/);
  assert.match(projectTabs, /useCoalescedTextEdit\([\s\S]*kind: "project-name"/);
  assert.doesNotMatch(topBar, /kind: "project-name"/);
  assert.match(inspector, /field: "label"[\s\S]*field: "prompt"[\s\S]*field: "note"/);
  assert.match(nodeFrame, /labelEdit\.cancel\(\)/);
  assert.match(textEditHook, /markKeyDown\(event\.key, composing\)/);
  assert.match(textEditHook, /consumeKeyUp\(event\.key\)\) return/);
});

console.log(`\n通过 ${passed} 项`);

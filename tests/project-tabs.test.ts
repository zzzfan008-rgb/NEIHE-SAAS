import assert from "node:assert/strict";
import fs from "node:fs";
import { maskRedrawReadiness } from "../src/lib/maskRedraw";
import { shouldWarnBeforeWorkspaceUnload } from "../src/lib/workspaceUnload";
import { imageModelAspectRatioPatch } from "../src/types/imageModels";
import { validateAndMigrateFlow } from "../server/lib/workflowSchema";
import type { Edge } from "@xyflow/react";
import {
  addExistingNodes,
  applyRunEventToTab,
  beginHistoryTransaction,
  beginMaskWork,
  endHistoryTransaction,
  isDocumentConnectionValid,
  isPristineProjectTab,
  normalizeTabSessionValue,
  persistedWorkflowForProjectTab,
  TAB_SESSION_SCHEMA_VERSION,
  selectActiveDocument,
  selectActiveDocumentTarget,
  selectNodeInputImages,
  useFlowStore,
  type DocumentTarget,
  type FlowState,
  type FlowNode,
  type RecentResult,
} from "../src/store/flowStore";
import { setGenerationSafetyBlockReason } from "../src/store/generationSafety";
import type { ConnectionDraft } from "../src/types/workbench";
import type { WorkflowInputRole } from "../src/types/workflow";

let passed = 0;

function activeDocument(state = useFlowStore.getState()) {
  return selectActiveDocument(state);
}

function documentTargetForTab(tabId: string): DocumentTarget {
  const tab = useFlowStore.getState().tabs.find((candidate) => candidate.id === tabId);
  assert.ok(tab, `找不到页签 ${tabId}`);
  return { tabId, projectId: tab.projectId, documentEpoch: tab.documentEpoch };
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

function imageNode(id: string, label: string): FlowNode {
  return {
    id,
    type: "image-input",
    position: { x: 0, y: 0 },
    data: { kind: "image-input", label, status: "idle", imageRole: "default" },
  };
}

function aiNode(id: string, label: string): FlowNode {
  return {
    id,
    type: "ai-modify",
    position: { x: 320, y: 0 },
    data: {
      kind: "ai-modify",
      label,
      status: "success",
      prompt: "修改衣领",
      aspectRatio: "1:1",
      batchSize: 1,
      outputImages: ["/api/files/previous.png"],
    },
  };
}

function moveNode(nodeId: string, x: number, dragging = true): void {
  useFlowStore.getState().onNodesChange([{
    id: nodeId,
    type: "position",
    position: { x, y: 24 },
    dragging,
  }]);
}

async function flushCommandMicrotasks(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

function assertNodeModelSelection(
  nodes: FlowNode[],
  nodeId: string,
  expected: { modelId: string; modelOptions: Record<string, unknown> },
): void {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  assert.ok(node, `找不到节点 ${nodeId}`);
  assert.equal(node.data.modelId, expected.modelId);
  assert.deepEqual(node.data.modelOptions, expected.modelOptions);
}

console.log("项目多页签状态测试");

await test("第一轮只接受六类配饰角色且每类最多一条连线", () => {
  const stage: FlowNode = {
    id: "stage-role-validation",
    type: "virtual-try-on",
    position: { x: 320, y: 0 },
    data: {
      kind: "virtual-try-on",
      label: "第一轮",
      status: "idle",
      workflowStage: "scene-stabilize",
      prompt: "",
      imageSize: "2K",
      modelId: "gemini-3.1-flash-image",
      modelOptions: { aspectRatio: "1:1", imageSize: "2K" },
      outputImages: [],
    },
  };
  const first = imageNode("role-source-1", "参考图 1");
  const second = imageNode("role-source-2", "参考图 2");
  const document = {
    nodes: [first, second, stage],
    edges: [{ id: "bag-existing", source: first.id, target: stage.id, targetHandle: "bag" }] as Edge[],
  };
  assert.equal(isDocumentConnectionValid(document, {
    id: "shoes-new", source: second.id, target: stage.id, targetHandle: "shoes",
  }), true);
  assert.equal(isDocumentConnectionValid(document, {
    id: "bag-duplicate", source: second.id, target: stage.id, targetHandle: "bag",
  }), false);
  assert.equal(isDocumentConnectionValid(document, {
    id: "legacy-accessory", source: second.id, target: stage.id, targetHandle: "accessory",
  }), false);
  assert.equal(isDocumentConnectionValid(document, {
    id: "stage-detail", source: second.id, target: stage.id, targetHandle: "detail",
  }), true);
});

await test("图片赋值与模板自动连接原子提交，重复和过期写入均为 no-op", () => {
  const person = imageNode("auto-person", "人物身份图");
  const outfit = imageNode("auto-outfit", "主穿搭图");
  if (person.data.kind !== "image-input" || outfit.data.kind !== "image-input") throw new Error("测试图片节点错误");
  person.data.autoConnectTargets = [{ targetNodeId: "auto-stabilize", targetHandle: "person" }];
  outfit.data.autoConnectTargets = [
    { targetNodeId: "auto-stabilize", targetHandle: "outfit" },
    { targetNodeId: "auto-refine", targetHandle: "outfit" },
  ];
  const stabilize: FlowNode = {
    id: "auto-stabilize", type: "virtual-try-on", position: { x: 320, y: 0 },
    data: {
      kind: "virtual-try-on", label: "第一轮", status: "idle", workflowStage: "scene-stabilize",
      prompt: "", modelId: "gemini-3.1-flash-image", modelOptions: { imageSize: "2K" },
      imageSize: "2K", aspectRatio: "3:4", basisRevision: 0, outputImages: [],
    },
  };
  const refine: FlowNode = {
    id: "auto-refine", type: "virtual-try-on", position: { x: 680, y: 0 },
    data: {
      kind: "virtual-try-on", label: "第二轮", status: "idle", workflowStage: "garment-refine",
      prompt: "", modelId: "gpt-image-2", modelOptions: { quality: "medium" },
      imageSize: "2K", aspectRatio: "3:4", outputImages: [],
    },
  };
  useFlowStore.getState().loadFlow({
    projectId: "auto-connect-project",
    projectName: "自动连接",
    nodes: [person, outfit, stabilize, refine],
    edges: [],
  });
  useFlowStore.temporal.getState().clear();
  const target = selectActiveDocumentTarget(useFlowStore.getState());

  useFlowStore.getState().assignImageInputInTab(target, person.id, "/api/files/person.png");
  assert.equal(activeDocument().edges.length, 1);
  assert.equal(activeDocument().edges[0].targetHandle, "person");
  assert.equal(activeDocument().nodes.find((node) => node.id === stabilize.id)?.data.basisRevision, 1);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);

  useFlowStore.getState().undo();
  const undonePerson = activeDocument().nodes.find((node) => node.id === person.id);
  assert.equal(undonePerson?.data.kind === "image-input" && undonePerson.data.imageUrl, undefined);
  assert.equal(activeDocument().edges.length, 0);

  useFlowStore.temporal.getState().clear();
  useFlowStore.getState().assignImageInputInTab(target, outfit.id, "/api/files/outfit.png");
  assert.deepEqual(activeDocument().edges.map((edge) => edge.targetHandle).sort(), ["outfit", "outfit"]);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);
  useFlowStore.getState().assignImageInputInTab(target, outfit.id, "/api/files/outfit.png");
  assert.equal(activeDocument().edges.length, 2);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);

  const beforeStaleWrite = structuredClone(activeDocument());
  useFlowStore.getState().assignImageInputInTab(
    { ...target, documentEpoch: target.documentEpoch + 1 },
    person.id,
    "/api/files/stale.png",
  );
  assert.deepEqual(activeDocument(), beforeStaleWrite);
});

await test("视频模式切换原子清理失效入边，一次撤销恢复设置和连线", () => {
  const frame = imageNode("video-frame", "视频首帧");
  const video: FlowNode = {
    id: "video-settings",
    type: "video-generate",
    position: { x: 320, y: 0 },
    data: {
      kind: "video-generate",
      label: "首帧生视频",
      status: "idle",
      prompt: "镜头缓慢推进",
      mode: "first-frame-to-video",
      videoModel: "doubao-seedance-2-5-260628",
      seconds: 4,
      aspectRatio: "adaptive",
      resolution: "480p",
      generateAudio: false,
      outputFormat: "mp4",
      outputImages: [],
    },
  };
  useFlowStore.getState().loadFlow({
    projectId: "video-setting-history",
    projectName: "视频设置历史",
    nodes: [frame, video],
    edges: [{ id: "video-frame-edge", source: frame.id, target: video.id, targetHandle: "first-frame" }],
  });
  useFlowStore.temporal.getState().clear();

  useFlowStore.getState().updateVideoNodeSettings(video.id, {
    mode: "text-to-video",
    outputImages: [],
  });
  const updated = activeDocument().nodes.find((node) => node.id === video.id);
  assert.equal(updated?.data.kind === "video-generate" && updated.data.mode, "text-to-video");
  assert.equal(activeDocument().edges.length, 0);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);

  useFlowStore.getState().undo();
  const restored = activeDocument().nodes.find((node) => node.id === video.id);
  assert.equal(restored?.data.kind === "video-generate" && restored.data.mode, "first-frame-to-video");
  assert.equal(activeDocument().edges[0]?.targetHandle, "first-frame");
});

await test("浏览器旧视频草稿迁移到 Seedance v11 模型、模式和端口", () => {
  const restored = normalizeTabSessionValue({
    schemaVersion: 1,
    activeTabId: "legacy-video-tab",
    tabs: [{
      id: "legacy-video-tab",
      projectId: "legacy-video-project",
      projectName: "旧视频草稿",
      revision: 1,
      nodes: [
        imageNode("legacy-first", "参考图一"),
        imageNode("legacy-last", "参考图二"),
        {
          id: "legacy-video",
          type: "video-generate",
          position: { x: 320, y: 0 },
          data: {
            kind: "video-generate",
            label: "旧多图视频",
            status: "idle",
            mode: "multi-image-video",
            prompt: "展示服装动态",
            videoModel: "seedance-2.5",
            aspectRatio: "16:9",
            resolution: "4k",
            seconds: 40,
            generateAudio: false,
            outputImages: [],
          },
        },
      ],
      edges: [
        { id: "legacy-first-edge", source: "legacy-first", target: "legacy-video", targetHandle: "first-frame" },
        { id: "legacy-last-edge", source: "legacy-last", target: "legacy-video", targetHandle: "last-frame" },
      ],
    }],
  });
  assert.ok(restored);
  const video = restored.tabs[0].nodes.find((node) => node.id === "legacy-video");
  assert.equal(video?.data.kind === "video-generate" && video.data.videoModel, "doubao-seedance-2-5-260628");
  assert.equal(video?.data.kind === "video-generate" && video.data.mode, "multimodal-reference");
  assert.equal(video?.data.kind === "video-generate" && video.data.resolution, "1080p");
  assert.equal(video?.data.kind === "video-generate" && video.data.seconds, 30);
  assert.deepEqual(restored.tabs[0].edges.map((edge) => edge.targetHandle), ["reference-image", "reference-image"]);
});

await test("浏览器旧蒙版草稿恢复时补齐唯一 repair-source 端口", () => {
  const restored = normalizeTabSessionValue({
    schemaVersion: 1,
    activeTabId: "legacy-mask-tab",
    tabs: [{
      id: "legacy-mask-tab",
      projectId: "legacy-mask-project",
      projectName: "旧蒙版草稿",
      nodes: [
        imageNode("legacy-mask-source", "原图"),
        {
          id: "legacy-mask",
          type: "mask-redraw",
          position: { x: 320, y: 0 },
          data: {
            kind: "mask-redraw", label: "局部重绘", status: "idle", prompt: "修复袖口",
            mask: "/api/files/legacy-mask.png", maskSourceRef: "/api/files/legacy-source.png",
            outputImages: [],
          },
        },
      ],
      edges: [
        { id: "legacy-mask-source-edge", source: "legacy-mask-source", target: "legacy-mask", targetHandle: "references" },
      ],
    }],
  });
  assert.ok(restored);
  assert.equal(restored.tabs[0].edges[0].targetHandle, "repair-source");
});

await test("当前会话保留用户主动断开底图后的细节参考端口", () => {
  const restored = normalizeTabSessionValue({
    schemaVersion: TAB_SESSION_SCHEMA_VERSION,
    activeTabId: "current-mask-tab",
    tabs: [{
      id: "current-mask-tab",
      projectId: "current-mask-project",
      projectName: "当前蒙版草稿",
      nodes: [
        imageNode("current-mask-reference", "细节参考"),
        {
          id: "current-mask",
          type: "mask-redraw",
          position: { x: 320, y: 0 },
          data: {
            kind: "mask-redraw", label: "局部重绘", status: "idle", prompt: "修复袖口",
            repairFocus: "custom", executionMode: "repair", outputImages: [],
          },
        },
      ],
      edges: [
        { id: "current-mask-reference-edge", source: "current-mask-reference", target: "current-mask", targetHandle: "references" },
      ],
    }],
  });
  assert.ok(restored);
  assert.equal(restored.tabs[0].edges[0].targetHandle, "references");
});

await test("配饰精修自动选择最多六张参考图且不覆盖已选连接", () => {
  const source = aiNode("repair-source", "第二轮成片");
  const repair: FlowNode = {
    id: "accessory-repair", type: "mask-redraw", position: { x: 640, y: 0 },
    data: {
      kind: "mask-redraw", label: "人物配饰精修", status: "idle", repairFocus: "accessories",
      executionMode: "bypass", prompt: "修复配饰", outputImages: [], modelId: "gpt-image-2", modelOptions: {},
    },
  };
  const candidates = Array.from({ length: 7 }, (_, index) => {
    const node = imageNode(`accessory-${index + 1}`, `配饰 ${index + 1}`);
    if (node.data.kind !== "image-input") throw new Error("测试图片节点错误");
    node.data.autoConnectTargets = [{ targetNodeId: repair.id, targetHandle: "references" }];
    return node;
  });
  useFlowStore.getState().loadFlow({
    projectId: "accessory-reference-limit",
    projectName: "配饰参考上限",
    nodes: [source, repair, ...candidates],
    edges: [{
      id: "repair-source-edge", source: source.id, sourceHandle: "image",
      target: repair.id, targetHandle: "repair-source",
    }],
  });
  const target = selectActiveDocumentTarget(useFlowStore.getState());
  for (const [index, candidate] of candidates.entries()) {
    useFlowStore.getState().assignImageInputInTab(target, candidate.id, `/api/files/accessory-${index + 1}.png`);
  }
  const references = activeDocument().edges.filter((edge) => (
    edge.target === repair.id && edge.targetHandle === "references"
  ));
  assert.equal(references.length, 6);
  assert.deepEqual(references.map((edge) => edge.source), candidates.slice(0, 6).map((node) => node.id));
  const seventh = activeDocument().nodes.find((node) => node.id === candidates[6].id);
  assert.equal(seventh?.data.kind === "image-input" && seventh.data.imageUrl, "/api/files/accessory-7.png");
});

await test("跳过的局部精修不会提交网络请求或创建最近生成记录", async () => {
  const source = aiNode("bypass-source", "第二轮成片");
  const bypass: FlowNode = {
    id: "bypass-repair", type: "mask-redraw", position: { x: 640, y: 0 },
    data: {
      kind: "mask-redraw", label: "上衣精修", status: "idle", repairFocus: "upper-garment",
      executionMode: "bypass", prompt: "修复上衣", outputImages: [], modelId: "gpt-image-2", modelOptions: {},
    },
  };
  useFlowStore.getState().loadFlow({
    projectId: "bypass-run",
    projectName: "跳过精修",
    nodes: [source, bypass],
    edges: [{ id: "bypass-source-edge", source: source.id, target: bypass.id, targetHandle: "repair-source" }],
  });
  const beforeResults = useFlowStore.getState().recentResults.length;
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    networkCalls += 1;
    return Response.json({ ok: true });
  };
  try {
    await useFlowStore.getState().runNode(bypass.id);
    assert.equal(networkCalls, 0);
    assert.equal(useFlowStore.getState().recentResults.length, beforeResults);
    assert.deepEqual(selectNodeInputImages(activeDocument(), bypass.id), ["/api/files/previous.png"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

type ConnectionDraftState = FlowState & {
  pendingConnectionDraft: ConnectionDraft | null;
  connectionDraftError: string | null;
  confirmPendingConnection: (targetHandle: WorkflowInputRole) => boolean;
  cancelPendingConnection: () => void;
};

function connectionDraftState(): ConnectionDraftState {
  return useFlowStore.getState() as ConnectionDraftState;
}

function stagedConnectionNode(id = "role-stage"): FlowNode {
  return {
    id,
    type: "virtual-try-on",
    position: { x: 420, y: 0 },
    data: {
      kind: "virtual-try-on",
      label: "第一轮 · Gemini 场景化定版",
      status: "idle",
      workflowStage: "scene-stabilize",
      prompt: "",
      imageSize: "2K",
      modelId: "gemini-3.1-flash-image",
      modelOptions: { aspectRatio: "3:4", imageSize: "2K" },
      basisRevision: 0,
      outputImages: [],
    },
  };
}

setGenerationSafetyBlockReason(null);

await test("分步连线先形成未持久化角色草稿，确认后只写一条边和一次历史", () => {
  const source = imageNode("role-draft-source", "通用参考图");
  const stage = stagedConnectionNode("role-draft-stage");
  useFlowStore.getState().loadFlow({
    projectId: "role-draft-project",
    projectName: "角色确认项目",
    nodes: [source, stage],
    edges: [],
  });
  useFlowStore.temporal.getState().clear();

  connectionDraftState().onConnect({
    source: source.id,
    target: stage.id,
    sourceHandle: null,
    targetHandle: null,
  });
  assert.equal(activeDocument().edges.length, 0, "确认角色前不得把边写入项目");
  assert.deepEqual(connectionDraftState().pendingConnectionDraft, {
    target: selectActiveDocumentTarget(useFlowStore.getState()),
    sourceNodeId: source.id,
    targetNodeId: stage.id,
    sourceHandle: null,
    proposedTargetHandle: null,
  });

  assert.equal(connectionDraftState().confirmPendingConnection("person"), true);
  assert.equal(connectionDraftState().pendingConnectionDraft, null);
  assert.deepEqual(activeDocument().edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    targetHandle: edge.targetHandle,
  })), [{ source: source.id, target: stage.id, targetHandle: "person" }]);
  assert.equal(useFlowStore.temporal.getState().pastStates.length, 1);
  useFlowStore.getState().undo();
  assert.equal(activeDocument().edges.length, 0, "一次撤销必须完整移除已确认连线");
});

await test("显式角色不允许在确认时改名，重复角色与 14 张总上限使用业务名拒绝", () => {
  const stage = stagedConnectionNode("role-guard-stage");
  const sources = Array.from({ length: 15 }, (_, index) => imageNode(`role-guard-${index + 1}`, `参考 ${index + 1}`));
  const occupiedRoles = [
    "person", "scene", "outfit", "bag", "shoes", "hat", "ring", "earrings", "bracelet",
    "detail", "detail", "detail", "detail", "detail",
  ] as const;
  useFlowStore.getState().loadFlow({
    projectId: "role-guard-project",
    projectName: "角色门禁项目",
    nodes: [...sources, stage],
    edges: occupiedRoles.map((targetHandle, index) => ({
      id: `occupied-${index}`,
      source: sources[index].id,
      target: stage.id,
      targetHandle,
    })),
  });

  connectionDraftState().onConnect({
    source: sources[14].id,
    target: stage.id,
    sourceHandle: null,
    targetHandle: "bag",
  });
  assert.equal(activeDocument().edges.length, 14, "显式角色仍需确认后才落边");
  assert.equal(connectionDraftState().confirmPendingConnection("shoes"), false);
  assert.match(connectionDraftState().connectionDraftError ?? "", /包袋.*鞋履|鞋履.*包袋/);
  assert.equal(connectionDraftState().confirmPendingConnection("bag"), false);
  assert.match(connectionDraftState().connectionDraftError ?? "", /最多 14 张/);
  assert.equal(activeDocument().edges.length, 14);
});

await test("切换或替换文档会立即使未确认角色草稿失效", () => {
  const source = imageNode("role-stale-source", "待确认参考");
  const stage = stagedConnectionNode("role-stale-stage");
  useFlowStore.getState().loadFlow({
    projectId: "role-stale-project",
    projectName: "草稿来源页",
    nodes: [source, stage],
    edges: [],
  });
  const sourceTabId = useFlowStore.getState().activeTabId;
  connectionDraftState().onConnect({ source: source.id, target: stage.id, targetHandle: "outfit" });
  assert.ok(connectionDraftState().pendingConnectionDraft);

  useFlowStore.getState().createBlankTab();
  const disposableTabId = useFlowStore.getState().activeTabId;
  assert.equal(connectionDraftState().pendingConnectionDraft, null);
  useFlowStore.getState().switchTab(sourceTabId);
  assert.equal(connectionDraftState().confirmPendingConnection("outfit"), false);
  assert.equal(activeDocument().edges.length, 0);
  useFlowStore.getState().closeTab(disposableTabId);
});

// 此文件验证已完成历史对账后的运行路径；冷启动 fail-closed 由 generation-safety.test 覆盖。
const initial = useFlowStore.getState();
const tabA = initial.activeTabId;
initial.setProjectName("项目 A");
initial.updateNodeData(activeDocument(initial).nodes[0].id, { label: "A 上传节点" });

useFlowStore.getState().openFlowTab({
  projectId: "project-b",
  projectName: "项目 B",
  nodes: [imageNode("b-node", "B 上传节点")],
  edges: [] as Edge[],
});
const tabB = useFlowStore.getState().activeTabId;

await test("切换页签保留各自画布与项目名称", () => {
  assert.notEqual(tabA, tabB);
  assert.equal(activeDocument().projectName, "项目 B");
  assert.equal(activeDocument().nodes[0].id, "b-node");
  useFlowStore.getState().switchTab(tabA);
  assert.equal(activeDocument().projectName, "项目 A");
  assert.equal(activeDocument().nodes[0].data.label, "A 上传节点");
  useFlowStore.getState().switchTab(tabB);
  assert.equal(activeDocument().nodes[0].data.label, "B 上传节点");
});

await test("重复打开同一项目复用已有页签且不覆盖未保存状态", () => {
  useFlowStore.getState().updateNodeData("b-node", { label: "B 本地修改" });
  const count = useFlowStore.getState().tabs.length;
  useFlowStore.getState().openFlowTab({
    projectId: "project-b",
    projectName: "服务端旧名称",
    nodes: [imageNode("replacement", "不应覆盖")],
    edges: [],
  });
  assert.equal(useFlowStore.getState().tabs.length, count);
  assert.equal(useFlowStore.getState().activeTabId, tabB);
  assert.equal(activeDocument().nodes[0].data.label, "B 本地修改");
});

await test("后台任务可定向回写非当前页签", () => {
  useFlowStore.getState().switchTab(tabA);
  useFlowStore.getState().updateNodeDataInTab(documentTargetForTab(tabB), "b-node", {
    status: "success",
    imageUrl: "/api/files/background-result.png",
  });
  assert.equal(activeDocument().projectName, "项目 A");
  useFlowStore.getState().switchTab(tabB);
  const node = activeDocument().nodes.find((candidate) => candidate.id === "b-node");
  assert.equal(node?.data.status, "success");
  assert.equal(node?.data.kind === "image-input" ? node.data.imageUrl : undefined, "/api/files/background-result.png");
});

await test("A 页签后台失败不影响 B 页签且保留 A 的上一版图片", () => {
  useFlowStore.getState().switchTab(tabA);
  useFlowStore.getState().addExistingNode(aiNode("a-ai-node", "A 后台改款"));
  useFlowStore.getState().switchTab(tabB);
  const beforeB = activeDocument().nodes;

  applyRunEventToTab(documentTargetForTab(tabA), "a-ai-node", {
    type: "node-status",
    nodeId: "a-ai-node",
    status: "error",
    error: "AI 网关暂不可用",
  });

  assert.equal(useFlowStore.getState().activeTabId, tabB);
  assert.strictEqual(activeDocument().nodes, beforeB);
  useFlowStore.getState().switchTab(tabA);
  const failedNode = activeDocument().nodes.find((node) => node.id === "a-ai-node");
  assert.equal(failedNode?.data.status, "error");
  assert.equal(failedNode?.data.error, "AI 网关暂不可用");
  assert.deepEqual(
    failedNode?.data.kind === "ai-modify" ? failedNode.data.outputImages : undefined,
    ["/api/files/previous.png"],
  );
  useFlowStore.getState().switchTab(tabB);
});

await test("活动任务对账完成前禁止关闭看似空闲的恢复页签", () => {
  const count = useFlowStore.getState().tabs.length;
  setGenerationSafetyBlockReason("正在确认运行历史");
  try {
    useFlowStore.getState().closeTab(tabB);
    assert.equal(useFlowStore.getState().tabs.length, count);
    assert.ok(useFlowStore.getState().tabs.some((tab) => tab.id === tabB));
  } finally {
    setGenerationSafetyBlockReason(null);
  }
});

await test("运行中的页签不能关闭，避免任务结果丢失画布回写", () => {
  useFlowStore.getState().updateNodeData("b-node", { status: "queued" });
  const count = useFlowStore.getState().tabs.length;
  useFlowStore.getState().closeTab(tabB);
  assert.equal(useFlowStore.getState().tabs.length, count);
  assert.equal(useFlowStore.getState().activeTabId, tabB);
  useFlowStore.getState().updateNodeData("b-node", { status: "idle" });
});

await test("关闭当前页签后切换到相邻页签，至少保留一个画布", () => {
  useFlowStore.getState().closeTab(tabB);
  assert.equal(useFlowStore.getState().activeTabId, tabA);
  assert.equal(useFlowStore.getState().tabs.length, 1);
  useFlowStore.getState().closeTab(tabA);
  assert.equal(useFlowStore.getState().tabs.length, 1);
  assert.ok(useFlowStore.getState().activeTabId);
  assert.equal(activeDocument().nodes.length, 1);
});

await test("删除已选节点时同步清理 selectedNodeId", () => {
  useFlowStore.getState().openFlowTab({
    projectId: "selection-removal-project",
    projectName: "选择清理测试",
    nodes: [imageNode("selected-for-removal", "待删除节点")],
    edges: [],
  });
  useFlowStore.getState().setSelectedNodeId("selected-for-removal");

  useFlowStore.getState().onNodesChange([{
    id: "selected-for-removal",
    type: "remove",
  }]);

  assert.equal(activeDocument().nodes.length, 0);
  assert.equal(activeDocument().selectedNodeId, null);
});

await test("素材节点以单一原子 action 加入，一次撤销完整移除", () => {
  const baseline = imageNode("asset-baseline", "基准节点");
  useFlowStore.getState().openFlowTab({
    projectId: "atomic-asset-project",
    projectName: "原子素材测试",
    nodes: [baseline],
    edges: [],
  });
  const addedId = useFlowStore.getState().addAssetNode(
    { name: "金色面料", image: "/api/files/gold-fabric.png" },
    { x: -320, y: 40 },
  );
  assert.ok(addedId);
  const added = activeDocument().nodes.find((node) => node.id === addedId);
  assert.equal(added?.data.kind, "image-input");
  assert.equal(added?.data.label, "金色面料");
  assert.equal(added?.data.status, "success");
  assert.equal(added?.data.kind === "image-input" ? added.data.imageUrl : undefined, "/api/files/gold-fabric.png");

  useFlowStore.getState().undo();
  assert.equal(activeDocument().nodes.length, 1);
  assert.equal(activeDocument().nodes[0].id, baseline.id);
  assert.equal(activeDocument().nodes.some((node) => node.id === addedId), false);
  assert.equal(activeDocument().selectedNodeId, null);

  const librarySource = fs.readFileSync(
    new URL("../src/components/panels/NodeLibraryPanel.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    librarySource,
    /addAssetNode\(asset,|AssetList|\/api\/assets/,
    "独立节点库不再承担素材管理，但 Store 的原子素材节点 action 仍需保持可用",
  );
  assert.doesNotMatch(librarySource, /useFlowStore\.getState\(\)\.selectedNodeId|updateNodeData\(newId/);
});

await test("多选节点批量粘贴只产生一次文档提交与撤销记录", () => {
  const baseline = imageNode("batch-copy-baseline", "批量复制基准");
  useFlowStore.getState().openFlowTab({
    projectId: "batch-copy-project",
    projectName: "批量复制测试",
    nodes: [baseline],
    edges: [],
  });
  const beforeRevision = activeDocument().revision;
  const additions = [
    imageNode("batch-copy-a", "副本 A"),
    imageNode("batch-copy-b", "副本 B"),
  ].map((node, index) => ({
    ...node,
    position: { x: 80 + index * 120, y: 60 + index * 40 },
  }));

  assert.deepEqual(addExistingNodes(additions), ["batch-copy-a", "batch-copy-b"]);
  assert.equal(activeDocument().nodes.length, 3);
  assert.deepEqual(activeDocument().selectedNodeIds, ["batch-copy-a", "batch-copy-b"]);
  assert.equal(activeDocument().revision, beforeRevision + 1);

  useFlowStore.getState().undo();
  assert.deepEqual(activeDocument().nodes.map((node) => node.id), [baseline.id]);
  assert.equal(activeDocument().selectedNodeIds.length, 0);
});

await test("空白项目启动器只在从未持久化的 pristine 文档中生效", async () => {
  useFlowStore.getState().createBlankTab();
  assert.equal(isPristineProjectTab(activeDocument()), true);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "offline" }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
  try {
    assert.equal(await useFlowStore.getState().saveProject(), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(activeDocument().saveState, "error");
  assert.equal(activeDocument().hasBeenPersisted, false);
  assert.equal(isPristineProjectTab(activeDocument()), true);
  const restoredAfterFailure = normalizeTabSessionValue({
    schemaVersion: 2,
    activeTabId: useFlowStore.getState().activeTabId,
    tabs: [activeDocument()],
  });
  assert.ok(restoredAfterFailure);
  assert.equal(restoredAfterFailure.tabs[0].hasBeenPersisted, false);
  assert.equal(isPristineProjectTab(restoredAfterFailure.tabs[0]), true);

  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  try {
    assert.equal(await useFlowStore.getState().saveProject(), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(activeDocument().saveState, "saved");
  assert.equal(activeDocument().hasBeenPersisted, true);
  assert.equal(isPristineProjectTab(activeDocument()), false);

  const emptyNodes = activeDocument().nodes.map((node) => ({
    ...node,
    data: { ...node.data },
  }));
  useFlowStore.getState().openFlowTab({
    projectId: "persisted-empty-project",
    projectName: "未命名设计项目",
    nodes: emptyNodes,
    edges: [],
  });
  assert.equal(activeDocument().saveState, "saved");
  assert.equal(activeDocument().hasBeenPersisted, true);
  assert.equal(isPristineProjectTab(activeDocument()), false);

  useFlowStore.getState().createBlankTab();
  const addedId = useFlowStore.getState().addNode("sketch-to-render", { x: 380, y: 0 });
  assert.ok(addedId);
  assert.equal(isPristineProjectTab(activeDocument()), false);
});

await test("快捷建图原子新增节点与合法连线，一次撤销完整恢复", () => {
  const anchor = imageNode("quick-anchor", "快捷上游");
  useFlowStore.getState().openFlowTab({
    projectId: "quick-connect-project",
    projectName: "快捷建图测试",
    nodes: [anchor],
    edges: [],
  });
  const beforeRevision = activeDocument().revision;
  const addedId = useFlowStore.getState().addConnectedNode(
    anchor.id,
    "upscale",
    "downstream",
    { sourceHandle: "image", targetHandle: "references", preset: { imageSize: "4K" } },
  );
  assert.ok(addedId);
  assert.equal(activeDocument().nodes.length, 2);
  assert.equal(activeDocument().edges.length, 1);
  assert.equal(activeDocument().edges[0].source, anchor.id);
  assert.equal(activeDocument().edges[0].target, addedId);
  assert.match(activeDocument().edges[0].id, /^[A-Za-z0-9_-]{1,128}$/);
  assert.equal(activeDocument().edges[0].sourceHandle, "image");
  assert.equal(activeDocument().edges[0].targetHandle, "references");
  const added = activeDocument().nodes.find((node) => node.id === addedId);
  assert.equal(added?.data.kind === "upscale" && added.data.imageSize, "4K");
  assert.equal(activeDocument().selectedNodeId, addedId);
  assert.equal(activeDocument().revision, beforeRevision + 1);

  useFlowStore.getState().undo();
  assert.deepEqual(activeDocument().nodes.map((node) => node.id), [anchor.id]);
  assert.equal(activeDocument().edges.length, 0);
});

await test("多图结果快捷建图只把用户选中的图片连接给下游", () => {
  const result: FlowNode = {
    id: "multi-result",
    type: "result",
    position: { x: 0, y: 0 },
    data: {
      kind: "result",
      label: "多图结果",
      status: "success",
      images: ["/api/files/first.png", "/api/files/second.png"],
    },
  };
  useFlowStore.getState().openFlowTab({
    projectId: "selected-result-connect",
    projectName: "选中结果图",
    nodes: [result],
    edges: [],
  });
  const addedId = useFlowStore.getState().addConnectedNode(
    result.id,
    "mask-redraw",
    "downstream",
    { sourceHandle: "image:1", targetHandle: "repair-source" },
  );
  assert.ok(addedId);
  assert.match(activeDocument().edges[0].id, /^[A-Za-z0-9_-]{1,128}$/);
  assert.equal(activeDocument().edges[0].id.includes(":"), false);
  assert.equal(activeDocument().edges[0].sourceHandle, "image:1");
  assert.equal(activeDocument().edges[0].targetHandle, "repair-source");
  assert.deepEqual(selectNodeInputImages(activeDocument(), addedId), ["/api/files/second.png"]);
  assert.doesNotThrow(() => validateAndMigrateFlow(persistedWorkflowForProjectTab(activeDocument())));
});

await test("旧会话中的 React Flow 结果边 ID 自动修复且不改变图片选择", () => {
  const restored = normalizeTabSessionValue({
    schemaVersion: TAB_SESSION_SCHEMA_VERSION,
    activeTabId: "legacy-result-edge-tab",
    tabs: [{
      id: "legacy-result-edge-tab",
      projectId: "legacy-result-edge-project",
      projectName: "旧结果边恢复",
      nodes: [{
        id: "legacy-result",
        type: "result",
        position: { x: 0, y: 0 },
        data: {
          kind: "result",
          label: "旧结果",
          status: "success",
          images: ["/api/files/first.png", "/api/files/second.png"],
        },
      }, {
        id: "legacy-mask",
        type: "mask-redraw",
        position: { x: 380, y: 0 },
        data: {
          kind: "mask-redraw",
          label: "局部重绘",
          status: "idle",
          repairFocus: "custom",
          executionMode: "repair",
          prompt: "改成白色",
          modelId: "gpt-image-2",
          modelOptions: {},
          outputImages: [],
        },
      }],
      edges: [{
        id: "xy-edge__legacy-resultimage:1-legacy-maskrepair-source",
        source: "legacy-result",
        sourceHandle: "image:1",
        target: "legacy-mask",
        targetHandle: "repair-source",
      }],
      selectedNodeIds: ["legacy-mask"],
      selectedNodeId: "legacy-mask",
      selectedResultId: null,
      compareIds: [],
      saveState: "error",
      hasBeenPersisted: true,
      revision: 2,
      savedRevision: 1,
      dirty: true,
      documentEpoch: 4,
      lifecycle: "saved",
    }],
  });

  assert.ok(restored);
  const tab = restored.tabs[0];
  assert.match(tab.edges[0].id, /^[A-Za-z0-9_-]{1,128}$/);
  assert.equal(tab.edges[0].id.includes(":"), false);
  assert.equal(tab.edges[0].sourceHandle, "image:1");
  assert.equal(tab.edges[0].targetHandle, "repair-source");
  assert.deepEqual(selectNodeInputImages(tab, "legacy-mask"), ["/api/files/second.png"]);
});

await test("快捷建图复用输入上限与只读门禁", () => {
  const source = imageNode("full-source", "已有上游");
  const target: FlowNode = {
    id: "full-target",
    type: "upscale",
    position: { x: 380, y: 0 },
    data: {
      kind: "upscale",
      label: "高清放大",
      status: "idle",
      imageSize: "2K",
      outputImages: [],
    },
  };
  useFlowStore.getState().openFlowTab({
    projectId: "quick-connect-full",
    projectName: "输入已满",
    nodes: [source, target],
    edges: [{ id: "already-connected", source: source.id, target: target.id }],
  });
  assert.equal(
    useFlowStore.getState().addConnectedNode(target.id, "image-input", "upstream"),
    null,
  );
  assert.equal(activeDocument().nodes.length, 2);

  useFlowStore.getState().openFlowTab({
    projectId: "quick-connect-readonly",
    projectName: "只读快捷建图",
    nodes: [imageNode("readonly-anchor", "只读节点")],
    edges: [],
    readOnly: true,
  });
  assert.equal(
    useFlowStore.getState().addConnectedNode("readonly-anchor", "ai-modify", "downstream"),
    null,
  );
  assert.equal(activeDocument().nodes.length, 1);
  assert.equal(activeDocument().edges.length, 0);
  useFlowStore.getState().createBlankTab();
});

await test("保存期间继续编辑会排队并最终写入最新版本", async () => {
  const requests: Array<{ body: string; resolve: (response: Response) => void }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) =>
    new Promise<Response>((resolve) => {
      requests.push({ body: String(init?.body ?? ""), resolve });
    });

  try {
    const before = useFlowStore.getState();
    const firstSave = before.saveProject();
    assert.equal(requests.length, 1);

    useFlowStore.getState().setProjectName("保存期间的新名称");
    const secondSave = useFlowStore.getState().saveProject();
    assert.equal(requests.length, 1, "第二次保存应等待当前请求完成");

    requests[0].resolve(Response.json({ ok: true }));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(requests.length, 2, "旧快照完成后应自动发送最新快照");

    const latestPayload = JSON.parse(requests[1].body) as { name: string };
    assert.equal(latestPayload.name, "保存期间的新名称");
    const duplicateSameSnapshot = useFlowStore.getState().saveProject();
    assert.equal(requests.length, 2, "同快照的显式重复保存应由当前请求覆盖");
    requests[1].resolve(Response.json({ ok: true }));
    await Promise.all([firstSave, secondSave, duplicateSameSnapshot]);
    await flushCommandMicrotasks();
    assert.equal(requests.length, 2, "当前快照成功后不得为重复点击发第三次请求");

    const after = activeDocument();
    assert.equal(after.dirty, false);
    assert.equal(after.saveState, "saved");
    assert.equal(after.savedRevision, after.revision);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("旧保存响应不得将同页签新项目标记为已保存", async () => {
  const sharedNodeId = "same-tab-save-identity";
  useFlowStore.getState().loadFlow({
    projectId: "same-tab-save-project-a",
    projectName: "同页签项目 A",
    nodes: [aiNode(sharedNodeId, "A")],
    edges: [],
    markDirty: true,
  });
  const source = selectActiveDocumentTarget(useFlowStore.getState());
  let resolveSave: ((response: Response) => void) | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise<Response>((resolve) => {
    resolveSave = resolve;
  });

  try {
    const saving = useFlowStore.getState().saveProject();
    assert.ok(resolveSave, "旧项目保存请求应已发出");
    useFlowStore.getState().loadFlow({
      projectId: "same-tab-save-project-b",
      projectName: "同页签项目 B",
      nodes: [aiNode(sharedNodeId, "B")],
      edges: [],
      markDirty: true,
    });
    const replacement = activeDocument();
    assert.equal(replacement.id, source.tabId);
    assert.equal(replacement.documentEpoch, source.documentEpoch + 1);

    resolveSave(Response.json({ ok: true }));
    assert.equal(await saving, false, "失效保存响应必须报告未保存新项目");
    const after = activeDocument();
    assert.equal(after.projectId, "same-tab-save-project-b");
    assert.equal(after.dirty, true);
    assert.equal(after.saveState, "idle");
    assert.equal(after.savedRevision, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("旧上传回写与运行预检不得穿透同页签 documentEpoch", async () => {
  const sharedNodeId = "same-tab-async-identity";
  const sourceNode = aiNode(sharedNodeId, "旧项目节点");
  sourceNode.data.status = "idle";
  useFlowStore.getState().loadFlow({
    projectId: "same-tab-async-project-a",
    projectName: "异步项目 A",
    nodes: [sourceNode],
    edges: [],
    markDirty: true,
  });
  const staleTarget = selectActiveDocumentTarget(useFlowStore.getState());
  const requests: string[] = [];
  let resolveSave: ((response: Response) => void) | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    requests.push(url);
    if (url === "/api/projects") {
      return new Promise<Response>((resolve) => {
        resolveSave = resolve;
      });
    }
    return Promise.resolve(Response.json({ runId: "must-not-be-created" }, { status: 202 }));
  };

  try {
    const running = useFlowStore.getState().runNode(sharedNodeId);
    assert.ok(resolveSave, "运行应先等待旧项目保存");
    const replacementNode = aiNode(sharedNodeId, "新项目节点");
    replacementNode.data.status = "idle";
    useFlowStore.getState().loadFlow({
      projectId: "same-tab-async-project-b",
      projectName: "异步项目 B",
      nodes: [replacementNode],
      edges: [],
      markDirty: true,
    });
    useFlowStore.getState().updateNodeDataInTab(staleTarget, sharedNodeId, {
      label: "旧上传误写",
      status: "success",
    });
    assert.equal(activeDocument().nodes[0].data.label, "新项目节点");

    resolveSave(Response.json({ ok: true }));
    await running;
    assert.deepEqual(requests, ["/api/projects"], "失效旧快照不得继续创建付费 Run");
    const after = activeDocument();
    assert.equal(after.projectId, "same-tab-async-project-b");
    assert.equal(after.nodes[0].data.label, "新项目节点");
    assert.equal(after.nodes[0].data.status, "idle");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("保存失败响应落在拖拽中时，等待结束后再标记最终 dirty 版本", async () => {
  const node = aiNode("drag-save-failure", "拖拽保存失败");
  useFlowStore.getState().openFlowTab({
    projectId: "drag-save-failure-project",
    projectName: "拖拽保存失败",
    nodes: [node],
    edges: [],
  });
  useFlowStore.temporal.getState().clear();
  const before = activeDocument();
  const requests: Array<{ body: string; resolve: (response: Response) => void }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) => new Promise<Response>((resolve) => {
    requests.push({ body: String(init?.body ?? ""), resolve });
  });

  try {
    let saveSettled = false;
    const saving = useFlowStore.getState().saveProject().finally(() => {
      saveSettled = true;
    });
    assert.equal(requests.length, 1);
    const transaction = beginHistoryTransaction("drag-save-failure");
    moveNode(node.id, 64);
    requests[0].resolve(Response.json({ error: "测试失败" }, { status: 503 }));
    await flushCommandMicrotasks();
    assert.equal(saveSettled, false, "失败响应不得在拖拽中提前改写元数据");
    assert.equal(activeDocument().saveState, "saving");

    moveNode(node.id, 160);
    assert.equal(endHistoryTransaction(transaction), true);
    assert.equal(await saving, false);
    const after = activeDocument();
    assert.deepEqual(after.nodes[0].position, { x: 160, y: 24 });
    assert.notEqual(after.nodes[0].dragging, true);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.savedRevision, before.savedRevision);
    assert.equal(after.dirty, true);
    assert.equal(after.saveState, "error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("净零拖拽保存等待结束后只写入起点快照", async () => {
  const node = aiNode("net-zero-drag-save", "净零拖拽保存");
  node.position = { x: 0, y: 24 };
  useFlowStore.getState().openFlowTab({
    projectId: "net-zero-drag-save-project",
    projectName: "净零拖拽保存",
    nodes: [node],
    edges: [],
  });
  useFlowStore.temporal.getState().clear();
  const before = activeDocument();
  const requests: Array<{ body: string; resolve: (response: Response) => void }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) => new Promise<Response>((resolve) => {
    requests.push({ body: String(init?.body ?? ""), resolve });
  });

  try {
    const transaction = beginHistoryTransaction("net-zero-drag-save");
    moveNode(node.id, 80);
    const saving = useFlowStore.getState().saveProject();
    moveNode(node.id, 0, false);
    assert.equal(requests.length, 0);
    assert.equal(endHistoryTransaction(transaction), false);
    await flushCommandMicrotasks();

    assert.equal(requests.length, 1);
    const payload = JSON.parse(requests[0].body) as { flow: { nodes: FlowNode[] } };
    assert.deepEqual(payload.flow.nodes[0].position, { x: 0, y: 24 });
    assert.notEqual(payload.flow.nodes[0].dragging, true);
    requests[0].resolve(Response.json({ ok: true }));
    assert.equal(await saving, true);

    const after = activeDocument();
    assert.equal(after.revision, before.revision);
    assert.equal(useFlowStore.temporal.getState().pastStates.length, 0);
    assert.equal(after.dirty, false);
    assert.equal(after.saveState, "saved");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("失败响应先等待拖拽时，后到的显式保存会重试一次且不多发", async () => {
  const node = aiNode("queued-drag-save", "排队拖拽保存");
  useFlowStore.getState().openFlowTab({
    projectId: "queued-drag-save-project",
    projectName: "排队拖拽保存",
    nodes: [node],
    edges: [],
  });
  const requests: Array<{ body: string; resolve: (response: Response) => void }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) => new Promise<Response>((resolve) => {
    requests.push({ body: String(init?.body ?? ""), resolve });
  });

  try {
    let firstSettled = false;
    const firstSave = useFlowStore.getState().saveProject().finally(() => {
      firstSettled = true;
    });
    assert.equal(requests.length, 1);
    const transaction = beginHistoryTransaction("queued-drag-save");
    moveNode(node.id, 64);

    requests[0].resolve(Response.json({ error: "首次保存失败" }, { status: 503 }));
    await flushCommandMicrotasks();
    assert.equal(firstSettled, false, "失败响应已先登记 settlement waiter");
    assert.equal(activeDocument().saveState, "saving");

    const secondSave = useFlowStore.getState().saveProject();
    assert.equal(requests.length, 1, "显式重试不得发送拖拽中间帧");

    moveNode(node.id, 128);
    assert.equal(endHistoryTransaction(transaction), true);
    await flushCommandMicrotasks(12);
    assert.equal(requests.length, 2);
    const latestPayload = JSON.parse(requests[1].body) as { flow: { nodes: FlowNode[] } };
    assert.deepEqual(latestPayload.flow.nodes[0].position, { x: 128, y: 24 });
    assert.notEqual(latestPayload.flow.nodes[0].dragging, true);

    requests[1].resolve(Response.json({ ok: true }));
    await Promise.all([firstSave, secondSave]);
    await flushCommandMicrotasks();
    assert.equal(requests.length, 2, "第二次成功已覆盖显式重试，不得发第三次请求");
    const after = activeDocument();
    assert.equal(after.dirty, false);
    assert.equal(after.saveState, "saved");
    assert.equal(after.savedRevision, after.revision);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("切页取消拖拽后，保存继续定向写入源页签回滚快照", async () => {
  const sourceNode = aiNode("switch-drag-save-source", "切页保存源节点");
  useFlowStore.getState().openFlowTab({
    projectId: "switch-drag-save-source-project",
    projectName: "切页保存源页签",
    nodes: [sourceNode],
    edges: [],
  });
  const sourceTabId = useFlowStore.getState().activeTabId;
  useFlowStore.getState().openFlowTab({
    projectId: "switch-drag-save-target-project",
    projectName: "切页保存目标页签",
    nodes: [aiNode("switch-drag-save-target", "切页保存目标节点")],
    edges: [],
  });
  const targetTabId = useFlowStore.getState().activeTabId;
  useFlowStore.getState().switchTab(sourceTabId);
  const requests: Array<{ body: string; resolve: (response: Response) => void }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) => new Promise<Response>((resolve) => {
    requests.push({ body: String(init?.body ?? ""), resolve });
  });

  try {
    const transaction = beginHistoryTransaction("switch-drag-save");
    moveNode(sourceNode.id, 180);
    const saving = useFlowStore.getState().saveProject();
    assert.equal(requests.length, 0);
    useFlowStore.getState().switchTab(targetTabId);
    await flushCommandMicrotasks();

    assert.equal(endHistoryTransaction(transaction), false);
    assert.equal(requests.length, 1);
    const payload = JSON.parse(requests[0].body) as {
      id: string;
      flow: { nodes: FlowNode[] };
    };
    assert.equal(payload.id, "switch-drag-save-source-project");
    assert.deepEqual(payload.flow.nodes[0].position, { x: 320, y: 0 });
    assert.notEqual(payload.flow.nodes[0].dragging, true);

    requests[0].resolve(Response.json({ ok: true }));
    assert.equal(await saving, true);
    const sourceTab = useFlowStore.getState().tabs.find((tab) => tab.id === sourceTabId);
    assert.equal(sourceTab?.dirty, false);
    assert.equal(sourceTab?.saveState, "saved");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("关闭活动页签会取消拖拽与待执行保存", async () => {
  const sourceNode = aiNode("close-active-drag-save", "关闭活动页签");
  useFlowStore.getState().openFlowTab({
    projectId: "close-active-drag-save-project",
    projectName: "关闭活动页签",
    nodes: [sourceNode],
    edges: [],
  });
  const sourceTabId = useFlowStore.getState().activeTabId;
  useFlowStore.getState().openFlowTab({
    projectId: "close-active-fallback-project",
    projectName: "关闭后目标",
    nodes: [aiNode("close-active-fallback", "关闭后目标")],
    edges: [],
  });
  const fallbackTabId = useFlowStore.getState().activeTabId;
  useFlowStore.getState().switchTab(sourceTabId);
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return Response.json({ ok: true });
  };

  try {
    const transaction = beginHistoryTransaction("close-active-drag-save");
    moveNode(sourceNode.id, 640);
    const saving = useFlowStore.getState().saveProject();
    useFlowStore.getState().closeTab(sourceTabId);
    await flushCommandMicrotasks();

    assert.equal(await saving, false);
    assert.equal(requestCount, 0);
    assert.equal(endHistoryTransaction(transaction), false);
    assert.equal(useFlowStore.getState().tabs.some((tab) => tab.id === sourceTabId), false);
    assert.equal(useFlowStore.getState().activeTabId, fallbackTabId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("Undo→Save 会先撤销拖拽，再保存撤销后快照", async () => {
  const node = aiNode("undo-then-save", "Undo 后保存");
  useFlowStore.getState().openFlowTab({
    projectId: "undo-then-save-project",
    projectName: "Undo 后保存",
    nodes: [node],
    edges: [],
  });
  useFlowStore.temporal.getState().clear();
  const requests: Array<{ body: string; resolve: (response: Response) => void }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) => new Promise<Response>((resolve) => {
    requests.push({ body: String(init?.body ?? ""), resolve });
  });

  try {
    const transaction = beginHistoryTransaction("undo-then-save");
    moveNode(node.id, 500);
    useFlowStore.getState().undo();
    const saving = useFlowStore.getState().saveProject();
    assert.equal(requests.length, 0);

    assert.equal(endHistoryTransaction(transaction), true);
    await flushCommandMicrotasks(12);
    assert.equal(requests.length, 1);
    const payload = JSON.parse(requests[0].body) as { flow: { nodes: FlowNode[] } };
    assert.deepEqual(payload.flow.nodes[0].position, { x: 320, y: 0 });
    assert.deepEqual(activeDocument().nodes[0].position, { x: 320, y: 0 });
    assert.equal(useFlowStore.temporal.getState().futureStates.length, 1);

    requests[0].resolve(Response.json({ ok: true }));
    assert.equal(await saving, true);
    assert.equal(activeDocument().dirty, false);
    assert.equal(activeDocument().saveState, "saved");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("Save→Undo 先发送拖拽终点，再排队补写撤销快照", async () => {
  const node = aiNode("save-then-undo", "保存后 Undo");
  useFlowStore.getState().openFlowTab({
    projectId: "save-then-undo-project",
    projectName: "保存后 Undo",
    nodes: [node],
    edges: [],
  });
  useFlowStore.temporal.getState().clear();
  const requests: Array<{ body: string; resolve: (response: Response) => void }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) => new Promise<Response>((resolve) => {
    requests.push({ body: String(init?.body ?? ""), resolve });
  });

  try {
    const transaction = beginHistoryTransaction("save-then-undo");
    moveNode(node.id, 500);
    const saving = useFlowStore.getState().saveProject();
    useFlowStore.getState().undo();
    assert.equal(requests.length, 0);

    assert.equal(endHistoryTransaction(transaction), true);
    await flushCommandMicrotasks(12);
    assert.equal(requests.length, 1);
    const firstPayload = JSON.parse(requests[0].body) as { flow: { nodes: FlowNode[] } };
    assert.deepEqual(firstPayload.flow.nodes[0].position, { x: 500, y: 24 });
    assert.notEqual(firstPayload.flow.nodes[0].dragging, true);
    assert.deepEqual(activeDocument().nodes[0].position, { x: 320, y: 0 });

    requests[0].resolve(Response.json({ ok: true }));
    await flushCommandMicrotasks(12);
    assert.equal(requests.length, 2, "Undo 改变 revision 后应补写最新快照");
    const secondPayload = JSON.parse(requests[1].body) as { flow: { nodes: FlowNode[] } };
    assert.deepEqual(secondPayload.flow.nodes[0].position, { x: 320, y: 0 });

    requests[1].resolve(Response.json({ ok: true }));
    assert.equal(await saving, true);
    assert.equal(activeDocument().dirty, false);
    assert.equal(activeDocument().saveState, "saved");
    assert.equal(useFlowStore.temporal.getState().futureStates.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("新建项目首次生成会先保存同一份项目，再提交运行", async () => {
  useFlowStore.getState().createBlankTab();
  useFlowStore.getState().addExistingNode(aiNode("first-run-ai", "首次生成"));
  const projectId = activeDocument().projectId;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ url, body });
    if (url === "/api/projects") return Response.json({ ok: true });
    if (url === "/api/run-plan") {
      return Response.json({ error: "测试在付费调用前终止" }, { status: 400 });
    }
    throw new Error(`意外请求：${url}`);
  };

  try {
    await useFlowStore.getState().runNode("first-run-ai");
    assert.deepEqual(requests.map((request) => request.url), ["/api/projects", "/api/run-plan"]);

    const saveBody = requests[0].body as {
      id: string;
      flow: { nodes: FlowNode[]; edges: Edge[] };
    };
    const runBody = requests[1].body as {
      projectId: string;
      nodes: FlowNode[];
      edges: Edge[];
    };
    assert.equal(saveBody.id, projectId);
    assert.equal(runBody.projectId, projectId);
    assert.deepEqual(runBody.nodes, saveBody.flow.nodes);
    assert.deepEqual(runBody.edges, saveBody.flow.edges);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("runNode 等待拖拽结束后向保存与运行提交同一最终快照", async () => {
  const node = aiNode("drag-run-node", "拖拽后运行");
  useFlowStore.getState().openFlowTab({
    projectId: "drag-run-project",
    projectName: "拖拽后运行",
    nodes: [node],
    edges: [],
  });
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ url, body });
    if (url === "/api/projects") return Response.json({ ok: true });
    if (url === "/api/run-plan") {
      return Response.json({ error: "测试在付费调用前终止" }, { status: 400 });
    }
    throw new Error(`意外请求：${url}`);
  };

  try {
    const transaction = beginHistoryTransaction("drag-before-run");
    moveNode(node.id, 384);
    const running = useFlowStore.getState().runNode(node.id);
    assert.equal(requests.length, 0, "运行不得读取拖拽中间帧");

    moveNode(node.id, 544);
    assert.equal(endHistoryTransaction(transaction), true);
    await running;

    assert.deepEqual(requests.map((request) => request.url), ["/api/projects", "/api/run-plan"]);
    const savedNodes = (requests[0].body as { flow: { nodes: FlowNode[] } }).flow.nodes;
    const runNodes = (requests[1].body as { nodes: FlowNode[] }).nodes;
    assert.deepEqual(savedNodes[0].position, { x: 544, y: 24 });
    assert.notEqual(savedNodes[0].dragging, true);
    assert.deepEqual(runNodes, savedNodes);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("runNode 创建 queued 记录时保留当前结果选择", async () => {
  useFlowStore.getState().openFlowTab({
    projectId: "queued-selection-project",
    projectName: "运行选择测试",
    nodes: [aiNode("queued-selection-node", "不抢占选择")],
    edges: [],
  });
  const keptResult = {
    id: "kept-result-selection",
    image: "/api/files/kept.png",
    nodeId: "older-node",
    nodeLabel: "原已选结果",
    kind: "ai-modify",
    projectId: "older-project",
    startedAt: 1,
    finishedAt: 2,
    status: "success",
  } satisfies RecentResult;
  useFlowStore.setState({ recentResults: [keptResult] });
  useFlowStore.getState().setSelectedResultId(keptResult.id);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === "/api/projects") return Response.json({ ok: true });
    if (url === "/api/run-plan") {
      return Response.json({ error: "测试在调用生图服务前终止" }, { status: 400 });
    }
    throw new Error(`意外请求：${url}`);
  };

  try {
    const running = useFlowStore.getState().runNode("queued-selection-node");
    const queued = useFlowStore.getState().recentResults.find(
      (record) => record.nodeId === "queued-selection-node",
    );
    assert.equal(queued?.status, "queued");
    assert.equal(activeDocument().selectedResultId, keptResult.id);
    await running;
    assert.equal(activeDocument().selectedResultId, keptResult.id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("历史安全门从 runNode 唯一入口阻止新的付费运行", async () => {
  useFlowStore.getState().openFlowTab({
    projectId: "history-gate-project",
    projectName: "历史安全门测试",
    nodes: [aiNode("history-gate-node", "门禁节点")],
    edges: [],
  });
  const before = useFlowStore.getState().recentResults.length;
  const beforeStatus = activeDocument().nodes[0].data.status;
  const originalFetch = globalThis.fetch;
  let requested = false;
  globalThis.fetch = async () => {
    requested = true;
    throw new Error("安全门开启时不应发起请求");
  };
  setGenerationSafetyBlockReason("运行历史同步失败");

  try {
    await useFlowStore.getState().runNode("history-gate-node");
    assert.equal(requested, false);
    assert.equal(useFlowStore.getState().recentResults.length, before);
    assert.equal(activeDocument().nodes[0].data.status, beforeStatus);
  } finally {
    setGenerationSafetyBlockReason(null);
    globalThis.fetch = originalFetch;
  }
});

await test("Gemini 选择经上传回写、加蒙版、切页与运行全程保真", async () => {
  const generationNode = aiNode("model-invariant-ai", "Gemini 保真节点");
  generationNode.data.status = "idle";
  if (generationNode.data.kind !== "ai-modify") throw new Error("测试生成节点类型错误");
  generationNode.data.outputImages = [];
  useFlowStore.getState().openFlowTab({
    projectId: "model-invariant-project",
    projectName: "模型保真项目",
    nodes: [imageNode("model-invariant-upload", "异步上传"), generationNode],
    edges: [{ id: "model-invariant-edge", source: "model-invariant-upload", target: generationNode.id }],
  });
  const invariantTabId = useFlowStore.getState().activeTabId;
  const expected = {
    modelId: "gemini-3.1-flash-image",
    modelOptions: { aspectRatio: "16:9", imageSize: "4K" },
  };

  useFlowStore.getState().updateNodeData(generationNode.id, expected);
  assertNodeModelSelection(activeDocument().nodes, generationNode.id, expected);

  await Promise.resolve().then(() => {
    useFlowStore.getState().updateNodeDataInTab(documentTargetForTab(invariantTabId), "model-invariant-upload", {
      status: "success",
      imageUrl: "/api/files/model-invariant-upload.png",
    });
  });
  assertNodeModelSelection(activeDocument().nodes, generationNode.id, expected);

  useFlowStore.getState().addExistingNode({
    id: "model-invariant-mask",
    type: "mask-redraw",
    position: { x: 320, y: 240 },
    data: {
      kind: "mask-redraw",
      label: "蒙版局部重绘",
      status: "idle",
      prompt: "仅替换被选中区域",
      modelId: "gpt-image-2",
      modelOptions: {},
      outputImages: [],
    },
  });
  useFlowStore.getState().onConnect({
    source: "model-invariant-upload",
    target: "model-invariant-mask",
    sourceHandle: null,
    targetHandle: null,
  });
  assertNodeModelSelection(activeDocument().nodes, generationNode.id, expected);

  useFlowStore.getState().openFlowTab({
    projectId: "model-invariant-other-project",
    projectName: "切换目标项目",
    nodes: [imageNode("model-invariant-other-upload", "另一页")],
    edges: [],
  });
  const storedInvariantTab = useFlowStore.getState().tabs.find((tab) => tab.id === invariantTabId);
  assert.ok(storedInvariantTab);
  assertNodeModelSelection(storedInvariantTab.nodes, generationNode.id, expected);
  useFlowStore.getState().switchTab(invariantTabId);
  assertNodeModelSelection(activeDocument().nodes, generationNode.id, expected);

  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ url, body });
    if (url === "/api/projects") return Response.json({ ok: true });
    if (url === "/api/run-plan") {
      return Response.json({ error: "测试在 Provider 调用前终止" }, { status: 400 });
    }
    throw new Error(`意外请求：${url}`);
  };

  try {
    await useFlowStore.getState().runNode(generationNode.id);
    assert.deepEqual(requests.map((request) => request.url), ["/api/projects", "/api/run-plan"]);
    assertNodeModelSelection(activeDocument().nodes, generationNode.id, expected);

    const savedFlow = (requests[0].body as { flow: { nodes: FlowNode[] } }).flow;
    const runNodes = (requests[1].body as { nodes: FlowNode[] }).nodes;
    assertNodeModelSelection(savedFlow.nodes, generationNode.id, expected);
    assertNodeModelSelection(runNodes, generationNode.id, expected);
    assert.deepEqual(
      runNodes.find((node) => node.id === generationNode.id),
      savedFlow.nodes.find((node) => node.id === generationNode.id),
      "/projects 与 /run-plan 必须提交同一个目标节点快照",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("节点与 Inspector 共用画幅补丁并同步 provider 参数", () => {
  assert.deepEqual(
    imageModelAspectRatioPatch(
      "gemini-3.1-flash-image",
      { aspectRatio: "3:4", imageSize: "2K" },
      "16:9",
    ),
    {
      aspectRatio: "16:9",
      modelOptions: { aspectRatio: "16:9", imageSize: "2K" },
    },
  );

  const inspectorSource = fs.readFileSync(
    new URL("../src/components/panels/InspectorPanel.tsx", import.meta.url),
    "utf8",
  );
  const aiModifySource = fs.readFileSync(
    new URL("../src/components/nodes/AiModifyNode.tsx", import.meta.url),
    "utf8",
  );
  const sketchSource = fs.readFileSync(
    new URL("../src/components/nodes/SketchToRenderNode.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    inspectorSource,
    /imageModelAspectRatioPatch\(selectedModelId, selectedModelOptions, value\)/,
    "Inspector 修改画幅时必须同步业务比例与 provider modelOptions",
  );
  for (const source of [aiModifySource, sketchSource]) {
    assert.match(
      source,
      /imageModelAspectRatioPatch\(data\.modelId, data\.modelOptions, e\.target\.value\)/,
      "节点内画幅入口也必须复用同一 provider 参数补丁",
    );
  }
});

await test("项目保存失败时显示错误且绝不提交生成", async () => {
  useFlowStore.getState().createBlankTab();
  useFlowStore.getState().addExistingNode(aiNode("blocked-first-run", "保存失败生成"));
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return Response.json({ error: "保存服务暂不可用" }, { status: 503 });
  };

  try {
    await useFlowStore.getState().runNode("blocked-first-run");
    assert.deepEqual(requests, ["/api/projects"]);
    const failedNode = activeDocument().nodes.find((node) => node.id === "blocked-first-run");
    assert.equal(failedNode?.data.status, "error");
    assert.match(failedNode?.data.error ?? "", /项目保存失败.*未调用生图服务.*保存服务暂不可用/);
    const result = useFlowStore.getState().recentResults.find(
      (record) => record.nodeId === "blocked-first-run",
    );
    assert.equal(result?.status, "error");
    assert.match(result?.error ?? "", /项目保存失败.*未调用生图服务.*保存服务暂不可用/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("保存等待期间的编辑不会悄悄改变已点击的付费请求", async () => {
  useFlowStore.getState().createBlankTab();
  useFlowStore.getState().addExistingNode(aiNode("snapshot-run", "快照生成"));
  const projectResolvers: Array<(response: Response) => void> = [];
  const runBodies: Array<{ nodes: FlowNode[] }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input);
    if (url === "/api/projects") {
      return new Promise<Response>((resolve) => projectResolvers.push(resolve));
    }
    if (url === "/api/run-plan") {
      runBodies.push(JSON.parse(String(init?.body ?? "{}")) as { nodes: FlowNode[] });
      return Promise.resolve(Response.json(
        { error: "画布尚未保存或已在其他位置更新，请保存后重试" },
        { status: 409 },
      ));
    }
    throw new Error(`意外请求：${url}`);
  };

  try {
    const running = useFlowStore.getState().runNode("snapshot-run");
    assert.equal(projectResolvers.length, 1);
    useFlowStore.getState().updateNodeData("snapshot-run", { prompt: "保存期间的新提示词" });
    projectResolvers[0](Response.json({ ok: true }));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(projectResolvers.length, 2, "保存队列应先持久化保存期间的编辑");
    projectResolvers[1](Response.json({ ok: true }));
    await running;

    assert.equal(runBodies.length, 1);
    const submitted = runBodies[0].nodes.find((node) => node.id === "snapshot-run");
    assert.equal(submitted?.data.kind, "ai-modify");
    assert.equal(submitted?.data.kind === "ai-modify" ? submitted.data.prompt : undefined, "修改衣领");
    assert.match(
      activeDocument().nodes.find((node) => node.id === "snapshot-run")?.data.error ?? "",
      /画布尚未保存或已在其他位置更新/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("网络或网关响应不确定时复用同一请求号，已知 runId 后禁止重复付费", async () => {
  useFlowStore.getState().createBlankTab();
  useFlowStore.getState().addExistingNode(aiNode("idempotent-run", "幂等生成"));
  const clientRequestIds: string[] = [];
  let submissions = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "/api/projects") return Response.json({ ok: true });
    if (url === "/api/run-plan") {
      submissions += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { clientRequestId?: string };
      assert.ok(body.clientRequestId);
      clientRequestIds.push(body.clientRequestId);
      if (submissions === 1) throw new TypeError("响应连接已断开");
      if (submissions === 2) {
        return Response.json({ error: "网关暂不可用" }, { status: 503 });
      }
      return Response.json({ runId: "idempotent-server-run", status: "queued" }, { status: 202 });
    }
    if (url === "/api/run-plan/idempotent-server-run") {
      return Response.json({ error: "状态服务暂不可用" }, { status: 503 });
    }
    throw new Error(`意外请求：${url}`);
  };

  try {
    await useFlowStore.getState().runNode("idempotent-run");
    const uncertain = activeDocument().nodes.find((node) => node.id === "idempotent-run");
    assert.equal(uncertain?.data.status, "outcome_unknown");
    assert.match(uncertain?.data.error ?? "", /同一请求号安全确认/);

    await useFlowStore.getState().runNode("idempotent-run");
    assert.deepEqual(clientRequestIds.length, 2);
    assert.equal(clientRequestIds[1], clientRequestIds[0]);
    const gatewayUnknown = activeDocument().nodes.find((node) => node.id === "idempotent-run");
    assert.equal(gatewayUnknown?.data.status, "outcome_unknown");

    await useFlowStore.getState().runNode("idempotent-run");
    assert.equal(clientRequestIds[2], clientRequestIds[0]);
    const recovering = activeDocument().nodes.find((node) => node.id === "idempotent-run");
    assert.equal(recovering?.data.status, "retry_wait");
    assert.match(recovering?.data.error ?? "", /勿重复提交/);

    await useFlowStore.getState().runNode("idempotent-run");
    assert.equal(submissions, 3, "已有 runId 但跟踪失败时必须继续阻止新的付费提交");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("丢失响应后即使参数变化收到 409，也持续复用原付费请求号", async () => {
  useFlowStore.getState().createBlankTab();
  useFlowStore.getState().addExistingNode(aiNode("ambiguous-conflict", "歧义冲突"));
  const clientRequestIds: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "/api/projects") return Response.json({ ok: true });
    if (url === "/api/run-plan") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { clientRequestId?: string };
      assert.ok(body.clientRequestId);
      clientRequestIds.push(body.clientRequestId);
      if (clientRequestIds.length === 1) throw new TypeError("首次响应丢失");
      return Response.json(
        { error: "clientRequestId 已用于另一份生成请求，请重新提交" },
        { status: 409 },
      );
    }
    throw new Error(`意外请求：${url}`);
  };

  try {
    await useFlowStore.getState().runNode("ambiguous-conflict");
    useFlowStore.getState().updateNodeData("ambiguous-conflict", { prompt: "响应丢失后的新提示词" });
    await useFlowStore.getState().runNode("ambiguous-conflict");
    await useFlowStore.getState().runNode("ambiguous-conflict");
    assert.equal(clientRequestIds.length, 3);
    assert.deepEqual(new Set(clientRequestIds).size, 1, "409 后不得换新请求号再次付费");
    const node = activeDocument().nodes.find((candidate) => candidate.id === "ambiguous-conflict");
    assert.equal(node?.data.status, "outcome_unknown");
    assert.match(node?.data.error ?? "", /旧请求可能已创建任务/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("React Flow 初始化尺寸不会移动节点或标记项目未保存", () => {
  useFlowStore.getState().openFlowTab({
    projectId: "dimension-init-project",
    projectName: "尺寸初始化测试",
    nodes: [imageNode("dimension-node", "尺寸初始化节点")],
    edges: [],
  });
  const before = activeDocument();
  const originalPosition = { ...before.nodes[0].position };

  useFlowStore.getState().onNodesChange([{
    id: "dimension-node",
    type: "dimensions",
    dimensions: { width: 280, height: 162 },
  }]);

  const after = activeDocument();
  assert.equal(after.revision, before.revision);
  assert.equal(after.dirty, false);
  assert.deepEqual(after.nodes[0].position, originalPosition);
  assert.deepEqual(after.nodes[0].measured, { width: 280, height: 162 });
});

await test("打开含蒙版节点的项目时只订阅稳定的首张输入图", () => {
  const source = fs.readFileSync(
    new URL("../src/components/nodes/MaskRedrawNode.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes("const source = useFlowStore((state) => selectActiveNodeInputImages(state, id)[0]);"));
  assert.doesNotMatch(source, /const sourceImages = useFlowStore/);
});

await test("保存当前原图的蒙版后局部重绘按钮立即恢复可点击", () => {
  const sourceRef = "/api/files/mask-source";
  useFlowStore.getState().openFlowTab({
    projectId: "mask-readiness-project",
    projectName: "蒙版按钮测试",
    nodes: [
      {
        id: "mask-source",
        type: "image-input",
        position: { x: 0, y: 0 },
        data: {
          kind: "image-input",
          label: "蒙版原图",
          status: "success",
          imageRole: "default",
          imageUrl: sourceRef,
        },
      },
      {
        id: "mask-node",
        type: "mask-redraw",
        position: { x: 320, y: 0 },
        data: {
          kind: "mask-redraw",
          label: "蒙版局部重绘",
          status: "idle",
          modelId: "gpt-image-2",
          modelOptions: {},
          prompt: "",
          outputImages: [],
        },
      },
    ],
    edges: [{ id: "mask-edge", source: "mask-source", target: "mask-node" }],
  });

  const source = selectNodeInputImages(activeDocument(), "mask-node")[0];
  assert.equal(source, sourceRef);
  const beforeSave = maskRedrawReadiness({ source, prompt: "" });
  assert.equal(beforeSave.canOpenRunAction, false);

  useFlowStore.getState().updateNodeData("mask-node", {
    mask: "data:image/png;base64,bWFzaw==",
    maskSourceRef: source,
  });
  const savedNode = activeDocument().nodes.find((node) => node.id === "mask-node");
  assert.equal(savedNode?.data.kind, "mask-redraw");
  if (savedNode?.data.kind !== "mask-redraw") throw new Error("蒙版节点丢失");
  const afterSave = maskRedrawReadiness({
    source,
    mask: savedNode.data.mask,
    maskSourceRef: savedNode.data.maskSourceRef,
    prompt: savedNode.data.prompt,
  });
  assert.equal(afterSave.hasCurrentMask, true);
  assert.equal(afterSave.canOpenRunAction, true, "保存蒙版后按钮不应再因提示词为空而保持 disabled");
  assert.equal(afterSave.canSubmit, false, "提示词仍应在点击动作时单独校验");

  const afterPrompt = maskRedrawReadiness({
    source,
    mask: "data:image/png;base64,bWFzaw==",
    maskSourceRef: source,
    prompt: "将选中区域改成银色拉链",
  });
  assert.equal(afterPrompt.canSubmit, true);

  const staleMask = maskRedrawReadiness({
    source: "/api/files/new-source",
    mask: "data:image/png;base64,bWFzaw==",
    maskSourceRef: source,
    prompt: "将选中区域改成银色拉链",
  });
  assert.equal(staleMask.canOpenRunAction, false, "原图变化后旧蒙版仍必须禁用");
});

await test("蒙版编辑与上传分别持有离页保护，释放操作幂等", () => {
  assert.equal(useFlowStore.getState().pendingMaskWorkCount, 0);
  const releaseEditor = beginMaskWork();
  const releaseUpload = beginMaskWork();
  assert.equal(useFlowStore.getState().pendingMaskWorkCount, 2);
  assert.equal(shouldWarnBeforeWorkspaceUnload({
    hasDirtyTabs: false,
    tabSessionPersistenceError: null,
    pendingMaskWorkCount: useFlowStore.getState().pendingMaskWorkCount,
  }), true, "尚未写入节点的蒙版工作也必须阻止静默离页");

  releaseEditor();
  assert.equal(useFlowStore.getState().pendingMaskWorkCount, 1, "编辑器卸载不能清除仍在进行的上传 pending");
  releaseEditor();
  assert.equal(useFlowStore.getState().pendingMaskWorkCount, 1, "重复 cleanup 不得重复递减");
  releaseUpload();
  assert.equal(useFlowStore.getState().pendingMaskWorkCount, 0);

  assert.equal(shouldWarnBeforeWorkspaceUnload({
    hasDirtyTabs: true,
    tabSessionPersistenceError: "quota",
    pendingMaskWorkCount: 0,
  }), true);
  assert.equal(shouldWarnBeforeWorkspaceUnload({
    hasDirtyTabs: true,
    tabSessionPersistenceError: null,
    pendingMaskWorkCount: 0,
  }), false, "会话快照正常时普通 dirty 页签仍可刷新恢复");
});

await test("蒙版异步保存接线冻结编辑、校验最新原图并保持失败界面", () => {
  const editorSource = fs.readFileSync(
    new URL("../src/components/nodes/MaskEditor.tsx", import.meta.url),
    "utf8",
  );
  const redrawSource = fs.readFileSync(
    new URL("../src/components/nodes/MaskRedrawNode.tsx", import.meta.url),
    "utf8",
  );
  const appSource = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const authSource = fs.readFileSync(new URL("../src/auth/AuthContext.tsx", import.meta.url), "utf8");
  const topBarSource = fs.readFileSync(
    new URL("../src/components/panels/TopBar.tsx", import.meta.url),
    "utf8",
  );
  assert.match(editorSource, /if \(!ready \|\| savingRef\.current\) return/);
  assert.match(editorSource, /onClick=\{onClose\} disabled=\{saving\}/);
  assert.match(editorSource, /aria-disabled=\{saving\}/);
  assert.match(editorSource, /loadGuardRef\.current\.invalidate\(\)/);
  assert.match(editorSource, /if \(!isCurrentLoad\(\)\) return/);
  assert.match(editorSource, /const snapshotLoadGuardRef = useRef\(createLatestMaskLoadGuard\(\)\)/);
  assert.match(editorSource, /const isCurrentLoad = snapshotLoadGuardRef\.current\.begin\(\)/);
  assert.ok(
    (editorSource.match(/snapshotLoadGuardRef\.current\.invalidate\(\)/g) ?? []).length >= 6,
    "source 切换、初始化、绘制、清空、反选与保存都必须废弃旧历史加载",
  );
  assert.match(redrawSource, /const releaseUploadPending = beginMaskWork\(\)/);
  assert.match(redrawSource, /finally \{\s*releaseUploadPending\(\)/);
  assert.match(redrawSource, /selectNodeInputImages\(currentTab, id\)\[0\] !== source/);
  assert.match(redrawSource, /updateNodeDataInTab\(target, id, \{ mask: url, maskSourceRef: source/);
  assert.match(appSource, /shouldWarnBeforeWorkspaceUnload\(\{/);
  assert.match(appSource, /isWorkspaceUnloadWarningSuppressed\(\)/);
  assert.match(appSource, /window\.addEventListener\("beforeunload", warnBeforeUnload\)/);
  assert.match(appSource, /pendingMaskWorkCount > 0\) return/);
  assert.match(authSource, /const authenticatedUserId = useRef<string \| null>\(null\)/);
  assert.match(authSource, /shouldReloadForAuthenticatedUserTransition\(\s*authenticatedUserId\.current/);
  assert.match(authSource, /suppressWorkspaceUnloadWarning\(\);\s*window\.location\.reload\(\)/);
  assert.match(topBarSource, /onClick=\{retryTabSessionPersistence\}/);
});

await test("桌面工作台使用五组工具栏与稳定右侧 Dock，快捷键入口位于创作工具之后", () => {
  const appSource = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const topBarSource = fs.readFileSync(
    new URL("../src/components/panels/TopBar.tsx", import.meta.url),
    "utf8",
  );
  const projectTabsSource = fs.readFileSync(
    new URL("../src/components/panels/ProjectTabs.tsx", import.meta.url),
    "utf8",
  );
  const projectCenterSource = fs.readFileSync(
    new URL("../src/components/panels/ProjectCenter.tsx", import.meta.url),
    "utf8",
  );
  const shellSource = fs.readFileSync(
    new URL("../src/components/workbench/WorkbenchShell.tsx", import.meta.url),
    "utf8",
  );
  const toolRailSource = fs.readFileSync(
    new URL("../src/components/workbench/ToolRail.tsx", import.meta.url),
    "utf8",
  );
  const shortcutMenuSource = fs.readFileSync(
    new URL("../src/components/workbench/ShortcutMenu.tsx", import.meta.url),
    "utf8",
  );

  assert.match(appSource, /<WorkbenchShell[\s\S]*inspector=\{\(/);
  assert.doesNotMatch(appSource, /NodeLibraryPanel/);
  assert.equal((shellSource.match(/\{children\}/g) ?? []).length, 1);
  assert.equal((shellSource.match(/\{inspector\}/g) ?? []).length, 1);
  assert.doesNotMatch(shellSource, /MobileSheet|useMediaQuery|mobilePanel/);
  assert.match(shellSource, /<ToolRail state=\{state\} dispatch=\{dispatch\}/);
  assert.match(shellSource, /aria-controls=\{INSPECTOR_PANEL_ID\}/);
  assert.match(shellSource, /border-l border-\[var\(--gc-border\)\]/);
  assert.match(shellSource, /transition-\[width,visibility\]/);
  assert.match(topBarSource, /items-center justify-between/);
  assert.match(topBarSource, /Coin AI - Canvas/);
  assert.doesNotMatch(topBarSource, /ThemeSwitcher|useTheme|THEMES/);
  assert.doesNotMatch(topBarSource, /ShortcutMenu|查看快捷键|KeyboardIcon/);
  assert.match(shortcutMenuSource, /eventDetails\.reason === "trigger-press"/);
  assert.match(shortcutMenuSource, /eventDetails\.event\.detail > 0/);
  assert.match(shortcutMenuSource, /aria-label="查看快捷键"/);
  assert.doesNotMatch(shortcutMenuSource, /title="快捷键"/);
  assert.match(shortcutMenuSource, /className="w-56 min-w-56/);
  assert.match(shortcutMenuSource, /<DropdownMenuShortcut/);
  assert.match(shortcutMenuSource, /openOnHover/);
  assert.match(shortcutMenuSource, /delay=\{0\}/);
  assert.match(shortcutMenuSource, /closeDelay=\{100\}/);
  assert.match(shortcutMenuSource, /side="right"/);
  assert.doesNotMatch(shortcutMenuSource, /onPointerEnter=\{openMenu\}/);
  assert.doesNotMatch(shortcutMenuSource, /onPointerLeave=\{scheduleClose\}/);
  assert.doesNotMatch(shortcutMenuSource, /onFocus=\{openMenu\}/);
  assert.match(toolRailSource, /\{TOOL_GROUPS\.map\([\s\S]*?aria-label="资产库"[\s\S]*?<ShortcutMenu/);
  assert.doesNotMatch(toolRailSource, /Separator|role="separator"/);
  assert.doesNotMatch(topBarSource, /GARMENT CANVAS|ProjectPicker/);
  assert.doesNotMatch(appSource, /TemplatesDock/);
  assert.match(projectTabsSource, /<LazyProjectCenter open=\{projectCenterOpen\}/);
  assert.match(projectTabsSource, /onFocus=\{\(\) => void loadProjectCenter\(\)\}/);
  assert.match(projectTabsSource, /onPointerEnter=\{\(\) => void loadProjectCenter\(\)\}/);
  assert.match(projectTabsSource, /onDoubleClick=\{\(\) => beginRename\(tab\)\}/);
  assert.match(projectTabsSource, /aria-label="保存项目名称和画布"/);
  assert.match(projectTabsSource, /event\.nativeEvent\.isComposing \|\| renameComposingRef\.current/);
  assert.match(projectTabsSource, /const saved = await saveProject\(\)/);
  assert.match(projectTabsSource, /if \(!saved\) \{[\s\S]*setRenameError/);
  assert.match(projectTabsSource, /onBlur=\{\(event\) => \{[\s\S]*setEditingTabId\(null\)/);
  assert.match(projectTabsSource, /role="alert"/);
  assert.match(projectCenterSource, /activeSection === "recent"/);
  assert.match(projectCenterSource, /activeSection === "templates"/);
  assert.match(projectCenterSource, /"my-templates"/);
  assert.match(projectCenterSource, /if \(!template\.builtIn\) return false/);
  assert.match(projectCenterSource, /if \(template\.builtIn\) return false/);
  assert.match(projectCenterSource, /inferTemplateLaunchMode\(template\)/);
  assert.match(projectCenterSource, /launchTemplateInNewTab\(template,\s*inferTemplateLaunchMode\(template\)\)/);
  assert.doesNotMatch(projectCenterSource, /projectDetails/);
  assert.match(projectCenterSource, /Promise\.allSettled\(\[loadProjects\(\), loadTemplates\(\)\]\)/);
  assert.match(projectCenterSource, /onSaved=\{\(\) => void loadTemplates\(\)\}/);
  assert.match(projectCenterSource, /const requestVersion = \+\+openRequestVersion\.current/);
  assert.match(projectCenterSource, /if \(requestVersion !== openRequestVersion\.current\) return/);
  assert.match(projectCenterSource, /最近项目/);
  assert.match(projectCenterSource, /内置模板/);
  assert.match(projectCenterSource, /我的模板/);
  assert.match(projectCenterSource, /保存当前画布为模板/);
  assert.match(projectCenterSource, /DELETE/);
  assert.match(projectCenterSource, /删除后无法恢复；由此模板创建的项目不会受到影响/);
  assert.match(projectCenterSource, /<Tabs[\s\S]*<TabsTrigger[\s\S]*<Card/);
  assert.match(projectCenterSource, /<DropdownMenu[\s\S]*<AlertDialog/);
  assert.match(projectCenterSource, /NEW_PROJECT_COVER/);
  assert.match(projectCenterSource, /EMPTY_PROJECT_COVER/);
  assert.match(projectCenterSource, /SAVE_TEMPLATE_COVER/);
  assert.match(projectCenterSource, /PROJECT_CENTER_CARD_GRID_CLASS = "grid grid-cols-3 xl:grid-cols-4 gap-4"/);
  assert.match(projectCenterSource, /PROJECT_CENTER_TITLE_CLASS = "min-w-0 flex-1 line-clamp-2 min-h-8 text-xs font-semibold text-\[var\(--gc-text\)\]"/);
  assert.ok(
    fs.existsSync(new URL("../public/assets/project-center/save-template-cover.png", import.meta.url)),
    "我的模板保存卡必须使用仓库内图片素材",
  );
});

await test("最近生成成功卡显式提供查看、对比、下载与设为输入动作", () => {
  const resultsPanelSource = fs.readFileSync(
    new URL("../src/components/panels/ResultsPanel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(resultsPanelSource, /aria-label=\{`查看生成记录：\$\{r\.nodeLabel\}`\}/);
  assert.match(resultsPanelSource, /OPEN_GENERATION_RECORD_EVENT/);
  assert.match(resultsPanelSource, /查看图片/);
  assert.match(resultsPanelSource, /aria-label=\{`\$\{compareIds\.includes\(r\.id\) \? "取消" : "加入"\}对比 \$\{r\.nodeLabel\}`\}/);
  assert.match(resultsPanelSource, /href=\{r\.image\}[\s\S]*download/);
  assert.match(resultsPanelSource, /aria-label=\{`将 \$\{r\.nodeLabel\} 设为输入，继续处理`\}/);
  assert.match(resultsPanelSource, /state\.addAssetNode\(\s*\{ name: r\.nodeLabel, image: r\.image \}/);
  assert.match(resultsPanelSource, /requestCanvasLanding\(\{ tabId: tab\.id, nodeId, fitView: false \}\)/);
  assert.match(resultsPanelSource, /isNodeRunActive\(r\.status\)/);
  assert.match(resultsPanelSource, /r\.status !== "success"/);
  assert.match(resultsPanelSource, /grid-cols-2/);
  assert.match(resultsPanelSource, /text-\[var\(--gc-media-overlay-text\)\]/);
});

await test("第二轮缺少人工确认或面料工艺时在任何网络请求前阻止运行", async () => {
  const baseline = imageNode("staged-baseline", "第一轮基准");
  const outfit = imageNode("staged-outfit", "主穿搭");
  if (baseline.data.kind !== "image-input" || outfit.data.kind !== "image-input") throw new Error("测试输入节点错误");
  baseline.data.imageUrl = "/api/files/baseline.png";
  outfit.data.imageUrl = "/api/files/outfit.png";
  const refine: FlowNode = {
    id: "staged-refine",
    type: "virtual-try-on",
    position: { x: 400, y: 0 },
    data: {
      kind: "virtual-try-on", label: "第二轮", status: "idle", workflowStage: "garment-refine",
      prompt: "", imageSize: "2K", modelId: "gpt-image-2", modelOptions: { quality: "medium" },
      garmentCategory: "knit", materialSpec: "", constructionSpec: "", outputImages: [],
    },
  };
  useFlowStore.getState().openFlowTab({
    projectId: "staged-gate-project",
    projectName: "分步付费门禁",
    nodes: [baseline, outfit, refine],
    edges: [
      { id: "staged-baseline-edge", source: baseline.id, target: refine.id, targetHandle: "baseline" },
      { id: "staged-outfit-edge", source: outfit.id, target: refine.id, targetHandle: "outfit" },
    ],
  });
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    networkCalls += 1;
    return Response.json({ ok: true });
  };
  try {
    await useFlowStore.getState().runNode(refine.id);
    assert.equal(networkCalls, 0);
    const current = activeDocument().nodes.find((node) => node.id === refine.id);
    assert.equal(current?.data.status, "error");
    assert.match(current?.data.error ?? "", /确认当前第一轮基准图/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("分步换装错误模型在客户端付费请求前被拒绝", async () => {
  const firstStage: FlowNode = {
    id: "invalid-model-first",
    type: "virtual-try-on",
    position: { x: 0, y: 0 },
    data: {
      kind: "virtual-try-on", label: "第一轮", status: "idle", workflowStage: "scene-stabilize",
      prompt: "", imageSize: "2K", aspectRatio: "3:4", modelId: "gpt-image-2",
      modelOptions: { quality: "medium" }, basisRevision: 0, outputImages: [],
    },
  };
  const secondStage: FlowNode = {
    id: "invalid-model-second",
    type: "virtual-try-on",
    position: { x: 400, y: 0 },
    data: {
      kind: "virtual-try-on", label: "第二轮", status: "idle", workflowStage: "garment-refine",
      prompt: "", imageSize: "2K", aspectRatio: "3:4", modelId: "gemini-3.1-flash-image",
      modelOptions: { imageSize: "2K" }, garmentCategory: "knit", materialSpec: "羊毛", constructionSpec: "12GG", outputImages: [],
    },
  };
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    networkCalls += 1;
    return Response.json({ ok: true });
  };
  try {
    useFlowStore.getState().loadFlow({
      projectId: "invalid-model-first-project",
      projectName: "错误第一轮模型",
      nodes: [firstStage],
      edges: [],
    });
    await useFlowStore.getState().runNode(firstStage.id);
    assert.equal(networkCalls, 0);
    assert.match(activeDocument().nodes[0].data.error ?? "", /第一轮必须使用 Gemini 3\.1 Flash/);

    useFlowStore.getState().loadFlow({
      projectId: "invalid-model-second-project",
      projectName: "错误第二轮模型",
      nodes: [secondStage],
      edges: [],
    });
    await useFlowStore.getState().runNode(secondStage.id);
    assert.equal(networkCalls, 0);
    assert.match(activeDocument().nodes[0].data.error ?? "", /第二轮必须使用 GPT Image 2/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

console.log(`\n通过 ${passed} 项`);

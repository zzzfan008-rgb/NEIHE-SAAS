import assert from "node:assert/strict";
import {
  createDocumentSnapshot,
  documentSnapshotToPersistedWorkflow,
} from "../src/lib/documentSnapshot";

const source = {
  projectName: "2027 春夏胶囊系列",
  projectId: "project-secret",
  tabId: "tab-runtime",
  readOnly: true,
  selectedNodeIds: ["upload"],
  saveState: "saving",
  hasBeenPersisted: true,
  runtime: { runId: "paid-run" },
  nodes: [
    {
      id: "upload",
      type: "image-input",
      position: { x: 10, y: 20 },
      selected: true,
      dragging: true,
      measured: { width: 320, height: 180 },
      width: 320,
      height: 180,
      unknownShell: "drop-me",
      data: {
        kind: "image-input",
        label: "款式参考",
        status: "running",
        error: "runtime-only",
        imageRole: "garment",
        imageUrl: "/api/files/garment.png",
        selectedResultId: "result-runtime",
        unknownData: "drop-me",
      },
    },
    {
      id: "sketch",
      type: "sketch-to-render",
      position: { x: 40, y: 50 },
      data: {
        kind: "sketch-to-render",
        label: "草图渲染",
        status: "queued",
        error: "queue-runtime",
        prompt: "轻薄风衣",
        aspectRatio: "16:9",
        batchSize: 2,
        outputImages: ["/api/files/sketch-a.png"],
        modelId: "gemini-3.1-flash-image",
        modelOptions: {
          aspectRatio: "16:9",
          imageSize: "4K",
          unsupportedOption: "drop-me",
        },
        runId: "drop-me",
      },
    },
    {
      id: "modify",
      type: "ai-modify",
      position: { x: 70, y: 80 },
      data: {
        kind: "ai-modify",
        label: "AI 改款",
        status: "success",
        prompt: "改成短款",
        aspectRatio: "3:4",
        batchSize: 1,
        outputImages: ["/api/files/modify-a.png"],
      },
    },
    {
      id: "fabric",
      type: "fabric-recolor",
      position: { x: 100, y: 110 },
      data: {
        kind: "fabric-recolor",
        label: "面料配色",
        status: "idle",
        colors: ["#112233", "#AABBCC"],
        prompt: "替换为冷色系",
        fabricImageUrl: "/api/files/fabric.png",
        outputImages: ["/api/files/fabric-a.png"],
        modelId: "flux-2-pro",
        modelOptions: {
          width: 1024,
          height: 1024,
          outputFormat: "jpeg",
          privateProviderFlag: true,
        },
      },
    },
    {
      id: "upscale",
      type: "upscale",
      position: { x: 130, y: 140 },
      data: {
        kind: "upscale",
        label: "高清放大",
        status: "error",
        error: "transient",
        imageSize: "4K",
        outputImages: ["/api/files/upscale-a.png"],
        modelId: "seedream-5-0-260128",
        modelOptions: { size: "4K", unknown: "drop-me" },
      },
    },
    {
      id: "extract",
      type: "print-extract",
      position: { x: 160, y: 170 },
      data: {
        kind: "print-extract",
        label: "印花提取",
        status: "outcome_unknown",
        prompt: "只提取胸前图案",
        outputImages: ["/api/files/extract-a.png"],
        savedAsAssets: ["/api/files/asset-a.png"],
        modelId: "grok-imagine-image",
        modelOptions: {
          aspectRatio: "1:1",
          resolution: "2k",
          unsupportedOption: "drop-me",
        },
      },
    },
    {
      id: "mutate",
      type: "print-mutate",
      position: { x: 190, y: 200 },
      data: {
        kind: "print-mutate",
        label: "印花裂变",
        status: "retry_wait",
        prompt: "水墨风格",
        count: 4,
        outputImages: ["/api/files/mutate-a.png"],
        modelId: "gpt-image-2-vip",
        modelOptions: { size: "2048x2048", unsupportedOption: "drop-me" },
      },
    },
    {
      id: "mask",
      type: "mask-redraw",
      position: { x: 220, y: 230 },
      data: {
        kind: "mask-redraw",
        label: "蒙版重绘",
        status: "cancel_requested",
        prompt: "袖口改成银色",
        mask: "/api/files/mask.png",
        maskSourceRef: "/api/files/source.png",
        maskMode: "replace",
        outputImages: ["/api/files/mask-a.png"],
        modelId: "gpt-image-2-vip",
        modelOptions: { size: "2048x2048", secret: true },
      },
    },
    {
      id: "result",
      type: "result",
      position: { x: 250, y: 260 },
      data: {
        kind: "result",
        label: "交付结果",
        status: "cancelled",
        error: "runtime-only",
        images: ["/api/files/final-a.png"],
        note: "客户已确认",
        compareIds: ["drop-me"],
      },
    },
  ],
  edges: [
    {
      id: "edge-with-handles",
      source: "upload",
      target: "sketch",
      sourceHandle: null,
      targetHandle: "image-input",
      selected: true,
      animated: true,
      data: { runId: "drop-me" },
      unknownEdge: "drop-me",
    },
    {
      id: "edge-without-handles",
      source: "sketch",
      target: "result",
      selected: false,
    },
  ],
} as unknown as Parameters<typeof createDocumentSnapshot>[0] & Record<string, unknown>;

const before = structuredClone(source);
const snapshot = createDocumentSnapshot(source);

assert.deepEqual(source, before, "创建快照不得改写 store 输入");
assert.deepEqual(snapshot, {
  projectName: "2027 春夏胶囊系列",
  nodes: [
    {
      id: "upload",
      type: "image-input",
      position: { x: 10, y: 20 },
      data: {
        kind: "image-input",
        label: "款式参考",
        imageRole: "garment",
        imageUrl: "/api/files/garment.png",
      },
    },
    {
      id: "sketch",
      type: "sketch-to-render",
      position: { x: 40, y: 50 },
      data: {
        kind: "sketch-to-render",
        label: "草图渲染",
        prompt: "轻薄风衣",
        aspectRatio: "16:9",
        batchSize: 2,
        outputImages: ["/api/files/sketch-a.png"],
        modelId: "gemini-3.1-flash-image",
        modelOptions: { aspectRatio: "16:9", imageSize: "4K" },
      },
    },
    {
      id: "modify",
      type: "ai-modify",
      position: { x: 70, y: 80 },
      data: {
        kind: "ai-modify",
        label: "AI 改款",
        prompt: "改成短款",
        aspectRatio: "3:4",
        batchSize: 1,
        outputImages: ["/api/files/modify-a.png"],
        modelId: "gpt-image-2-vip",
        modelOptions: { size: "1536x2048" },
      },
    },
    {
      id: "fabric",
      type: "fabric-recolor",
      position: { x: 100, y: 110 },
      data: {
        kind: "fabric-recolor",
        label: "面料配色",
        operationMode: "combined",
        colors: ["#112233", "#AABBCC"],
        prompt: "替换为冷色系",
        fabricImageUrl: "/api/files/fabric.png",
        outputImages: ["/api/files/fabric-a.png"],
        modelId: "flux-2-pro",
        modelOptions: { width: 1024, height: 1024, outputFormat: "jpeg" },
      },
    },
    {
      id: "upscale",
      type: "upscale",
      position: { x: 130, y: 140 },
      data: {
        kind: "upscale",
        label: "高清放大",
        imageSize: "4K",
        outputImages: ["/api/files/upscale-a.png"],
        modelId: "seedream-5-0-260128",
        modelOptions: { size: "2K" },
      },
    },
    {
      id: "extract",
      type: "print-extract",
      position: { x: 160, y: 170 },
      data: {
        kind: "print-extract",
        label: "印花提取",
        prompt: "只提取胸前图案",
        outputImages: ["/api/files/extract-a.png"],
        savedAsAssets: ["/api/files/asset-a.png"],
        modelId: "grok-imagine-image",
        modelOptions: { aspectRatio: "1:1", resolution: "2k" },
      },
    },
    {
      id: "mutate",
      type: "print-mutate",
      position: { x: 190, y: 200 },
      data: {
        kind: "print-mutate",
        label: "印花裂变",
        prompt: "水墨风格",
        count: 4,
        outputImages: ["/api/files/mutate-a.png"],
        modelId: "gpt-image-2-vip",
        modelOptions: { size: "2048x2048" },
      },
    },
    {
      id: "mask",
      type: "mask-redraw",
      position: { x: 220, y: 230 },
      data: {
        kind: "mask-redraw",
        label: "蒙版重绘",
        prompt: "袖口改成银色",
        mask: "/api/files/mask.png",
        maskSourceRef: "/api/files/source.png",
        outputImages: ["/api/files/mask-a.png"],
        modelId: "gpt-image-2",
        modelOptions: {},
      },
    },
    {
      id: "result",
      type: "result",
      position: { x: 250, y: 260 },
      data: {
        kind: "result",
        label: "交付结果",
        images: ["/api/files/final-a.png"],
        note: "客户已确认",
      },
    },
  ],
  edges: [
    {
      id: "edge-with-handles",
      source: "upload",
      target: "sketch",
      sourceHandle: null,
      targetHandle: null,
    },
    {
      id: "edge-without-handles",
      source: "sketch",
      target: "result",
    },
  ],
});

assert.deepEqual(Object.keys(snapshot), ["projectName", "nodes", "edges"]);
assert.deepEqual(Object.keys(snapshot.edges[1]), ["id", "source", "target"]);
assert.notStrictEqual(snapshot.nodes, source.nodes);
assert.notStrictEqual(snapshot.edges, source.edges);
assert.notStrictEqual(snapshot.nodes[0].position, source.nodes[0].position);
assert.notStrictEqual(snapshot.nodes[0].data, source.nodes[0].data);
assert.notStrictEqual(
  snapshot.nodes[1].data.kind === "sketch-to-render" && snapshot.nodes[1].data.outputImages,
  source.nodes[1].data.outputImages,
);
assert.notStrictEqual(
  snapshot.nodes[1].data.kind === "sketch-to-render" && snapshot.nodes[1].data.modelOptions,
  source.nodes[1].data.modelOptions,
);
assert.notStrictEqual(
  snapshot.nodes[3].data.kind === "fabric-recolor" && snapshot.nodes[3].data.colors,
  source.nodes[3].data.colors,
);

const wire = documentSnapshotToPersistedWorkflow(snapshot);
assert.equal(wire.schemaVersion, 6);
assert.deepEqual(wire.nodes, snapshot.nodes.map((node) => ({
  ...node,
  data: { ...node.data, status: "idle" },
})));
assert.deepEqual(wire.edges, snapshot.edges);
assert.notStrictEqual(wire.nodes, snapshot.nodes);
assert.notStrictEqual(wire.edges, snapshot.edges);
assert.notStrictEqual(wire.nodes[0].position, snapshot.nodes[0].position);
assert.notStrictEqual(wire.nodes[0].data, snapshot.nodes[0].data);
assert.notStrictEqual(
  wire.nodes[1].data.kind === "sketch-to-render" && wire.nodes[1].data.outputImages,
  snapshot.nodes[1].data.kind === "sketch-to-render" && snapshot.nodes[1].data.outputImages,
);
assert.notStrictEqual(
  wire.nodes[1].data.kind === "sketch-to-render" && wire.nodes[1].data.modelOptions,
  snapshot.nodes[1].data.kind === "sketch-to-render" && snapshot.nodes[1].data.modelOptions,
);

const v5Snapshot = createDocumentSnapshot({
  projectName: "v5 文档白名单",
  nodes: [
    { id: "text-v5", type: "text-input", position: { x: 0, y: 0 }, selected: true, data: { kind: "text-input", label: "说明", status: "running", text: "面料说明", editorSelection: [0, 2] } },
    { id: "board-v5", type: "drawing-board", position: { x: 100, y: 0 }, data: { kind: "drawing-board", label: "画板", status: "idle", boardVersion: 1, width: 1200, height: 900, background: "#FFFFFF", contentRef: "/api/drawings/content-1", previewImageRef: "/api/files/preview.png", exportImageRef: "/api/files/export.png", drawingRecoveryDraft: { private: true } } },
    { id: "palette-v5", type: "color-palette", position: { x: 200, y: 0 }, data: { kind: "color-palette", label: "色板", status: "idle", paletteVersion: 1, swatches: [{ id: "red", value: "#FF0000", name: "红色", source: "custom" }], recentColors: ["#000000"] } },
    { id: "approval-v5", type: "stage-approval", position: { x: 300, y: 0 }, data: { kind: "stage-approval", label: "确认基准", status: "success", approvalKind: "scene-baseline", approvedSourceNodeId: "stabilize-v5", approvedBaselineRef: "/api/files/baseline.png", approvedBasisRevision: 3, approvedAt: "2026-09-03T00:00:00.000Z", approvalDialogOpen: true } },
    { id: "stabilize-v5", type: "virtual-try-on", position: { x: 400, y: 0 }, data: { kind: "virtual-try-on", label: "第一轮", status: "idle", workflowStage: "scene-stabilize", prompt: "", modelId: "gemini-3.1-flash-image-preview", modelOptions: { aspectRatio: "3:4", imageSize: "2K" }, imageSize: "2K", basisRevision: 3, outputImages: ["/api/files/baseline.png"], displayState: "ready" } },
    { id: "fabric-v5", type: "fabric-recolor", position: { x: 500, y: 0 }, data: { kind: "fabric-recolor", label: "配色替换", status: "idle", operationMode: "color", colors: ["#FF0000"], prompt: "", outputImages: [], modelId: "gpt-image-2-vip", modelOptions: { size: "2048x2048" } } },
  ],
  edges: [
    { id: "board-approval-v5", source: "board-v5", sourceHandle: "image", target: "approval-v5", targetHandle: "baseline-candidate", connectionDraft: true },
    { id: "palette-fabric-v5", source: "palette-v5", sourceHandle: "colors", target: "fabric-v5", targetHandle: "palette" },
  ],
} as unknown as Parameters<typeof createDocumentSnapshot>[0]);

const v5Wire = documentSnapshotToPersistedWorkflow(v5Snapshot);
assert.equal(v5Wire.schemaVersion, 6);
assert.deepEqual(v5Snapshot.nodes.map((node) => node.data.kind), ["text-input", "drawing-board", "color-palette", "stage-approval", "virtual-try-on", "fabric-recolor"]);
assert.equal((v5Snapshot.nodes[0].data as Record<string, unknown>).editorSelection, undefined);
assert.equal((v5Snapshot.nodes[1].data as Record<string, unknown>).drawingRecoveryDraft, undefined);
assert.equal((v5Snapshot.nodes[2].data as Record<string, unknown>).recentColors, undefined);
assert.equal((v5Snapshot.nodes[3].data as Record<string, unknown>).approvalDialogOpen, undefined);
assert.equal((v5Snapshot.nodes[4].data as Record<string, unknown>).displayState, undefined);
assert.deepEqual(v5Wire.edges, [
  { id: "board-approval-v5", source: "board-v5", target: "approval-v5", sourceHandle: "image", targetHandle: "baseline-candidate" },
  { id: "palette-fabric-v5", source: "palette-v5", target: "fabric-v5", sourceHandle: "colors", targetHandle: "palette" },
]);

console.log("通过 1 项纯文档快照边界测试（覆盖 9 种节点）");

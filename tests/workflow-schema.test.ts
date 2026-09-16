import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { writeJsonAtomicSync } from "../server/lib/atomicJson";
import {
  assertUrlAllowed,
  downloadImageToDataUrl,
  ensureThumbnail,
  isGlobalIpAddress,
  type HostLookup,
  type ImageFetch,
} from "../server/lib/fileStore";
import {
  ImageValidationError,
  isLocalImageReference,
  validateImageDataUrl,
} from "../server/lib/imageValidation";
import { validateAndMigrateFlow, WorkflowValidationError } from "../server/lib/workflowSchema";
import { ensureBuiltinTemplates } from "../server/routes/templates";
import { DEFAULT_GENERATION_MODEL_ID, getImageModelContract, MASK_REDRAW_MODEL_ID } from "../src/types/imageModels";
import { WORKFLOW_SCHEMA_VERSION } from "../src/types/workflow";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString("base64")}`;
const MASK_CONTRACT = getImageModelContract(MASK_REDRAW_MODEL_ID).edit.mask;

if (!MASK_CONTRACT) throw new Error("gpt-image-2 mask contract missing");

async function halfEditablePng(
  width: number,
  height: number,
  uncompressed = false,
): Promise<{ buffer: Buffer; dataUrl: string }> {
  const pixels = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width / 2; x += 1) {
      pixels[(y * width + x) * 4 + 3] = 0;
    }
  }
  const image = sharp(pixels, { raw: { width, height, channels: 4 } });
  const buffer = uncompressed
    ? await image.png({ compressionLevel: 0 }).toBuffer()
    : await image.png().toBuffer();
  return { buffer, dataUrl: `data:image/png;base64,${buffer.toString("base64")}` };
}

function imageInputFlow(imageUrl: string) {
  return {
    schemaVersion: 2,
    nodes: [{
      id: "source",
      type: "image-input",
      position: { x: 0, y: 0 },
      data: {
        kind: "image-input",
        label: "原图",
        status: "idle",
        imageRole: "reference",
        imageUrl,
      },
    }],
    edges: [],
  };
}

function maskFlow(mask: string, maskSourceRef = PNG_DATA_URL, prompt = "局部改色") {
  return {
    schemaVersion: 2,
    nodes: [{
      id: "mask",
      type: "mask-redraw",
      position: { x: 0, y: 0 },
      data: {
        kind: "mask-redraw",
        label: "局部重绘",
        status: "idle",
        prompt,
        mask,
        maskSourceRef,
        outputImages: [],
        modelId: MASK_REDRAW_MODEL_ID,
        modelOptions: {},
      },
    }],
    edges: [],
  };
}

let passed = 0;
async function test(name: string, run: () => unknown | Promise<unknown>) {
  try {
    await run();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

const legacyAiFlow = () => ({
  nodes: [
    {
      id: "n1",
      type: "ai-modify",
      position: { x: 1, y: 2 },
      data: { kind: "ai-modify", label: "改款", status: "idle", prompt: "", outputImages: [] },
    },
  ],
  edges: [],
});

async function main() {
  console.log("工作流 Schema / 图片 / SSRF 回归测试");

  await test("v11 Preview 模型确定性迁移为正式模型并保留图片、参数和布局", () => {
    const legacy = {
      schemaVersion: 11,
      nodes: [{ id: "try-on", type: "virtual-try-on", position: { x: 23, y: 45 }, data: {
        kind: "virtual-try-on", label: "第一轮", status: "idle", workflowStage: "scene-stabilize",
        prompt: "保留细节", imageSize: "2K", aspectRatio: "3:4", basisRevision: 4,
        modelId: "gemini-3.1-flash-image-preview", modelOptions: { aspectRatio: "3:4", imageSize: "2K" },
        promptEnhancement: false, qualityMode: "fast", safetyFallback: false, stylePresetId: "faithful",
        outputImages: [PNG_DATA_URL],
      } }], edges: [],
    };
    const migrated = validateAndMigrateFlow(legacy);
    assert.equal(migrated.nodes[0].data.modelId, "gemini-3.1-flash-image");
    assert.deepEqual(migrated.nodes[0].position, legacy.nodes[0].position);
    assert.deepEqual(migrated.nodes[0].data.outputImages, [PNG_DATA_URL]);
    assert.deepEqual(migrated.nodes[0].data.modelOptions, legacy.nodes[0].data.modelOptions);
    assert.deepEqual(validateAndMigrateFlow(migrated), migrated);
    assert.throws(() => validateAndMigrateFlow({ ...legacy, schemaVersion: WORKFLOW_SCHEMA_VERSION }), /modelId/);
  });

  await test("v4 分步换装与配色节点确定性迁移到 v5 typed-port 文档", () => {
    const legacy = {
      schemaVersion: 4,
      nodes: [
        {
          id: "palette-source", type: "fabric-recolor", position: { x: 0, y: 0 },
          data: {
            kind: "fabric-recolor", label: "旧配色", status: "idle", colors: ["#112233"],
            prompt: "", outputImages: [], modelId: "gpt-image-2-vip",
            modelOptions: { size: "2048x2048" },
          },
        },
        {
          id: "stabilize", type: "virtual-try-on", position: { x: 300, y: 0 },
          data: {
            kind: "virtual-try-on", label: "第一轮", status: "idle", workflowStage: "scene-stabilize",
            prompt: "", imageSize: "2K", modelId: "gemini-3.1-flash-image",
            modelOptions: { aspectRatio: "3:4", imageSize: "2K" }, outputImages: [PNG_DATA_URL],
          },
        },
        {
          id: "refine", type: "virtual-try-on", position: { x: 700, y: 0 },
          data: {
            kind: "virtual-try-on", label: "第二轮", status: "idle", workflowStage: "garment-refine",
            prompt: "", imageSize: "2K", modelId: "gpt-image-2", modelOptions: { quality: "medium" },
            garmentCategory: "knit", materialSpec: "羊毛", constructionSpec: "12GG",
            approvedBaselineRef: PNG_DATA_URL,
            approvedAt: "2026-09-03T06:00:00.000Z",
            outputImages: [],
          },
        },
      ],
      edges: [{ id: "legacy-baseline", source: "stabilize", target: "refine", targetHandle: "baseline" }],
    };

    const migrated = validateAndMigrateFlow(legacy);
    assert.equal(migrated.schemaVersion, WORKFLOW_SCHEMA_VERSION);
    const fabric = migrated.nodes.find((node) => node.id === "palette-source")?.data;
    assert.equal(fabric?.kind === "fabric-recolor" && fabric.operationMode, "combined");
    const stabilize = migrated.nodes.find((node) => node.id === "stabilize")?.data;
    assert.equal(stabilize?.kind === "virtual-try-on" && stabilize.basisRevision, 0);
    const approval = migrated.nodes.find((node) => node.data.kind === "stage-approval");
    assert.ok(approval, "已确认的 v4 第二轮必须插入独立确认节点");
    assert.equal(approval.data.kind === "stage-approval" && approval.data.approvedSourceNodeId, "stabilize");
    assert.equal(approval.data.kind === "stage-approval" && approval.data.approvedBaselineRef, PNG_DATA_URL);
    assert.equal(approval.data.kind === "stage-approval" && approval.data.approvedBasisRevision, 0);
    assert.equal(
      approval.data.kind === "stage-approval" && approval.data.approvedAt,
      "2026-09-03T06:00:00.000Z",
      "迁移必须把完整确认事实转移到独立节点",
    );
    const migratedRefine = migrated.nodes.find((node) => node.id === "refine")?.data;
    assert.equal(migratedRefine?.kind === "virtual-try-on" && "approvedBaselineRef" in migratedRefine, false);
    assert.equal(migratedRefine?.kind === "virtual-try-on" && "approvedAt" in migratedRefine, false);
    assert.ok(migrated.edges.some((edge) => (
      edge.source === "stabilize" && edge.target === approval.id && edge.targetHandle === "baseline-candidate"
    )));
    assert.ok(migrated.edges.some((edge) => (
      edge.source === approval.id && edge.target === "refine" && edge.targetHandle === "baseline"
    )));
    assert.deepEqual(validateAndMigrateFlow(migrated), migrated, "重复读取不得重复插入确认节点");
  });

  await test("v9 VEO 视频节点确定迁移为 Seedance v11 契约", () => {
    const migrated = validateAndMigrateFlow({
      schemaVersion: 9,
      nodes: [{
        id: "video",
        type: "video-generate",
        position: { x: 0, y: 0 },
        data: {
          kind: "video-generate",
          label: "旧视频",
          status: "idle",
          mode: "keyframes-to-video",
          prompt: "转身展示",
          videoModel: "veo-3.1",
          quality: "standard",
          aspectRatio: "16:9",
          resolution: "4k",
          seconds: 8,
          outputImages: [],
        },
      }],
      edges: [],
    });
    const video = migrated.nodes[0].data;
    assert.equal(migrated.schemaVersion, WORKFLOW_SCHEMA_VERSION);
    assert.equal(video.kind, "video-generate");
    if (video.kind !== "video-generate") throw new Error("video migration failed");
    assert.equal(video.videoModel, "doubao-seedance-2-5-260628");
    assert.equal(video.aspectRatio, "adaptive");
    assert.equal(video.resolution, "1080p");
    assert.equal(video.seconds, 8);
    assert.equal(video.generateAudio, true);
    assert.equal(video.outputFormat, "mp4");
    assert.equal("quality" in video, false);
  });

  await test("v11 接受结果节点的稳定单图输出端口并拒绝越界视频参数", () => {
    const base = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes: [
        {
          id: "result", type: "result", position: { x: 0, y: 0 },
          data: { kind: "result", label: "结果", status: "success", images: [PNG_DATA_URL, PNG_DATA_URL] },
        },
        {
          id: "upscale", type: "upscale", position: { x: 380, y: 0 },
          data: {
            kind: "upscale", label: "放大", status: "idle", imageSize: "2K", outputImages: [],
            modelId: "gpt-image-2-vip", modelOptions: { size: "2048x2048" },
          },
        },
      ],
      edges: [{ id: "selected-image", source: "result", sourceHandle: "image:1", target: "upscale", targetHandle: "references" }],
    };
    assert.equal(validateAndMigrateFlow(base).edges[0].sourceHandle, "image:1");

    const invalidVideo = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes: [{
        id: "video", type: "video-generate", position: { x: 0, y: 0 },
        data: {
          kind: "video-generate", label: "视频", status: "idle", mode: "text-to-video", prompt: "展示",
          videoModel: "doubao-seedance-2-5-260628", aspectRatio: "16:9", resolution: "4k", seconds: 5,
          generateAudio: true, outputFormat: "mp4", outputImages: [],
        },
      }],
      edges: [],
    };
    assert.throws(() => validateAndMigrateFlow(invalidVideo), /resolution/);
  });

  await test("v7 接受新节点及合法 typed ports，并拒绝非法角色与类型组合", () => {
    const nodes = [
      {
        id: "text", type: "text-input", position: { x: 0, y: 0 },
        data: { kind: "text-input", label: "文本", status: "idle", text: "说明" },
      },
      {
        id: "board", type: "drawing-board", position: { x: 0, y: 100 },
        data: {
          kind: "drawing-board", label: "画板", status: "idle", boardVersion: 1,
          width: 1024, height: 1024, background: "#FFFFFF", previewImageRef: PNG_DATA_URL,
        },
      },
      {
        id: "palette", type: "color-palette", position: { x: 0, y: 200 },
        data: {
          kind: "color-palette", label: "色板", status: "idle", paletteVersion: 1,
          swatches: [{ id: "black", value: "#000000", source: "quick" }],
        },
      },
      {
        id: "approval", type: "stage-approval", position: { x: 400, y: 0 },
        data: { kind: "stage-approval", label: "确认", status: "idle", approvalKind: "scene-baseline" },
      },
      {
        id: "fabric", type: "fabric-recolor", position: { x: 400, y: 200 },
        data: {
          kind: "fabric-recolor", label: "配色替换", status: "idle", operationMode: "color",
          colors: [], prompt: "", outputImages: [], modelId: "gpt-image-2-vip",
          modelOptions: { size: "2048x2048" },
        },
      },
    ];
    const valid = validateAndMigrateFlow({
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes,
      edges: [
        { id: "board-approval", source: "board", sourceHandle: "image", target: "approval", targetHandle: "baseline-candidate" },
        { id: "palette-fabric", source: "palette", sourceHandle: "colors", target: "fabric", targetHandle: "palette" },
      ],
    });
    assert.equal(valid.nodes.length, 5);
    assert.equal(valid.edges.length, 2);

    assert.throws(() => validateAndMigrateFlow({
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes,
      edges: [{ id: "wrong-kind", source: "text", sourceHandle: "text", target: "fabric", targetHandle: "palette" }],
    }), /配色|palette|colors|类型/);
    assert.throws(() => validateAndMigrateFlow({
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes,
      edges: [{ id: "unknown-role", source: "board", target: "approval", targetHandle: "not-a-role" }],
    }), /角色|role|targetHandle/);
  });

  await test("无版本 v0 确定性迁移到 v7，并补模型默认字段", () => {
    const first = validateAndMigrateFlow(legacyAiFlow());
    const second = validateAndMigrateFlow(first);
    assert.equal(first.schemaVersion, WORKFLOW_SCHEMA_VERSION);
    assert.equal(first.nodes[0].data.kind, "ai-modify");
    if (first.nodes[0].data.kind !== "ai-modify") throw new Error("unexpected node kind");
    assert.equal(first.nodes[0].data.aspectRatio, "1:1");
    assert.equal(first.nodes[0].data.batchSize, 1);
    assert.equal(first.nodes[0].data.modelId, "gpt-image-2-vip");
    assert.deepEqual(first.nodes[0].data.modelOptions, { size: "2048x2048" });
    assert.deepEqual(second, first);
  });

  await test("v2 显式合法模型与参数不得被默认值替换", () => {
    const flow = { ...legacyAiFlow(), schemaVersion: 2 };
    Object.assign(flow.nodes[0].data, {
      aspectRatio: "16:9",
      batchSize: 1,
      modelId: "gemini-3.1-flash-image",
      modelOptions: { aspectRatio: "16:9", imageSize: "4K" },
    });

    const normalized = validateAndMigrateFlow(flow);
    const data = normalized.nodes[0].data;
    assert.equal(data.kind, "ai-modify");
    if (data.kind !== "ai-modify") throw new Error("unexpected node kind");
    assert.equal(data.modelId, "gemini-3.1-flash-image");
    assert.deepEqual(data.modelOptions, { aspectRatio: "16:9", imageSize: "4K" });
  });

  await test("虚拟模特换装仅接受指定模型、2K/4K 与最多 14 路参考图", () => {
    const flow = {
      schemaVersion: 3,
      nodes: [{
        id: "try-on",
        type: "virtual-try-on",
        position: { x: 300, y: 0 },
        data: {
          kind: "virtual-try-on",
          label: "虚拟模特换装",
          status: "idle",
          prompt: "保留模特背景",
          imageSize: "4K",
          modelId: "gemini-3.1-flash-image",
          modelOptions: { aspectRatio: "1:1", imageSize: "4K" },
          outputImages: [],
        },
      }],
      edges: [] as Array<{ id: string; source: string; target: string }>,
    };
    for (let index = 0; index < 14; index += 1) {
      flow.nodes.push({
        id: `try-on-ref-${index}`,
        type: "image-input",
        position: { x: 0, y: index * 20 },
        data: {
          kind: "image-input",
          label: `参考图 ${index + 1}`,
          status: "idle",
          imageRole: "reference",
        },
      } as never);
      flow.edges.push({ id: `try-on-edge-${index}`, source: `try-on-ref-${index}`, target: "try-on" });
    }
    const normalized = validateAndMigrateFlow(flow);
    assert.equal(normalized.edges.length, 14);
    assert.equal(normalized.nodes[0].data.kind, "virtual-try-on");
    assert.equal(normalized.nodes[0].data.kind === "virtual-try-on" && normalized.nodes[0].data.workflowStage, "standard");

    flow.nodes.push({
      id: "try-on-ref-14",
      type: "image-input",
      position: { x: 0, y: 300 },
      data: {
        kind: "image-input", label: "参考图 15", status: "idle", imageRole: "reference",
      },
    } as never);
    flow.edges.push({ id: "try-on-edge-14", source: "try-on-ref-14", target: "try-on" });
    assert.throws(
      () => validateAndMigrateFlow(flow),
      /参考图最多连接 14 个来源|accepts at most 14 incoming image connections/,
    );

    flow.edges.pop();
    flow.nodes.pop();
    flow.schemaVersion = 4;
    Object.assign(flow.nodes[0].data, { workflowStage: "standard" });
    flow.nodes[0].data.modelId = "gpt-image-2-vip";
    flow.nodes[0].data.modelOptions = { size: "2048x2048" };
    assert.throws(() => validateAndMigrateFlow(flow), /is not allowed for virtual-try-on/);
  });

  await test("双模型分步换装模板保存阶段、工艺字段与角色连线", () => {
    const normalized = validateAndMigrateFlow({
      schemaVersion: 4,
      nodes: [
        {
          id: "stabilize", type: "virtual-try-on", position: { x: 0, y: 0 },
          data: {
            kind: "virtual-try-on", label: "第一轮", status: "idle", workflowStage: "scene-stabilize",
            prompt: "", imageSize: "2K", modelId: "gemini-3.1-flash-image",
            modelOptions: { aspectRatio: "1:1", imageSize: "2K" }, outputImages: [],
          },
        },
        {
          id: "refine", type: "virtual-try-on", position: { x: 400, y: 0 },
          data: {
            kind: "virtual-try-on", label: "第二轮", status: "idle", workflowStage: "garment-refine",
            prompt: "", imageSize: "2K", modelId: "gpt-image-2", modelOptions: { quality: "medium" },
            garmentCategory: "knit", materialSpec: "", constructionSpec: "", outputImages: [],
          },
        },
      ],
      edges: [{ id: "baseline", source: "stabilize", target: "refine", targetHandle: "baseline" }],
    });
    const staged = normalized.nodes.filter((node) => node.data.kind === "virtual-try-on");
    assert.deepEqual(staged.map((node) => node.data.kind === "virtual-try-on" && node.data.workflowStage), [
      "scene-stabilize", "garment-refine",
    ]);
    const refine = staged[1].data;
    assert.equal(refine.kind, "virtual-try-on");
    if (refine.kind !== "virtual-try-on") throw new Error("unexpected node kind");
    assert.equal(refine.garmentCategory, "knit");
    assert.deepEqual(refine.modelOptions, { quality: "high" });
    assert.ok(normalized.edges.some((edge) => edge.target === "refine" && edge.targetHandle === "baseline"));

    const invalidFirstStage = structuredClone(normalized);
    const firstStageNode = invalidFirstStage.nodes.find((node) => node.id === "stabilize");
    if (!firstStageNode || firstStageNode.data.kind !== "virtual-try-on") throw new Error("missing first stage");
    firstStageNode.data.modelId = "gpt-image-2";
    assert.throws(
      () => validateAndMigrateFlow(invalidFirstStage),
      /scene-stabilize must use gemini-3\.1-flash-image/,
    );

    const invalidSecondStage = structuredClone(normalized);
    const secondStageNode = invalidSecondStage.nodes.find((node) => node.id === "refine");
    if (!secondStageNode || secondStageNode.data.kind !== "virtual-try-on") throw new Error("missing second stage");
    secondStageNode.data.modelId = "gemini-3.1-flash-image";
    secondStageNode.data.modelOptions = { aspectRatio: "1:1", imageSize: "2K" };
    assert.throws(
      () => validateAndMigrateFlow(invalidSecondStage),
      /garment-refine must use gpt-image-2/,
    );
  });

  await test("旧浏览器丢失阶段字段后按角色连线与固定模型安全恢复", () => {
    const inputNode = (id: string) => ({
      id,
      type: "image-input",
      position: { x: 0, y: 0 },
      data: { kind: "image-input", label: id, status: "idle", imageRole: "reference" },
    });
    const normalized = validateAndMigrateFlow({
      schemaVersion: 4,
      nodes: [
        inputNode("person"), inputNode("scene"), inputNode("outfit"), inputNode("accessory"),
        {
          ...inputNode("structure"),
          data: {
            kind: "image-input", label: "服装结构细节（可选）", status: "idle", imageRole: "garment",
          },
        },
        {
          id: "stabilize", type: "virtual-try-on", position: { x: 300, y: 0 },
          data: {
            kind: "virtual-try-on", label: "第一轮", status: "idle", workflowStage: "standard",
            prompt: "", imageSize: "2K", modelId: "gemini-3.1-flash-image",
            modelOptions: { aspectRatio: "1:1", imageSize: "2K" }, outputImages: [],
          },
        },
        {
          id: "refine", type: "virtual-try-on", position: { x: 600, y: 0 },
          data: {
            kind: "virtual-try-on", label: "第二轮", status: "idle",
            prompt: "", imageSize: "2K", modelId: "gpt-image-2",
            modelOptions: {}, outputImages: [],
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
    });
    const stages = normalized.nodes
      .filter((node) => node.data.kind === "virtual-try-on")
      .map((node) => node.data.kind === "virtual-try-on" && node.data.workflowStage);
    assert.deepEqual(stages, ["scene-stabilize", "garment-refine"]);
    assert.ok(!normalized.edges.some((edge) => edge.id === "stale-person-stage"));
    assert.equal(normalized.nodes.find((node) => node.id === "accessory")?.data.label, "鞋履参考图（可选）");
    assert.equal(normalized.nodes.find((node) => node.id === "structure")?.data.label, "包袋参考图（可选）");
    for (const nodeId of ["hat", "ring", "earrings", "bracelet"]) {
      assert.ok(normalized.nodes.some((node) => node.id === nodeId));
    }
    assert.ok(normalized.nodes.some((node) => node.id === "garment-detail"));
    assert.equal(normalized.edges.find((edge) => edge.id === "accessory-stage")?.targetHandle, "shoes");
    assert.equal(normalized.edges.find((edge) => edge.id === "structure-stabilize")?.targetHandle, "bag");
    assert.ok(normalized.edges.some((edge) => edge.id === "hat-stabilize" && edge.targetHandle === "hat"));
    assert.ok(normalized.edges.some((edge) => edge.id === "ring-stabilize" && edge.targetHandle === "ring"));
    assert.ok(normalized.edges.some((edge) => edge.id === "earrings-stabilize" && edge.targetHandle === "earrings"));
    assert.ok(normalized.edges.some((edge) => edge.id === "bracelet-stabilize" && edge.targetHandle === "bracelet"));
    assert.ok(!normalized.edges.some((edge) => edge.id === "structure-refine"));
    assert.ok(!normalized.edges.some((edge) => edge.id === "garment-detail-stabilize"));
    assert.ok(normalized.edges.some((edge) => edge.id === "garment-detail-refine" && edge.targetHandle === "detail"));
    assert.deepEqual(validateAndMigrateFlow(normalized), normalized);
  });

  await test("v2 蒙版节点迁移到统一局部修改并剥离旧处理模式", () => {
    const legacyMaskFlow = maskFlow(PNG_DATA_URL) as ReturnType<typeof maskFlow> & {
      nodes: Array<{ data: Record<string, unknown> }>;
    };
    legacyMaskFlow.nodes[0].data.maskMode = "preserve";
    const normalized = validateAndMigrateFlow(legacyMaskFlow);
    assert.equal(normalized.schemaVersion, WORKFLOW_SCHEMA_VERSION);
    assert.equal((normalized.nodes[0].data as Record<string, unknown>).maskMode, undefined);
  });

  await test("v8 局部修改迁移为必跑自定义精修并把首条输入标记为底图", () => {
    const legacy = maskFlow(PNG_DATA_URL) as ReturnType<typeof maskFlow> & {
      schemaVersion: number;
      nodes: Array<{ data: Record<string, unknown> }>;
      edges: Array<Record<string, unknown>>;
    };
    legacy.schemaVersion = 8;
    legacy.nodes.push({
      id: "source",
      type: "image-input",
      position: { x: -200, y: 0 },
      data: { kind: "image-input", label: "旧底图", status: "idle", imageRole: "reference", imageUrl: PNG_DATA_URL },
    } as never);
    legacy.edges.push({ id: "source-mask", source: "source", target: "mask", targetHandle: "references" });
    const migrated = validateAndMigrateFlow(legacy);
    const mask = migrated.nodes.find((node) => node.id === "mask");
    assert.equal(mask?.data.kind === "mask-redraw" && mask.data.repairFocus, "custom");
    assert.equal(mask?.data.kind === "mask-redraw" && mask.data.executionMode, "repair");
    assert.equal(migrated.edges[0].targetHandle, "repair-source");
    assert.deepEqual(validateAndMigrateFlow(migrated), migrated);
  });

  await test("v2 蒙版节点的 8 路历史输入可迁移、保存并再次读取", () => {
    const legacyMaskFlow = maskFlow(PNG_DATA_URL);
    for (let index = 0; index < 8; index += 1) {
      legacyMaskFlow.nodes.push({
        id: `legacy-ref-${index}`,
        type: "image-input",
        position: { x: -200, y: index * 80 },
        data: {
          kind: "image-input",
          label: `历史参考图 ${index + 1}`,
          status: "idle",
          imageRole: "reference",
          imageUrl: PNG_DATA_URL,
        },
      } as never);
      legacyMaskFlow.edges.push({
        id: `legacy-edge-${index}`,
        source: `legacy-ref-${index}`,
        target: "mask",
      } as never);
    }

    const migrated = validateAndMigrateFlow(legacyMaskFlow);
    assert.equal(migrated.schemaVersion, WORKFLOW_SCHEMA_VERSION);
    assert.equal(migrated.edges.length, 8);
    assert.deepEqual(validateAndMigrateFlow(migrated), migrated);
  });

  await test("v2 读取后只返回文档白名单，并把运行态归一为 idle", () => {
    const normalized = validateAndMigrateFlow({
      schemaVersion: 2,
      debugOnly: "must-not-survive",
      nodes: [
        {
          id: "n1",
          type: "ai-modify",
          position: { x: 1, y: 2, stalePositionField: true },
          selected: true,
          dragging: true,
          measured: { width: 320, height: 180 },
          width: 320,
          height: 180,
          unknownNodeField: "must-not-survive",
          data: {
            kind: "ai-modify",
            label: "改款",
            status: "success",
            error: "runtime-only",
            prompt: "保留版型",
            aspectRatio: "1:1",
            batchSize: 1,
            outputImages: [],
            modelId: "gpt-image-2-vip",
            modelOptions: { size: "2048x2048", unknownModelOption: "must-not-survive" },
            unknownDataField: "must-not-survive",
          },
        },
        {
          id: "n2",
          type: "result",
          position: { x: 420, y: 2 },
          data: {
            kind: "result",
            label: "结果",
            status: "idle",
            images: [],
          },
        },
      ],
      edges: [
        {
          id: "e1",
          source: "n1",
          target: "n2",
          sourceHandle: "images",
          targetHandle: null,
          selected: true,
          animated: true,
          unknownEdgeField: "must-not-survive",
        },
      ],
    });

    assert.deepEqual(normalized, {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes: [
        {
          id: "n1",
          type: "ai-modify",
          position: { x: 1, y: 2 },
          data: {
            kind: "ai-modify",
            label: "改款",
            status: "idle",
            prompt: "保留版型",
            aspectRatio: "1:1",
            batchSize: 1,
            outputImages: [],
            modelId: "gpt-image-2-vip",
            modelOptions: { size: "2048x2048" },
          },
        },
        {
          id: "n2",
          type: "result",
          position: { x: 420, y: 2 },
          data: {
            kind: "result",
            label: "结果",
            status: "idle",
            images: [],
          },
        },
      ],
      edges: [
        {
          id: "e1",
          source: "n1",
          target: "n2",
          sourceHandle: null,
          targetHandle: null,
        },
      ],
    });
  });

  await test("拒绝未知版本、kind/type 不符、非法批量与悬空边", () => {
    assert.throws(() => validateAndMigrateFlow({ ...legacyAiFlow(), schemaVersion: 99 }), WorkflowValidationError);
    const mismatch = legacyAiFlow();
    mismatch.nodes[0].data.kind = "result" as "ai-modify";
    assert.throws(() => validateAndMigrateFlow(mismatch), /must equal node type/);
    const batch = legacyAiFlow();
    Object.assign(batch.nodes[0].data, { batchSize: 3 });
    assert.throws(() => validateAndMigrateFlow(batch), /batchSize/);
    const invalidModelOptions = { ...legacyAiFlow(), schemaVersion: 4 };
    Object.assign(invalidModelOptions.nodes[0].data, {
      aspectRatio: "1:1",
      batchSize: 1,
      modelId: "gpt-image-2-vip",
      modelOptions: { size: "unsupported-size", unknownModelOption: true },
    });
    assert.throws(() => validateAndMigrateFlow(invalidModelOptions), /modelOptions/);
    const dangling = legacyAiFlow();
    dangling.edges.push({ id: "e1", source: "n1", target: "missing" } as never);
    assert.throws(() => validateAndMigrateFlow(dangling), /target not found/);
    const spoofedImage = legacyAiFlow();
    Object.assign(spoofedImage.nodes[0].data, {
      outputImages: [`data:image/jpeg;base64,${PNG.toString("base64")}`],
    });
    assert.throws(() => validateAndMigrateFlow(spoofedImage), /MIME\/signature mismatch/);
  });

  await test("运行态不会写进项目：queued/running/error 读取时归一为 idle", () => {
    for (const status of ["queued", "running", "error"] as const) {
      const flow = legacyAiFlow();
      Object.assign(flow.nodes[0].data, { status, error: "transient failure" });
      const normalized = validateAndMigrateFlow(flow);
      assert.equal(normalized.nodes[0].data.status, "idle");
      assert.equal(normalized.nodes[0].data.error, undefined);
    }
  });

  await test("工作流 Schema 拒绝超过节点上限的参考图连接", () => {
    const flow = legacyAiFlow();
    for (let index = 0; index < 9; index += 1) {
      flow.nodes.push({
        id: `ref${index}`,
        type: "image-input",
        position: { x: 0, y: index * 10 },
        data: {
          kind: "image-input",
          label: `ref${index}`,
          status: "idle",
          imageRole: "reference",
        },
      } as never);
      flow.edges.push({ id: `e${index}`, source: `ref${index}`, target: "n1" } as never);
    }
    assert.throws(
      () => validateAndMigrateFlow(flow),
      /参考图最多连接 8 个来源|accepts at most 8 incoming image connections/,
    );
  });

  await test("图片上传节点只接受单个 imageUrl 字段", () => {
    const flow = {
      nodes: [{
        id: "upload",
        type: "image-input",
        position: { x: 0, y: 0 },
        data: {
          kind: "image-input",
          label: "单图上传",
          status: "idle",
          imageRole: "reference",
          imageUrl: ["/api/files/one.png", "/api/files/two.png"],
        },
      }],
      edges: [],
    };
    assert.throws(() => validateAndMigrateFlow(flow), /imageUrl/);
  });

  await test("v7 校验并持久化图片自动连接目标，v6 节点默认不启用", () => {
    const v6 = imageInputFlow("/api/files/source.png");
    v6.schemaVersion = 6;
    const migrated = validateAndMigrateFlow(v6);
    assert.equal(migrated.schemaVersion, WORKFLOW_SCHEMA_VERSION);
    assert.equal(migrated.nodes[0].data.kind, "image-input");
    if (migrated.nodes[0].data.kind !== "image-input") throw new Error("unexpected node kind");
    assert.equal(migrated.nodes[0].data.autoConnectTargets, undefined);

    const current = imageInputFlow("/api/files/source.png") as ReturnType<typeof imageInputFlow> & {
      nodes: Array<{ data: Record<string, unknown> }>;
    };
    current.schemaVersion = WORKFLOW_SCHEMA_VERSION;
    current.nodes[0].data.autoConnectTargets = [
      { targetNodeId: "stabilize", targetHandle: "person" },
    ];
    const validated = validateAndMigrateFlow(current);
    assert.deepEqual(
      validated.nodes[0].data.kind === "image-input" && validated.nodes[0].data.autoConnectTargets,
      [{ targetNodeId: "stabilize", targetHandle: "person" }],
    );

    current.nodes[0].data.autoConnectTargets = [
      { targetNodeId: "stabilize", targetHandle: "person" },
      { targetNodeId: "stabilize", targetHandle: "person" },
    ];
    assert.throws(() => validateAndMigrateFlow(current), /duplicate/);
    current.nodes[0].data.autoConnectTargets = [{ targetNodeId: "stabilize", targetHandle: "unknown" }];
    assert.throws(() => validateAndMigrateFlow(current), /targetHandle/);
  });

  await test("大于文本上限但小于图片字节上限的 dataURL 可用于通用图片与蒙版", async () => {
    const largePng = await halfEditablePng(128, 128, true);
    assert.ok(largePng.dataUrl.length > 20_000, "fixture 必须超过普通文本上限");
    assert.ok(largePng.buffer.length < MASK_CONTRACT.maxBytes, "fixture 必须低于蒙版字节上限");

    const imageFlow = validateAndMigrateFlow(imageInputFlow(largePng.dataUrl));
    assert.equal(imageFlow.nodes[0].data.kind, "image-input");
    if (imageFlow.nodes[0].data.kind !== "image-input") throw new Error("unexpected node kind");
    assert.equal(imageFlow.nodes[0].data.imageUrl, largePng.dataUrl);

    const redrawFlow = validateAndMigrateFlow(maskFlow(largePng.dataUrl, largePng.dataUrl));
    assert.equal(redrawFlow.nodes[0].data.kind, "mask-redraw");
    if (redrawFlow.nodes[0].data.kind !== "mask-redraw") throw new Error("unexpected node kind");
    assert.equal(redrawFlow.nodes[0].data.mask, largePng.dataUrl);
    assert.equal(redrawFlow.nodes[0].data.maskSourceRef, largePng.dataUrl);
  });

  await test("蒙版 schema 按契约拒绝非 PNG 与解码后超过 4MiB 的 dataURL", async () => {
    const jpeg = await sharp({
      create: { width: 4, height: 2, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).jpeg().toBuffer();
    assert.throws(
      () => validateAndMigrateFlow(maskFlow(`data:image/jpeg;base64,${jpeg.toString("base64")}`)),
      /dataURL MIME must be one of: image\/png/,
    );

    const oversized = await halfEditablePng(1024, 1024, true);
    assert.ok(oversized.buffer.length > MASK_CONTRACT.maxBytes, "fixture 必须超过蒙版字节上限");
    assert.throws(() => validateAndMigrateFlow(maskFlow(oversized.dataUrl)), /image too large/);

    const localMask = validateAndMigrateFlow(maskFlow("/api/files/mask.png"));
    assert.equal(localMask.nodes[0].data.kind, "mask-redraw");
    if (localMask.nodes[0].data.kind !== "mask-redraw") throw new Error("unexpected node kind");
    assert.equal(localMask.nodes[0].data.mask, "/api/files/mask.png");

    for (const invalidMask of ["/api/files/mask.jpg", "https://example.com/mask.png"]) {
      assert.throws(
        () => validateAndMigrateFlow(maskFlow(invalidMask)),
        /mask: must be an inline PNG dataURL or local \/api\/files\/\*\.png reference/,
      );
    }
  });

  await test("普通文本与非 dataURL 图片引用仍保留 20,000 字符上限", () => {
    const promptFlow = legacyAiFlow();
    promptFlow.nodes[0].data.prompt = "x".repeat(20_001);
    assert.throws(() => validateAndMigrateFlow(promptFlow), /prompt: must be at most 20000 characters/);

    const longUrl = `https://example.com/${"x".repeat(20_001)}`;
    assert.throws(() => validateAndMigrateFlow(imageInputFlow(longUrl)), /imageUrl: must be at most 20000 characters/);
  });

  await test("干净检出也可迁移旧项目，并校验仓库内置模板", () => {
    // 不依赖被 .gitignore 排除的 data/projects；旧项目夹具必须由测试自己提供。
    const legacyProject = {
      id: "legacy-project",
      name: "旧项目",
      updatedAt: "2026-01-01T00:00:00.000Z",
      flow: legacyAiFlow(),
    };
    assert.equal(validateAndMigrateFlow(legacyProject.flow).schemaVersion, WORKFLOW_SCHEMA_VERSION);

    // Inspect the templates initialized for this test run, not another checkout's runtime data.
    const builtinRoot = path.join(process.env.DATA_DIR ?? "data", "templates", "builtin");
    const builtinFiles = fs.readdirSync(builtinRoot).filter((name) => name.endsWith(".json"));
    assert.ok(builtinFiles.length >= 7, "仓库应包含基础内置模板");
    for (const file of builtinFiles) {
      const value = JSON.parse(fs.readFileSync(path.join(builtinRoot, file), "utf-8")) as { flow: unknown };
      assert.equal(validateAndMigrateFlow(value.flow).schemaVersion, WORKFLOW_SCHEMA_VERSION, `${builtinRoot}/${file}`);
    }
    for (const [file, expected] of [
      ["builtin-person-scene-transfer.json", ["subject", "scene"]],
      ["builtin-pattern-style-transfer.json", ["pattern", "style"]],
    ] as const) {
      const transfer = JSON.parse(fs.readFileSync(path.join(builtinRoot, file), "utf-8")) as {
        flow: { edges: Array<{ source: string; target: string }> };
      };
      assert.deepEqual(
        transfer.flow.edges.filter((edge) => edge.target === "transfer").map((edge) => edge.source),
        expected,
        `${file} 必须按图1、图2顺序传入参考图`,
      );
    }
    const textToImage = JSON.parse(
      fs.readFileSync(path.join(builtinRoot, "builtin-text-to-image.json"), "utf-8"),
    ) as { flow: { nodes: Array<{ id: string; data: { prompt?: string } }>; edges: unknown[] } };
    const generateNode = textToImage.flow.nodes.find((node) => node.id === "generate");
    assert.ok(generateNode?.data.prompt?.trim(), "文生图模板必须提供可编辑的示例提示词");
    assert.equal(textToImage.flow.edges.length, 1, "文生图结果应自动汇总到结果节点");

    const stagedTryOn = JSON.parse(
      fs.readFileSync(path.join(builtinRoot, "builtin-tool-one-click-try-on.json"), "utf-8"),
    ) as {
      schemaVersion: number;
      id: string;
      builtIn: boolean;
      ownerId?: string;
      flow: {
        schemaVersion: number;
        nodes: Array<{ id: string; type: string; data: Record<string, unknown> }>;
        edges: Array<{ source: string; target: string; sourceHandle?: string; targetHandle?: string }>;
      };
    };
    assert.equal(stagedTryOn.schemaVersion, WORKFLOW_SCHEMA_VERSION);
    assert.equal(stagedTryOn.id, "builtin-tool-one-click-try-on");
    assert.equal(stagedTryOn.builtIn, true);
    assert.equal(stagedTryOn.ownerId, undefined);
    assert.equal(stagedTryOn.flow.schemaVersion, WORKFLOW_SCHEMA_VERSION);
    assert.equal(stagedTryOn.flow.nodes.find((node) => node.id === "stabilize")?.data.modelId, "gemini-3.1-flash-image");
    assert.equal(stagedTryOn.flow.nodes.find((node) => node.id === "refine")?.data.modelId, "gpt-image-2");
    assert.equal(stagedTryOn.flow.nodes.find((node) => node.id === "approval")?.type, "stage-approval");
    assert.equal(stagedTryOn.flow.nodes.length, 23);
    assert.equal(stagedTryOn.flow.nodes.find((node) => node.id === "scene")?.data.label, "场景参考图（必需）");
    assert.equal(stagedTryOn.flow.nodes.find((node) => node.id === "pose")?.data.label, "人物姿势参考图（必需）");
    assert.equal(stagedTryOn.flow.nodes.find((node) => node.id === "socks")?.data.label, "袜子参考图（可选）");
    assert.equal(stagedTryOn.flow.edges.length, 3, "图片连接必须在赋值后创建，第二轮结果固定连接局部重绘");
    assert.equal(stagedTryOn.flow.edges.some((edge) => edge.target === "stabilize" && edge.source !== "approval"), false);
    assert.ok(stagedTryOn.flow.edges.some((edge) => (
      edge.source === "stabilize" && edge.target === "approval" &&
      edge.sourceHandle === "image" && edge.targetHandle === "baseline-candidate"
    )));
    assert.ok(stagedTryOn.flow.edges.some((edge) => (
      edge.source === "approval" && edge.target === "refine" &&
      edge.sourceHandle === "image" && edge.targetHandle === "baseline"
    )));
    const targetsFor = (nodeId: string) => (
      stagedTryOn.flow.nodes.find((node) => node.id === nodeId)?.data.autoConnectTargets
    );
    assert.deepEqual(targetsFor("person"), [{ targetNodeId: "stabilize", targetHandle: "person" }]);
    assert.deepEqual(targetsFor("identity-secondary-1"), [{ targetNodeId: "stabilize", targetHandle: "person" }]);
    assert.deepEqual(targetsFor("identity-secondary-2"), [{ targetNodeId: "stabilize", targetHandle: "person" }]);
    assert.deepEqual(targetsFor("scene"), [{ targetNodeId: "stabilize", targetHandle: "scene" }]);
    assert.deepEqual(targetsFor("pose"), [{ targetNodeId: "stabilize", targetHandle: "pose" }]);
    assert.deepEqual(targetsFor("outfit"), [
      { targetNodeId: "stabilize", targetHandle: "outfit" },
      { targetNodeId: "refine", targetHandle: "outfit" },
      { targetNodeId: "garment-detail", targetHandle: "references" },
    ]);
    for (const role of ["bag", "shoes", "socks", "hat", "ring", "earrings", "bracelet"]) {
      assert.deepEqual(targetsFor(role), [{ targetNodeId: "stabilize", targetHandle: role }]);
    }
    for (const role of ["eyewear", "neckwear", "belt", "watch"]) {
      assert.equal(targetsFor(role), undefined);
    }
    assert.deepEqual(targetsFor("material"), [
      { targetNodeId: "refine", targetHandle: "material" },
      { targetNodeId: "garment-detail", targetHandle: "references" },
    ]);
    for (const nodeId of ["stabilize", "refine"]) {
      const data = stagedTryOn.flow.nodes.find((node) => node.id === nodeId)?.data;
      assert.equal(data?.qualityMode, "best");
      assert.equal(data?.promptEnhancement, true);
      assert.equal(data?.safetyFallback, true);
      assert.equal(data?.stylePresetId, "faithful");
    }
    assert.deepEqual(
      stagedTryOn.flow.edges.filter((edge) => edge.targetHandle === "repair-source").map((edge) => `${edge.source}:${edge.target}`),
      ["refine:garment-detail"],
    );
    const localRedraw = stagedTryOn.flow.nodes.find((node) => node.id === "garment-detail");
    assert.equal(localRedraw?.type, "mask-redraw");
    assert.equal(localRedraw?.data.modelId, "gpt-image-2");
    assert.equal(localRedraw?.data.repairFocus, "custom");
    assert.equal(localRedraw?.data.executionMode, "repair");
    for (const deletedNodeId of ["upper-repair", "pants-repair", "accessory-repair", "logo-correct"]) {
      assert.equal(stagedTryOn.flow.nodes.some((node) => node.id === deletedNodeId), false);
    }
    for (const node of stagedTryOn.flow.nodes) {
      assert.equal("imageUrl" in node.data, false, `${node.id} 不得保存真实输入图`);
      assert.equal("approvedBaselineRef" in node.data, false, `${node.id} 不得保存审批事实`);
    }
  });

  await test("已有数据目录保留可迁移的 v1 内置模板并增量补齐缺失模板", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-templates-"));
    const originalDataDir = process.env.DATA_DIR;
    try {
      process.env.DATA_DIR = dir;
      ensureBuiltinTemplates();
      const builtinDir = path.join(dir, "templates", "builtin");
      const existingPath = path.join(builtinDir, "builtin-sketch-recolor.json");
      const stagedPath = path.join(builtinDir, "builtin-tool-one-click-try-on.json");
      const staged = JSON.parse(fs.readFileSync(stagedPath, "utf-8")) as { flow: { nodes: Array<{ id: string }> } };
      staged.flow.nodes = staged.flow.nodes.filter((node) => node.id !== "socks");
      fs.writeFileSync(stagedPath, JSON.stringify(staged, null, 2), "utf-8");
      ensureBuiltinTemplates();
      const refreshedStaged = JSON.parse(fs.readFileSync(stagedPath, "utf-8")) as { flow: { nodes: Array<{ id: string }> } };
      assert.ok(refreshedStaged.flow.nodes.some((node) => node.id === "socks"), "已有一键换装模板应补齐袜子参考图节点");
      const existing = JSON.parse(fs.readFileSync(existingPath, "utf-8")) as {
        schemaVersion: number;
        description: string;
        flow: {
          schemaVersion: number;
          nodes: Array<{ data: Record<string, unknown> }>;
        };
      };
      existing.schemaVersion = 1;
      existing.flow.schemaVersion = 1;
      existing.description = "preserve-existing-v1";
      for (const node of existing.flow.nodes) {
        delete node.data.modelId;
        delete node.data.modelOptions;
      }
      const existingJson = JSON.stringify(existing, null, 2);
      fs.writeFileSync(existingPath, existingJson, "utf-8");
      for (const file of fs.readdirSync(builtinDir)) {
        if (file !== path.basename(existingPath)) fs.rmSync(path.join(builtinDir, file));
      }
      fs.writeFileSync(path.join(builtinDir, "builtin-style-transfer.json"), "deprecated", "utf-8");
      fs.writeFileSync(path.join(builtinDir, "builtin-dual-model-staged-try-on.json"), "deprecated", "utf-8");
      fs.writeFileSync(path.join(builtinDir, "builtin-tool-color-replace.json"), "deprecated", "utf-8");

      ensureBuiltinTemplates();

      assert.equal(fs.readFileSync(existingPath, "utf-8"), existingJson);
      assert.equal(fs.existsSync(path.join(builtinDir, "builtin-style-transfer.json")), false);
      assert.equal(fs.existsSync(path.join(builtinDir, "builtin-dual-model-staged-try-on.json")), false);
      assert.equal(fs.existsSync(path.join(builtinDir, "builtin-tool-color-replace.json")), false);
      const refreshedFiles = fs.readdirSync(builtinDir).filter((name) => name.endsWith(".json")).sort();
      assert.equal(refreshedFiles.length, 21);
      for (const required of [
        "builtin-sketch-recolor.json",
        "builtin-tool-one-click-try-on.json",
        "builtin-tool-text-to-video.json",
        "builtin-tool-first-frame-to-video.json",
        "builtin-tool-multimodal-reference.json",
        "builtin-tool-video-edit.json",
        "builtin-tool-video-extend.json",
      ]) assert.ok(refreshedFiles.includes(required), required);
    } finally {
      if (originalDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = originalDataDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("工作树遗留模板恢复完整流程，补齐 AI 搭配并保留现有换装参数与用户模板", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garment-template-recovery-"));
    const originalDataDir = process.env.DATA_DIR;
    try {
      process.env.DATA_DIR = dir;
      ensureBuiltinTemplates();
      const builtinDir = path.join(dir, "templates", "builtin");
      const fixtureDir = new URL("./fixtures/legacy-builtin-templates/", import.meta.url);
      for (const file of fs.readdirSync(fixtureDir)) {
        fs.copyFileSync(new URL(file, fixtureDir), path.join(builtinDir, file));
      }
      fs.rmSync(path.join(builtinDir, "builtin-tool-ai-styling.json"));
      const tryOnPath = path.join(builtinDir, "builtin-tool-one-click-try-on.json");
      const tryOn = JSON.parse(fs.readFileSync(tryOnPath, "utf8"));
      for (const node of tryOn.flow.nodes) {
        if (["refine", "garment-detail"].includes(node.id)) {
          node.data.modelId = "gpt-image-2.5-sunburst";
          node.data.modelOptions = { quality: "high" };
        }
      }
      const tryOnJson = JSON.stringify(tryOn);
      fs.writeFileSync(tryOnPath, tryOnJson);
      const userDir = path.join(dir, "templates", "user");
      fs.mkdirSync(userDir, { recursive: true });
      const userPath = path.join(userDir, "saved-sketch.json");
      const legacy = fs.readFileSync(new URL("builtin-sketch-recolor.json", fixtureDir), "utf8");
      fs.writeFileSync(userPath, legacy);

      ensureBuiltinTemplates();

      for (const id of ["builtin-sketch-recolor", "builtin-sketch-upscale", "builtin-tool-sketch-render"]) {
        const template = JSON.parse(fs.readFileSync(path.join(builtinDir, `${id}.json`), "utf8"));
        const flow = validateAndMigrateFlow(template.flow);
        const input = flow.nodes.find((node) => node.type === "image-input")!;
        const optimize = flow.nodes.find((node) => node.type === "sketch-optimize")!;
        const render = flow.nodes.find((node) => node.type === "sketch-to-render")!;
        assert.ok(optimize, `${id} must restore sketch optimization`);
        assert.ok(flow.edges.some((edge) => edge.source === input.id && edge.target === optimize.id));
        assert.ok(flow.edges.some((edge) => edge.source === optimize.id && edge.target === render.id));
        assert.ok(!flow.edges.some((edge) => edge.source === input.id && edge.target === render.id));
      }
      const styling = JSON.parse(fs.readFileSync(path.join(builtinDir, "builtin-tool-ai-styling.json"), "utf8"));
      const stylingFlow = validateAndMigrateFlow(styling.flow);
      assert.deepEqual(stylingFlow.nodes.map((node) => node.type), ["outfit-reference", "ai-styling", "result"]);
      assert.deepEqual(stylingFlow.edges.map((edge) => [edge.source, edge.target]), [["reference", "styling"], ["styling", "result"]]);
      const fabric = JSON.parse(fs.readFileSync(path.join(builtinDir, "builtin-tool-fabric-replace.json"), "utf8"));
      assert.equal(fabric.schemaVersion, WORKFLOW_SCHEMA_VERSION);
      assert.equal(fabric.flow.nodes.find((node: { id: string }) => node.id === "generate").data.modelId, DEFAULT_GENERATION_MODEL_ID);
      assert.equal(fs.readFileSync(tryOnPath, "utf8"), tryOnJson);
      assert.equal(fs.readFileSync(userPath, "utf8"), legacy);
      const before = fs.readdirSync(builtinDir).sort().map((file) => fs.readFileSync(path.join(builtinDir, file), "utf8"));
      ensureBuiltinTemplates();
      assert.deepEqual(fs.readdirSync(builtinDir).sort().map((file) => fs.readFileSync(path.join(builtinDir, file), "utf8")), before);
    } finally {
      if (originalDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = originalDataDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("历史 v2 内置模板缺少模型字段时会被当前合法定义修复", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-v2-template-upgrade-"));
    const originalDataDir = process.env.DATA_DIR;
    try {
      process.env.DATA_DIR = dir;
      ensureBuiltinTemplates();
      const filePath = path.join(dir, "templates", "builtin", "builtin-sketch-upscale.json");
      const broken = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
        flow: { nodes: Array<{ data: Record<string, unknown> }> };
      };
      for (const node of broken.flow.nodes) {
        delete node.data.modelId;
        delete node.data.modelOptions;
      }
      fs.writeFileSync(filePath, JSON.stringify(broken, null, 2), "utf-8");

      ensureBuiltinTemplates();

      const repaired = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
        schemaVersion: unknown;
        flow: { nodes: Array<{ type: string; data: Record<string, unknown> }> };
      };
      assert.equal(repaired.schemaVersion, WORKFLOW_SCHEMA_VERSION);
      assert.equal(validateAndMigrateFlow(repaired.flow).schemaVersion, WORKFLOW_SCHEMA_VERSION);
      for (const node of repaired.flow.nodes.filter((candidate) => candidate.type !== "image-input")) {
        assert.equal(typeof node.data.modelId, "string", `${node.type} 应补 modelId`);
        assert.equal(typeof node.data.modelOptions, "object", `${node.type} 应补 modelOptions`);
      }
    } finally {
      if (originalDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = originalDataDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("全新空数据目录生成的 v11 内置模板均可读取和校验", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-fresh-templates-"));
    const originalDataDir = process.env.DATA_DIR;
    try {
      process.env.DATA_DIR = dir;
      ensureBuiltinTemplates();

      const builtinDir = path.join(dir, "templates", "builtin");
      const files = fs.readdirSync(builtinDir).filter((name) => name.endsWith(".json")).sort();
      assert.equal(files.length, 21);
      assert.equal(files.includes("builtin-tool-color-replace.json"), false);
      for (const file of files) {
        const template = JSON.parse(fs.readFileSync(path.join(builtinDir, file), "utf-8")) as {
          schemaVersion: unknown;
          flow: unknown;
        };
        assert.equal(template.schemaVersion, WORKFLOW_SCHEMA_VERSION, file);
        assert.equal(validateAndMigrateFlow(template.flow).schemaVersion, WORKFLOW_SCHEMA_VERSION, file);
      }
    } finally {
      if (originalDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = originalDataDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("图片 dataURL 校验 MIME、魔数、base64 和体积", () => {
    const parsed = validateImageDataUrl(PNG_DATA_URL);
    assert.equal(parsed.mime, "image/png");
    assert.deepEqual(parsed.buffer, PNG);
    assert.deepEqual(validateImageDataUrl(PNG_DATA_URL, PNG.length).buffer, PNG);
    assert.throws(() => validateImageDataUrl(`data:image/jpeg;base64,${PNG.toString("base64")}`), /mismatch/);
    assert.throws(() => validateImageDataUrl("data:image/png;base64,abc$"), ImageValidationError);
    assert.throws(() => validateImageDataUrl(PNG_DATA_URL, PNG.length - 1), /too large/);
    assert.equal(isLocalImageReference("/api/files/abc_12-x.png"), true);
    assert.equal(isLocalImageReference("https://example.com/a.png"), false);
    assert.equal(isLocalImageReference("/api/files/../secret.png"), false);
  });

  await test("原子 JSON 写入留下完整目标且无临时文件", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-json-"));
    try {
      const target = path.join(dir, "project.json");
      writeJsonAtomicSync(target, { version: 1 });
      writeJsonAtomicSync(target, { version: 2, nested: { ok: true } });
      assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf-8")), { version: 2, nested: { ok: true } });
      assert.deepEqual(fs.readdirSync(dir), ["project.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("服务端为原图生成可复用 WebP 缩略图缓存", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-thumbnails-"));
    const originalDataDir = process.env.DATA_DIR;
    try {
      process.env.DATA_DIR = dir;
      const uploads = path.join(dir, "uploads");
      fs.mkdirSync(uploads, { recursive: true });
      fs.writeFileSync(path.join(uploads, "source.png"), PNG);
      const first = await ensureThumbnail("source.png");
      const second = await ensureThumbnail("source.png");
      assert.equal(first, second);
      const bytes = fs.readFileSync(first);
      assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
      assert.equal(bytes.subarray(8, 12).toString("ascii"), "WEBP");
    } finally {
      if (originalDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = originalDataDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("缩略图拒绝超过四千万像素的输入且不留下临时文件", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-thumbnail-limit-"));
    const originalDataDir = process.env.DATA_DIR;
    try {
      process.env.DATA_DIR = dir;
      const uploads = path.join(dir, "uploads");
      fs.mkdirSync(uploads, { recursive: true });
      const oversizedPng = Buffer.from(PNG);
      oversizedPng.writeUInt32BE(10_000, 16);
      oversizedPng.writeUInt32BE(5_000, 20);
      fs.writeFileSync(path.join(uploads, "oversized.png"), oversizedPng);

      await assert.rejects(() => ensureThumbnail("oversized.png"), /pixel limit/i);
      assert.deepEqual(fs.readdirSync(path.join(dir, "thumbnails")), []);
    } finally {
      if (originalDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = originalDataDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("IP 分类拒绝内网、回环、链路本地、ULA 和 IPv4-mapped", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "::1", "fe80::1", "fd00::1", "::192.168.1.1", "::ffff:127.0.0.1", "::ffff:7f00:1", "2002:c0a8:101::"]) {
      assert.equal(isGlobalIpAddress(address), false, address);
    }
    assert.equal(isGlobalIpAddress("8.8.8.8"), true);
    assert.equal(isGlobalIpAddress("2606:4700:4700::1111"), true);
  });

  await test("域名任一 DNS 地址非 global 即阻断", async () => {
    await assert.rejects(
      () => assertUrlAllowed("https://images.example/a.png", async () => ["93.184.216.34", "192.168.1.2"]),
      /blocked non-global/,
    );
    const allowed = await assertUrlAllowed("https://images.example/a.png", async () => ["93.184.216.34"]);
    assert.equal(allowed.hostname, "images.example");
  });

  await test("手动重定向在请求下一跳前重新解析并阻断私网", async () => {
    const calls: string[] = [];
    const lookup: HostLookup = async (host) => host === "public.example" ? ["93.184.216.34"] : ["192.168.1.1"];
    const fetcher: ImageFetch = async (input, init) => {
      calls.push(String(input));
      assert.equal(init?.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: "http://nas.internal/photo.png" } });
    };
    await assert.rejects(
      () => downloadImageToDataUrl("https://public.example/photo.png", { lookup, fetch: fetcher }),
      /private\/metadata|non-global/,
    );
    assert.equal(calls.length, 1, "私网重定向目标不应被请求");
  });

  await test("合法逐跳重定向返回经魔数验证的图片", async () => {
    const calls: string[] = [];
    const lookup: HostLookup = async () => ["93.184.216.34"];
    const fetcher: ImageFetch = async (input, init) => {
      calls.push(String(input));
      assert.equal(init?.redirect, "manual");
      if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "/final.png" } });
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png", "content-length": String(PNG.length) } });
    };
    const result = await downloadImageToDataUrl("https://images.example/start", { lookup, fetch: fetcher });
    assert.equal(result, PNG_DATA_URL);
    assert.deepEqual(calls, ["https://images.example/start", "https://images.example/final.png"]);
  });

  console.log(`\n通过 ${passed} 项`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

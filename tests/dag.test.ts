/**
 * DAG 回归测试（纯逻辑，不调真实 API）：
 * 1. 线性链路：下游在执行时拿到上游本次产出（而非计划期快照）
 * 2. 分支 DAG：每个下游只收到其直接上游
 * 3. 环检测仍有效
 * 4. 单节点重跑：范围外上游回退快照
 * 5. runs 清理有界（终态 Run 超上限被回收）
 * 运行：node node_modules/tsx/dist/cli.mjs tests/dag.test.ts
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { assertPlanInputs, buildExecutionPlan, DagError, type FlowEdge, type FlowNode } from "../server/engine/dag";
import type { SceneAnalyzer } from "../server/lib/sceneAnalysis";
import type {
  AIProvider,
  ImageGenRequest,
  NodeExecution,
  NodeKind,
  WorkflowNodeData,
} from "../src/types/workflow";

// 所有测试文件都进入临时目录，绝不读写项目 data/。
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-test-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { createRun, executeStep, getRunForUser } = await import("../server/engine/runner");
const { uploadsDir } = await import("../server/lib/fileStore");
const TEST_OWNER_ID = "dag-test-owner";

// 造一张真实存在的测试图片（落盘校验需要）。
const SEED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const SECOND_PNG = await sharp({
  create: { width: 1, height: 1, channels: 3, background: { r: 24, g: 92, b: 180 } },
}).png().toBuffer();
const SEED_DATA_URL = `data:image/png;base64,${SEED_PNG.toString("base64")}`;
const SECOND_DATA_URL = `data:image/png;base64,${SECOND_PNG.toString("base64")}`;
const PERSON_GRID_PNG = await sharp({
  create: { width: 4, height: 4, channels: 3, background: { r: 20, g: 40, b: 60 } },
}).composite([{
  input: await sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 220, g: 80, b: 40 } },
  }).png().toBuffer(),
  left: 2,
  top: 2,
}]).png().toBuffer();
const PERSON_GRID_DATA_URL = `data:image/png;base64,${PERSON_GRID_PNG.toString("base64")}`;
const SCENE_PNG = await sharp({
  create: { width: 2, height: 3, channels: 3, background: { r: 70, g: 130, b: 35 } },
}).png().toBuffer();
const SCENE_DATA_URL = `data:image/png;base64,${SCENE_PNG.toString("base64")}`;
const MASK_SOURCE_PNG = await sharp({
  create: { width: 128, height: 128, channels: 3, background: { r: 35, g: 92, b: 165 } },
}).png().toBuffer();
const MASK_SOURCE_DATA_URL = `data:image/png;base64,${MASK_SOURCE_PNG.toString("base64")}`;
const MASK_PIXELS = Buffer.alloc(128 * 128 * 4, 255);
for (let y = 40; y < 88; y += 1) {
  for (let x = 40; x < 88; x += 1) MASK_PIXELS[(y * 128 + x) * 4 + 3] = 0;
}
const MASK_PNG = await sharp(MASK_PIXELS, { raw: { width: 128, height: 128, channels: 4 } }).png().toBuffer();
const MASK_DATA_URL = `data:image/png;base64,${MASK_PNG.toString("base64")}`;
const REPLACE_PIXELS = Buffer.alloc(128 * 128 * 3);
for (let y = 0; y < 128; y += 1) {
  for (let x = 0; x < 128; x += 1) {
    const offset = (y * 128 + x) * 3;
    const isNewContour = y >= 30 && y < 98 && x >= 18 && x < 110;
    const color = isNewContour
      ? { r: 225, g: 42, b: 48 }
      : { r: 35, g: 92, b: 165 };
    REPLACE_PIXELS[offset] = color.r;
    REPLACE_PIXELS[offset + 1] = color.g;
    REPLACE_PIXELS[offset + 2] = color.b;
  }
}
const REPLACE_PNG = await sharp(REPLACE_PIXELS, {
  raw: { width: 128, height: 128, channels: 3 },
}).png().toBuffer();
const REPLACE_PROVIDER_PNG = await sharp(REPLACE_PNG).resize({ width: 816, height: 816, fit: "fill" }).png().toBuffer();
const REPLACE_PROVIDER_DATA_URL = `data:image/png;base64,${REPLACE_PROVIDER_PNG.toString("base64")}`;
fs.writeFileSync(path.join(uploadsDir(), "seed.png"), SEED_PNG);

let passed = 0;
function ok(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      console.error(`  ✗ ${name}`);
      console.error(err);
      process.exitCode = 1;
    });
}

function imgNode(id: string, imageUrl?: string): FlowNode {
  return {
    id,
    type: "image-input",
    data: {
      kind: "image-input",
      label: id,
      status: "idle",
      imageUrl,
      imageRole: "default",
    } as WorkflowNodeData as FlowNode["data"],
  };
}

function aiNode(id: string, kind: "sketch-to-render" | "ai-modify", outputImages: string[] = []): FlowNode {
  return {
    id,
    type: kind,
    data: {
      kind,
      label: id,
      status: "idle",
      prompt: "test",
      aspectRatio: "1:1",
      batchSize: 1,
      outputImages,
    } as WorkflowNodeData as FlowNode["data"],
  };
}

function resultNode(id: string): FlowNode {
  return {
    id,
    type: "result",
    data: { kind: "result", label: id, status: "idle", images: [] } as WorkflowNodeData as FlowNode["data"],
  };
}

const edge = (source: string, target: string): FlowEdge => ({ source, target });

interface RecordedProviderCall {
  method: "generate" | "edit";
  request: ImageGenRequest;
}

async function runRecordedAiStep(
  kind: Exclude<NodeKind, "image-input" | "result">,
  params: Record<string, unknown>,
  inputImages: string[],
  providerImages?: string[],
  referenceRoles?: string[],
  sceneAnalyzer?: SceneAnalyzer,
) {
  const calls: RecordedProviderCall[] = [];
  const providerIds: string[] = [];
  const record = (method: RecordedProviderCall["method"], request: ImageGenRequest) => {
    calls.push({
      method,
      request: {
        ...request,
        referenceImages: request.referenceImages ? [...request.referenceImages] : undefined,
      },
    });
    const count = Math.max(1, request.batchSize ?? 1);
    return {
      images: providerImages ?? Array.from({ length: count }, () => SEED_DATA_URL),
      model: "runner-stub-model",
    };
  };
  const provider: AIProvider = {
    id: "runner-stub",
    async generate(request) { return record("generate", request); },
    async edit(request) { return record("edit", request); },
  };
  const step: NodeExecution = {
    nodeId: `runner-${kind}`,
    kind,
    inputImages,
    params,
  };
  const result = await executeStep(step, inputImages, (providerId) => {
    providerIds.push(providerId);
    return provider;
  }, { referenceRoles, sceneAnalyzer });
  return { calls, providerIds, result };
}

async function main() {
  console.log("DAG 回归测试");

  await ok("线性链路：下游步骤携带上游依赖（ID + 快照）", () => {
    const plan = buildExecutionPlan(
      [imgNode("input", "/api/files/a.png"), aiNode("render", "sketch-to-render"), aiNode("modify", "ai-modify")],
      [edge("input", "render"), edge("render", "modify")],
    );
    const modify = plan.steps.find((s) => s.nodeId === "modify")!;
    // 计划期 render 无产出 → 快照为空，但依赖关系必须保留（运行时解析）
    assert.deepStrictEqual(modify.upstream, [{ nodeId: "render", images: [] }]);
    assert.deepStrictEqual(modify.inputImages, []);
  });

  await ok("分支 DAG：每个下游只挂自己的直接上游", () => {
    const plan = buildExecutionPlan(
      [imgNode("in1", "/a.png"), imgNode("in2", "/b.png"), aiNode("r1", "sketch-to-render"), aiNode("r2", "ai-modify"), resultNode("out")],
      [edge("in1", "r1"), edge("in2", "r2"), edge("r1", "out"), edge("r2", "out")],
    );
    const r1 = plan.steps.find((s) => s.nodeId === "r1")!;
    const r2 = plan.steps.find((s) => s.nodeId === "r2")!;
    const out = plan.steps.find((s) => s.nodeId === "out")!;
    assert.deepStrictEqual(r1.upstream?.map((u) => u.nodeId), ["in1"]);
    assert.deepStrictEqual(r2.upstream?.map((u) => u.nodeId), ["in2"]);
    assert.deepStrictEqual(out.upstream?.map((u) => u.nodeId), ["r1", "r2"]);
  });

  await ok("蒙版执行计划统一为版本化局部修改，不再携带旧处理模式", () => {
    const maskNode = (id: string, legacyMaskMode?: "preserve" | "replace"): FlowNode => ({
      id,
      type: "mask-redraw",
      data: {
        kind: "mask-redraw",
        label: "蒙版重绘",
        status: "idle",
        prompt: "替换胸前图案",
        mask: MASK_DATA_URL,
        maskSourceRef: MASK_SOURCE_DATA_URL,
        ...(legacyMaskMode ? { maskMode: legacyMaskMode } : {}),
        outputImages: [],
        modelId: "gpt-image-2",
        modelOptions: {},
      },
    });
    const legacyStep = buildExecutionPlan([maskNode("legacy", "preserve")], []).steps[0];
    const replaceStep = buildExecutionPlan([maskNode("replace", "replace")], []).steps[0];
    assert.equal(legacyStep.params.maskPipelineVersion, 3);
    assert.equal(replaceStep.params.maskPipelineVersion, 3);
    assert.equal(legacyStep.params.maskMode, undefined);
    assert.equal(replaceStep.params.maskMode, undefined);
  });

  await ok("风格迁移：双参考图按人物、场景的连线顺序传入", () => {
    const transfer = aiNode("transfer", "ai-modify");
    const plan = buildExecutionPlan(
      [
        imgNode("subject", "/api/files/person.png"),
        imgNode("scene", "/api/files/scene.png"),
        transfer,
      ],
      [edge("subject", "transfer"), edge("scene", "transfer")],
    );
    const step = plan.steps.find((item) => item.nodeId === "transfer")!;
    assert.deepStrictEqual(step.upstream, [
      { nodeId: "subject", images: ["/api/files/person.png"] },
      { nodeId: "scene", images: ["/api/files/scene.png"] },
    ]);
    assert.deepStrictEqual(step.inputImages, [
      "/api/files/person.png",
      "/api/files/scene.png",
    ]);
  });

  await ok("带提示词的 AI 节点最多接受 8 张参考图", () => {
    const inputs = Array.from({ length: 9 }, (_, index) =>
      imgNode(`ref${index + 1}`, `/api/files/ref${index + 1}.png`),
    );
    const transfer = aiNode("transfer", "ai-modify");
    const eightEdges = inputs.slice(0, 8).map((node) => edge(node.id, "transfer"));
    const valid = buildExecutionPlan([...inputs.slice(0, 8), transfer], eightEdges, {
      onlyNodeId: "transfer",
      includeDownstream: false,
    });
    assert.doesNotThrow(() => assertPlanInputs(valid, eightEdges));

    const nineEdges = inputs.map((node) => edge(node.id, "transfer"));
    const invalid = buildExecutionPlan([...inputs, transfer], nineEdges, {
      onlyNodeId: "transfer",
      includeDownstream: false,
    });
    assert.throws(() => assertPlanInputs(invalid, nineEdges), /at most 8 reference images/);
  });

  await ok("虚拟模特换装统一接受最多 14 张有序参考图", () => {
    const inputs = Array.from({ length: 15 }, (_, index) =>
      imgNode(`try-on-ref-${index + 1}`, `/api/files/try-on-ref-${index + 1}.png`),
    );
    const tryOn: FlowNode = {
      id: "try-on",
      type: "virtual-try-on",
      data: {
        kind: "virtual-try-on",
        label: "虚拟模特换装",
        status: "idle",
        workflowStage: "standard",
        prompt: "保留背景",
        imageSize: "4K",
        modelId: "gemini-3.1-flash-image-preview",
        modelOptions: { aspectRatio: "1:1", imageSize: "4K" },
        outputImages: [],
      } as WorkflowNodeData as FlowNode["data"],
    };
    const fourteenEdges = inputs.slice(0, 14).map((node) => edge(node.id, tryOn.id));
    const valid = buildExecutionPlan([...inputs.slice(0, 14), tryOn], fourteenEdges, {
      onlyNodeId: tryOn.id,
      includeDownstream: false,
    });
    assert.doesNotThrow(() => assertPlanInputs(valid, fourteenEdges));
    assert.deepStrictEqual(valid.steps[0].inputImages, inputs.slice(0, 14).map(
      (_, index) => `/api/files/try-on-ref-${index + 1}.png`,
    ));

    const fifteenEdges = inputs.map((node) => edge(node.id, tryOn.id));
    const invalid = buildExecutionPlan([...inputs, tryOn], fifteenEdges, {
      onlyNodeId: tryOn.id,
      includeDownstream: false,
    });
    assert.throws(() => assertPlanInputs(invalid, fifteenEdges), /at most 14 reference images/);
  });

  await ok("分步换装按角色排序并在付费前执行确认与工艺门禁", () => {
    const person = imgNode("person", "/api/files/person.png");
    const scene = imgNode("scene", "/api/files/scene.png");
    const outfit = imgNode("outfit", "/api/files/outfit.png");
    const shoes = imgNode("accessory", "/api/files/shoes.png");
    const bag = imgNode("structure", "/api/files/bag.png");
    const hat = imgNode("hat", "/api/files/hat.png");
    const ring = imgNode("ring", "/api/files/ring.png");
    const earrings = imgNode("earrings", "/api/files/earrings.png");
    const bracelet = imgNode("bracelet", "/api/files/bracelet.png");
    const detail = imgNode("detail", "/api/files/detail.png");
    const stabilize: FlowNode = {
      id: "stabilize",
      type: "virtual-try-on",
      data: {
        kind: "virtual-try-on", label: "第一轮", status: "idle", workflowStage: "scene-stabilize",
        prompt: "", imageSize: "2K", modelId: "gemini-3.1-flash-image-preview",
        modelOptions: { aspectRatio: "1:1", imageSize: "2K" }, outputImages: [],
      },
    };
    const stageOneEdges: FlowEdge[] = [
      { source: bracelet.id, target: stabilize.id, targetHandle: "bracelet" },
      { source: outfit.id, target: stabilize.id, targetHandle: "outfit" },
      { source: bag.id, target: stabilize.id, targetHandle: "bag" },
      { source: person.id, target: stabilize.id, targetHandle: "person" },
      { source: hat.id, target: stabilize.id, targetHandle: "hat" },
      { source: shoes.id, target: stabilize.id, targetHandle: "shoes" },
      { source: ring.id, target: stabilize.id, targetHandle: "ring" },
      { source: scene.id, target: stabilize.id, targetHandle: "scene" },
      { source: earrings.id, target: stabilize.id, targetHandle: "earrings" },
      { source: detail.id, target: stabilize.id, targetHandle: "detail" },
    ];
    const stageOneNodes = [person, scene, outfit, shoes, bag, hat, ring, earrings, bracelet, detail, stabilize];
    const stageOne = buildExecutionPlan(stageOneNodes, stageOneEdges, {
      onlyNodeId: stabilize.id, includeDownstream: false,
    });
    assert.deepStrictEqual(stageOne.steps[0].inputImages, [
      "/api/files/scene.png", "/api/files/person.png", "/api/files/outfit.png",
      "/api/files/bag.png", "/api/files/shoes.png", "/api/files/hat.png",
      "/api/files/ring.png", "/api/files/earrings.png", "/api/files/bracelet.png",
      "/api/files/detail.png",
    ]);
    assert.doesNotThrow(() => assertPlanInputs(stageOne, stageOneEdges));
    const invalidStageOneNode: FlowNode = {
      ...stabilize,
      data: { ...stabilize.data, modelId: "gpt-image-2" },
    };
    const invalidStageOne = buildExecutionPlan(
      [...stageOneNodes.filter((node) => node.id !== stabilize.id), invalidStageOneNode],
      stageOneEdges,
      { onlyNodeId: stabilize.id, includeDownstream: false },
    );
    assert.throws(
      () => assertPlanInputs(invalidStageOne, stageOneEdges),
      /第一轮必须使用 Gemini 3\.1 Flash/,
    );

    const baselineRef = "/api/files/baseline.png";
    const approvedStage: FlowNode = {
      ...stabilize,
      data: {
        ...stabilize.data,
        basisRevision: 3,
        outputImages: [baselineRef],
      },
    };
    const approval: FlowNode = {
      id: "approval",
      type: "stage-approval",
      data: {
        kind: "stage-approval",
        label: "确认第一轮基准",
        status: "idle",
        approvalKind: "scene-baseline",
        approvedSourceNodeId: approvedStage.id,
        approvedBaselineRef: baselineRef,
        approvedBasisRevision: 3,
        approvedAt: "2026-09-03T06:00:00.000Z",
      },
    };
    const material = imgNode("material", "/api/files/material.png");
    const refine: FlowNode = {
      id: "refine",
      type: "virtual-try-on",
      data: {
        kind: "virtual-try-on", label: "第二轮", status: "idle", workflowStage: "garment-refine",
        prompt: "", imageSize: "2K", modelId: "gpt-image-2", modelOptions: { quality: "medium" },
        garmentCategory: "knit", materialSpec: "羊毛双股纱，中等厚度",
        constructionSpec: "12GG，平针衣身，1×1罗纹领口",
        outputImages: [],
      },
    };
    const stageTwoEdges: FlowEdge[] = [
      { source: approvedStage.id, target: approval.id, targetHandle: "baseline-candidate" },
      { source: detail.id, target: refine.id, targetHandle: "detail" },
      { source: material.id, target: refine.id, targetHandle: "material" },
      { source: outfit.id, target: refine.id, targetHandle: "outfit" },
      { source: approval.id, target: refine.id, targetHandle: "baseline" },
    ];
    const stageTwoNodes = [approvedStage, approval, outfit, material, detail, refine];
    const stageTwo = buildExecutionPlan(stageTwoNodes, stageTwoEdges, {
      onlyNodeId: refine.id, includeDownstream: false,
    });
    assert.deepStrictEqual(stageTwo.steps[0].inputImages, [
      "/api/files/baseline.png", "/api/files/outfit.png", "/api/files/material.png", "/api/files/detail.png",
    ]);
    assert.doesNotThrow(() => assertPlanInputs(stageTwo, stageTwoEdges));
    const invalidStageTwoNode: FlowNode = {
      ...refine,
      data: { ...refine.data, modelId: "gemini-3.1-flash-image-preview" },
    };
    const invalidStageTwo = buildExecutionPlan(
      [...stageTwoNodes.filter((node) => node.id !== refine.id), invalidStageTwoNode],
      stageTwoEdges,
      { onlyNodeId: refine.id, includeDownstream: false },
    );
    assert.throws(
      () => assertPlanInputs(invalidStageTwo, stageTwoEdges),
      /第二轮必须使用 GPT Image 2/,
    );

    const staleApproval: FlowNode = {
      ...approval,
      data: { ...approval.data, approvedBasisRevision: 2 },
    };
    const stalePlan = buildExecutionPlan(
      [approvedStage, staleApproval, outfit, material, detail, refine],
      stageTwoEdges,
      { onlyNodeId: refine.id, includeDownstream: false },
    );
    assert.throws(() => assertPlanInputs(stalePlan, stageTwoEdges), /重新确认|确认已失效/);

    const missingMaterial: FlowNode = {
      ...refine,
      data: { ...refine.data, materialSpec: "" },
    };
    const missingMaterialPlan = buildExecutionPlan(
      [approvedStage, approval, outfit, material, detail, missingMaterial],
      stageTwoEdges,
      { onlyNodeId: refine.id, includeDownstream: false },
    );
    assert.throws(() => assertPlanInputs(missingMaterialPlan, stageTwoEdges), /面料|material/i);
  });

  await ok("局部修改在入队前拒绝会占满引导图名额的 8 张用户参考图", () => {
    const references = Array.from({ length: 8 }, (_, index) => `/api/files/mask-ref-${index + 1}.png`);
    const upstream = aiNode("mask-upstream", "ai-modify", references);
    const maskNode: FlowNode = {
      id: "mask-target",
      type: "mask-redraw",
      data: {
        kind: "mask-redraw",
        label: "局部修改",
        status: "idle",
        prompt: "修改衣袖",
        mask: MASK_DATA_URL,
        maskSourceRef: references[0],
        outputImages: [],
        modelId: "gpt-image-2",
        modelOptions: {},
      } as WorkflowNodeData as FlowNode["data"],
    };
    const maskEdge = edge(upstream.id, maskNode.id);
    const plan = buildExecutionPlan([upstream, maskNode], [maskEdge], {
      onlyNodeId: maskNode.id,
      includeDownstream: false,
    });

    assert.throws(
      () => assertPlanInputs(plan, [maskEdge]),
      /at most 7 user reference images/,
    );
  });

  await ok("环检测：A↔B 抛 DagError", () => {
    assert.throws(
      () => buildExecutionPlan([aiNode("a"), aiNode("b")], [edge("a", "b"), edge("b", "a")]),
      DagError,
    );
  });

  await ok("单节点重跑：范围外上游保留快照回退", () => {
    const plan = buildExecutionPlan(
      [aiNode("render", "sketch-to-render", ["/api/files/rendered.png"]), aiNode("modify", "ai-modify")],
      [edge("render", "modify")],
      { onlyNodeId: "modify" },
    );
    assert.strictEqual(plan.steps.length, 1);
    const modify = plan.steps[0];
    assert.deepStrictEqual(modify.upstream, [
      { nodeId: "render", images: ["/api/files/rendered.png"] },
    ]);
  });

  await ok("画布单节点执行：显式关闭下游扩展，避免额外 AI 调用", () => {
    const plan = buildExecutionPlan(
      [
        imgNode("input", "/api/files/seed.png"),
        aiNode("render", "sketch-to-render"),
        aiNode("modify", "ai-modify"),
        resultNode("out"),
      ],
      [edge("input", "render"), edge("render", "modify"), edge("modify", "out")],
      { onlyNodeId: "render", includeDownstream: false },
    );
    assert.deepStrictEqual(plan.steps.map((step) => step.nodeId), ["render"]);
    assert.deepStrictEqual(plan.steps[0].upstream, [
      { nodeId: "input", images: ["/api/files/seed.png"] },
    ]);
  });

  await ok("面料配色计划：保留颜色数组交给后端一色一图", () => {
    const recolor: FlowNode = {
      id: "recolor",
      type: "fabric-recolor",
      data: {
        kind: "fabric-recolor",
        label: "配色",
        status: "idle",
        colors: ["#112233", "#AABBCC"],
        prompt: "",
        outputImages: [],
      },
    };
    const plan = buildExecutionPlan([imgNode("input", "/api/files/seed.png"), recolor], [edge("input", "recolor")]);
    assert.deepStrictEqual(plan.steps.find((step) => step.nodeId === "recolor")?.params.colors, [
      "#112233",
      "#AABBCC",
    ]);
    assert.doesNotThrow(() => assertPlanInputs(plan, [edge("input", "recolor")]));
  });

  await ok("付费节点输入门禁：拒绝空输入与只有 fabric 的配色计划", () => {
    const modifyPlan = buildExecutionPlan([aiNode("modify", "ai-modify")], [], {
      onlyNodeId: "modify",
      includeDownstream: false,
    });
    assert.throws(() => assertPlanInputs(modifyPlan, []), /requires an upstream image/);

    const fabricOnly: FlowNode = {
      id: "recolor",
      type: "fabric-recolor",
      data: {
        kind: "fabric-recolor",
        label: "配色",
        status: "idle",
        colors: ["#112233"],
        prompt: "",
        outputImages: [],
      },
    };
    const fabricEdges = [{ ...edge("fabric", "recolor"), targetHandle: "fabric" }];
    const fabricPlan = buildExecutionPlan(
      [imgNode("fabric", "/api/files/seed.png"), fabricOnly],
      fabricEdges,
      { onlyNodeId: "recolor", includeDownstream: false },
    );
    assert.throws(() => assertPlanInputs(fabricPlan, fabricEdges), /requires a garment image/);
  });

  await ok("文生图：有提示词时允许生成节点无图片输入", () => {
    const plan = buildExecutionPlan([aiNode("generate", "sketch-to-render")], []);
    assert.doesNotThrow(() => assertPlanInputs(plan, []));
    const step = plan.steps[0];
    assert.equal(step.params.prompt, "test");
    assert.deepStrictEqual(step.inputImages, []);
  });

  await ok("runner 草图效果图：有参考图走 edit 并按批量返回", async () => {
    const prompt = "保留轮廓，渲染成真丝礼服";
    const { calls, providerIds, result } = await runRecordedAiStep(
      "sketch-to-render",
      { prompt, aspectRatio: "3:4", batchSize: 2 },
      [SEED_DATA_URL],
    );
    assert.deepStrictEqual(providerIds, ["gpt-image-2-vip"]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, "edit");
    assert.deepStrictEqual(calls[0].request.referenceImages, [SEED_DATA_URL]);
    assert.strictEqual(calls[0].request.prompt, prompt);
    assert.strictEqual(calls[0].request.aspectRatio, "3:4");
    assert.strictEqual(calls[0].request.batchSize, 2);
    assert.strictEqual(result.images.length, 2);
    assert.deepStrictEqual(result.prompts, [prompt, prompt]);
    assert.strictEqual(result.providerRequests, 1);
  });

  await ok("runner 文生图：无参考图走 generate 并保留数量", async () => {
    const prompt = "生成一组沙漠金属感礼服";
    const { calls, providerIds, result } = await runRecordedAiStep(
      "sketch-to-render",
      { prompt, aspectRatio: "16:9", batchSize: 2 },
      [],
    );
    assert.deepStrictEqual(providerIds, ["gpt-image-2-vip"]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, "generate");
    assert.strictEqual(calls[0].request.referenceImages, undefined);
    assert.strictEqual(calls[0].request.prompt, prompt);
    assert.strictEqual(calls[0].request.batchSize, 2);
    assert.strictEqual(result.images.length, 2);
    assert.strictEqual(result.providerRequests, 1);
  });

  await ok("runner AI 改款：多参考图顺序传入 edit 并生成用户数量", async () => {
    const prompt = "改成娃娃领和短袖";
    const { calls, providerIds, result } = await runRecordedAiStep(
      "ai-modify",
      { prompt, aspectRatio: "1:1", batchSize: 4 },
      [SEED_DATA_URL, SECOND_DATA_URL],
    );
    assert.deepStrictEqual(providerIds, ["gpt-image-2-vip"]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, "edit");
    assert.deepStrictEqual(calls[0].request.referenceImages, [SEED_DATA_URL, SECOND_DATA_URL]);
    assert.strictEqual(calls[0].request.prompt, prompt);
    assert.strictEqual(calls[0].request.batchSize, 4);
    assert.strictEqual(result.images.length, 4);
    assert.strictEqual(result.prompts?.length, 4);
    assert.strictEqual(result.providerRequests, 1);
  });

  await ok("runner 虚拟换装自动推导画幅并只传递用户选择的 2K/4K 档位", async () => {
    const gpt = await runRecordedAiStep(
      "virtual-try-on",
      { prompt: "外套敞开", imageSize: "2K", modelId: "gpt-image-2", modelOptions: {} },
      [SEED_DATA_URL, SECOND_DATA_URL],
    );
    assert.deepStrictEqual(gpt.providerIds, ["gpt-image-2"]);
    assert.strictEqual(gpt.calls[0].method, "edit");
    assert.deepStrictEqual(gpt.calls[0].request.referenceImages, [SEED_DATA_URL, SECOND_DATA_URL]);
    assert.deepStrictEqual(gpt.calls[0].request.modelOptions, { size: "2048x2048" });
    assert.match(gpt.calls[0].request.prompt, /参考图1是唯一的最终模特基准图/);
    assert.match(gpt.calls[0].request.prompt, /参考图2是主穿搭参考/);
    assert.match(gpt.calls[0].request.prompt, /参考图1人物与场景 > 参考图2整体穿搭/);
    assert.match(gpt.calls[0].request.prompt, /补充要求：外套敞开/);
    assert.deepStrictEqual(gpt.result.providerOutputSizes, ["1x1"]);

    const gemini = await runRecordedAiStep(
      "virtual-try-on",
      {
        prompt: "",
        imageSize: "4K",
        modelId: "gemini-3.1-flash-image-preview",
        modelOptions: { aspectRatio: "1:1", imageSize: "2K" },
      },
      [SEED_DATA_URL, SECOND_DATA_URL],
    );
    assert.deepStrictEqual(gemini.providerIds, ["gemini-3.1-flash-image-preview"]);
    assert.deepStrictEqual(gemini.calls[0].request.modelOptions, { aspectRatio: "1:1", imageSize: "4K" });
    assert.strictEqual(gemini.result.images.length, 1);

    await assert.rejects(
      () => runRecordedAiStep(
        "virtual-try-on",
        { prompt: "图2控制人物，图3控制上衣", imageSize: "2K", modelId: "gpt-image-2", modelOptions: {} },
        [SEED_DATA_URL, SECOND_DATA_URL],
      ),
      /补充要求不能重新定义图1、图2等参考图编号/,
    );
  });

  await ok("runner 分步换装使用角色提示词并固定第二轮中等质量", async () => {
    const sceneAnalyzer: SceneAnalyzer = async () => ({
      prompt: "环境：极简摄影棚；背景：暖灰色无缝背景；光线：左前方柔光；镜头：平视中焦；取景：全身；构图：人物居中；身体姿态：自然站立；手部姿态：右手下垂；神态：冷静；视线：看向镜头；人物位置：画面中央",
      providerRequests: 1,
      model: "scene-analyzer-stub",
      cacheHit: false,
    });
    const stageOne = await runRecordedAiStep(
      "virtual-try-on",
      {
        workflowStage: "scene-stabilize", prompt: "", imageSize: "2K",
        modelId: "gemini-3.1-flash-image-preview", modelOptions: { aspectRatio: "1:1", imageSize: "2K" },
      },
      [
        SCENE_DATA_URL, PERSON_GRID_DATA_URL, SECOND_DATA_URL,
        SECOND_DATA_URL, SEED_DATA_URL, SECOND_DATA_URL,
        SEED_DATA_URL, SECOND_DATA_URL, SEED_DATA_URL,
      ],
      undefined,
      ["scene", "person", "outfit", "bag", "shoes", "hat", "ring", "earrings", "bracelet"],
      sceneAnalyzer,
    );
    assert.equal(stageOne.result.providerRequests, 2);
    assert.equal(stageOne.calls[0].request.referenceImages?.length, 9);
    assert.notEqual(stageOne.calls[0].request.referenceImages?.[0], PERSON_GRID_DATA_URL);
    assert.equal(stageOne.calls[0].request.referenceImages?.[1], PERSON_GRID_DATA_URL);
    assert.equal(stageOne.calls[0].request.referenceImages?.[2], SECOND_DATA_URL);
    assert.ok(!stageOne.calls[0].request.referenceImages?.includes(SCENE_DATA_URL));
    assert.deepEqual(stageOne.calls[0].request.modelOptions, { aspectRatio: "2:3", imageSize: "2K" });
    assert.match(stageOne.calls[0].request.prompt, /右下角提取的脸部锚点，是脸部恢复唯一正确来源/);
    assert.match(stageOne.calls[0].request.prompt, /完整人物身份图，是人物一致性的唯一来源/);
    assert.match(stageOne.calls[0].request.prompt, /参考图3是服装与搭配风格的唯一来源/);
    assert.match(stageOne.calls[0].request.prompt, /原始场景图没有发送给生图模型/);
    assert.match(stageOne.calls[0].request.prompt, /暖灰色无缝背景/);
    assert.match(stageOne.calls[0].request.prompt, /参考图4只控制目标包袋/);
    assert.match(stageOne.calls[0].request.prompt, /参考图5只控制目标鞋履/);
    assert.match(stageOne.calls[0].request.prompt, /参考图6只控制目标帽子/);
    assert.match(stageOne.calls[0].request.prompt, /参考图7只控制目标戒指/);
    assert.match(stageOne.calls[0].request.prompt, /参考图8只控制目标耳环/);
    assert.match(stageOne.calls[0].request.prompt, /参考图9只控制目标手镯/);
    assert.match(stageOne.calls[0].request.prompt, /全局权重低于人物身份、场景描述和主穿搭/);
    assert.match(stageOne.calls[0].request.prompt, /真实存在且清晰可见的金属装饰图案与五金/);
    assert.match(stageOne.calls[0].request.prompt, /只提取戒指本体/);
    assert.match(stageOne.calls[0].request.prompt, /目标商品本体上已有的金属装饰图案与五金保持来源外观/);

    const bagOnly = await runRecordedAiStep(
      "virtual-try-on",
      {
        workflowStage: "scene-stabilize", prompt: "", imageSize: "2K",
        modelId: "gemini-3.1-flash-image-preview", modelOptions: { aspectRatio: "1:1", imageSize: "2K" },
      },
      [SCENE_DATA_URL, PERSON_GRID_DATA_URL, SECOND_DATA_URL, SECOND_DATA_URL],
      undefined,
      ["scene", "person", "outfit", "bag"],
      sceneAnalyzer,
    );
    assert.match(bagOnly.calls[0].request.prompt, /只控制目标包袋/);
    assert.doesNotMatch(bagOnly.calls[0].request.prompt, /鞋履|帽子|戒指|耳环|手镯|未提供/);

    const stageTwo = await runRecordedAiStep(
      "virtual-try-on",
      {
        workflowStage: "garment-refine", prompt: "", imageSize: "2K", modelId: "gpt-image-2",
        modelOptions: { quality: "medium" }, garmentCategory: "knit",
        approvedBaselineRef: SEED_DATA_URL,
        materialSpec: "羊毛双股纱，中等厚度", constructionSpec: "12GG，平针衣身，1×1罗纹领口",
      },
      [SEED_DATA_URL, SECOND_DATA_URL],
      undefined,
      ["baseline", "outfit"],
    );
    assert.deepStrictEqual(stageTwo.calls[0].request.modelOptions, { size: "2048x2048", quality: "medium" });
    assert.match(stageTwo.calls[0].request.prompt, /唯一人物与场景基准/);
    assert.match(stageTwo.calls[0].request.prompt, /不得裁剪、缩放、扩图、重新取景或重新生成整个人物/);
    assert.match(stageTwo.calls[0].request.prompt, /不得简化为近似扣带或其它结构/);
    assert.match(stageTwo.calls[0].request.prompt, /目标商品上已经存在的金属装饰图案与五金必须保持原有位置、比例和外观/);
    assert.match(stageTwo.calls[0].request.prompt, /羊毛双股纱，中等厚度/);
    assert.match(stageTwo.calls[0].request.prompt, /12GG，平针衣身/);
  });

  await ok("runner 面料配色：一色一次 edit，成衣与面料参考均传入", async () => {
    const colors = ["#DE2910", "#002FA7"];
    const { calls, providerIds, result } = await runRecordedAiStep(
      "fabric-recolor",
      { colors, fabricImageUrl: SECOND_DATA_URL },
      [SEED_DATA_URL],
    );
    assert.deepStrictEqual(providerIds, ["gpt-image-2-vip"]);
    assert.strictEqual(calls.length, colors.length);
    assert.ok(calls.every((call) => call.method === "edit"));
    assert.ok(calls.every((call) => call.request.batchSize === 1));
    for (const call of calls) {
      assert.deepStrictEqual(call.request.referenceImages, [SEED_DATA_URL, SECOND_DATA_URL]);
    }
    assert.match(calls[0].request.prompt, /中国红\(#DE2910\)/);
    assert.match(calls[1].request.prompt, /克莱因蓝\(#002FA7\)/);
    assert.strictEqual(result.images.length, colors.length);
    assert.deepStrictEqual(result.prompts, calls.map((call) => call.request.prompt));
    assert.strictEqual(result.providerRequests, colors.length);
  });

  await ok("runner 高清放大：单参考图走 edit，固定单图并传递 2K", async () => {
    const { calls, providerIds, result } = await runRecordedAiStep(
      "upscale",
      { imageSize: "2K" },
      [SEED_DATA_URL],
    );
    assert.deepStrictEqual(providerIds, ["gpt-image-2-vip"]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, "edit");
    assert.deepStrictEqual(calls[0].request.referenceImages, [SEED_DATA_URL]);
    assert.match(calls[0].request.prompt, /放大为超高清版本/);
    assert.strictEqual(calls[0].request.imageSize, "2K");
    assert.strictEqual(calls[0].request.batchSize, 1);
    assert.strictEqual(result.images.length, 1);
    assert.strictEqual(result.providerRequests, 1);
  });

  await ok("runner 印花提取：参考图走 edit，合并固定与用户提示词", async () => {
    const extra = "只要胸前的主图案";
    const { calls, providerIds, result } = await runRecordedAiStep(
      "print-extract",
      { prompt: extra },
      [SEED_DATA_URL],
    );
    assert.deepStrictEqual(providerIds, ["gpt-image-2-vip"]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, "edit");
    assert.deepStrictEqual(calls[0].request.referenceImages, [SEED_DATA_URL]);
    assert.match(calls[0].request.prompt, /提取这件衣服上的印花图案/);
    assert.match(calls[0].request.prompt, new RegExp(`补充要求：${extra}`));
    assert.strictEqual(calls[0].request.batchSize, 1);
    assert.strictEqual(result.images.length, 1);
    assert.strictEqual(result.providerRequests, 1);
  });

  await ok("runner 严格使用节点保存的模型与模型原生参数", async () => {
    const modelOptions = { width: 1024, height: 768, outputFormat: "png" };
    const { calls, providerIds } = await runRecordedAiStep(
      "print-extract",
      { prompt: "提取主图案", modelId: "flux-2-pro", modelOptions },
      [SEED_DATA_URL],
    );
    assert.deepStrictEqual(providerIds, ["flux-2-pro"]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, "edit");
    assert.deepStrictEqual(calls[0].request.modelOptions, modelOptions);
  });

  await ok("runner 印花裂变：参考图走 edit，按 count 返回且合并提示词", async () => {
    const extra = "转为水墨风格";
    const { calls, providerIds, result } = await runRecordedAiStep(
      "print-mutate",
      { prompt: extra, count: 3 },
      [SEED_DATA_URL],
    );
    assert.deepStrictEqual(providerIds, ["gpt-image-2-vip"]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, "edit");
    assert.deepStrictEqual(calls[0].request.referenceImages, [SEED_DATA_URL]);
    assert.match(calls[0].request.prompt, /生成风格一致的新变体/);
    assert.match(calls[0].request.prompt, new RegExp(`补充要求：${extra}`));
    assert.strictEqual(calls[0].request.batchSize, 3);
    assert.strictEqual(result.images.length, 3);
    assert.strictEqual(result.prompts?.length, 3);
    assert.strictEqual(result.providerRequests, 1);
  });

  await ok("runner 统一局部修改：整图比例、核心非裁切与连续融合贯穿完整链路", async () => {
    const { calls, providerIds, result } = await runRecordedAiStep(
      "mask-redraw",
      {
        prompt: "在胸前添加红色刺绣并替换旧标识",
        mask: MASK_DATA_URL,
        maskSourceRef: MASK_SOURCE_DATA_URL,
        modelId: "gpt-image-2",
        modelOptions: {},
      },
      [MASK_SOURCE_DATA_URL],
      [REPLACE_PROVIDER_DATA_URL],
    );
    assert.deepStrictEqual(providerIds, ["gpt-image-2"]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, "edit");
    assert.strictEqual(calls[0].request.maskMode, undefined);
    assert.strictEqual(calls[0].request.referenceImages?.length, 2);
    assert.strictEqual(calls[0].request.referenceImages?.[0], MASK_SOURCE_DATA_URL);
    assert.notStrictEqual(calls[0].request.referenceImages?.[1], MASK_SOURCE_DATA_URL);
    assert.match(calls[0].request.prompt, /参考图2[^\n]{0,80}区域引导图/);
    assert.match(calls[0].request.prompt, /红色[^\n]{0,40}修改核心/);
    assert.match(calls[0].request.prompt, /金色[^\n]{0,60}缓冲区/);
    assert.match(calls[0].request.prompt, /(整幅|完整)画面[^\n]{0,80}(构图|比例)/);
    assert.match(calls[0].request.prompt, /添加、替换、删除或调整/);
    assert.match(calls[0].request.prompt, /冲突的旧对象、旧包带、旧颜色/);
    assert.match(calls[0].request.prompt, /完整重建被遮挡的底层服装或背景/);
    assert.match(calls[0].request.prompt, /禁止用模糊、暗斑、色块、漂浮投影或半透明残影/);
    assert.match(calls[0].request.prompt, /真实接触并符合整幅画面光源方向的阴影/);
    assert.match(calls[0].request.prompt, /PNG 完整最终图片/);
    assert.deepStrictEqual(calls[0].request.modelOptions, { size: "816x816" });
    assert.notStrictEqual(calls[0].request.mask, MASK_DATA_URL, "模型必须收到扩展后的安全区蒙版");
    assert.strictEqual(result.images.length, 1);
    const decoded = await sharp(Buffer.from(result.images[0].split(",")[1], "base64"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const backgroundOffset = (64 * decoded.info.width + 10) * decoded.info.channels;
    assert.deepStrictEqual(
      Array.from(decoded.data.subarray(backgroundOffset, backgroundOffset + 3)),
      [35, 92, 165],
      "融合区外必须逐像素保持原色",
    );
  });

  await ok("runner 蒙版多参考图：保留用户图号并把区域引导图追加到最后", async () => {
    const { calls } = await runRecordedAiStep(
      "mask-redraw",
      {
        prompt: "将选中区域修改为图2的手提包",
        mask: MASK_DATA_URL,
        maskSourceRef: MASK_SOURCE_DATA_URL,
        modelId: "gpt-image-2",
        modelOptions: {},
      },
      [MASK_SOURCE_DATA_URL, SECOND_DATA_URL],
      [REPLACE_PROVIDER_DATA_URL],
    );
    const references = calls[0].request.referenceImages ?? [];
    assert.strictEqual(references.length, 3);
    assert.strictEqual(references[0], MASK_SOURCE_DATA_URL);
    assert.strictEqual(references[1], SECOND_DATA_URL, "用户的图2必须原样传给模型");
    assert.notStrictEqual(references[2], SECOND_DATA_URL, "区域引导图必须追加到所有用户参考图之后");
    assert.match(calls[0].request.prompt, /参考图2是用户提供的目标内容参考图/);
    assert.match(calls[0].request.prompt, /最后一张参考图（参考图3）才是区域引导图/);
    assert.doesNotMatch(calls[0].request.prompt, /参考图2是区域引导图/);
  });

  await ok("runner 蒙版参考图上限：为内部区域引导图预留一个模型名额", async () => {
    await assert.rejects(
      () => runRecordedAiStep(
        "mask-redraw",
        {
          prompt: "替换选中的服装细节",
          mask: MASK_DATA_URL,
          maskSourceRef: MASK_SOURCE_DATA_URL,
          modelId: "gpt-image-2",
          modelOptions: {},
        },
        Array.from({ length: 8 }, (_, index) => index === 0 ? MASK_SOURCE_DATA_URL : SECOND_DATA_URL),
        [REPLACE_PROVIDER_DATA_URL],
      ),
      /accepts at most 7 user reference images/,
    );
  });


  await ok("端到端（无 AI）：result 节点收到上游本次产出", async () => {
    // image-input → result：image-input 执行时产出图片，result 必须收到它
    const plan = buildExecutionPlan(
      [imgNode("input", "/api/files/seed.png"), resultNode("out")],
      [edge("input", "out")],
    );
    const run = await createRun(plan, TEST_OWNER_ID);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("run timeout")), 5000);
      run.emitter.on(
        "event",
        (e: { type: string; nodeId?: string; status?: string; images?: string[] }) => {
          if (e.type === "node-status" && e.nodeId === "out" && e.status === "success") {
            assert.deepStrictEqual(e.images, ["/api/files/seed.png"]);
          }
          if (e.type === "done") {
            clearTimeout(timer);
            resolve();
          }
          if (e.type === "run-error") {
            clearTimeout(timer);
            reject(new Error(`run failed: ${(e as { error?: string }).error}`));
          }
        },
      );
    });
  });

  await ok("runs 有界：终态 Run 超上限被清理", async () => {
    // 直接造 60 个终态 Run 再触发一次 createRun 的清理
    const plan = buildExecutionPlan([resultNode("x")], []);
    let oldestRunId = "";
    for (let i = 0; i < 60; i++) {
      const r = await createRun(plan, TEST_OWNER_ID);
      if (i === 0) oldestRunId = r.id;
      r.finished = true;
    }
    await createRun(plan, TEST_OWNER_ID);
    const probe = await createRun(plan, TEST_OWNER_ID);
    assert.ok(getRunForUser(probe.id, TEST_OWNER_ID), "新 Run 必须存在");
    assert.strictEqual(getRunForUser(probe.id, "another-owner"), undefined, "其他用户不能读取 Run");
    assert.strictEqual(getRunForUser(oldestRunId, TEST_OWNER_ID), undefined, "最老的终态 Run 必须已被回收");
  });

  console.log(`\n通过 ${passed} 项`);
}

void main().finally(() => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

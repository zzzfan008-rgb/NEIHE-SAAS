import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express, { type Request, type Response } from "express";
import sharp from "sharp";
import { ProviderError } from "../server/providers/base";
import type { AuthenticatedRequest } from "../server/lib/auth";
import type { GenerationRecordContext } from "../server/lib/generationRecords";
import type { ProviderResolver } from "../server/engine/runner";
import type { SceneAnalyzer } from "../server/lib/sceneAnalysis";
import type { AIProvider, ExecutionPlan, ImageGenRequest, ImageGenResult, NodeExecution } from "../src/types/workflow";
import { resetPostgresTestDatabase } from "./postgresTestDatabase";
import { normalizeProviderImageDataUrl } from "../server/lib/uploadImageNormalization";
import { POSE_REVIEW_LABELS, parsePoseReviewCandidates } from '../src/lib/tryOnPoseReview';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-run-queue-"));
process.env.DATA_DIR = temp;
process.env.SQLITE_IMPORT_FILE = "missing.db";
process.env.INITIAL_ADMIN_ACCOUNT_ID = "queue-admin";
process.env.INITIAL_ADMIN_PASSWORD = "Initial1234";
process.env.APIYI_API_KEY = "queue-image-test-key";
process.env.APIYI_BASE_URL = "https://image-queue.example";
process.env.SEEDANCE_API_KEY = "queue-video-test-key";
process.env.SEEDANCE_API_BASE_URL = "https://video-queue.example";

await resetPostgresTestDatabase();
const database = await import("../server/lib/database");
const queue = await import("../server/engine/runQueue");
const fileStore = await import("../server/lib/fileStore");
const { generateRouter } = await import("../server/routes/generate");
const { streamDurableRunEvents } = await import("../server/routes/runPlan");
await database.initializeDatabase();

const owner = await database.queryOne<{ id: string }>("SELECT id FROM users WHERE account_id = 'queue-admin'");
assert.ok(owner);

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
async function solidImage(width: number, height: number, color: { r: number; g: number; b: number }): Promise<string> {
  const buffer = await sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
  return `data:image/png;base64,${buffer.toString("base64")}`;
}
let sequence = 0;
let clock = Date.now() + 10_000;
let passed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function tick(amount = 1_000): number {
  clock = Math.max(clock + amount, Date.now() + 1_000);
  return clock;
}

function step(nodeId: string, upstream?: NodeExecution["upstream"]): NodeExecution {
  return {
    nodeId,
    kind: "print-extract",
    inputImages: upstream ? [] : [PNG_DATA_URL],
    upstream,
    params: {
      prompt: "提取印花",
      modelId: "gpt-image-2-vip",
      modelOptions: { size: "1280x1280" },
    },
  };
}

function context(nodeId: string): GenerationRecordContext {
  return {
    userId: owner.id,
    nodeId,
    nodeLabel: nodeId,
    kind: "print-extract",
    prompt: "提取印花",
    requestedCount: 1,
  };
}

async function enqueueSingle(prefix: string): Promise<string> {
  sequence += 1;
  const nodeId = `${prefix}-${sequence}`;
  const run = await queue.enqueueGenerationRun({ steps: [step(nodeId)] }, owner.id, context(nodeId));
  return run.id;
}

async function enqueueVideo(prefix: string): Promise<string> {
  sequence += 1;
  const nodeId = `${prefix}-${sequence}`;
  const videoStep: NodeExecution = {
    nodeId,
    kind: "video-generate",
    inputImages: [],
    params: {
      mode: "text-to-video",
      prompt: "服装走秀",
      videoModel: "doubao-seedance-2-5-260628",
      aspectRatio: "16:9",
      resolution: "720p",
      seconds: 5,
      generateAudio: true,
      outputFormat: "mp4",
    },
  };
  const run = await queue.enqueueGenerationRun({ steps: [videoStep] }, owner.id, {
    ...context(nodeId), kind: "video-generate", prompt: "服装走秀",
  });
  return run.id;
}

function resolver(
  behavior: (request: ImageGenRequest, call: number) => ImageGenResult | Promise<ImageGenResult>,
): { resolveProvider: ProviderResolver; calls: () => number; requests: () => readonly ImageGenRequest[] } {
  let calls = 0;
  const requests: ImageGenRequest[] = [];
  const invoke = async (request: ImageGenRequest) => {
    calls += 1;
    requests.push(request);
    return behavior(request, calls);
  };
  const provider: AIProvider = {
    id: "gpt-image-2-vip",
    async generate(request) { return invoke(request); },
    async edit(request) { return invoke(request); },
  };
  return { resolveProvider: () => provider, calls: () => calls, requests: () => requests };
}

async function runRow(runId: string) {
  return database.queryOne<{
    status: string; error: string | null; provider_requests: number; successful_count: number;
  }>(
    "SELECT status, error, provider_requests, successful_count FROM generation_runs WHERE id = $1",
    [runId],
  );
}

interface ExplainPlanNode {
  "Node Type": string;
  "Sort Method"?: string;
  Plans?: ExplainPlanNode[];
}

function flattenPlan(node: ExplainPlanNode): ExplainPlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

console.log("PostgreSQL 持久生成队列测试");

await test("入队立即返回且数据库重连后 queued 任务仍可执行并重放事件", async () => {
  const fake = resolver(() => ({
    images: [PNG_DATA_URL], model: "gpt-image-2-vip", providerOutputSizes: ["2048x2048"],
  }));
  const runId = await enqueueSingle("restart");
  assert.equal(fake.calls(), 0, "入队阶段不得调用上游");
  assert.equal((await runRow(runId))?.status, "queued");

  await database.closeDatabaseForTests();
  await database.initializeDatabase();
  const now = tick();
  assert.equal(await queue.processNextGenerationJob("worker-restart", {
    resolveProvider: fake.resolveProvider, now: () => now, random: () => 0, retryDelaysMs: [0, 0],
  }), true);
  assert.equal(fake.calls(), 1);
  assert.deepEqual(await runRow(runId), {
    status: "succeeded", error: null, provider_requests: 1, successful_count: 1,
  });
  const output = await database.queryOne<{ image: string; provider_output_size: string | null }>(
    "SELECT image, provider_output_size FROM generation_outputs WHERE run_id = $1 AND status = 'success'", [runId],
  );
  assert.match(output?.image ?? "", /^\/api\/files\//);
  assert.equal(output?.provider_output_size, "2048x2048");

  const allEvents = await queue.readDurableRunEvents(runId, owner.id, 0);
  assert.ok(allEvents && allEvents.length >= 4);
  assert.deepEqual(allEvents.map((event) => event.seq), allEvents.map((_event, index) => index + 1));
  const cursor = allEvents[1].seq ?? 0;
  const replay = await queue.readDurableRunEvents(runId, owner.id, cursor);
  assert.deepEqual(replay?.map((event) => event.seq), allEvents.slice(2).map((event) => event.seq));
});

await test("领取旧版超量配色任务时同步规范化历史请求数量", async () => {
  sequence += 1;
  const nodeId = `legacy-recolor-count-${sequence}`;
  const recolorStep: NodeExecution = {
    nodeId,
    kind: "fabric-recolor",
    inputImages: [PNG_DATA_URL],
    params: {
      prompt: "",
      operationMode: "color",
      colors: Array.from({ length: 32 }, (_, index) => `#${index.toString(16).padStart(6, "0")}`),
      modelId: "gpt-image-2-vip",
      modelOptions: {},
    },
  };
  const run = await queue.enqueueGenerationRun({ steps: [recolorStep] }, owner.id, {
    ...context(nodeId),
    kind: "fabric-recolor",
    requestedCount: 32,
  });
  try {
    await database.query("UPDATE generation_jobs SET available_at = 0 WHERE run_id = $1", [run.id]);
    const claimed = await queue.claimNextJob("legacy-recolor-count-worker", tick(), 60_000);
    assert.equal(claimed?.runId, run.id);
    assert.equal((await database.queryOne<{ requested_count: number }>(
      "SELECT requested_count FROM generation_runs WHERE id = $1",
      [run.id],
    ))?.requested_count, 8);
  } finally {
    await database.query("DELETE FROM generation_runs WHERE id = $1", [run.id]);
  }
});

await test("持久队列分离场景与姿势原图，未提交配饰不进入提示词", async () => {
  const testId = ++sequence;
  const personImage = await solidImage(4, 4, { r: 210, g: 60, b: 35 });
  const sceneImage = await solidImage(2, 3, { r: 40, g: 140, b: 55 });
  const poseImage = await solidImage(3, 5, { r: 180, g: 75, b: 145 });
  const normalizedPose = await normalizeProviderImageDataUrl(poseImage);
  const expectedPose = `data:${normalizedPose.mimeType};base64,${normalizedPose.buffer.toString("base64")}`;
  const outfitImage = await solidImage(1, 2, { r: 35, g: 70, b: 190 });
  const bagImage = await solidImage(2, 1, { r: 130, g: 45, b: 160 });
  const source = (nodeId: string, imageUrl: string): NodeExecution => ({
    nodeId,
    kind: "image-input",
    inputImages: [],
    params: { imageUrl },
  });
  const personId = `queue-person-${testId}`;
  const sceneId = `queue-scene-${testId}`;
  const poseId = `queue-pose-${testId}`;
  const outfitId = `queue-outfit-${testId}`;
  const bagId = `queue-bag-${testId}`;
  const stageId = `queue-stage-${testId}`;
  const stage: NodeExecution = {
    nodeId: stageId,
    kind: "virtual-try-on",
    inputImages: [],
    upstream: [
      { nodeId: bagId, images: [], targetHandle: "bag" },
      { nodeId: sceneId, images: [], targetHandle: "scene" },
      { nodeId: poseId, images: [], targetHandle: "pose" },
      { nodeId: outfitId, images: [], targetHandle: "outfit" },
      { nodeId: personId, images: [], targetHandle: "person" },
    ],
    params: {
      workflowStage: "scene-stabilize",
      poseReferenceType: "depth",
      prompt: "",
      imageSize: "2K",
      modelId: "gemini-3.1-flash-image",
      modelOptions: { aspectRatio: "1:1", imageSize: "2K" },
    },
  };
  const fake = resolver(() => ({ images: [PNG_DATA_URL], model: "gemini-stub" }));
  const sceneInputs: string[] = [];
  const sceneAnalyzer: SceneAnalyzer = async (image, options) => {
    sceneInputs.push(image);
    await options?.beforeProviderCall?.(1);
    return {
      prompt: "环境：摄影棚；背景：暖灰；光线：柔光；镜头：平视；取景：全身；构图：纵深居中",
      providerRequests: 1,
      model: "scene-stub",
      cacheHit: false,
    };
  };
  const run = await queue.enqueueGenerationRun(
    {
      steps: [
        source(personId, personImage),
        source(sceneId, sceneImage),
        source(poseId, poseImage),
        source(outfitId, outfitImage),
        source(bagId, bagImage),
        stage,
      ],
    },
    owner.id,
    {
      ...context(stageId),
      nodeId: stageId,
      nodeLabel: "第一轮",
      kind: "virtual-try-on",
      referenceImages: [personImage, sceneImage, poseImage, outfitImage, bagImage],
    },
  );
  for (let index = 0; index < 6; index += 1) {
    assert.equal(await queue.processNextGenerationJob(`worker-roles-${testId}`, {
      resolveProvider: fake.resolveProvider,
      sceneAnalyzer,
      candidateSelector: async input => {
        assert.equal(input.poseReferenceType, 'depth');
        assert.equal(input.referenceImages[input.referenceRoles.indexOf('pose')], expectedPose);
        await input.beforeProviderCall?.(1);
        await input.beforeProviderCall?.(2);
        return { selectedIndex: 0, scores: [], model: 'judge-stub', providerRequests: 2, allHardFail: false };
      },
      now: () => tick(),
      random: () => 0,
    }), true);
  }
  assert.equal(fake.calls(), 1);
  assert.equal(sceneInputs.length, 1);
  assert.equal(fake.requests()[0].referenceImages?.length, 5);
  assert.equal(fake.requests()[0].referenceImages?.[0], expectedPose, "原始深度图必须直接进入生图请求");
  assert.doesNotMatch(fake.requests()[0].prompt, /姿势分析对原图的几何复核|身体姿势：/);
  assert.equal(fake.requests()[0].referenceImages?.at(-1), sceneInputs[0]);
  assert.match(fake.requests()[0].prompt, /【身份】参考图2是主要完整人物身份图/);
  assert.match(fake.requests()[0].prompt, /类型：深度图，亮近暗远/);
  assert.match(fake.requests()[0].prompt, /参考图2.*完整人物身份图/);
  assert.match(fake.requests()[0].prompt, /参考图3.*服装与搭配风格的唯一来源/);
  assert.match(fake.requests()[0].prompt, /参考图4只控制目标包袋/);
  assert.match(fake.requests()[0].prompt, /参考图1.*用户手动选择的原始姿势参考图/);
  assert.doesNotMatch(fake.requests()[0].prompt, /鞋履|帽子|戒指|耳环|手镯|未提供/);
  assert.deepEqual(await runRow(run.id), {
    status: "succeeded", error: null, provider_requests: 4, successful_count: 1,
  });
  const recorded = await database.queryOne<{ prompt: string; reference_images_json: string; parameters_json: string }>(
    "SELECT prompt, reference_images_json, parameters_json FROM generation_runs WHERE id = $1", [run.id],
  );
  assert.ok(recorded);
  assert.equal(recorded.prompt, fake.requests()[0].prompt);
  const manifest = JSON.parse(recorded.parameters_json).referenceManifest;
  assert.deepEqual(manifest.map((ref: { number: number; role: string }) => [ref.number, ref.role]),
    [[1, "pose"], [2, "person"], [3, "outfit"], [4, "bag"], [5, "scene"]]);
  const sourceRows = await database.query<{ node_id: string; output_images_json: string }>(
    "SELECT node_id, output_images_json FROM generation_run_steps WHERE run_id = $1", [run.id],
  );
  const sources = new Map(sourceRows.map(row => [row.node_id, JSON.parse(row.output_images_json)[0]]));
  const expectedReferences = [poseId, personId, outfitId, bagId, sceneId].map(id => sources.get(id));
  assert.deepEqual(JSON.parse(recorded.reference_images_json), expectedReferences);
  assert.deepEqual(manifest.map((ref: { image: string }) => ref.image), expectedReferences,
    "记录必须使用运行时解析到的文件 ID，不得保存入队前顺序或归一化后的 base64");
  const events = await queue.readDurableRunEvents(run.id, owner.id, 0);
  const prepared = events?.find(event => event.type === "node-status" && event.executionMeta?.sceneRequest);
  assert.ok(prepared?.type === "node-status");
  assert.deepEqual(prepared.executionMeta?.sceneRequest, { prompt: recorded.prompt, references: manifest });
});

await test("第一轮请求失败仍保留实际参考清单和最终提示词", async () => {
  const nodeId = `failed-scene-request-${++sequence}`;
  const roles = ["scene", "outfit", "person", "pose"];
  const images = await Promise.all(roles.map((_role, index) => solidImage(3, 4, { r: 30 + index * 40, g: 80, b: 90 })));
  const stage: NodeExecution = {
    nodeId, kind: "virtual-try-on", inputImages: [],
    upstream: roles.map((role, index) => ({ nodeId: `source-${role}`, targetHandle: role, images: [images[index]] })),
    params: { workflowStage: "scene-stabilize", modelId: "gemini-3.1-flash-image", imageSize: "2K", qualityMode: "fast" },
  };
  const fake = resolver(() => { throw new ProviderError("invalid request", 400, "stub", "invalid_request"); });
  const run = await queue.enqueueGenerationRun({ steps: [stage] }, owner.id, {
    ...context(nodeId), kind: "virtual-try-on", referenceImages: images,
  });
  await queue.processNextGenerationJob(`failed-scene-worker-${sequence}`, {
    resolveProvider: fake.resolveProvider,
    sceneAnalyzer: async () => ({ prompt: "摄影棚", providerRequests: 0, model: "stub", cacheHit: true }),
    now: () => tick(),
  });
  const row = await database.queryOne<{ status: string; prompt: string; reference_images_json: string }>(
    "SELECT status, prompt, reference_images_json FROM generation_runs WHERE id = $1", [run.id],
  );
  assert.equal(row?.status, "failed");
  assert.equal(row?.prompt, fake.requests()[0].prompt);
  assert.deepEqual(JSON.parse(row!.reference_images_json), [images[3], images[2], images[1], images[0]]);
});

for (const judgeMode of ['selected', 'error', 'indeterminate']) {
  const judgeAvailable = judgeMode !== 'error';
  const hasWinner = judgeMode === 'selected';
  await test(`最佳档位三张候选：${judgeMode}，独立评审重试计数与元数据完整保留`, async () => {
    const testId = ++sequence;
    const poseReview = { version: 1 as const, referenceType: 'depth' as const,
      candidates: parsePoseReviewCandidates([0, 1, 2].map(index => ({ index, checks: Object.fromEntries(
        Object.keys(POSE_REVIEW_LABELS).map(field => [field, { status: hasWinner ? 'match' : 'indeterminate', reference: '参考可见位置', candidate: '候选可见位置' }]),
      ) })), 3, 'depth') };
    const personImage = await solidImage(4, 4, { r: 200, g: 70, b: 50 });
    const sceneImage = await solidImage(3, 4, { r: 60, g: 130, b: 90 });
    const poseImage = await solidImage(3, 4, { r: 170, g: 65, b: 150 });
    const normalizedPose = await normalizeProviderImageDataUrl(poseImage);
    const expectedPose = `data:${normalizedPose.mimeType};base64,${normalizedPose.buffer.toString("base64")}`;
    const outfitImage = await solidImage(2, 3, { r: 40, g: 70, b: 180 });
    const candidates = [
      await solidImage(3, 4, { r: 220, g: 30, b: 30 }),
      await solidImage(3, 4, { r: 30, g: 220, b: 30 }),
      await solidImage(3, 4, { r: 30, g: 30, b: 220 }),
    ];
    let candidateIndex = 0;
    const fake = resolver(() => ({
      images: [candidates[candidateIndex++]],
      model: "gemini-stub",
    }));
    const source = (nodeId: string, imageUrl: string): NodeExecution => ({
      nodeId,
      kind: "image-input",
      inputImages: [],
      params: { imageUrl },
    });
    const personId = `candidate-person-${testId}`;
    const sceneId = `candidate-scene-${testId}`;
    const poseId = `candidate-pose-${testId}`;
    const outfitId = `candidate-outfit-${testId}`;
    const stageId = `candidate-stage-${testId}`;
    const stage: NodeExecution = {
      nodeId: stageId,
      kind: "virtual-try-on",
      inputImages: [],
      upstream: [
        { nodeId: sceneId, images: [], targetHandle: "scene" },
        { nodeId: poseId, images: [], targetHandle: "pose" },
        { nodeId: personId, images: [], targetHandle: "person" },
        { nodeId: outfitId, images: [], targetHandle: "outfit" },
      ],
      params: {
        workflowStage: "scene-stabilize",
        prompt: "保留目标穿搭",
        imageSize: "2K",
        modelId: "gemini-3.1-flash-image",
        modelOptions: { aspectRatio: "3:4", imageSize: "2K" },
        promptEnhancement: false,
        qualityMode: "best",
        safetyFallback: false,
        stylePresetId: "faithful",
      },
    };
    const run = await queue.enqueueGenerationRun(
      { steps: [source(personId, personImage), source(sceneId, sceneImage), source(poseId, poseImage), source(outfitId, outfitImage), stage] },
      owner.id,
      {
        ...context(stageId),
        nodeId: stageId,
        nodeLabel: "候选择优",
        kind: "virtual-try-on",
        referenceImages: [personImage, sceneImage, poseImage, outfitImage],
      },
    );
    for (let index = 0; index < 5; index += 1) {
      assert.equal(await queue.processNextGenerationJob(`worker-candidates-${testId}`, {
        resolveProvider: fake.resolveProvider,
        sceneAnalyzer: async (_image, options) => {
          await options?.beforeProviderCall?.(1);
          return { prompt: "环境：摄影棚；光线：左侧柔光；镜头：平视；构图：纵深居中", providerRequests: 1, model: "scene-stub", cacheHit: false };
        },
        candidateSelector: async (input) => {
          for (let request = 1; request <= 3; request++) await input.beforeProviderCall?.(request);
          assert.ok(input.referenceRoles.includes("scene"));
          assert.equal(input.referenceImages[input.referenceRoles.indexOf("pose")], expectedPose);
          assert.doesNotMatch(input.prompt, /姿势分析对原图的几何复核|身体姿势：/);
          if (!judgeAvailable) throw new Error("judge unavailable");
          return {
            selectedIndex: hasWinner ? 1 : null,
            poseReview,
            scores: [
              { index: 0, identity: 15, anatomy: 12, garment: 17, material: 15, accessories: 10, scene: 8, total: 77, hardFail: false, reasons: [] },
              { index: 1, identity: 19, anatomy: 14, garment: 19, material: 18, accessories: 14, scene: 9, total: 93, hardFail: false, reasons: [] },
              { index: 2, identity: 16, anatomy: 10, garment: 15, material: 15, accessories: 10, scene: 8, total: 74, hardFail: false, reasons: [] },
            ],
            model: "judge-stub",
            providerRequests: 3,
            allHardFail: false,
          };
        },
        now: () => tick(),
        random: () => 0,
      }), true);
    }
    assert.equal(fake.calls(), 3);
    assert.deepEqual(await runRow(run.id), {
      status: 'succeeded', error: hasWinner ? null : judgeAvailable ? '所有候选均未通过自动评审，请核对姿势与穿搭；已保留全部结果' : '候选自动评审未完成，全部候选已保留，请人工核对姿势后选择基准', provider_requests: 7, successful_count: hasWinner ? 1 : 3,
    });
    const stepRow = await database.queryOne<{ output_images_json: string; execution_meta_json: string }>(`
      SELECT output_images_json, execution_meta_json FROM generation_run_steps
      WHERE run_id = $1 AND node_id = $2
    `, [run.id, stageId]);
    assert.equal(JSON.parse(stepRow?.output_images_json ?? '[]').length, hasWinner ? 1 : 3);
    const selection = JSON.parse(stepRow?.execution_meta_json ?? '{}').tryOn.candidateSelection;
    assert.equal(selection?.selectedIndex, hasWinner ? 1 : judgeAvailable ? null : undefined);
    assert.deepEqual(selection?.poseReview, judgeAvailable ? poseReview : undefined);
    assert.equal((await database.queryOne<{ provider_requests: number }>('SELECT provider_requests FROM usage_events WHERE run_id = $1', [run.id]))?.provider_requests, 7);
    const events = await queue.readDurableRunEvents(run.id, owner.id, 0);
    assert.ok(events?.some(event => event.type === 'node-status' && event.nodeId === stageId && event.status === 'success' &&
      JSON.stringify(event.executionMeta?.tryOn) === JSON.stringify(JSON.parse(stepRow!.execution_meta_json).tryOn)));
    assert.equal((await database.queryOne<{ count: number }>(`
      SELECT COUNT(*)::int AS count FROM files WHERE run_id = $1 AND node_id = $2
    `, [run.id, stageId]))?.count, 3);
    assert.equal((await database.queryOne<{ count: number }>(`
      SELECT COUNT(*)::int AS count FROM generation_outputs WHERE run_id = $1 AND status = 'success'
    `, [run.id]))?.count, hasWinner ? 1 : 3);
  });
}

await test("同一付费请求号并发重试只创建一个 run，语义漂移返回冲突", async () => {
  const nodeId = `request-idempotency-${++sequence}`;
  const clientRequestId = `client-request-${sequence}`;
  const plan = { steps: [step(nodeId)] };
  const runContext = { ...context(nodeId), clientRequestId };
  let runId: string | undefined;
  try {
    const [first, second] = await Promise.all([
      queue.enqueueGenerationRun(plan, owner.id, runContext),
      queue.enqueueGenerationRun(plan, owner.id, runContext),
    ]);
    runId = first.id;
    assert.equal(second.id, first.id);
    assert.equal((await database.queryOne<{ count: number }>(`
      SELECT COUNT(*)::int AS count FROM generation_runs
      WHERE owner_id = $1 AND client_request_id = $2
    `, [owner.id, clientRequestId]))?.count, 1);
    assert.equal((await database.queryOne<{ count: number }>(`
      SELECT COUNT(*)::int AS count FROM generation_jobs WHERE run_id = $1
    `, [first.id]))?.count, 1);

    const changed = step(nodeId);
    changed.params = { ...changed.params, prompt: "另一份付费语义" };
    await assert.rejects(
      queue.enqueueGenerationRun({ steps: [changed] }, owner.id, runContext),
      queue.GenerationRequestConflictError,
    );
  } finally {
    if (runId) await database.query("DELETE FROM generation_runs WHERE id = $1", [runId]);
  }
});

await test("停用账号即使持有旧会话上下文也不能新建付费任务", async () => {
  const userId = `inactive-owner-${++sequence}`;
  const nodeId = `inactive-owner-node-${sequence}`;
  const createdAt = new Date().toISOString();
  await database.query(`
    INSERT INTO users (
      id, account_id, display_name, role, password_hash, active, created_at, updated_at
    ) VALUES ($1, $1, '已停用账号', 'user', 'test-only', 0, $2, $2)
  `, [userId, createdAt]);
  try {
    await assert.rejects(
      queue.enqueueGenerationRun(
        { steps: [step(nodeId)] },
        userId,
        { ...context(nodeId), userId, clientRequestId: `inactive-request-${sequence}` },
      ),
      queue.GenerationOwnerUnavailableError,
    );
    assert.equal((await database.queryOne<{ count: number }>(`
      SELECT COUNT(*)::int AS count FROM generation_runs WHERE owner_id = $1
    `, [userId]))?.count, 0);
  } finally {
    await database.query("DELETE FROM users WHERE id = $1", [userId]);
  }
});

await test("没有执行计划的历史 queued 行不占活动任务容量", async () => {
  const prefix = `legacy-active-${++sequence}-`;
  const nodeId = `legacy-capacity-node-${sequence}`;
  let runId: string | undefined;
  try {
    await database.query(`
      INSERT INTO generation_runs (
        id, owner_id, node_id, node_label, kind, requested_count, status, started_at
      )
      SELECT $1 || index, $2, 'legacy-node-' || index, '历史任务',
        'ai-modify', 1, 'queued', index
      FROM generate_series(1, 180) AS index
    `, [prefix, owner.id]);
    const run = await queue.enqueueGenerationRun(
      { steps: [step(nodeId)] },
      owner.id,
      { ...context(nodeId), clientRequestId: `legacy-capacity-request-${sequence}` },
    );
    runId = run.id;
    assert.ok(runId);
  } finally {
    await database.query("DELETE FROM generation_runs WHERE id LIKE $1", [`${prefix}%`]);
    if (runId) await database.query("DELETE FROM generation_runs WHERE id = $1", [runId]);
  }
});

await test("179 条活动任务下两个不同请求并发入队时只接受一个", async () => {
  const testId = ++sequence;
  const prefix = `capacity-race-${testId}-`;
  const acceptedRunIds: string[] = [];
  try {
    await database.query(`
      INSERT INTO generation_runs (
        id, owner_id, node_id, node_label, kind, requested_count, status, started_at, plan_json
      )
      SELECT $1 || index, $2, 'capacity-node-' || index, '容量任务',
        'ai-modify', 1, 'queued', index, '{"steps":[]}'
      FROM generate_series(1, 179) AS index
    `, [prefix, owner.id]);
    const outcomes = await Promise.allSettled(["a", "b"].map((suffix) => {
      const nodeId = `capacity-race-node-${testId}-${suffix}`;
      return queue.enqueueGenerationRun(
        { steps: [step(nodeId)] },
        owner.id,
        { ...context(nodeId), clientRequestId: `capacity-race-request-${testId}-${suffix}` },
      );
    }));
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<{ id: string }> => outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    acceptedRunIds.push(...fulfilled.map((outcome) => outcome.value.id));
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof queue.ActiveRunLimitError);
    assert.equal((await database.queryOne<{ count: number }>(`
      SELECT COUNT(*)::int AS count FROM generation_runs
      WHERE owner_id = $1
        AND deleted_at IS NULL
        AND plan_json IS NOT NULL
        AND status IN ('queued','running','retry_wait','cancel_requested')
    `, [owner.id]))?.count, 180);
  } finally {
    await database.query("DELETE FROM generation_runs WHERE id LIKE $1", [`${prefix}%`]);
    if (acceptedRunIds.length > 0) {
      await database.query("DELETE FROM generation_runs WHERE id = ANY($1::text[])", [acceptedRunIds]);
    }
  }
});

await test("已软删除的 queued Run 永远不会被 Worker 领取或调用上游", async () => {
  const fake = resolver(() => ({ images: [PNG_DATA_URL], model: "gpt-image-2-vip" }));
  const runId = await enqueueSingle("soft-deleted");
  try {
    await database.query(`
      UPDATE generation_runs SET deleted_at = $1, purge_after = $1 WHERE id = $2
    `, [new Date().toISOString(), runId]);
    assert.equal(await queue.processNextGenerationJob("worker-soft-deleted", {
      resolveProvider: fake.resolveProvider,
      now: () => tick(),
      random: () => 0,
    }), false);
    assert.equal(fake.calls(), 0);
  } finally {
    await database.query("DELETE FROM generation_runs WHERE id = $1", [runId]);
  }
});

await test("retry_wait 在 available_at 前不可领取，到期后才对 Worker 可见", async () => {
  const fake = resolver(() => ({ images: [PNG_DATA_URL], model: "gpt-image-2-vip" }));
  const runId = await enqueueSingle("available-at");
  const availableAt = tick(10_000);
  await database.query(
    "UPDATE generation_jobs SET status = 'retry_wait', available_at = $1 WHERE run_id = $2",
    [availableAt, runId],
  );
  await database.query("UPDATE generation_run_steps SET status = 'retry_wait' WHERE run_id = $1", [runId]);
  await database.query("UPDATE generation_runs SET status = 'retry_wait' WHERE id = $1", [runId]);

  assert.equal(await queue.processNextGenerationJob("worker-not-yet-available", {
    resolveProvider: fake.resolveProvider, now: () => availableAt - 1, random: () => 0,
  }), false);
  assert.equal(fake.calls(), 0);
  assert.equal((await runRow(runId))?.status, "retry_wait");

  assert.equal(await queue.processNextGenerationJob("worker-now-available", {
    resolveProvider: fake.resolveProvider, now: () => availableAt, random: () => 0,
  }), true);
  assert.equal(fake.calls(), 1);
  assert.equal((await runRow(runId))?.status, "succeeded");
});

await test("生成结果统一转为 PNG 且队列稳定键保持幂等", async () => {
  const key = `file-idempotency-${sequence += 1}`;
  const webp = await sharp({
    create: { width: 32, height: 24, channels: 3, background: { r: 31, g: 91, b: 173 } },
  }).webp({ quality: 90 }).toBuffer();
  const source = `data:image/webp;base64,${webp.toString("base64")}`;
  const first = await fileStore.persistMediaRefWithReceipt(source, key);
  const second = await fileStore.persistMediaRefWithReceipt(source, key);
  try {
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.id, first.id);
    assert.equal(second.url, first.url);
    assert.match(first.id, /^generated-[a-f0-9]{24}\.png$/);
    assert.equal(fileStore.mimeOfFile(first.id), "image/png");
    assert.equal((await sharp(path.join(fileStore.uploadsDir(), first.id)).metadata()).format, "png");
    assert.equal(fs.readdirSync(fileStore.uploadsDir()).filter((id) => id === first.id).length, 1);
  } finally {
    fileStore.deleteStoredImage(first.id);
  }
});

await test("内存执行链的 JPEG 结果也以 PNG 文件路由返回", async () => {
  const jpeg = await sharp({
    create: { width: 30, height: 20, channels: 3, background: { r: 190, g: 80, b: 42 } },
  }).jpeg({ quality: 90 }).toBuffer();
  const url = await fileStore.persistImageRef(`data:image/jpeg;base64,${jpeg.toString("base64")}`);
  const id = path.basename(url);
  try {
    assert.match(url, /^\/api\/files\/[A-Za-z0-9_-]{12}\.png$/);
    assert.equal(fileStore.mimeOfFile(id), "image/png");
    assert.equal((await sharp(path.join(fileStore.uploadsDir(), id)).metadata()).format, "png");
  } finally {
    fileStore.deleteStoredImage(id);
  }
});

await test("成功事务回滚会补偿删除本次新建的结果文件", async () => {
  const fake = resolver(() => ({ images: [PNG_DATA_URL], model: "gpt-image-2-vip" }));
  const runId = await enqueueSingle("rollback-file");
  const before = new Set(fs.readdirSync(fileStore.uploadsDir()));
  await database.query(`
    CREATE OR REPLACE FUNCTION reject_test_generation_success() RETURNS trigger AS $$
    BEGIN
      IF NEW.status = 'succeeded' AND NEW.node_id LIKE 'rollback-file-%' THEN
        RAISE EXCEPTION 'forced completion rollback';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER reject_test_generation_success_trigger
      BEFORE UPDATE ON generation_run_steps
      FOR EACH ROW EXECUTE FUNCTION reject_test_generation_success();
  `);
  try {
    const now = tick();
    assert.equal(await queue.processNextGenerationJob("worker-rollback-file", {
      resolveProvider: fake.resolveProvider, now: () => now, random: () => 0,
    }), true);
  } finally {
    await database.query("DROP TRIGGER IF EXISTS reject_test_generation_success_trigger ON generation_run_steps");
    await database.query("DROP FUNCTION IF EXISTS reject_test_generation_success()");
  }
  assert.equal(fake.calls(), 1);
  assert.equal((await runRow(runId))?.status, "failed");
  assert.equal((await database.queryOne<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM files WHERE run_id = $1", [runId],
  ))?.count, 0);
  assert.deepEqual(fs.readdirSync(fileStore.uploadsDir()).filter((id) => !before.has(id)), []);
});

await test("明确 429 最多自动重放两次并保留三次真实请求计数", async () => {
  const fake = resolver(() => {
    throw new ProviderError("AI 服务当前繁忙，请稍后重试", 429, "stub", "rate_limited");
  });
  const runId = await enqueueSingle("rate-limit");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = tick();
    assert.equal(await queue.processNextGenerationJob("worker-429", {
      resolveProvider: fake.resolveProvider, now: () => now, random: () => 0, retryDelaysMs: [0, 0],
    }), true);
  }
  assert.equal(fake.calls(), 3);
  assert.deepEqual(await runRow(runId), {
    status: "failed", error: "AI 服务当前繁忙，请稍后重试", provider_requests: 3, successful_count: 0,
  });
  const job = await database.queryOne<{ retry_count: number; status: string }>(
    "SELECT retry_count, status FROM generation_jobs WHERE run_id = $1", [runId],
  );
  assert.deepEqual(job, { retry_count: 2, status: "failed" });
  const now = tick();
  assert.equal(await queue.processNextGenerationJob("worker-429", {
    resolveProvider: fake.resolveProvider, now: () => now, random: () => 0, retryDelaysMs: [0, 0],
  }), false);
});

await test("视频轮询失败后从已保存任务恢复且不会重复提交", async () => {
  const runId = await enqueueVideo("video-resume");
  const originalFetch = globalThis.fetch;
  let postCalls = 0;
  let statusCalls = 0;
  const mp4 = Buffer.alloc(12);
  mp4.writeUInt32BE(12, 0);
  mp4.write("ftyp", 4, "ascii");
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      postCalls += 1;
      assert.ok(new Headers(init.headers).get("idempotency-key"));
      return Response.json({ id: "durable-video-task" });
    }
    if (url === "https://cdn.example/durable-video.mp4") return new Response(mp4);
    statusCalls += 1;
    return statusCalls === 1
      ? new Response(JSON.stringify({ error: "busy" }), { status: 429 })
      : Response.json({ status: "succeeded", content: { video_url: "https://cdn.example/durable-video.mp4" } });
  }) as typeof fetch;
  try {
    let now = tick();
    assert.equal(await queue.processNextGenerationJob("worker-video-resume", {
      now: () => now, random: () => 0, retryDelaysMs: [0, 0],
    }), true);
    assert.deepEqual(await database.queryOne<{
      status: string; retry_count: number; provider_task_id: string; provider_model: string;
    }>(`
      SELECT status, retry_count, provider_task_id, provider_model
      FROM generation_jobs WHERE run_id = $1
    `, [runId]), {
      status: "retry_wait",
      retry_count: 1,
      provider_task_id: "durable-video-task",
      provider_model: "doubao-seedance-2-5-260628",
    });
    assert.equal((await runRow(runId))?.provider_requests, 0, "运行汇总在终态前不提前发布");

    now = tick();
    assert.equal(await queue.processNextGenerationJob("worker-video-resume", {
      now: () => now, random: () => 0, retryDelaysMs: [0, 0],
    }), true);
    assert.equal(postCalls, 1);
    assert.equal(statusCalls, 2);
    assert.deepEqual(await runRow(runId), {
      status: "succeeded", error: null, provider_requests: 1, successful_count: 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("视频已受理但任务状态落库失败时终止为未知且不重提", async () => {
  const runId = await enqueueVideo("video-acceptance-persistence-failure");
  await database.query(`
    CREATE FUNCTION reject_video_task_state_for_test() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'simulated provider task persistence failure';
    END;
    $$ LANGUAGE plpgsql
  `);
  await database.query(`
    CREATE TRIGGER reject_video_task_state_for_test
    BEFORE UPDATE OF provider_task_id ON generation_jobs
    FOR EACH ROW WHEN (NEW.provider_task_id IS NOT NULL)
    EXECUTE FUNCTION reject_video_task_state_for_test()
  `);
  const originalFetch = globalThis.fetch;
  let postCalls = 0;
  let pollCalls = 0;
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "POST") {
      postCalls += 1;
      return Response.json({ id: "accepted-with-db-failure" });
    }
    pollCalls += 1;
    return Response.json({ status: "succeeded", content: { video_url: "https://cdn.example/unused.mp4" } });
  }) as typeof fetch;
  try {
    assert.equal(await queue.processNextGenerationJob("worker-video-persistence-failure", {
      now: () => tick(), random: () => 0, retryDelaysMs: [0, 0],
    }), true);
    assert.equal(postCalls, 1);
    assert.equal(pollCalls, 0);
    assert.deepEqual(await runRow(runId), {
      status: "outcome_unknown",
      error: "视频任务已受理但状态保存失败，结果状态未知；请核对 API易消耗记录后再决定是否重试：simulated provider task persistence failure",
      provider_requests: 1,
      successful_count: 0,
    });
    assert.deepEqual(await database.queryOne<{ status: string; retry_count: number }>(
      "SELECT status, retry_count FROM generation_jobs WHERE run_id = $1", [runId],
    ), { status: "outcome_unknown", retry_count: 0 });
  } finally {
    globalThis.fetch = originalFetch;
    await database.query("DROP TRIGGER reject_video_task_state_for_test ON generation_jobs");
    await database.query("DROP FUNCTION reject_video_task_state_for_test()");
  }
});

await test("Gemini IMAGE_SAFETY 最多自动重试两次并可在第三次成功", async () => {
  const fake = resolver((_request, call) => {
    if (call <= 2) {
      throw new ProviderError(
        "AI 图片安全审核暂时未通过，系统将按上限自动重试",
        422,
        "gemini-3.1-flash-image",
        "image_safety",
      );
    }
    return { images: [PNG_DATA_URL], model: "gemini-3.1-flash-image" };
  });
  const runId = await enqueueSingle("image-safety");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = tick();
    assert.equal(await queue.processNextGenerationJob("worker-image-safety", {
      resolveProvider: fake.resolveProvider, now: () => now, random: () => 0, retryDelaysMs: [0, 0],
    }), true);
  }
  assert.equal(fake.calls(), 3);
  assert.deepEqual(await runRow(runId), {
    status: "succeeded", error: null, provider_requests: 3, successful_count: 1,
  });
  assert.deepEqual(await database.queryOne<{ retry_count: number; status: string }>(
    "SELECT retry_count, status FROM generation_jobs WHERE run_id = $1", [runId],
  ), { retry_count: 2, status: "succeeded" });
});

await test("确认临时的 503 连续两次失败后第三次成功且请求数准确", async () => {
  const fake = resolver((_request, call) => {
    if (call <= 2) {
      throw new ProviderError("AI 服务暂时不可用，请稍后重试", 503, "stub", "gateway_unavailable");
    }
    return { images: [PNG_DATA_URL], model: "gpt-image-2-vip" };
  });
  const runId = await enqueueSingle("temporary-503");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = tick();
    assert.equal(await queue.processNextGenerationJob("worker-503", {
      resolveProvider: fake.resolveProvider, now: () => now, random: () => 0, retryDelaysMs: [0, 0, 0],
    }), true);
  }
  assert.equal(fake.calls(), 3);
  assert.deepEqual(await runRow(runId), {
    status: "succeeded", error: null, provider_requests: 3, successful_count: 1,
  });
});

await test("连续 503 按 5/30 秒退避，第 3 次失败后终止", async () => {
  const fake = resolver(() => {
    throw new ProviderError("AI 服务暂时不可用，请稍后重试", 503, "stub", "gateway_unavailable");
  });
  const runId = await enqueueSingle("persistent-503");
  const expectedDelays = [5_000, 30_000];
  let attemptNow = tick();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(await queue.processNextGenerationJob("worker-persistent-503", {
      resolveProvider: fake.resolveProvider, now: () => attemptNow, random: () => 0,
    }), true);
    if (attempt < expectedDelays.length) {
      const job = await database.queryOne<{ retry_count: number; status: string; available_at: number }>(
        "SELECT retry_count, status, available_at FROM generation_jobs WHERE run_id = $1", [runId],
      );
      assert.deepEqual({ retry_count: job?.retry_count, status: job?.status }, {
        retry_count: attempt + 1, status: "retry_wait",
      });
      assert.equal((job?.available_at ?? 0) - attemptNow, expectedDelays[attempt]);
      attemptNow = job!.available_at;
    }
  }
  clock = Math.max(clock, attemptNow);
  assert.equal(fake.calls(), 3);
  assert.deepEqual(await runRow(runId), {
    status: "failed", error: "AI 服务暂时不可用，请稍后重试", provider_requests: 3, successful_count: 0,
  });
  assert.deepEqual(await database.queryOne<{ retry_count: number; status: string }>(
    "SELECT retry_count, status FROM generation_jobs WHERE run_id = $1", [runId],
  ), { retry_count: 2, status: "failed" });
});

await test("GPT Image 2.5 不确定结果不自动重放付费请求", async () => {
  const fake = resolver(() => {
    throw new ProviderError("transport interrupted", 504, "gpt-image-2.5-flare-2026-09-08", "outcome_unknown");
  });
  const runId = await enqueueSingle("gpt25-unknown");
  await queue.processNextGenerationJob("worker-gpt25", {
    resolveProvider: fake.resolveProvider, now: () => tick(), random: () => 0, retryDelaysMs: [0, 0],
  });
  assert.equal(fake.calls(), 1);
  const unknown = await runRow(runId);
  assert.equal(unknown?.status, "outcome_unknown");
  assert.match(unknown?.error ?? "", /未自动重试/);
  assert.deepEqual(await database.queryOne<{ retry_count: number; status: string }>(
    "SELECT retry_count, status FROM generation_jobs WHERE run_id = $1", [runId],
  ), { retry_count: 0, status: "outcome_unknown" });
});

await test("超时或连接不确定结果最多自动重放两次，耗尽后进入 outcome_unknown", async () => {
  const fake = resolver(() => {
    throw new ProviderError(
      "AI 请求已超时，结果可能已经生成；系统将按上限自动重试，可能产生重复扣费",
      504,
      "stub",
      "outcome_unknown",
    );
  });
  const runId = await enqueueSingle("unknown");
  let now = tick();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(await queue.processNextGenerationJob("worker-unknown", {
      resolveProvider: fake.resolveProvider, now: () => now, random: () => 0, retryDelaysMs: [0, 0],
    }), true);
    now = tick();
  }
  assert.equal(fake.calls(), 3);
  const unknown = await runRow(runId);
  assert.equal(unknown?.status, "outcome_unknown");
  assert.equal(unknown?.provider_requests, 3);
  assert.match(unknown?.error ?? "", /核对 API易消耗记录/);
  assert.match(unknown?.error ?? "", /最多 2 次自动重试/);
  assert.equal(await queue.processNextGenerationJob("worker-unknown", {
    resolveProvider: fake.resolveProvider, now: () => now, random: () => 0, retryDelaysMs: [0, 0],
  }), false);
  assert.equal(fake.calls(), 3);
});

await test("invalid_response 是确定失败且不会进入自动重试", async () => {
  const fake = resolver(() => {
    throw new ProviderError("AI 服务返回了损坏的图片数据", 502, "stub", "invalid_response");
  });
  const runId = await enqueueSingle("invalid-response");
  let now = tick();
  assert.equal(await queue.processNextGenerationJob("worker-invalid-response", {
    resolveProvider: fake.resolveProvider, now: () => now, random: () => 0, retryDelaysMs: [0, 0],
  }), true);
  assert.equal(fake.calls(), 1);
  assert.equal((await runRow(runId))?.status, "failed");
  const job = await database.queryOne<{ retry_count: number; status: string }>(
    "SELECT retry_count, status FROM generation_jobs WHERE run_id = $1", [runId],
  );
  assert.deepEqual(job, { retry_count: 0, status: "failed" });
  now = tick();
  assert.equal(await queue.processNextGenerationJob("worker-invalid-response", {
    resolveProvider: fake.resolveProvider, now: () => now, random: () => 0, retryDelaysMs: [0, 0],
  }), false);
  assert.equal(fake.calls(), 1);
});

await test("租约在上游调用前过期可安全重排，调用开始后中断最多自动重试两次", async () => {
  const safeRunId = await enqueueSingle("lease-safe");
  const expiredAt = tick();
  await database.query(`
    UPDATE generation_jobs SET status = 'running', worker_id = 'dead-worker', lease_expires_at = $1,
      attempt_started_at = NULL WHERE run_id = $2
  `, [expiredAt - 1, safeRunId]);
  await database.query("UPDATE generation_run_steps SET status = 'running' WHERE run_id = $1", [safeRunId]);
  await database.query("UPDATE generation_runs SET status = 'running' WHERE id = $1", [safeRunId]);
  assert.equal(await queue.recoverExpiredGenerationJobs(expiredAt), 1);
  assert.equal((await runRow(safeRunId))?.status, "queued");
  const safeFake = resolver(() => ({ images: [PNG_DATA_URL], model: "gpt-image-2-vip" }));
  const safeNow = tick();
  assert.equal(await queue.processNextGenerationJob("worker-recovered", {
    resolveProvider: safeFake.resolveProvider, now: () => safeNow, random: () => 0,
  }), true);
  assert.equal((await runRow(safeRunId))?.status, "succeeded");

  const unknownRunId = await enqueueSingle("lease-unknown");
  const unknownExpiry = tick();
  await database.query(`
    UPDATE generation_jobs SET status = 'running', worker_id = 'dead-worker', lease_expires_at = $1,
      attempt_started_at = $2 WHERE run_id = $3
  `, [unknownExpiry - 1, unknownExpiry - 100, unknownRunId]);
  await database.query(`
    UPDATE generation_run_steps SET status = 'running', provider_requests = 1 WHERE run_id = $1
  `, [unknownRunId]);
  await database.query("UPDATE generation_runs SET status = 'running' WHERE id = $1", [unknownRunId]);
  assert.equal(await queue.recoverExpiredGenerationJobs(unknownExpiry), 1);
  assert.equal((await runRow(unknownRunId))?.status, "retry_wait");

  for (let retry = 1; retry <= 2; retry += 1) {
    const nextExpiry = tick() + 30_000;
    await database.query(`
      UPDATE generation_jobs SET status = 'running', worker_id = 'dead-worker', lease_expires_at = $1,
        attempt_started_at = $2, available_at = $2 WHERE run_id = $3
    `, [nextExpiry - 1, nextExpiry - 100, unknownRunId]);
    await database.query(`
      UPDATE generation_run_steps SET status = 'running', provider_requests = $1 WHERE run_id = $2
    `, [retry + 1, unknownRunId]);
    await database.query("UPDATE generation_runs SET status = 'running' WHERE id = $1", [unknownRunId]);
    assert.equal(await queue.recoverExpiredGenerationJobs(nextExpiry), 1);
  }
  const unknown = await runRow(unknownRunId);
  assert.equal(unknown?.status, "outcome_unknown");
  assert.equal(unknown?.provider_requests, 3);
  assert.match(unknown?.error ?? "", /核对 API易消耗记录/);
});

await test("GPT 2.5 调用后 Worker 租约过期保留未知结果且不自动重放", async () => {
  for (const modelId of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst", undefined]) {
    const planned = step(`lease-gpt25-${modelId ?? "default"}-${++sequence}`);
    planned.params.modelId = modelId;
    const { id: runId } = await queue.enqueueGenerationRun({ steps: [planned] }, owner.id, context(planned.nodeId));
    const expiredAt = tick();
    await database.query(`
      UPDATE generation_jobs SET status = 'running', worker_id = 'dead-worker',
        lease_expires_at = $1, attempt_started_at = $2 WHERE run_id = $3
    `, [expiredAt - 1, expiredAt - 100, runId]);
    await database.query("UPDATE generation_run_steps SET status = 'running', provider_requests = 1 WHERE run_id = $1", [runId]);
    await database.query("UPDATE generation_runs SET status = 'running' WHERE id = $1", [runId]);
    assert.equal(await queue.recoverExpiredGenerationJobs(expiredAt), 1);
    assert.equal((await runRow(runId))?.status, "outcome_unknown");
    assert.deepEqual(await database.queryOne<{ status: string; retry_count: number }>(
      "SELECT status, retry_count FROM generation_jobs WHERE run_id = $1", [runId],
    ), { status: "outcome_unknown", retry_count: 0 });
  }
});

await test("视频任务在受理状态落库前中断时禁止自动重提", async () => {
  const runId = await enqueueVideo("video-untracked");
  const expiredAt = tick();
  await database.query(`
    UPDATE generation_jobs SET status = 'running', worker_id = 'dead-video-worker',
      lease_expires_at = $1, attempt_started_at = $2 WHERE run_id = $3
  `, [expiredAt - 1, expiredAt - 100, runId]);
  await database.query(`
    UPDATE generation_run_steps SET status = 'running', provider_requests = 1 WHERE run_id = $1
  `, [runId]);
  await database.query("UPDATE generation_runs SET status = 'running' WHERE id = $1", [runId]);
  assert.equal(await queue.recoverExpiredGenerationJobs(expiredAt), 1);
  const row = await runRow(runId);
  assert.equal(row?.status, "outcome_unknown");
  assert.equal(row?.provider_requests, 1);
  assert.match(row?.error ?? "", /禁止自动重提/);
  assert.deepEqual(await database.queryOne<{ status: string; retry_count: number }>(
    "SELECT status, retry_count FROM generation_jobs WHERE run_id = $1", [runId],
  ), { status: "outcome_unknown", retry_count: 0 });
});

await test("同一 run 的并发事件通过原子序号严格递增且无缺口", async () => {
  const runId = await enqueueSingle("concurrent-events");
  const first = await database.db().connect();
  const second = await database.db().connect();
  let secondAppend: Promise<unknown> | undefined;
  try {
    await first.query("BEGIN");
    await second.query("BEGIN");
    const firstEvent = await queue.appendRunEvent(first, runId, {
      type: "node-status", nodeId: "concurrent-events-a", status: "queued",
    }, tick());
    let secondSettled = false;
    secondAppend = queue.appendRunEvent(second, runId, {
      type: "node-status", nodeId: "concurrent-events-b", status: "queued",
    }, tick()).then((event) => { secondSettled = true; return event; });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(secondSettled, false, "第二个事务应等待同一 run 的序号分配锁");
    await first.query("COMMIT");
    const secondEvent = await secondAppend as { seq?: number };
    await second.query("COMMIT");
    assert.deepEqual([firstEvent.seq, secondEvent.seq], [2, 3]);
  } finally {
    await first.query("ROLLBACK").catch(() => undefined);
    await second.query("ROLLBACK").catch(() => undefined);
    await secondAppend?.catch(() => undefined);
    first.release();
    second.release();
  }
  const events = await queue.readDurableRunEvents(runId, owner.id, 0);
  assert.deepEqual(events?.map((event) => event.seq), [1, 2, 3]);
  await database.query("DELETE FROM generation_runs WHERE id = $1", [runId]);
});

await test("SSE 在观察到终态后再次 drain，发送同一提交中的最后事件", async () => {
  const request = new EventEmitter() as EventEmitter & Request;
  request.get = () => undefined;
  const writes: string[] = [];
  let ended = false;
  const response = {
    writeHead: () => response,
    write: (chunk: string) => { writes.push(chunk); return true; },
    end: () => { ended = true; return response; },
  } as unknown as Response;
  let reads = 0;
  await streamDurableRunEvents("race-run", owner.id, request, response, {
    readEvents: async (_runId, _ownerId, afterSeq) => {
      reads += 1;
      if (afterSeq === 0) {
        return [{ type: "node-status", nodeId: "race-node", status: "running", seq: 1 }];
      }
      if (afterSeq === 1) {
        return [
          {
            type: "node-status", nodeId: "race-node", status: "success",
            images: ["/api/files/race.png"], seq: 2,
          },
          { type: "done", seq: 3 },
        ];
      }
      return [];
    },
    getRun: async () => ({ id: "race-run", status: "succeeded", finished: true }),
    wait: async () => undefined,
  });
  const body = writes.join("");
  assert.equal(reads, 2);
  assert.match(body, /id: 2/);
  assert.match(body, /\"type\":\"done\"/);
  assert.equal(ended, true);
});

await test("直连蒙版任务把第一张参考图持久绑定为 maskSourceRef", async () => {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    (req as AuthenticatedRequest).authUser = {
      id: owner.id, accountId: "queue-admin", displayName: "Queue Admin",
      role: "admin", mustChangePassword: false,
    };
    next();
  });
  app.use("/api/generate", generateRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientRequestId: "direct-mask-request",
        modelId: "gpt-image-2",
        kind: "mask-redraw",
        nodeId: "direct-mask-test",
        request: {
          prompt: "只修改左侧衣袖",
          referenceImages: [PNG_DATA_URL],
          mask: PNG_DATA_URL,
          maskMode: "replace",
          modelOptions: {},
        },
      }),
    });
    const body = await response.json() as { runId?: string; error?: string };
    assert.equal(response.status, 202, body.error);
    assert.ok(body.runId);
    const stored = await database.queryOne<{ step_json: string }>(
      "SELECT step_json FROM generation_run_steps WHERE run_id = $1", [body.runId],
    );
    assert.ok(stored);
    const queuedStep = JSON.parse(stored.step_json) as NodeExecution;
    assert.equal(queuedStep.kind, "mask-redraw");
    assert.deepEqual(queuedStep.inputImages, [PNG_DATA_URL]);
    assert.equal(queuedStep.params.maskSourceRef, PNG_DATA_URL);
    assert.equal(queuedStep.params.maskMode, undefined);
    assert.equal(queuedStep.params.maskPipelineVersion, 3);
    const storedRun = await database.queryOne<{ parameters_json: string }>(
      "SELECT parameters_json FROM generation_runs WHERE id = $1", [body.runId],
    );
    const parameters = JSON.parse(storedRun?.parameters_json ?? "{}") as Record<string, unknown>;
    assert.equal(parameters.maskMode, undefined);
    assert.equal(parameters.maskPipelineVersion, 3);

    const overLimitResponse = await fetch(`http://127.0.0.1:${address.port}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientRequestId: "direct-mask-over-limit",
        modelId: "gpt-image-2",
        kind: "mask-redraw",
        nodeId: "direct-mask-over-limit",
        request: {
          prompt: "局部修改",
          referenceImages: Array.from({ length: 8 }, () => PNG_DATA_URL),
          mask: PNG_DATA_URL,
          modelOptions: {},
        },
      }),
    });
    const overLimitBody = await overLimitResponse.json() as { error?: string };
    assert.equal(overLimitResponse.status, 400);
    assert.match(overLimitBody.error ?? "", /at most 7 user images/);

    await database.query("DELETE FROM generation_runs WHERE id = $1", [body.runId]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

await test("500 个 job 的领取计划无 Sort 且 claimNextJob P95 小于 50ms", async () => {
  const runIds: string[] = [];
  for (let runIndex = 0; runIndex < 100; runIndex += 1) {
    sequence += 1;
    const nodes = Array.from({ length: 5 }, (_value, stepIndex) => "perf-" + sequence + "-" + stepIndex);
    const steps = nodes.map((nodeId, stepIndex) => step(
      nodeId,
      stepIndex === 0 ? undefined : [{ nodeId: nodes[stepIndex - 1], images: [] }],
    ));
    const run = await queue.enqueueGenerationRun({ steps }, owner.id, context(nodes.at(-1)!));
    runIds.push(run.id);
  }
  try {
    assert.equal((await database.queryOne<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM generation_jobs WHERE run_id = ANY($1::text[])", [runIds],
    ))?.count, 500);
    await database.query("ANALYZE generation_jobs, generation_run_steps, generation_runs");
    const benchmarkNow = tick(10_000);
    const explain = await database.query<{ "QUERY PLAN": Array<{ Plan: ExplainPlanNode }> }>(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + queue.CLAIM_NEXT_JOB_SQL,
      [benchmarkNow],
    );
    const root = explain[0]?.["QUERY PLAN"]?.[0]?.Plan;
    assert.ok(root);
    const sortNodes = flattenPlan(root).filter((node) => node["Node Type"].includes("Sort"));
    assert.deepEqual(sortNodes.map((node) => ({
      nodeType: node["Node Type"], sortMethod: node["Sort Method"] ?? null,
    })), []);

    const durations: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const started = process.hrtime.bigint();
      const claimed = await queue.claimNextJob("perf-worker-" + index, benchmarkNow, 60_000);
      durations.push(Number(process.hrtime.bigint() - started) / 1_000_000);
      assert.ok(claimed && runIds.includes(claimed.runId));
    }
    durations.sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
    assert.ok(p95 < 50, "claimNextJob P95 " + p95.toFixed(2) + "ms exceeds 50ms");
    console.log("    claimNextJob P95 " + p95.toFixed(2) + "ms");
  } finally {
    await database.query("DELETE FROM generation_runs WHERE id = ANY($1::text[])", [runIds]);
  }
});

await database.closeDatabaseForTests();
fs.rmSync(temp, { recursive: true, force: true });
console.log(`\n通过 ${passed} 项`);

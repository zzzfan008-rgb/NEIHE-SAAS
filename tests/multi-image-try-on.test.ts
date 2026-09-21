import assert from "node:assert/strict";
import fs from "node:fs";
import sharp from "sharp";
import { PROVIDER_TARGET_BYTES } from "../server/lib/uploadImageNormalization";
import { planMultiImageReferences, multiImageReferenceError, MULTI_IMAGE_TRY_ON_ROLES, readMultiImageReferenceManifest, isDirectMultiImagePoseNode } from "../src/lib/multiImageTryOn";
import { prepareMultiImageTryOn, stitchReferenceImages } from "../server/lib/multiImageTryOn";
import { copyMultiImageTryOnTemplate } from "../src/lib/multiImageTryOnTemplate";
import { createDocumentSnapshot, documentSnapshotToPersistedWorkflow } from "../src/lib/documentSnapshot";
import { validateAndMigrateFlow } from "../server/lib/workflowSchema";
import { inputPortSpecs } from "../src/lib/workflowPorts";
import { buildExecutionPlan, assertPlanInputs } from "../server/engine/dag";
import { executeStep } from "../server/engine/runner";
import { parseDataUrl } from "../server/providers/base";
import { selectActiveDocument, useFlowStore, applyRunEventToRecentResults } from "../src/store/flowStore";
import type { GenerationRequestSnapshot } from "../server/lib/generationRecords";
import type { ImageGenRequest, VirtualTryOnNodeData, WorkflowTemplate } from "../src/types/workflow";

const pro = "gemini-3-pro-image-preview";
const baseRoles = ["pose", "person", "scene", "outfit", "shoes", "socks", "hat"];
const allRoles = [...MULTI_IMAGE_TRY_ON_ROLES, "detail", "detail", "detail", "detail"];
for (const count of [4, 5, 6, 7, 20]) {
  const roles = count === 20 ? allRoles : baseRoles.slice(0, count);
  const refs = roles.map((role, index) => ({ role, id: `original-${index}` })).reverse();
  const before = JSON.stringify(refs);
  const groups = planMultiImageReferences(refs, pro);
  assert.equal(JSON.stringify(refs), before);
  assert.deepEqual(groups.slice(0, 3).map(group => group.role), ["pose", "person", "scene"]);
  assert.equal(groups.flatMap(group => group.members).length, count, "不丢弃任何素材");
  assert.ok(groups.length <= 6);
  if (count <= 6) assert.ok(groups.every(group => group.members.length === 1), "六张及以下不拼接");
  if (count > 6) assert.ok(groups.find(group => group.role === "footwear")?.members.length === 2);
  assert.equal(multiImageReferenceError(roles), undefined);
}
assert.equal(planMultiImageReferences(allRoles.map(role => ({ role })), "gemini-3.1-flash-image").length, 20, "只对Pro使用六图策略，其他模型另行校验自己的上限");
assert.match(multiImageReferenceError(["person", "scene", "outfit"])!, /姿势/);
assert.match(multiImageReferenceError([...baseRoles, "person"])!, /人物/);
assert.match(multiImageReferenceError([...baseRoles, "unknown"])!, /不支持/);
assert.match(multiImageReferenceError([...allRoles, "hat"])!, /20/);

const images = await Promise.all(allRoles.map(async (_, index) => {
  const buffer = await sharp({ create: { width: 48 + index, height: 72, channels: 3,
    background: { r: index * 10, g: 90, b: 160 } } }).png().toBuffer();
  return `data:image/png;base64,${buffer.toString("base64")}`;
}));
assert.equal(await stitchReferenceImages([images[0]]), images[0]);
const joined = await stitchReferenceImages([images[0], images[1]]);
const sheet = await sharp(parseDataUrl(joined).buffer).metadata();
assert.deepEqual([sheet.width, sheet.height, sheet.format], [2072, 1024, "png"]);
// Uniform rectangular source remains centered, uncropped and unstretched.
const sheetRaw = await sharp(parseDataUrl(joined).buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const pixel = (x: number, y: number) => Array.from(sheetRaw.data.subarray((y * sheetRaw.info.width + x) * 3, (y * sheetRaw.info.width + x) * 3 + 3));
assert.deepEqual(pixel(512, 512), [0, 90, 160]);
assert.deepEqual(pixel(0, 0), [255, 255, 255]);
// Worst-case detailed sheets must still fit provider byte limits.
let seed = 123456;
const noisyImages: string[] = [];
for (let index = 0; index < 9; index++) {
  const raw = Buffer.alloc(1024 * 1024 * 3);
  for (let offset = 0; offset < raw.length; offset++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    raw[offset] = seed >>> 24;
  }
  const encoded = await sharp(raw, { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer();
  noisyImages.push(`data:image/png;base64,${encoded.toString("base64")}`);
}
const boundedSheet = parseDataUrl(await stitchReferenceImages(noisyImages));
assert.ok(boundedSheet.buffer.length <= PROVIDER_TARGET_BYTES, "高细节配饰拼图不超过Provider大小限制");
assert.equal(boundedSheet.mime, "image/jpeg", "大拼图触发有界压缩，普通小拼图仍保持PNG");
const packed = await prepareMultiImageTryOn(images, allRoles, images, pro);
assert.equal(packed.referenceImages.length, 6);
assert.deepEqual(packed.referenceImages.slice(0, 3), images.slice(0, 3), "前三张原图原样传递");
assert.equal(packed.references.length, 20);
assert.deepEqual(readMultiImageReferenceManifest(packed.references), packed.references);
assert.equal(readMultiImageReferenceManifest([{ ...packed.references[0], number: 2 }, ...packed.references.slice(1)]), undefined);
const history = applyRunEventToRecentResults([{
  id: "multi-record", nodeId: "stabilize", nodeLabel: "多图编辑", kind: "virtual-try-on", image: "", status: "queued", startedAt: 1,
  parameters: { workflowStage: "scene-stabilize", sceneInputMode: "multi-reference-edit" },
}], "multi-record", { type: "node-status", nodeId: "stabilize", status: "running",
  executionMeta: { sceneRequest: { prompt: "最终分组提示词", references: packed.references } } });
assert.equal(history[0].prompt, "最终分组提示词");
assert.deepEqual(history[0].parameters?.referenceManifest, packed.references, "运行记录支持拼图中的重复参数编号");
assert.deepEqual(history[0].referenceImages, packed.references.map(ref => ref.image), "历史记录保留素材来源，不持久化临时拼图DataURL");
assert.match(packed.instructions, /参考图6拼图第1行第1列：包袋/);
await assert.rejects(prepareMultiImageTryOn(images, ["pose"], images, pro), /信息不完整/);

const template = JSON.parse(fs.readFileSync(new URL("../templates/multi-image-try-on.workflow.json", import.meta.url), "utf8")) as WorkflowTemplate;
const validated = validateAndMigrateFlow(template.flow);
assert.equal(isDirectMultiImagePoseNode("pose", validated.nodes, validated.edges), true);
const legacyStage = { id: "legacy-stage", data: { kind: "virtual-try-on", workflowStage: "scene-stabilize" } };
assert.equal(isDirectMultiImagePoseNode("pose", [...validated.nodes, legacyStage], [...validated.edges,
  { source: "pose", target: "legacy-stage", targetHandle: "pose" }]), false, "同图仍连接旧流程时保留旧提示词入口");
assert.equal(template.name, "多图编辑换装+修改");
assert.ok(!validated.nodes.some(node => node.data.kind === "ai-modify" || (node.data.kind === "virtual-try-on" && node.data.workflowStage === "garment-refine")));
assert.equal(validated.nodes.filter(node => node.data.kind === "virtual-try-on" || node.data.kind === "mask-redraw").length, 2);
assert.ok(!validated.edges.some(edge => edge.target === "garment-detail" && edge.targetHandle === "repair-source"), "用户必须选择具体成片，不自动串行修改");
assert.ok(validated.nodes.every(node => node.data.kind !== "image-input" || !node.data.imageUrl), "模板不携带原项目私有照片");
assert.ok(validated.nodes.some(node => node.data.kind === "ti-angle"), "保留原副本3D拍摄设置");
const immutable = JSON.stringify(validated);
const recopy = copyMultiImageTryOnTemplate(validated);
assert.equal(JSON.stringify(validated), immutable, "复制函数不修改来源");
assert.equal(recopy.name, template.name);
const persisted = documentSnapshotToPersistedWorkflow(createDocumentSnapshot({ projectName: template.name, ...validated }));
const roundtrip = validateAndMigrateFlow(persisted);
const data = roundtrip.nodes.find(node => node.id === "stabilize")!.data as VirtualTryOnNodeData;
assert.equal(data.sceneInputMode, "multi-reference-edit");
assert.deepEqual(inputPortSpecs(data).filter(port => port.required).map(port => port.id), ["pose", "person", "scene", "outfit"]);
useFlowStore.getState().loadFlow({ ...roundtrip, projectName: template.name });
assert.equal(selectActiveDocument(useFlowStore.getState()).nodes.find(node => node.id === "stabilize")!.data.sceneInputMode, "multi-reference-edit");

const flow = structuredClone(roundtrip);
for (const node of flow.nodes) {
  if (node.data.kind === "image-input") {
    node.data.imageUrl = images[baseRoles.indexOf(node.id)] ?? images[8];
    if (!flow.edges.some(edge => edge.source === node.id && edge.target === "stabilize")) {
      flow.edges.push({ id: `test-${node.id}`, source: node.id, sourceHandle: "image", target: "stabilize", targetHandle: node.data.autoConnectTargets![0].targetHandle });
    }
  }
}
const plan = buildExecutionPlan(flow.nodes, flow.edges, { onlyNodeId: "stabilize", includeDownstream: false });
assert.doesNotThrow(() => assertPlanInputs(plan, flow.edges), "原图数量可以超过模型有效参数图数量");
assert.ok(plan.steps[0].params.angleControl, "拍摄设置继续进入执行参数");
const missingPosePlan = { ...plan, steps: plan.steps.map(step => ({ ...step, upstream: step.upstream?.filter(ref => ref.targetHandle !== "pose") })) };
assert.throws(() => assertPlanInputs(missingPosePlan, flow.edges), /姿势/);
const flashPlan = { ...plan, steps: plan.steps.map(step => ({ ...step, params: { ...step.params, modelId: "gemini-3.1-flash-image" } })) };
assert.throws(() => assertPlanInputs(flashPlan, flow.edges), /at most/, "Flash原有限额不被Pro拼接特例绕过");

const oldFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("禁止网络：测试不能调用真实模型"); };
try {
  for (const roles of [baseRoles.slice(0, 5), baseRoles.slice(0, 6), baseRoles, allRoles]) {
    const sourceImages = roles.map(role => images[allRoles.indexOf(role)]);
    const shuffledRoles = [...roles].reverse();
    const shuffledImages = [...sourceImages].reverse();
    let calls = 0;
    let recorded: GenerationRequestSnapshot | undefined;
    const edit = async (request: ImageGenRequest) => {
      calls++;
      assert.ok(request.referenceImages!.length <= 6);
      assert.deepEqual(request.referenceImages!.slice(0, 3), sourceImages.slice(0, 3));
      if (roles.length <= 6) assert.deepEqual(request.referenceImages, sourceImages);
      assert.match(request.prompt, /直接输出完整成片/);
      assert.match(request.prompt, /针织组织、蕾丝、缝线/);
      assert.doesNotMatch(request.prompt, /不强求针目|完成第一轮场景化/);
      return { images: [images[0]], model: pro };
    };
    const result = await executeStep({ nodeId: "stabilize", kind: "virtual-try-on", inputImages: shuffledImages,
      params: { ...data, sceneFraming: "scene" } }, shuffledImages,
    () => ({ id: pro, edit, generate: async () => { throw new Error("必须多图编辑，不得文生图"); } }), {
      referenceRoles: shuffledRoles,
      sceneAnalyzer: async () => { throw new Error("不得先分析重建场景"); },
      onSceneRequestPrepared: async snapshot => { recorded = snapshot; },
      candidateSelector: async input => {
        assert.equal(input.referenceImages.length, roles.length, "评审仍可核对所有原始素材");
        return { selectedIndex: 0, scores: [], model: "mock", providerRequests: 0, allHardFail: false };
      },
    });
    assert.equal(calls, 1, "仅一次图像编辑，不生成人物底图或自动精修");
    assert.equal(result.images.length, 1);
    assert.equal(recorded!.references.length, roles.length, "记录保留全部原图与参数编号映射");
    assert.deepEqual(recorded!.references.slice(0, 3).map(ref => ref.role), ["pose", "person", "scene"]);
  }
} finally { globalThis.fetch = oldFetch; }
console.log("多图编辑换装：排序、六图边界、20图拼接、像素几何、模板复制/持久化、DAG与模拟模型请求通过（无付费调用）");

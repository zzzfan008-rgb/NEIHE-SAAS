import assert from "node:assert/strict";
import fs from "node:fs";
import sharp from "sharp";
import { PROVIDER_TARGET_BYTES } from "../server/lib/uploadImageNormalization";
import { planMultiImageReferences, multiImageReferenceError, MULTI_IMAGE_TRY_ON_ROLES, readMultiImageReferenceManifest, isDirectMultiImagePoseNode } from "../src/lib/multiImageTryOn";
import { multiImageTryOnPrompt, prepareMultiImageTryOn, stitchReferenceImages } from "../server/lib/multiImageTryOn";
import { copyMultiImageTryOnTemplate } from "../src/lib/multiImageTryOnTemplate";
import { createDocumentSnapshot, documentSnapshotToPersistedWorkflow } from "../src/lib/documentSnapshot";
import { validateAndMigrateFlow } from "../server/lib/workflowSchema";
import { inputPortSpecs } from "../src/lib/workflowPorts";
import { buildExecutionPlan, assertPlanInputs } from "../server/engine/dag";
import { executeStep } from "../server/engine/runner";
import { parseDataUrl } from "../server/providers/base";
import { apiyiProviders } from "../server/providers/apiyi";
import { selectActiveDocument, selectCanRetryMultiImage, useFlowStore, applyRunEventToRecentResults, type RecentResult } from "../src/store/flowStore";
import type { GenerationRequestSnapshot } from "../server/lib/generationRecords";
import type { ImageGenRequest, VirtualTryOnNodeData, WorkflowTemplate } from "../src/types/workflow";

const pro = "gemini-3-pro-image-preview";
const referenceMap = "参考图1：姿势。\n参考图2：人物。\n参考图3：场景。\n参考图4：主穿搭。\n参考图5拼图第1行第1列：鞋子。\n参考图5拼图第1行第2列：袜子。";
for (const concise of [false, true]) {
  for (const angleControlled of [false, true]) {
    const prompt = multiImageTryOnPrompt(referenceMap, "保留胸前印花和项链", angleControlled, concise);
    assert.ok(prompt.includes(referenceMap));
    assert.match(prompt, /以参考图2提供的人物造型基调/);
    assert.match(prompt, /风格化的人物形象/);
    assert.match(prompt, /公众人物/);
    assert.match(prompt, /不复制参考图中任何真实可识别个人/);
    assert.match(prompt, /参照图1.*头部朝向.*手部动作.*双腿弯曲/);
    assert.match(prompt, /图1只提供动作几何参考/);
    assert.match(prompt, /一律禁止进入成片/);
    assert.match(prompt, /采用图3的场景、光照/);
    assert.match(prompt, /保留胸前印花和项链/);
    assert.match(prompt, /版型、颜色/);
    assert.match(prompt, /针织组织、蕾丝、缝线/);
    assert.match(prompt, /体型、发型方向、肤色基调/);
    assert.doesNotMatch(prompt, /换脸|身份替换|执行一次多图编辑换装/);
    if (angleControlled) assert.match(prompt, /姿势图控制关节动作，但不覆盖3D视角/);
    else {
      assert.match(prompt, /保持姿势参考的动作与左右关系，不镜像/);
      assert.match(prompt, /取景以图1姿势参考为准/);
      assert.doesNotMatch(prompt, /遵循下方的3D视角/);
    }
  }
}
assert.doesNotMatch(multiImageTryOnPrompt("参考图1：姿势。参考图2：人物。参考图3：场景。参考图4：主穿搭。", "", false), /拼图|网格/);
// 骨骼图姿势参考按 DWPose 语义编译：1:1 关节对齐，骨骼线条不渲染
const skeletonPrompt = multiImageTryOnPrompt(referenceMap, "", false, false, "skeleton");
assert.match(skeletonPrompt, /DWPose骨骼图/);
assert.match(skeletonPrompt, /1:1复刻人物动作/);
assert.match(skeletonPrompt, /骨骼线条与关键点不得渲染到成图/);
assert.match(skeletonPrompt, /逐点对齐/);
assert.doesNotMatch(skeletonPrompt, /参照图1提取身体朝向/);
assert.match(multiImageTryOnPrompt(referenceMap, "", true, false, "skeleton"), /骨骼图控制关节动作/);
assert.match(multiImageTryOnPrompt(referenceMap, "", false, false, "skeleton"), /取景以场景图与构图需要为准/);
assert.match(multiImageTryOnPrompt(referenceMap, "", false, false, "original"), /参照图1提取身体朝向/);
const baseRoles = ["pose", "person", "scene", "outfit", "shoes", "socks", "hat"];
const allRoles = [...MULTI_IMAGE_TRY_ON_ROLES, "detail", "detail", "detail", "detail"];
for (const count of [4, 5, 6, 7, 14, 15, 20]) {
  const roles = count > baseRoles.length ? allRoles.slice(0, count) : baseRoles.slice(0, count);
  const refs = roles.map((role, index) => ({ role, id: `original-${index}` })).reverse();
  const before = JSON.stringify(refs);
  const groups = planMultiImageReferences(refs, pro);
  assert.equal(JSON.stringify(refs), before);
  assert.deepEqual(groups.slice(0, 3).map(group => group.role), ["pose", "person", "scene"]);
  assert.equal(groups.flatMap(group => group.members).length, count, "不丢弃任何素材");
  assert.ok(groups.length <= 14);
  if (count <= 14) assert.ok(groups.every(group => group.members.length === 1), "正式Pro容量内不拼接");
  if (count > 14) assert.ok(groups.some(group => group.members.length > 1), "超过正式Pro容量后才拼接");
  assert.equal(multiImageReferenceError(roles), undefined);
}
assert.equal(planMultiImageReferences(allRoles.map(role => ({ role })), "gemini-3.1-flash-image").length, 20, "只对Pro使用超额拼接策略，其他模型另行校验自己的上限");
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
assert.equal(packed.referenceImages.length, 12);
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
assert.match(packed.instructions, /拼图第1行第1列：包袋/);
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
assert.equal(recopy.description, template.description);
assert.equal(recopy.flow.nodes.find(node => node.id === "guide")?.data.text, validated.nodes.find(node => node.id === "guide")?.data.text);
const templateAngle = validated.nodes.find(node => node.data.kind === "ti-angle")!;
assert.equal(templateAngle.data.kind === "ti-angle" && templateAngle.data.angle.enabled, false);
const enabledSource = structuredClone(validated);
const sourceAngle = enabledSource.nodes.find(node => node.data.kind === "ti-angle")!;
if (sourceAngle.data.kind !== "ti-angle") throw new Error("缺少TiAngel");
sourceAngle.data.angle.enabled = true;
const copiedAngle = copyMultiImageTryOnTemplate(enabledSource).flow.nodes.find(node => node.data.kind === "ti-angle")!;
assert.equal(copiedAngle.data.kind === "ti-angle" && copiedAngle.data.angle.enabled, false, "新模板默认关闭");
assert.equal(sourceAngle.data.angle.enabled, true, "源项目开启状态不能被改写");
const restoredSource = validateAndMigrateFlow(documentSnapshotToPersistedWorkflow(createDocumentSnapshot({ projectName: "existing", ...enabledSource })));
assert.equal(restoredSource.nodes.find(node => node.data.kind === "ti-angle")?.data.angle.enabled, true, "已有项目保存重开仍保留开启设置");
const withoutAngle = { ...validated, nodes: validated.nodes.filter(node => node.data.kind !== "ti-angle"),
  edges: validated.edges.filter(edge => edge.source !== templateAngle.id) };
const addedAngleFlow = copyMultiImageTryOnTemplate(withoutAngle).flow;
const addedAngle = addedAngleFlow.nodes.find(node => node.data.kind === "ti-angle")!;
assert.equal(addedAngle.data.kind === "ti-angle" && addedAngle.data.angle.enabled, false);
assert.ok(addedAngleFlow.edges.some(edge => edge.source === addedAngle.id && edge.targetHandle === "angle-direction"), "来源无TiAngel时新模板也提供可启用的节点");
const persisted = documentSnapshotToPersistedWorkflow(createDocumentSnapshot({ projectName: template.name, ...validated }));
const roundtrip = validateAndMigrateFlow(persisted);
const data = roundtrip.nodes.find(node => node.id === "stabilize")!.data as VirtualTryOnNodeData;
assert.equal(data.sceneInputMode, "multi-reference-edit");
assert.equal(data.modelId, "gemini-3.1-flash-image");
assert.deepEqual(inputPortSpecs(data).filter(port => port.required).map(port => port.id), ["pose", "person", "scene", "outfit"]);
useFlowStore.getState().loadFlow({ ...roundtrip, projectName: template.name });
assert.equal(selectActiveDocument(useFlowStore.getState()).nodes.find(node => node.id === "stabilize")!.data.sceneInputMode, "multi-reference-edit");

const retryState = useFlowStore.getState();
const retryDocument = selectActiveDocument(retryState);
const failedRecord: RecentResult = { id: "failure", runId: "failed-run", projectId: retryDocument.projectId,
  nodeId: "stabilize", nodeLabel: "换装", kind: "virtual-try-on", image: "", status: "error", startedAt: 1 };
assert.equal(selectCanRetryMultiImage({ ...retryState, recentResults: [failedRecord] }, "stabilize"), true);
assert.equal(selectCanRetryMultiImage({ ...retryState, recentResults: [{ ...failedRecord, projectId: "other" }] }, "stabilize"), false);
assert.equal(selectCanRetryMultiImage({ ...retryState, recentResults: [{ ...failedRecord, nodeId: "other" }] }, "stabilize"), false);
for (const status of ["success", "outcome_unknown", "running", "queued"] as const) {
  assert.equal(selectCanRetryMultiImage({ ...retryState, recentResults: [failedRecord,
    { ...failedRecord, id: "newer", startedAt: 2, status }] }, "stabilize"), false, status);
}
assert.equal(selectCanRetryMultiImage({ ...retryState, recentResults: [failedRecord],
  tabs: retryState.tabs.map(tab => tab.id === retryDocument.id ? { ...tab, readOnly: true } : tab) }, "stabilize"), false);

const flow = structuredClone(roundtrip);
const flowGeneration = flow.nodes.find(node => node.id === "stabilize")!;
flowGeneration.data.modelId = pro;
for (const node of flow.nodes) {
  if (node.data.kind === "image-input") {
    node.data.imageUrl = images[baseRoles.indexOf(node.id)] ?? images[8];
    if (!flow.edges.some(edge => edge.source === node.id && edge.target === "stabilize")) {
      flow.edges.push({ id: `test-${node.id}`, source: node.id, sourceHandle: "image", target: "stabilize", targetHandle: node.data.autoConnectTargets![0].targetHandle });
    }
  }
}
const disabledPlan = buildExecutionPlan(flow.nodes, flow.edges, { onlyNodeId: "stabilize", includeDownstream: false });
assert.equal(disabledPlan.steps[0].params.angleControl, undefined, "TiAngel关闭时不发送拍摄指令");
const flowAngle = flow.nodes.find(node => node.data.kind === "ti-angle")!;
if (flowAngle.data.kind !== "ti-angle") throw new Error("缺少TiAngel");
flowAngle.data.angle.enabled = true;
const plan = buildExecutionPlan(flow.nodes, flow.edges, { onlyNodeId: "stabilize", includeDownstream: false });
assert.throws(() => assertPlanInputs(plan, flow.edges), /已改用 Gemini 3.1 Flash Image/, "多图编辑换装已放弃 Pro，服务端拒绝 Pro 计划");
assert.ok(plan.steps[0].params.angleControl, "拍摄设置继续进入执行参数");
const missingPosePlan = { ...plan, steps: plan.steps.map(step => ({
  ...step,
  params: { ...step.params, modelId: "gemini-3.1-flash-image" },
  upstream: (step.upstream ?? []).filter(ref => ref.targetHandle !== "pose").slice(0, 13),
})) };
assert.throws(() => assertPlanInputs(missingPosePlan, flow.edges), /姿势/);
const flashPlan = { ...plan, steps: plan.steps.map(step => ({ ...step, params: { ...step.params, modelId: "gemini-3.1-flash-image" } })) };
assert.throws(() => assertPlanInputs(flashPlan, flow.edges), /at most/, "Flash原有限额不被Pro拼接特例绕过");

const oldFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("禁止网络：测试不能调用真实模型"); };
try {
  // Compile the connected TiAngel through the real DAG for the supported Flash path.
  for (const modelId of ["gemini-3.1-flash-image"] as const) {
    for (const enabled of [false, true]) {
      const angleFlow = structuredClone(roundtrip);
      angleFlow.nodes = angleFlow.nodes.filter(node => ["pose", "person", "scene", "outfit", "stabilize"].includes(node.id) || node.data.kind === "ti-angle");
      const ids = new Set(angleFlow.nodes.map(node => node.id));
      angleFlow.edges = angleFlow.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target));
      for (const node of angleFlow.nodes) {
        if (node.data.kind === "image-input") node.data.imageUrl = images[baseRoles.indexOf(node.id)];
        if (node.data.kind === "virtual-try-on") node.data.modelId = modelId;
        if (node.data.kind === "ti-angle") node.data.angle.enabled = enabled;
      }
      const anglePlan = buildExecutionPlan(angleFlow.nodes, angleFlow.edges, { onlyNodeId: "stabilize", includeDownstream: false });
      assert.doesNotThrow(() => assertPlanInputs(anglePlan, angleFlow.edges));
      const step = anglePlan.steps[0];
      const control = step.params.angleControl as { text: string; targetModelId: string } | undefined;
      assert.equal(Boolean(control), enabled);
      if (control) assert.equal(control.targetModelId, modelId);
      let calls = 0;
      await executeStep(step, images.slice(0, 4), () => ({ id: modelId,
        edit: async request => {
          calls++;
          assert.deepEqual(request.referenceImages, images.slice(0, 4), "TiAngel不新增图片或改变图序");
          assert.match(request.prompt, /针织组织、蕾丝、缝线/);
          if (control) {
            assert.ok(request.prompt.includes(control.text));
            assert.match(request.prompt, /姿势图控制关节动作，但不覆盖3D视角/);
            assert.doesNotMatch(request.prompt, /取景以图1姿势参考为准/);
          } else {
            assert.match(request.prompt, /取景以图1姿势参考为准/);
            assert.doesNotMatch(request.prompt, /3D视角指令|FUJIFILM/);
          }
          return { images: [images[0]], model: modelId };
        }, generate: async () => { throw new Error("不能生成人物中间图"); },
      }), { referenceRoles: baseRoles.slice(0, 4),
        candidateSelector: async () => ({ selectedIndex: 0, scores: [], model: "mock", providerRequests: 0, allHardFail: false }),
      });
      assert.equal(calls, 1, "TiAngel开关不追加生图请求");
    }
  }
  for (const roles of [baseRoles.slice(0, 5), baseRoles.slice(0, 6), baseRoles, allRoles]) {
    const sourceImages = roles.map(role => images[allRoles.indexOf(role)]);
    const shuffledRoles = [...roles].reverse();
    const shuffledImages = [...sourceImages].reverse();
    let calls = 0;
    let recorded: GenerationRequestSnapshot | undefined;
    const edit = async (request: ImageGenRequest) => {
      calls++;
      assert.ok(request.referenceImages!.length <= 14);
      assert.deepEqual(request.referenceImages!.slice(0, 3), sourceImages.slice(0, 3));
      if (roles.length <= 14) assert.deepEqual(request.referenceImages, sourceImages);
      assert.match(request.prompt, /输出一张完整的服装摄影照片/);
      assert.match(request.prompt, /针织组织、蕾丝、缝线/);
      assert.doesNotMatch(request.prompt, /不强求针目|完成第一轮场景化/);
      return { images: [images[0]], model: pro };
    };
    const result = await executeStep({ nodeId: "stabilize", kind: "virtual-try-on", inputImages: shuffledImages,
      params: { ...data, modelId: pro, sceneFraming: "scene" } }, shuffledImages,
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
  let disabledReviewCalls = 0;
  const noReview = await executeStep({
    nodeId: "stabilize", kind: "virtual-try-on", inputImages: images.slice(0, 4),
    params: { ...data, sceneFraming: "scene", candidateReviewMode: "disabled" },
  }, images.slice(0, 4), () => ({
    id: pro,
    edit: async () => ({ images: [images[0]], model: pro }),
    generate: async () => { throw new Error("必须多图编辑，不得文生图"); },
  }), {
    referenceRoles: baseRoles.slice(0, 4),
    candidateSelector: async () => {
      disabledReviewCalls += 1;
      throw new Error("关闭评审后不得调用候选评审");
    },
  });
  assert.equal(disabledReviewCalls, 0);
  assert.equal((noReview.executionMeta?.tryOn as Record<string, unknown>).candidateReviewDisabled, true);
} finally { globalThis.fetch = oldFetch; }

// Exercise the real adapter, but replace the network boundary; never contact a paid provider.
const originalBase = process.env.APIYI_BASE_URL;
const originalKey = process.env.APIYI_API_KEY;
process.env.APIYI_BASE_URL = "https://gateway.example";
process.env.APIYI_API_KEY = "test-only-contract-key";
try {
  for (const count of [4, 5, 6, 7, 14, 15, 20]) {
    const roles = count > baseRoles.length ? allRoles.slice(0, count) : baseRoles.slice(0, count);
    const originals = roles.map((_, index) => images[index]);
    const expectedGroups = planMultiImageReferences(roles.map((role, index) => ({ role, index })), pro);
    const sentPrompts: string[] = [];
    for (const concise of [false, true]) {
      let calls = 0;
      let recorded: GenerationRequestSnapshot | undefined;
      globalThis.fetch = async (url, init) => {
        calls++;
        assert.equal(String(url), "https://gateway.example/v1beta/models/gemini-3-pro-image:generateContent");
        assert.equal(init?.method, "POST");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), "Bearer test-only-contract-key");
        assert.equal(headers.get("content-type"), "application/json");
        const body = JSON.parse(String(init?.body));
        assert.equal(body.contents.length, 1);
        assert.equal(body.contents[0].role, "user");
        const parts = body.contents[0].parts;
        assert.equal(parts.length, expectedGroups.length + 1);
        assert.deepEqual(Object.keys(parts[0]), ["text"]);
        const prompt = parts[0].text as string;
        assert.equal(prompt, recorded?.prompt, "历史记录与真正发送的指令一致");
        sentPrompts.push(prompt);
        assert.match(prompt, /风格化的人物形象/);
        assert.match(prompt, /保留胸前印花/);
        assert.match(prompt, /参考图1：姿势/);
        if (count === 7) {
          assert.match(prompt, /参考图6：袜子/);
          assert.match(prompt, /参考图7：帽子/);
        }
        for (const [index, part] of parts.slice(1).entries()) {
          assert.deepEqual(Object.keys(part), ["inline_data"], "text 和 inline_data 绝不混合");
          assert.ok(["image/png", "image/jpeg"].includes(part.inline_data.mime_type));
          assert.ok(!part.inline_data.data.startsWith("data:"));
          assert.equal(Buffer.from(part.inline_data.data, "base64").toString("base64"), part.inline_data.data);
          if (index < 3 || count <= 14) assert.equal(part.inline_data.data, originals[index].split(",")[1]);
        }
        assert.deepEqual(body.generationConfig, { responseModalities: ["IMAGE"], imageConfig: { imageSize: "2K" } });
        return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [
          { text: "完成" }, { inlineData: { mimeType: "image/png", data: images[0].split(",")[1] } },
        ] } }] });
      };
      await executeStep({ nodeId: "stabilize", kind: "virtual-try-on", inputImages: [...originals].reverse(),
        params: { ...data, modelId: pro, prompt: "保留胸前印花", sceneFraming: "custom", aspectRatio: "3:4", imageSize: "2K",
          modelOptions: { aspectRatio: "3:4", imageSize: "2K" }, ...(concise ? { multiImagePromptMode: "concise" } : {}) } },
      [...originals].reverse(), () => apiyiProviders[pro], {
        referenceRoles: [...roles].reverse(), onSceneRequestPrepared: async value => { recorded = value; },
        sceneAnalyzer: async () => { throw new Error("禁止额外分析请求"); },
        candidateSelector: async () => ({ selectedIndex: 0, scores: [], model: "mock", providerRequests: 0, allHardFail: false }),
      });
      assert.equal(calls, 1, "一次编辑，不自动追加请求");
    }
    assert.ok(sentPrompts[1].length < sentPrompts[0].length, "简化仅影响本次指令");
  }
} finally {
  globalThis.fetch = oldFetch;
  if (originalBase === undefined) delete process.env.APIYI_BASE_URL; else process.env.APIYI_BASE_URL = originalBase;
  if (originalKey === undefined) delete process.env.APIYI_API_KEY; else process.env.APIYI_API_KEY = originalKey;
}
console.log("多图编辑换装：排序、14图边界、20图拼接、像素几何、模板复制/持久化、DAG与模拟模型请求通过（无付费调用）");

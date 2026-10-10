import assert from "node:assert/strict";
import { unwrapPortkeyRequest } from "./portkeyMock";
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
import { selectActiveDocument, selectCanRetryMultiImage, useFlowStore, applyRunEventToRecentResults, normalizeTabSessionValue, persistedWorkflowForProjectTab, type RecentResult } from "../src/store/flowStore";
import type { GenerationRequestSnapshot } from "../server/lib/generationRecords";
import type { ImageGenRequest, VirtualTryOnNodeData, WorkflowTemplate } from "../src/types/workflow";

const pro = "gemini-3-pro-image-preview";
const referenceMap = "参考图1：人物。\n参考图2：主穿搭。\n参考图3：姿势。\n参考图4：场景。\n参考图5拼图第1行第1列：鞋子。\n参考图5拼图第1行第2列：袜子。";
const calibratedSupplement = "三图校准补充（仅补充图1不可见关系）\n前后深度：画面左膝比画面右膝更靠近镜头\n面部神态：嘴唇闭合";
// Golden prompt from doc/Modelfinalprompt.txt with the approved reference reordering; pose unchanged.
const modelFinalPrompt = fs.readFileSync(new URL('./fixtures/multi-image-model-final-prompt.txt', import.meta.url), 'utf8').trim();
const modelFinalPoseBody = modelFinalPrompt.match(/^整体姿势：[\s\S]+?(?=\n环境：)/m)![0];
const modelFinalPose = `三图校准姿势\n${modelFinalPoseBody}`;
const modelFinalReferenceMap = '参考图1：人物。\n参考图2：主穿搭。\n参考图3：姿势。\n参考图4：场景。\n参考图5：鞋子。\n参考图6：帽子。';
const normalizePromptLayout = (prompt: string) => prompt.split('\n').map(line => line.trim()).filter(Boolean).join('\n');
assert.deepEqual(
  planMultiImageReferences(['scene', 'pose', 'outfit', 'person', 'hat', 'shoes'].map(role => ({ role })), 'gemini-3.1-flash-image').map(group => group.role),
  ['person', 'outfit', 'pose', 'scene', 'shoes', 'hat'],
  '实际参考图应按人物1、主穿搭2、姿势3、场景4排序，配饰相对顺序不变',
);
assert.equal(
  normalizePromptLayout(multiImageTryOnPrompt(modelFinalReferenceMap, '', undefined, false, 'unspecified', modelFinalPose, 'three-view', true)),
  normalizePromptLayout(modelFinalPrompt),
  '六图与已保存九类姿势应按用户文档拼接，而不是追加旧优先级说明',
);

function assertPhotographicRealism(prompt: string): void {
  assert.match(prompt, /真实摄影质感/);
  assert.doesNotMatch(prompt, /风格化/);
  assert.match(prompt, /真实自然肤质/);
  assert.match(prompt, /细小汗毛.*肤色细微起伏/);
  assert.match(prompt, /轻微雀斑.*局部泛红.*细小痘印/);
  assert.match(prompt, /鼻翼与脸颊自然凹凸/);
  assert.match(prompt, /唇纹细腻自然/);
  assert.match(prompt, /虹膜呈现复杂放射状纤维结构/);
  assert.match(prompt, /瞳孔边缘锐利清晰/);
  assert.match(prompt, /角膜拥有真实湿润反射/);
  assert.match(prompt, /睫毛粗细不一/);
  assert.match(prompt, /眉毛浓密.*自然生长方向/);
  assert.match(prompt, /发丝.*碎发.*绒毛.*飞发/);
  assert.match(prompt, /符合真实人体解剖比例/);
  assert.match(prompt, /细节服从当前拍摄距离/);
  const sections = ['人物：', '服装及配饰：', '动作：', '环境：', '真实摄影质感：', '完整呈现原始商品', '内容边界：', '输出一张完整'];
  const positions = sections.map(section => prompt.indexOf(section));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])), '提示词段落顺序遵循用户文档');
}
for (const concise of [false, true]) {
  for (const angleControlText of [undefined, '3D视角：从画面左侧观察']) {
    const prompt = multiImageTryOnPrompt(referenceMap, "保留胸前印花和项链", angleControlText, concise);
    assert.ok(prompt.includes(referenceMap));
    assert.match(prompt, /以参考图1提供的人物造型基调/);
    assertPhotographicRealism(prompt);
    assert.match(prompt, /全新的原创模特/);
    assert.match(prompt, /生成全原创形象/);
    assert.match(prompt, /内容边界：仅展示原创服装与配饰的原创造型/);
    assert.doesNotMatch(prompt, /原创虚构模特|真实可识别个人|身份复刻|真实品牌/);
    assert.match(prompt, /动作：.*身体朝向.*手部动作.*双腿弯曲/);
    assert.match(prompt, /参照图3的骨架动作方向/);
    assert.match(prompt, /采用图4的场景、光照和图4的环境色彩/);
    assert.match(prompt, /保留胸前印花和项链/);
    assert.match(prompt, /版型、颜色/);
    assert.match(prompt, /针织组织、蕾丝、缝线/);
    assert.match(prompt, /体型、发型方向、肤色基调/);
    assert.doesNotMatch(prompt, /换脸|身份替换|执行一次多图编辑换装/);
    if (angleControlText) {
      assert.match(prompt, /在图3动作方向基础上/);
      assert.equal(prompt.split(angleControlText).length - 1, 1);
      assert.ok(prompt.indexOf('真实摄影质感：') < prompt.indexOf(angleControlText));
      assert.ok(prompt.indexOf(angleControlText) < prompt.indexOf('完整呈现原始商品'));
    } else {
      assert.match(prompt, /取景以图3动作方向为准/);
      assert.doesNotMatch(prompt, /3D视角/);
    }
  }
}
assert.doesNotMatch(multiImageTryOnPrompt(modelFinalReferenceMap, "", undefined), /拼图|网格/);
// 骨骼图姿势参考按 DWPose 语义编译：1:1 关节对齐，骨骼线条不渲染
const skeletonPrompt = multiImageTryOnPrompt(referenceMap, "", undefined, false, "skeleton");
assert.match(skeletonPrompt, /骨架动作方向/);
assert.match(skeletonPrompt, /参照图3的骨架动作方向/);
assert.match(skeletonPrompt, /成图呈现自然人物摄影效果/);
assert.match(skeletonPrompt, /逐点对齐/);
assert.doesNotMatch(skeletonPrompt, /参照图3提取身体朝向/);
assert.match(multiImageTryOnPrompt(referenceMap, "", "3D视角：从画面左侧观察", false, "skeleton"), /在图3动作方向基础上/);
assert.match(multiImageTryOnPrompt(referenceMap, "", undefined, false, "skeleton"), /取景以场景图与构图需要为准/);
assert.match(multiImageTryOnPrompt(referenceMap, "", undefined, false, "original"), /按照图3动作方向呈现/);
const orderedPrompt = multiImageTryOnPrompt(referenceMap, "", undefined, false, "original");
assert.ok(orderedPrompt.indexOf("人物：") < orderedPrompt.indexOf("动作："), "人物与素材说明在动作段之前");
const promptedPose = multiImageTryOnPrompt(referenceMap, "", undefined, false, "original", "画面左腿交叉，肩线倾斜");
assert.match(promptedPose, /姿势补充描述（仅在图3无法判定的项目上参考）：画面左腿交叉，肩线倾斜/);
assert.match(promptedPose, /身体朝向、肩髋倾斜、四肢弯曲、手脚位置与接触、双腿交叉与前后关系、重心与承重一律以图3可见几何为准/);
assert.match(promptedPose, /仅图3无法判定的头部旋转、俯仰、视线方向与面部神态才参考该文字/);
assert.match(promptedPose, /该文字中与图3可见几何冲突的部分全部忽略/);
assert.doesNotMatch(multiImageTryOnPrompt(referenceMap, "", undefined, false, "original", ""), /姿势补充描述/);
assert.doesNotMatch(multiImageTryOnPrompt(referenceMap, "", undefined, false, "original"), /姿势补充描述/);
const calibratedPrompt = multiImageTryOnPrompt(referenceMap, "", undefined, false, "original", calibratedSupplement, "three-view", true);
assert.match(calibratedPrompt, /三图校准补充（从属约束）/);
assert.match(calibratedPrompt, /画面左膝比画面右膝更靠近镜头/);
assert.match(calibratedPrompt, /参考图3可见人体几何是最高优先级/);
assert.match(calibratedPrompt, /校准文字仅补充图3无法直接判定/);
assert.doesNotMatch(calibratedPrompt, /唯一姿势锚点|逐关节1:1复刻图3|图1不可见关系/);
assert.match(calibratedPrompt, /仅补充图3不可见关系/);
assert.ok(calibratedSupplement.includes('仅补充图1不可见关系'), '旧姿势数据不被改写，仅生成时转换固定标题中的图号');
assert.doesNotMatch(calibratedPrompt, /无法判断/);
assert.doesNotMatch(calibratedPrompt, /仅在图3无法判定的头部/);
const rejectedCalibratedPrompt = multiImageTryOnPrompt(referenceMap, "", undefined, false, "original", "整体姿态：画面左腿交叉", "three-view");
assert.doesNotMatch(rejectedCalibratedPrompt, /整体姿态：画面左腿交叉/, '未通过结构门禁的三图文字不得进入最终 prompt');
const manuallyForgedSupplement = multiImageTryOnPrompt(referenceMap, "", undefined, false, "original", calibratedSupplement, "three-view", false);
assert.doesNotMatch(manuallyForgedSupplement, /画面左膝比画面右膝更靠近镜头/, '仅格式正确但没有服务端校验位的文字也不得进入最终 prompt');
for (const concise of [false, true]) {
  for (const poseReferenceType of ['original', 'skeleton']) {
    for (const posePromptMode of ['single', 'three-view']) {
      assertPhotographicRealism(multiImageTryOnPrompt(referenceMap, '', undefined, concise, poseReferenceType, '保留校准后的姿势', posePromptMode));
    }
  }
}
const baseRoles = ["pose", "person", "scene", "outfit", "shoes", "socks", "hat"];
const allRoles = [...MULTI_IMAGE_TRY_ON_ROLES, "detail", "detail", "detail", "detail"];
for (const count of [4, 5, 6, 7, 14, 15, 20]) {
  const roles = count > baseRoles.length ? allRoles.slice(0, count) : baseRoles.slice(0, count);
  const refs = roles.map((role, index) => ({ role, id: `original-${index}` })).reverse();
  const before = JSON.stringify(refs);
  const groups = planMultiImageReferences(refs, pro);
  assert.equal(JSON.stringify(refs), before);
  assert.deepEqual(groups.slice(0, 4).map(group => group.role), ["person", "outfit", "pose", "scene"]);
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
assert.equal(packed.referenceImages[0], images[0], "人物原图作为图1原样传递");
assert.equal(packed.referenceImages[1], images[1], "主穿搭原图作为图2原样传递");
assert.equal(packed.referenceImages[3], images[3], "场景原图作为图4原样传递");
const packedPose = await sharp(parseDataUrl(packed.referenceImages[2]).buffer).metadata();
assert.equal(Math.max(packedPose.width!, packedPose.height!), 2048, "姿势参考放大到至少 2048 长边");
assert.equal(packed.references.length, 20);
assert.deepEqual(readMultiImageReferenceManifest(packed.references), packed.references);
assert.equal(readMultiImageReferenceManifest([{ ...packed.references[0], number: 2 }, ...packed.references.slice(1)]), undefined);
const legacyManifest = baseRoles.map((role, index) => ({ number: index + 1, role, image: images[index] }));
assert.deepEqual(readMultiImageReferenceManifest(legacyManifest), legacyManifest, '旧记录仍按姿势1、人物2、场景3、主穿搭4原样读取');
assert.equal(readMultiImageReferenceManifest(packed.references.map((ref, index) => index === 1 ? { ...ref, role: 'scene' } : ref)), undefined, '新记录首四项不得错配');
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
assert.equal(validated.nodes.find(node => node.id === "pose")?.data.kind === "image-input" && validated.nodes.find(node => node.id === "pose")?.data.poseReference, true, "多图模板默认提供姿势参考节点");
const calibrationFlow = structuredClone(validated);
const calibrationNode = calibrationFlow.nodes.find(node => node.id === "pose")!;
if (calibrationNode.data.kind === "image-input") {
  calibrationNode.data.imageUrl = "/api/files/pose-source.png";
  calibrationNode.data.posePrompt = "明确校准：左膝位于右膝前方";
  calibrationNode.data.posePromptImage = calibrationNode.data.imageUrl;
  calibrationNode.data.posePromptMode = "three-view";
}
const normalizedCalibrationFlow = validateAndMigrateFlow(calibrationFlow);
const calibrationSnapshot = createDocumentSnapshot({ projectName: "calibrated pose", nodes: normalizedCalibrationFlow.nodes, edges: normalizedCalibrationFlow.edges });
const persistedCalibration = documentSnapshotToPersistedWorkflow(calibrationSnapshot);
const persistedCalibrationNode = persistedCalibration.nodes.find(node => node.id === "pose")!;
assert.equal((persistedCalibrationNode.data as any).posePromptMode, "three-view", "校准语义必须跨保存/重载保留");
const verifiedFlow = structuredClone(calibrationFlow);
const verifiedPose = verifiedFlow.nodes.find(node => node.id === 'pose')!;
if (verifiedPose.data.kind !== 'image-input') throw new Error('missing verified pose input');
verifiedPose.data.posePromptOptimized = calibratedSupplement;
(verifiedPose.data as any).posePromptOptimizedVerified = true;
const verifiedReloaded = validateAndMigrateFlow(documentSnapshotToPersistedWorkflow(createDocumentSnapshot({ projectName: 'verified pose', ...verifiedFlow })));
const verifiedReloadedPose = verifiedReloaded.nodes.find(node => node.id === 'pose')!;
assert.equal((verifiedReloadedPose.data as any).posePromptOptimizedVerified, true, '结构门禁状态必须跨保存/重载保留');
const verifiedFirst = verifiedReloaded.nodes.find(node => node.data.kind === 'virtual-try-on')!;
const verifiedStep = buildExecutionPlan(verifiedReloaded.nodes, verifiedReloaded.edges, { onlyNodeId: verifiedFirst.id, includeDownstream: false }).steps.find(step => step.nodeId === verifiedFirst.id)!;
assert.equal(verifiedStep.params.posePrompt, calibratedSupplement, '只有服务端校验通过的三图补充才能进入第一阶段');
const completePose = '三图校准姿势（用户编辑）\n整体姿势：站立\n头部：向画面左侧倾斜\n视线：看向镜头\n面部：嘴角上扬\n上肢：双手交握\n肩部：肩部放松\n腰部：轻微弯曲\n胯部：轻微转动\n下肢：双腿交叉';
verifiedPose.data.posePromptOptimized = completePose;
const sequentialReloaded = validateAndMigrateFlow(documentSnapshotToPersistedWorkflow(createDocumentSnapshot({ projectName: 'sequential pose', ...verifiedFlow })));
const sequentialStep = buildExecutionPlan(sequentialReloaded.nodes, sequentialReloaded.edges, { onlyNodeId: verifiedFirst.id, includeDownstream: false }).steps.find(step => step.nodeId === verifiedFirst.id)!;
assert.equal(sequentialStep.params.posePrompt, completePose, '用户编辑的九类姿势跨持久化与DAG保持不变');
for (const concise of [false, true]) {
  for (const poseReferenceType of ['unspecified', 'original', 'skeleton']) {
    const prompt = multiImageTryOnPrompt(referenceMap, '', undefined, concise, poseReferenceType, completePose, 'three-view', true);
    assert.ok(prompt.includes(completePose.split('\n').slice(1).join('\n')), '用户修改的完整九类正文原样进入最终生图提示词');
    assert.doesNotMatch(prompt, /三图校准姿势|用户编辑|最高优先级|四类|从属约束|冲突的部分全部忽略/);
    assertPhotographicRealism(prompt);
  }
}
assert.doesNotMatch(multiImageTryOnPrompt(referenceMap, '', undefined, false, 'original', completePose, 'three-view', false), /下肢：双腿交叉/, '未经校验的九类草稿不进入生图');
const freePose = '三图校准姿势（用户编辑）\n双手环抱胸前，左腿前伸，身体略后仰';
assert.ok(multiImageTryOnPrompt(referenceMap, '', undefined, false, 'original', freePose, 'three-view', true).includes('双手环抱胸前，左腿前伸，身体略后仰'), '带用户编辑标记的自由文本按标记头直接采用');
verifiedPose.data.posePromptOptimized = freePose;
const freeReloaded = validateAndMigrateFlow(documentSnapshotToPersistedWorkflow(createDocumentSnapshot({ projectName: 'free pose', ...verifiedFlow })));
const freeFirst = freeReloaded.nodes.find(node => node.data.kind === 'virtual-try-on')!;
const freeStep = buildExecutionPlan(freeReloaded.nodes, freeReloaded.edges, { onlyNodeId: freeFirst.id, includeDownstream: false }).steps.find(step => step.nodeId === freeFirst.id)!;
assert.equal(freeStep.params.posePrompt, freePose, '带用户编辑标记的自由文本跨持久化与DAG保持不变');
for (const mode of ['single', 'three-view'] as const) {
  const editedFlow = structuredClone(calibrationFlow);
  const poseNode = editedFlow.nodes.find(node => node.id === 'pose')!;
  if (poseNode.data.kind !== 'image-input') throw new Error('missing pose input');
  poseNode.data.posePromptMode = mode;
  poseNode.data.posePromptOptimized = '用户编辑：画面右手贴近髋部';
  const normalized = validateAndMigrateFlow(editedFlow);
  const persisted = documentSnapshotToPersistedWorkflow(createDocumentSnapshot({ projectName: 'editable pose', ...normalized }));
  const reloaded = validateAndMigrateFlow(persisted);
  const reloadedPose = reloaded.nodes.find(node => node.id === 'pose')!;
  assert.equal((reloadedPose.data as any).posePromptOptimized, poseNode.data.posePromptOptimized, '手工优化结果不依赖三图模式，保存后不能丢失');
  const first = reloaded.nodes.find(node => node.data.kind === 'virtual-try-on')!;
  const step = buildExecutionPlan(reloaded.nodes, reloaded.edges, { onlyNodeId: first.id, includeDownstream: false }).steps.find(step => step.nodeId === first.id)!;
  if (mode === 'single') assert.equal(step.params.posePrompt, poseNode.data.posePromptOptimized, '单图手工优化文本继续进入第一阶段');
  else assert.equal(step.params.posePrompt, undefined, '未经结构门禁的三图手工文本不得覆盖原姿势图');
  assert.equal(step.params.posePromptMode, mode, '手工编辑不能伪装成三图校准');
  assert.equal((reloadedPose.data as any).posePrompt, calibrationNode.data.posePrompt, '保留原始反推用于对比');
  for (const invalid of [123, 'x'.repeat(4001)]) {
    const malformed = structuredClone(editedFlow);
    (malformed.nodes.find(node => node.id === 'pose')!.data as any).posePromptOptimized = invalid;
    assert.throws(() => validateAndMigrateFlow(malformed), /posePromptOptimized/);
  }
}
const invalidCalibrationFlow = structuredClone(calibrationFlow);
const invalidCalibrationNode = invalidCalibrationFlow.nodes.find(node => node.id === "pose")!;
if (invalidCalibrationNode.data.kind === "image-input") invalidCalibrationNode.data.posePromptMode = "invented" as never;
assert.throws(() => validateAndMigrateFlow(invalidCalibrationFlow), /posePromptMode/, "未知校准模式必须在工作流边界拒绝");
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
const copiedPose = recopy.flow.nodes.find(node => node.id === "pose");
assert.equal(copiedPose?.data.kind === "image-input" && copiedPose.data.poseReference, true, "复制模板保留姿势参考功能");
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
assert.deepEqual(inputPortSpecs(data).filter(port => port.required).map(port => port.id), ["person", "outfit", "pose", "scene"]);
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
assert.doesNotThrow(() => assertPlanInputs(plan, flow.edges), "多图编辑换装允许 Pro 并保留原有图源上限");
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
  // Reproduce the successful six-role pipeline through document/session/DAG
  // boundaries, rather than testing the prompt builder in isolation.
  for (const enabled of [false, true]) {
    const roles = ["pose", "person", "scene", "outfit", "shoes", "hat"];
    const replay = structuredClone(roundtrip);
    replay.nodes = replay.nodes.filter(node => roles.includes(node.id) || node.id === "stabilize" || node.data.kind === "ti-angle");
    const ids = new Set(replay.nodes.map(node => node.id));
    replay.edges = replay.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target));
    for (const node of replay.nodes) {
      if (node.data.kind === "image-input") {
        node.data.imageUrl = images[roles.indexOf(node.id)];
        if (node.id === "pose") Object.assign(node.data, {
          posePrompt: "校准动作：双手插袋，双脚前后错位", posePromptMode: "three-view", posePromptImage: node.data.imageUrl,
        });
        if (!replay.edges.some(edge => edge.source === node.id && edge.target === "stabilize")) {
          replay.edges.push({ id: `replay-${node.id}`, source: node.id, sourceHandle: "image", target: "stabilize", targetHandle: node.id });
        }
      }
      if (node.data.kind === "ti-angle") node.data.angle.enabled = enabled;
    }
    useFlowStore.getState().loadFlow({ ...replay, projectId: "mode-replay", projectName: "恢复多图模式" });
    useFlowStore.getState().updateNodeData("stabilize", { prompt: "不要墨镜", modelId: "gemini-3.1-flash-image" });
    const tab = selectActiveDocument(useFlowStore.getState());
    const recovered = normalizeTabSessionValue({ activeTabId: tab.id, tabs: [tab] });
    assert.ok(recovered);
    const restored = validateAndMigrateFlow(persistedWorkflowForProjectTab(recovered.tabs[0]));
    const compiled = buildExecutionPlan(restored.nodes, restored.edges, { onlyNodeId: "stabilize", includeDownstream: false });
    const step = compiled.steps[0];
    assert.equal(step.params.sceneInputMode, "multi-reference-edit");
    assert.equal(step.params.posePromptMode, "three-view");
    let snapshot: GenerationRequestSnapshot | undefined;
    let calls = 0;
    await executeStep(step, images.slice(0, 6), () => ({ id: "mock", generate: async () => { throw new Error("仅使用多图编辑"); },
      edit: async request => {
        calls++;
        assert.equal(snapshot?.prompt, request.prompt);
        assert.deepEqual(snapshot?.references.map(ref => ref.role), ['person', 'outfit', 'pose', 'scene', 'shoes', 'hat']);
        assert.deepEqual(request.referenceImages.filter((_, index) => index !== 2), [images[1], images[3], images[2], images[4], images[5]]);
        assert.match(request.prompt, /^以参考图1提供的人物造型基调/);
        assert.doesNotMatch(request.prompt, /校准动作：双手插袋，双脚前后错位/, '旧版未校验三图文字不得进入最终 API prompt');
        assert.match(request.prompt, /参考图3可见人体几何是最高优先级/);
        assert.match(request.prompt, /参考图4：场景/);
        assert.match(request.prompt, /参考图2：主穿搭/);
        assert.match(request.prompt, /生成全原创形象/);
        assert.match(request.prompt, /不要墨镜/);
        assert.doesNotMatch(request.prompt, /建立第一轮人物场景基准|锁定同一人物|场景分析作为环境辅助/);
        assertPhotographicRealism(request.prompt);
        assert.equal(request.prompt.includes("受控相机视角"), enabled);
        return { images: [images[0]], model: "mock" };
      },
    }), { referenceRoles: roles,
      sceneAnalyzer: async () => { throw new Error("多图模式不应执行旧场景分析链路"); },
      onSceneRequestPrepared: async request => { snapshot = request; },
      candidateSelector: async () => ({ selectedIndex: 0, scores: [], model: "mock", providerRequests: 0, allHardFail: false }),
    });
    assert.equal(calls, 1);
  }
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
          assert.deepEqual(request.referenceImages.filter((_, index) => index !== 2), [images[1], images[3], images[2]], "TiAngel不新增图片或改变角色图序");
          const poseMeta = await sharp(parseDataUrl(request.referenceImages[2]).buffer).metadata();
          assert.equal(Math.max(poseMeta.width!, poseMeta.height!), 2048, "姿势参考放大到至少 2048 长边");
          assert.match(request.prompt, /针织组织、蕾丝、缝线/);
          assertPhotographicRealism(request.prompt);
          if (control) {
            assert.ok(request.prompt.includes(control.text));
            assert.equal(request.prompt.split(control.text).length - 1, 1, '相机指令仅在相机段出现一次');
            assert.ok(request.prompt.indexOf(control.text) < request.prompt.indexOf('完整呈现原始商品'));
            assert.match(request.prompt, /在图3动作方向基础上/);
            assert.doesNotMatch(request.prompt, /取景以图3姿势参考为准/);
          } else {
            assert.match(request.prompt, /取景以图3动作方向为准/);
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
      assert.deepEqual([request.referenceImages![0], request.referenceImages![1], request.referenceImages![3]], ['person', 'outfit', 'scene'].map(role => sourceImages[roles.indexOf(role)]));
      const proPose = await sharp(parseDataUrl(request.referenceImages![2]).buffer).metadata();
      assert.equal(Math.max(proPose.width!, proPose.height!), 2048, "姿势参考放大到至少 2048 长边");
      if (roles.length <= 14) assert.deepEqual(request.referenceImages!.slice(4), sourceImages.slice(4));
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
    assert.deepEqual(recorded!.references.slice(0, 4).map(ref => ref.role), ["person", "outfit", "pose", "scene"]);
  }
  let posePromptCalls = 0;
  await executeStep({ nodeId: "stabilize", kind: "virtual-try-on", inputImages: images.slice(0, 4),
    params: { ...data, modelId: "gemini-3.1-flash-image", sceneFraming: "scene", posePrompt: "画面左腿交叉，肩线倾斜" } },
  images.slice(0, 4), () => ({
    id: "gemini-3.1-flash-image",
    edit: async request => {
      posePromptCalls++;
      assert.match(request.prompt, /姿势补充描述（仅在图3无法判定的项目上参考）：画面左腿交叉，肩线倾斜/);
      return { images: [images[0]], model: "gemini-3.1-flash-image" };
    },
    generate: async () => { throw new Error("必须多图编辑，不得文生图"); },
  }), { referenceRoles: ["pose", "person", "scene", "outfit"],
    candidateSelector: async () => ({ selectedIndex: 0, scores: [], model: "mock", providerRequests: 0, allHardFail: false }) });
  assert.equal(posePromptCalls, 1, "反推姿势描述必须进入多图第一轮请求");
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

async function assertSerializedPrimaryImages(sent: Buffer[], originals: string[], roles: readonly string[]) {
  assert.equal(sent.length, 4);
  for (const [index, role] of ['person', 'outfit', 'pose', 'scene'].entries()) {
    const expected = await sharp(parseDataUrl(originals[roles.indexOf(role)]).buffer).stats();
    const actual = await sharp(sent[index]).stats();
    for (let channel = 0; channel < 3; channel++) {
      assert.ok(Math.abs(actual.channels[channel].mean - expected.channels[channel].mean) <= 2, `API图${index + 1}像素对应${role}，容许JPEG量化误差`);
    }
  }
}

// Exercise the real adapter, but replace the network boundary; never contact a paid provider.
const originalBase = process.env.APIYI_BASE_URL;
const originalKey = process.env.APIYI_API_KEY;
process.env.APIYI_BASE_URL = "https://gateway.example";
process.env.APIYI_API_KEY = "test-only-contract-key";
try {
  for (const count of [4, 5, 6, 7, 14, 15, 20]) {
    const roles = count === 6 ? ['pose', 'person', 'scene', 'outfit', 'shoes', 'hat'] : count > baseRoles.length ? allRoles.slice(0, count) : baseRoles.slice(0, count);
    const originals = roles.map((_, index) => images[index]);
    const expectedGroups = planMultiImageReferences(roles.map((role, index) => ({ role, index })), pro);
    const sentPrompts: string[] = [];
    for (const concise of [false, true]) {
      let calls = 0;
      let recorded: GenerationRequestSnapshot | undefined;
      globalThis.fetch = async (url, init) => {
        [url, init] = unwrapPortkeyRequest(url, init);
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
        assertPhotographicRealism(prompt);
        if (count === 6) {
          assert.ok(prompt.includes(modelFinalPoseBody));
          assert.doesNotMatch(prompt, /三图校准姿势|用户编辑|最高优先级|原图不得推翻/);
          if (!concise) assert.equal(normalizePromptLayout(prompt), normalizePromptLayout(modelFinalPrompt), '实际 API 请求与用户文档一致');
        } else assert.match(prompt, /保留胸前印花/);
        assert.match(prompt, /参考图1：人物。\n参考图2：主穿搭。\n参考图3：姿势。\n参考图4：场景。/);
        await assertSerializedPrimaryImages(parts.slice(1, 5).map((part: { inline_data: { data: string } }) => Buffer.from(part.inline_data.data, 'base64')), originals, roles);
        if (count === 7) {
          assert.match(prompt, /参考图6：袜子/);
          assert.match(prompt, /参考图7：帽子/);
        }
        for (const part of parts.slice(1)) {
          assert.deepEqual(Object.keys(part), ["inline_data"], "text 和 inline_data 绝不混合");
          assert.ok(["image/png", "image/jpeg"].includes(part.inline_data.mime_type));
          assert.ok(!part.inline_data.data.startsWith("data:"));
          assert.equal(Buffer.from(part.inline_data.data, "base64").toString("base64"), part.inline_data.data);
          const sent = Buffer.from(part.inline_data.data, "base64");
          assert.ok(["image/png", "image/jpeg"].includes(part.inline_data.mime_type), "不透明单图转 JPEG，带透明缝隙的拼图保留 PNG");
          const metadata = await sharp(sent).metadata();
          assert.ok(Math.max(metadata.width!, metadata.height!) <= 2048);
        }
        assert.deepEqual(body.generationConfig, { responseModalities: ["IMAGE"], imageConfig: { imageSize: "2K" } });
        return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [
          { text: "完成" }, { inlineData: { mimeType: "image/png", data: images[0].split(",")[1] } },
        ] } }] });
      };
      await executeStep({ nodeId: "stabilize", kind: "virtual-try-on", inputImages: [...originals].reverse(),
        params: { ...data, modelId: pro, prompt: count === 6 ? '' : '保留胸前印花', sceneFraming: 'custom', aspectRatio: '3:4', imageSize: '2K',
          ...(count === 6 ? { posePrompt: modelFinalPose, posePromptMode: 'three-view', posePromptOptimizedVerified: true } : {}),
          modelOptions: { aspectRatio: '3:4', imageSize: '2K' }, ...(concise ? { multiImagePromptMode: 'concise' } : {}) } },
      [...originals].reverse(), () => apiyiProviders[pro], {
        referenceRoles: [...roles].reverse(), onSceneRequestPrepared: async value => { recorded = value; },
        sceneAnalyzer: async () => { throw new Error("禁止额外分析请求"); },
        candidateSelector: async () => ({ selectedIndex: 0, scores: [], model: "mock", providerRequests: 0, allHardFail: false }),
      });
      assert.equal(calls, 1, "一次编辑，不自动追加请求");
    }
    assert.ok(sentPrompts[1].length < sentPrompts[0].length, "简化仅影响本次指令");
  }
  for (const modelId of ["gemini-3.1-flash-image", "gpt-image-2"] as const) {
    for (const concise of [false, true]) {
      let calls = 0;
      let recorded: GenerationRequestSnapshot | undefined;
      globalThis.fetch = async (url, init) => {
        [url, init] = unwrapPortkeyRequest(url, init);
        calls++;
        assert.equal(init?.method, "POST");
        let prompt: string;
        if (modelId === "gpt-image-2") {
          assert.equal(String(url), "https://gateway.example/v1/images/edits");
          assert.ok(init?.body instanceof FormData);
          assert.equal(init.body.get("model"), modelId);
          prompt = String(init.body.get("prompt"));
          assert.equal([...init.body.values()].filter(value => typeof value !== "string").length, 4);
          const imagesSent = [...init.body.values()].filter(value => typeof value !== 'string');
          await assertSerializedPrimaryImages(await Promise.all(imagesSent.map(image => image.arrayBuffer().then(bytes => Buffer.from(bytes)))), images.slice(0, 4), baseRoles.slice(0, 4));
        } else {
          assert.equal(String(url), "https://gateway.example/v1beta/models/gemini-3.1-flash-image:generateContent");
          const body = JSON.parse(String(init?.body));
          assert.equal(body.contents[0].parts.length, 5);
          prompt = body.contents[0].parts[0].text;
          await assertSerializedPrimaryImages(body.contents[0].parts.slice(1).map((part: { inline_data: { data: string } }) => Buffer.from(part.inline_data.data, 'base64')), images.slice(0, 4), baseRoles.slice(0, 4));
        }
        assert.equal(prompt, recorded?.prompt, "历史记录与最终 Provider 请求一致");
        assertPhotographicRealism(prompt);
        assert.match(prompt, /保留胸前印花/);
        assert.match(prompt, /参考图1：人物。\n参考图2：主穿搭。\n参考图3：姿势。\n参考图4：场景。/);
        return modelId === "gpt-image-2"
          ? Response.json({ data: [{ b64_json: images[0].split(",")[1] }] })
          : Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [
            { inlineData: { mimeType: "image/png", data: images[0].split(",")[1] } },
          ] } }] });
      };
      await executeStep({ nodeId: "stabilize", kind: "virtual-try-on", inputImages: images.slice(0, 4),
        params: { ...data, modelId, prompt: "保留胸前印花", sceneFraming: "custom", candidateReviewMode: "disabled",
          modelOptions: modelId.startsWith("gemini") ? { aspectRatio: "3:4", imageSize: "2K" } : { quality: "high", size: "1024x1536" },
          aspectRatio: "3:4", imageSize: "2K", ...(concise ? { multiImagePromptMode: "concise" } : {}) } },
      images.slice(0, 4), () => apiyiProviders[modelId], {
        referenceRoles: baseRoles.slice(0, 4), onSceneRequestPrepared: async value => { recorded = value; },
        sceneAnalyzer: async () => { throw new Error("禁止额外分析请求"); },
      });
      assert.equal(calls, 1, "写实约束不增加生图请求");
    }
  }
} finally {
  globalThis.fetch = oldFetch;
  if (originalBase === undefined) delete process.env.APIYI_BASE_URL; else process.env.APIYI_BASE_URL = originalBase;
  if (originalKey === undefined) delete process.env.APIYI_API_KEY; else process.env.APIYI_API_KEY = originalKey;
}
console.log("多图编辑换装：排序、14图边界、20图拼接、像素几何、模板复制/持久化、DAG与模拟模型请求通过（无付费调用）");

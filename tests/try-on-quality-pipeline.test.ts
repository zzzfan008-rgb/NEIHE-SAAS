import assert from "node:assert";
import {
  PROMPT_ENHANCER_SYSTEM_PROMPT,
  TRY_ON_PROMPT_ENHANCER_SYSTEM_PROMPT,
} from "../server/lib/promptEnhancement";
import { parseTryOnCandidateSelection, selectBestTryOnCandidate } from "../server/lib/tryOnCandidateSelection";
import sharp from "sharp";
import { tryOnCandidateCount } from "../src/lib/tryOnStylePresets";
import { executeStep } from "../server/engine/runner";
import type { ImageGenRequest } from "../src/types/workflow";
import type { GenerationRequestSnapshot } from "../server/lib/generationRecords";
import { ProviderError } from "../server/providers/base";
import { parsePoseReviewCandidates, readTryOnPoseReview } from '../src/lib/tryOnPoseReview';

console.log("一键换装质量流水线契约测试");

for (const factor of ["主体与动作", "环境", "主光方向与光质", "镜头与视点", "色调与媒介", "构图"]) {
  assert.match(PROMPT_ENHANCER_SYSTEM_PROMPT, new RegExp(factor));
  assert.match(TRY_ON_PROMPT_ENHANCER_SYSTEM_PROMPT, new RegExp(factor));
}
for (const prompt of [PROMPT_ENHANCER_SYSTEM_PROMPT, TRY_ON_PROMPT_ENHANCER_SYSTEM_PROMPT]) {
  assert.match(prompt, /分辨率由 API 参数控制/);
  assert.match(prompt, /不得虚构品牌、Logo、文字、水印/);
  assert.match(prompt, /不要强制居中或左右对称/);
}

assert.equal(tryOnCandidateCount("scene-stabilize", "fast"), 1);
assert.equal(tryOnCandidateCount("scene-stabilize", "balanced"), 2);
assert.equal(tryOnCandidateCount("scene-stabilize", "best"), 3);
assert.equal(tryOnCandidateCount("garment-refine", "best"), 2);

const selected = parseTryOnCandidateSelection({
  choices: [{ message: { content: JSON.stringify({ scores: [
    { index: 0, identity: 20, anatomy: 15, garment: 20, material: 20, accessories: 15, scene: 10, hardFail: true, reasons: ["严重手部错误"] },
    { index: 1, identity: 18, anatomy: 14, garment: 19, material: 18, accessories: 14, scene: 9, hardFail: false, reasons: [] },
  ] }) } }],
}, 2, "judge-stub");
assert.equal(selected.selectedIndex, 1, "硬失败候选即使总分更高也不能胜出");
assert.equal(selected.allHardFail, false);

const rejected = parseTryOnCandidateSelection({
  choices: [{ message: { content: JSON.stringify({ scores: [
    { index: 0, identity: 5, anatomy: 5, garment: 5, material: 5, accessories: 5, scene: 5, hardFail: true, reasons: ["身份替换"] },
    { index: 1, identity: 5, anatomy: 5, garment: 5, material: 5, accessories: 5, scene: 5, hardFail: true, reasons: ["核心穿搭错误"] },
  ] }) } }],
}, 2, "judge-stub");
assert.equal(rejected.selectedIndex, null);
assert.equal(rejected.allHardFail, true);

const detailedChecks = { screenLeftArm: true, screenRightArm: true, screenLeftHand: true, screenRightHand: true, screenLeftLeg: true, screenRightLeg: true, weightAndCrossing: true, notMirrored: true };
const scores = [
  { index: 0, identity: 20, anatomy: 15, garment: 20, material: 20, accessories: 15, scene: 10, hardFail: false, poseMatches: false, poseChecks: { headAndTorso: false, armsAndHands: false, legsAndWeight: true }, reasons: ["头部与肩线不符"] },
  { index: 1, identity: 18, anatomy: 14, garment: 19, material: 18, accessories: 14, scene: 9, hardFail: false, poseMatches: true, poseChecks: { headAndTorso: true, armsAndHands: true, legsAndWeight: true }, reasons: [] },
].map(score => ({ ...score, poseChecks: { ...score.poseChecks, ...detailedChecks } }));
const responsePayload = { choices: [{ message: { content: JSON.stringify({ scores }) } }] };
assert.equal(parseTryOnCandidateSelection(responsePayload, 2, "judge", true).selectedIndex, 1);
assert.throws(() => parseTryOnCandidateSelection({ choices: [{ message: { content: JSON.stringify({ scores: scores.map(({ poseMatches: _pose, ...score }) => score) }) } }] }, 2, "judge", true), /姿势/);
const strictPoseSelection = parseTryOnCandidateSelection({
  choices: [{ message: { content: JSON.stringify({ scores: [
    { index: 0, identity: 20, anatomy: 15, garment: 20, material: 20, accessories: 15, scene: 10, hardFail: false, poseMatches: true, poseChecks: { headAndTorso: true, armsAndHands: false, legsAndWeight: true }, reasons: ["双臂与手部不符"] },
    { index: 1, identity: 18, anatomy: 14, garment: 19, material: 18, accessories: 14, scene: 9, hardFail: false, poseMatches: true, poseChecks: { headAndTorso: true, armsAndHands: true, legsAndWeight: true }, reasons: [] },
  ].map(score => ({ ...score, poseChecks: { ...score.poseChecks, ...detailedChecks } })) }) } }],
}, 2, "judge", true, true);
assert.equal(strictPoseSelection.selectedIndex, 1, "手臂或手部不符的第一轮候选不得自动胜出");
assert.equal(strictPoseSelection.scores[0].hardFail, true);
// Regression for oUkhm663Q9: high score and positive aggregate checks must not
// override wrong arm/hand, crossing or mirrored geometry. No paid provider here.
for (const field of Object.keys(detailedChecks)) {
  const failing = { ...scores[1], index: 0, poseChecks: { ...scores[1].poseChecks, [field]: false } };
  const parsed = parseTryOnCandidateSelection({ choices: [{ message: { content: JSON.stringify({ scores: [failing] }) } }] }, 1, "judge", true, true);
  assert.equal(parsed.allHardFail, true, field);
  assert.equal(parsed.selectedIndex, null, field);
  for (const unknown of [undefined, null, "unknown"]) {
    assert.throws(() => parseTryOnCandidateSelection({ choices: [{ message: { content: JSON.stringify({ scores: [{ ...failing, poseChecks: { ...failing.poseChecks, [field]: unknown } }] }) } }] }, 1, "judge", true, true), /姿势分项/);
  }
}
assert.throws(
  () => parseTryOnCandidateSelection({ choices: [{ message: { content: JSON.stringify({ scores: scores.map(({ poseChecks: _poseChecks, ...score }) => score) }) } }] }, 2, "judge", true, true),
  /姿势分项/,
);

const originalFetch = globalThis.fetch;
const originalKey = process.env.APIYI_API_KEY;
process.env.APIYI_API_KEY = "test-only-key";
const image = `data:image/png;base64,${(await sharp({ create: { width: 1600, height: 2400, channels: 3, background: "white" } }).png().toBuffer()).toString("base64")}`;
let calls = 0;
let marked = 0;
const poseFields = ['headAndTorso', 'screenLeftArm', 'screenRightArm', 'screenLeftHand', 'screenRightHand', 'screenLeftLeg', 'screenRightLeg', 'weightAndCrossing', 'notMirrored', 'gaze'];
const poseRows = scores.map(({ index }) => ({ index, checks: Object.fromEntries(poseFields.map(field => [field, {
  status: field === 'gaze' ? 'not-observable' : index === 0 && field === 'screenRightLeg' ? 'mismatch' : 'match',
  reference: '画面右膝弯曲，腿部交叉', candidate: index === 0 ? '双脚分开，右膝伸直' : '画面右膝弯曲，腿部交叉',
}])) }));
const posePayload = { choices: [{ message: { content: JSON.stringify({ candidates: poseRows }) } }] };
const matchingPose = { ...poseRows[1], index: 0 };
for (const field of poseFields.filter(field => field !== 'gaze')) {
  for (const status of ['mismatch', 'indeterminate', 'not-observable']) {
    const row = { ...matchingPose, checks: { ...matchingPose.checks, [field]: { ...matchingPose.checks[field], status } } };
    assert.equal(parsePoseReviewCandidates([row], 1, 'depth')[0].status, status === 'mismatch' ? 'mismatch' : 'indeterminate', `${field}/${status} 不得放行`);
  }
}
for (const referenceType of ['original', 'neutral-outfit', 'skeleton', 'depth', 'unspecified'] as const) {
  assert.equal(parsePoseReviewCandidates([matchingPose], 1, referenceType)[0].status, referenceType === 'skeleton' || referenceType === 'depth' ? 'match' : 'indeterminate');
}
const falseGaze = { ...matchingPose, checks: { ...matchingPose.checks, gaze: { ...matchingPose.checks.gaze, status: 'mismatch' } } };
assert.equal(parsePoseReviewCandidates([falseGaze], 1, 'depth')[0].status, 'match', '深度参考无法提供视线信息，不能因此判错');
for (const rows of [[], [matchingPose, matchingPose], [{ ...matchingPose, index: -1 }], [{ ...matchingPose, index: 0.5 }], [{ ...matchingPose, index: 1 }], [{ ...matchingPose, checks: {} }]]) {
  assert.throws(() => parsePoseReviewCandidates(rows, 1, 'depth'));
}
assert.throws(() => parsePoseReviewCandidates([matchingPose, matchingPose], 2, 'depth'), /索引/);
for (const patch of [{ status: true }, { status: 'unknown' }, { reference: '' }, { candidate: ' ' }, { reference: 'x'.repeat(601) }]) {
  assert.throws(() => parsePoseReviewCandidates([{ ...matchingPose, checks: { ...matchingPose.checks, screenRightLeg: { ...matchingPose.checks.screenRightLeg, ...patch } } }], 1, 'depth'));
}
assert.equal(readTryOnPoseReview({ version: 1, referenceType: 'depth', candidates: [matchingPose] })?.candidates[0].status, 'match');
assert.equal(readTryOnPoseReview({ version: 1, referenceType: 'depth', candidates: [{ index: 0, status: 'match' }] }), undefined);
try {
  let earlyPoseCalls = 0;
  let angleControlled = false;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body));
    const parts = body.messages[0].content;
    const reviewInstructions = parts.filter((part: { type?: string }) => part.type === 'text').map((part: { text?: string }) => part.text).join('\n');
    const poseOnly = reviewInstructions.includes('独立姿势对照评审');
    if (angleControlled) {
      assert.match(reviewInstructions, /TiAngelNode 已启用/);
      assert.match(reviewInstructions, poseOnly ? /不要求复制原图二维坐标/ : /不得因候选偏离原 scene 镜头/);
    } else {
      assert.doesNotMatch(reviewInstructions, /TiAngelNode 已启用/);
    }
    if (poseOnly) {
      assert.doesNotMatch(reviewInstructions, /不能泄漏的完整生成提示词|角色：scene|角色：person|角色：outfit/);
      assert.match(reviewInstructions, /depth/);
      assert.match(reviewInstructions, /画面左\/右/);
      assert.match(reviewInstructions, /not-observable/);
    } else {
      assert.ok(parts.some((part: { text?: string }) => part.text?.includes('角色：scene')));
      assert.ok(!parts.some((part: { text?: string }) => part.text?.includes('角色：pose')), '质量裁判不再评姿势');
      assert.match(reviewInstructions, /不评动作一致性/);
    }
    const images = parts.filter((part: { type: string }) => part.type === 'image_url');
    assert.equal(images.length, poseOnly ? 2 : 3);
    const metadata = await sharp(Buffer.from(images[0].image_url.url.split(',')[1], 'base64')).metadata();
    assert.equal(metadata.height, 1280);
    assert.ok(Math.abs(metadata.width! / metadata.height! - 2 / 3) < 0.002);
    if (poseOnly) {
      const row = { ...poseRows[earlyPoseCalls], index: 0 };
      earlyPoseCalls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: [row] }) } }] }), { status: 200 });
    }
    return new Response(JSON.stringify(calls === 1 ? { choices: [{ message: { content: 'invalid JSON' } }] } : responsePayload), { status: 200 });
  };
  const input = { stage: 'scene-stabilize' as const, referenceImages: [image, image], referenceRoles: ['scene', 'pose'], candidates: [image, image], prompt: '不能泄漏的完整生成提示词', poseReferenceType: 'depth', beforeProviderCall: async () => { marked += 1; } };
  const result = await selectBestTryOnCandidate(input);
  assert.equal(result.selectedIndex, 1);
  assert.equal(result.providerRequests, 4, '质量重试与每候选独立姿势请求均计费');
  assert.equal(marked, 4);
  assert.equal(input.referenceImages[0], image, "评审压缩不得修改生图参考");
  angleControlled = true;
  calls = 0;
  earlyPoseCalls = 0;
  const angled = await selectBestTryOnCandidate({ ...input, angleControlled: true });
  assert.equal(angled.selectedIndex, 1);
  assert.equal(angled.providerRequests, 4, '角度控制仍逐候选独立评姿势');
  angleControlled = false;
  calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401 }); };
  await assert.rejects(selectBestTryOnCandidate(input));
  assert.equal(calls, 1, "鉴权错误不得重试");

  for (const mode of ['match', 'mismatch', 'indeterminate', 'not-observable', 'malformed', 'unauthorized', 'quality-fail', 'retry']) {
    let requests = 0;
    const ordinals: number[] = [];
    globalThis.fetch = async (_url, init) => {
      requests++;
      const content = JSON.parse(String(init?.body)).messages[0].content;
      const poseOnly = content[0].text.includes('独立姿势对照评审');
      if (!poseOnly) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scores: [{ ...scores[0], hardFail: mode === 'quality-fail' }] }) } }] }));
      if (mode === 'unauthorized') return new Response('{}', { status: 401 });
      const status = ['mismatch', 'indeterminate', 'not-observable'].includes(mode) ? mode : 'match';
      const rows = mode === 'malformed' || (mode === 'retry' && requests === 2) ? [] : [{
        ...matchingPose, checks: { ...matchingPose.checks, screenRightLeg: { ...matchingPose.checks.screenRightLeg, status } },
      }];
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: rows }) } }] }));
    };
    const single = await selectBestTryOnCandidate({ ...input, candidates: [image], beforeProviderCall: async n => { ordinals.push(n); } });
    assert.equal(single.selectedIndex, mode === 'match' || mode === 'retry' ? 0 : null, `单候选 ${mode} 不得默认通过`);
    assert.equal(requests, mode === 'malformed' || mode === 'retry' ? 3 : 2);
    assert.equal(single.providerRequests, requests);
    assert.deepEqual(ordinals, Array.from({ length: requests }, (_, i) => i + 1));
    if (mode === 'malformed' || mode === 'unauthorized') {
      assert.ok(single.poseReviewError);
      assert.equal(single.poseReview, undefined);
      assert.equal(single.scores[0].poseMatches, undefined, '失败时不得保留质量裁判的姿势结论');
    } else assert.equal(single.poseReview?.candidates[0].status, mode === 'mismatch' ? 'mismatch' : mode === 'indeterminate' || mode === 'not-observable' ? 'indeterminate' : 'match');
  }
  calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.doesNotMatch(String(init?.body), /独立姿势对照评审/);
    return new Response(JSON.stringify(responsePayload));
  };
  const refined = await selectBestTryOnCandidate({ ...input, stage: 'garment-refine', referenceImages: [image], referenceRoles: ['baseline'] });
  assert.equal(refined.selectedIndex, 1);
  assert.equal(refined.providerRequests, 1);
  assert.equal(calls, 1, '第二轮不新增独立裁判');
  await selectBestTryOnCandidate({ ...input, stage: 'garment-refine', candidates: [image] });
  assert.equal(calls, 1, '第二轮单候选兼容路径保留');
  calls = 0;
  const noPose = await selectBestTryOnCandidate({ ...input, referenceImages: [image], referenceRoles: ['scene'] });
  assert.equal(noPose.selectedIndex, 0, '未提供姿势参考时按质量分选择，不受姿势分项影响');
  assert.equal(noPose.providerRequests, 1, '没有姿势参考时仅评审质量');
  assert.equal(calls, 1);
  assert.equal(noPose.poseReview, undefined);
  assert.ok(noPose.scores.every(score => score.poseMatches === undefined));

  const isolatedImages = await Promise.all(['red', 'green', 'blue', 'yellow'].map(async background =>
    `data:image/png;base64,${(await sharp({ create: { width: 16, height: 24, channels: 3, background } }).png().toBuffer()).toString('base64')}`));
  const expectedPose = `data:image/jpeg;base64,${(await sharp(Buffer.from(isolatedImages[1].split(',')[1], 'base64')).jpeg({ quality: 85 }).toBuffer()).toString('base64')}`;
  const expectedCandidates = await Promise.all([isolatedImages[2], isolatedImages[3]].map(async value =>
    `data:image/jpeg;base64,${(await sharp(Buffer.from(value.split(',')[1], 'base64')).jpeg({ quality: 85 }).toBuffer()).toString('base64')}`));
  let isolatedPoseCalls = 0;
  globalThis.fetch = async (_url, init) => {
    const parts = JSON.parse(String(init?.body)).messages[0].content;
    const poseOnly = parts[0].text.includes('独立姿势对照评审');
    const images = parts.filter((p: { type: string }) => p.type === 'image_url');
    if (poseOnly) {
      assert.equal(images.length, 2, '每个候选必须单独评审，避免多候选 JSON 拼接');
      assert.equal(images[0].image_url.url, expectedPose, '独立裁判必须拿到实际pose字节，不得错取人物/场景');
      assert.equal(images[1].image_url.url, expectedCandidates[isolatedPoseCalls], '请求只能携带当前候选');
      assert.doesNotMatch(JSON.stringify(parts), /不能泄漏的完整生成提示词/);
      const row = { ...poseRows[isolatedPoseCalls], index: 0 };
      isolatedPoseCalls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: [row] }) } }] }));
    }
    isolatedPoseCalls = 0;
    assert.ok(images.every((p: { image_url: { url: string } }) => p.image_url.url !== expectedPose));
    return new Response(JSON.stringify(responsePayload));
  };
  const isolated = await selectBestTryOnCandidate({ ...input, referenceImages: isolatedImages, referenceRoles: ['person', 'pose', 'outfit', 'scene'], candidates: [isolatedImages[2], isolatedImages[3]] });
  assert.equal(isolated.selectedIndex, 1, '逐候选响应仍必须映射回原候选索引');
  assert.equal(isolated.providerRequests, 3, '质量一次加每候选一次姿势评审');
  const withoutCallback = await selectBestTryOnCandidate({ ...input, beforeProviderCall: undefined, referenceImages: isolatedImages, referenceRoles: ['person', 'pose', 'outfit', 'scene'], candidates: [isolatedImages[2], isolatedImages[3]] });
  assert.equal(withoutCallback.providerRequests, 3, '未传回调时仍累计每候选姿势评审');

  // Reproduce E3ceUhXiqN's erroneous prose at the real runner → generator →
  // selector seam. Old analysis text must reach neither paid request.
  globalThis.fetch = async () => { throw new Error("unexpected real network request"); };
  const inventedPose = "Both elbows bent; both hands tucked into front pockets; right leg positioned forward.";
  const smallImage = `data:image/png;base64,${(await sharp({ create: { width: 32, height: 48, channels: 3, background: "white" } }).png().toBuffer()).toString("base64")}`;
  {
    const images = Array(3).fill(smallImage);
    const generate = async (request: ImageGenRequest) => {
      assert.match(request.prompt, /未提供独立姿势参考图/);
      assert.match(request.prompt, /自然安排人物动作/);
      assert.doesNotMatch(request.prompt, /undefined|最终动作仅由姿势参考图/);
      return { images: [smallImage], model: 'gemini-3-pro-image-preview' };
    };
    const noPoseResult = await executeStep({ nodeId: 'no-pose', kind: 'virtual-try-on', inputImages: images,
      params: { workflowStage: 'scene-stabilize', modelId: 'gemini-3-pro-image-preview', imageSize: '2K', qualityMode: 'fast' } }, images,
    () => ({ id: 'stub', generate, edit: generate }), {
      referenceRoles: ['scene', 'person', 'outfit'],
      sceneAnalyzer: async () => ({ prompt: '摄影棚', providerRequests: 0, model: 'stub', cacheHit: true }),
      candidateSelector: async input => {
        assert.deepEqual(input.referenceRoles, ['person', 'outfit', 'scene']);
        return { selectedIndex: 0, scores: [], model: 'stub', providerRequests: 0, allHardFail: false };
      },
    });
    assert.equal(noPoseResult.images.length, 1);
  }
  for (const modelId of ['gemini-3.1-flash-image', 'gemini-3-pro-image-preview', 'gpt-image-2', 'gpt-image-2.5-flare']) {
    for (const prompt of ['画面左腿较直，画面右膝弯曲。', ' \n ']) {
      let enhancerCalls = 0;
      let snapshot: GenerationRequestSnapshot | undefined;
      const generate = async (request: ImageGenRequest) => {
        assert.equal(request.prompt, snapshot?.prompt);
        if (prompt.trim()) assert.ok(request.prompt.includes(prompt.trim()), '必须保留用户原始动作文字');
        assert.doesNotMatch(request.prompt, /结构化增强要求|保持原服装褶皱不变/);
        const headings = Array.from(request.prompt.matchAll(/^【([^】]+)】/gm), ([, heading]) => heading);
        assert.ok(headings.indexOf('姿势') < headings.indexOf('身份'), '先定义动作，再定义身份和服装');
        assert.doesNotMatch(request.prompt, /严格还原其中可见的头部俯仰与侧倾、视线/);
        return { images: [smallImage], model: modelId };
      };
      const images = Array(4).fill(smallImage);
      const result = await executeStep({ nodeId: 'scene-no-enhancement', kind: 'virtual-try-on', inputImages: images,
        params: { workflowStage: 'scene-stabilize', modelId, imageSize: '2K', poseReferenceType: 'depth',
          prompt, promptEnhancement: true, materialSpec: '旧配置残留', qualityMode: 'fast' } }, images,
      () => ({ id: modelId, generate, edit: generate }), {
        referenceRoles: ['scene', 'pose', 'person', 'outfit'],
        onSceneRequestPrepared: async request => { snapshot = request; },
        candidateSelector: async () => ({ selectedIndex: null, scores: [], model: 'stub', providerRequests: 0, allHardFail: false }),
        sceneAnalyzer: async () => ({ prompt: '摄影棚', providerRequests: 0, model: 'stub', cacheHit: true }),
        promptEnhancer: async () => {
          enhancerCalls++;
          return { enhancedPrompt: '保持原服装褶皱不变', safePrompt: '改写动作', providerRequests: 1, model: 'stub', cacheHit: false };
        },
      });
      assert.equal(enhancerCalls, 0, '第一轮旧配置开启增强也不得调用增强器');
      assert.equal(result.providerRequests, 1, '第一轮不得增加增强请求计费');
      assert.deepEqual((result.executionMeta?.tryOn as Record<string, unknown>).promptEnhancement, {
        enabled: false, reason: 'scene-stabilize-original-prompt', message: '第一轮不执行通用提示词增强，保留原始要求',
      });
    }
  }
  {
    const snapshots: GenerationRequestSnapshot[] = [];
    let calls = 0;
    const generate = async (request: ImageGenRequest) => {
      assert.equal(snapshots.at(-1)?.prompt, request.prompt, "调用前必须记录原始提示词");
      calls++;
      throw new ProviderError("refused", 400, "stub", "content_refused");
    };
    const images = Array(4).fill(smallImage);
    await assert.rejects(executeStep({ nodeId: "fallback-record", kind: "virtual-try-on", inputImages: images,
      params: { workflowStage: "scene-stabilize", modelId: "gpt-image-2.5-flare", imageSize: "2K",
        prompt: "自然质感", promptEnhancement: true, safetyFallback: true, qualityMode: "fast" } }, images,
    () => ({ id: "stub", generate, edit: generate }), {
      referenceRoles: ["scene", "pose", "outfit", "person"],
      onSceneRequestPrepared: async request => { snapshots.push(request); },
      sceneAnalyzer: async () => ({ prompt: "摄影棚", providerRequests: 0, model: "stub", cacheHit: true }),
      promptEnhancer: async () => { assert.fail('第一轮不得生成安全改写版本'); },
    }), error => error instanceof ProviderError && error.category === 'content_refused');
    assert.equal(snapshots.length, 1);
    assert.equal(calls, 1, '第一轮审核拒绝不得用同一提示词再次生成');
  }
  {
    const prompts: string[] = [];
    const generate = async (request: ImageGenRequest) => {
      prompts.push(request.prompt);
      if (prompts.length === 1) throw new ProviderError('refused', 400, 'stub', 'content_refused');
      return { images: [smallImage], model: 'stub' };
    };
    const images = [smallImage, smallImage];
    const result = await executeStep({ nodeId: 'refine-fallback', kind: 'virtual-try-on', inputImages: images,
      params: { workflowStage: 'garment-refine', modelId: 'gpt-image-2', imageSize: '2K',
        prompt: '保留双褶线', garmentCategory: 'knit', materialSpec: '羊毛', constructionSpec: '平针', approvedBaselineRef: smallImage,
        promptEnhancement: true, safetyFallback: true, qualityMode: 'fast' } }, images,
    () => ({ id: 'stub', generate, edit: generate }), {
      referenceRoles: ['baseline', 'outfit'],
      promptEnhancer: async () => ({ enhancedPrompt: '保留清晰双褶线', safePrompt: '还原服装结构', providerRequests: 1, model: 'stub', cacheHit: false }),
    });
    assert.match(prompts[0], /用户原始要求（必须逐项保留）：保留双褶线/);
    assert.match(prompts[0], /结构化增强要求：保留清晰双褶线/);
    assert.match(prompts[1], /补充要求：还原服装结构/);
    assert.equal(prompts.length, 2, '第二轮仍可安全降级一次');
    assert.equal(result.prompts?.[0], prompts[1]);
    assert.equal((result.executionMeta?.tryOn as Record<string, unknown>).safetyFallbackUsed, true);
  }
  for (const poseReferenceType of ["depth", "skeleton", "neutral-outfit", "original"]) {
    for (const withNeutral of [false, true]) {
      let poseCalls = 0;
      let generationCalls = 0;
      let judgeCalls = 0;
      const assertNoPoseProse = (prompt: string) => {
        assert.ok(!prompt.includes(inventedPose), "不得让模型臆测动作进入生图或评审");
        assert.doesNotMatch(prompt, /姿势分析对原图的几何复核|姿势分析不可用|身体姿势：|手部姿势：/);
        const label = { depth: '深度图', skeleton: 'DWPose 骨骼图', 'neutral-outfit': '服饰简化人物照片', original: '原始人物照片' }[poseReferenceType];
        assert.ok(prompt.includes(`参考图1是${label}。`));
      };
      const generate = async (request: ImageGenRequest) => {
        generationCalls++;
        assertNoPoseProse(request.prompt);
        assert.equal(request.referenceImages?.[0], smallImage);
        assert.equal(request.referenceImages?.length, 4, "只发送用户连接的四张图片，不附加人脸或中性源");
        assert.doesNotMatch(request.prompt, /脸部锚点|身份锚点|背心＋紧身裤中性源/);
        return { images: [smallImage], model: "stub" };
      };
      // An extra legacy option deliberately remains in the fixture: it must
      // never be invoked, even by a caller still passing the former hook.
      const options = {
        referenceRoles: ["scene", "pose", "person", "outfit"],
        sceneAnalyzer: async () => ({ prompt: "环境：摄影棚", providerRequests: 0, model: "stub", cacheHit: true }),
        identityAnchorer: async () => { assert.fail("不得调用人脸定位或裁切"); },
        poseAnalyzer: async () => {
          poseCalls++;
          return { guideImage: smallImage, prompt: inventedPose, providerRequests: 1, model: "stub", cacheHit: false };
        },
        candidateSelector: async (input: { prompt: string; referenceRoles: string[]; referenceImages: string[] }) => {
          judgeCalls++;
          assertNoPoseProse(input.prompt);
          assert.equal(input.referenceRoles[0], "pose");
          assert.deepEqual(input.referenceRoles, ["pose", "person", "outfit", "scene"]);
          assert.equal(input.referenceImages.length, 4);
          return { selectedIndex: 0, scores: [], model: "stub", providerRequests: 0, allHardFail: false };
        },
      };
      const refs = Array.from({ length: 4 }, () => smallImage);
      const result = await executeStep({ nodeId: "pose-prose-regression", kind: "virtual-try-on", inputImages: refs,
        params: { workflowStage: "scene-stabilize", modelId: "gemini-3.1-flash-image", imageSize: "2K", qualityMode: "best", poseReferenceType,
          ...(withNeutral ? { poseNeutralSource: smallImage } : {}) } }, refs,
      () => ({ id: "stub", generate, edit: generate }), options);
      assert.equal(poseCalls, 0, "不再调用或计费姿势文字分析");
      assert.equal(generationCalls, 3);
      assert.equal(judgeCalls, 1);
      assert.equal(result.providerRequests, 3);
    }
  }
  {
    const refs = Array.from({ length: 4 }, () => smallImage);
    const posePrompt = '整体姿态：侧身站立\n面部神态：嘴唇闭合，嘴角轻微上扬\n视线方向：无法判断';
    const generate = async (request: ImageGenRequest) => {
      assert.ok(request.prompt.includes(posePrompt), '用户确认的姿态与神态原文进入最终请求');
      assert.match(request.prompt, /“无法判断”表示没有该项约束/);
      assert.match(request.prompt, /不能从灰阶或关键点猜测视线与表情/);
      assert.match(request.prompt, /神态只改变可见表情，不改变身份参考的五官结构/);
      assert.equal(request.referenceImages?.[0], smallImage);
      return { images: [smallImage], model: 'stub' };
    };
    const result = await executeStep({ nodeId: 'pose-expression', kind: 'virtual-try-on', inputImages: refs,
      params: { workflowStage: 'scene-stabilize', modelId: 'gemini-3-pro-image-preview', imageSize: '2K', qualityMode: 'fast', poseReferenceType: 'depth', posePrompt } }, refs,
    () => ({ id: 'stub', generate, edit: generate }), {
      referenceRoles: ['pose', 'person', 'outfit', 'scene'],
      sceneAnalyzer: async () => ({ prompt: '环境：摄影棚', providerRequests: 0, model: 'stub', cacheHit: true }),
      candidateSelector: async () => ({ selectedIndex: 0, scores: [], model: 'stub', providerRequests: 0, allHardFail: false }),
    });
    assert.equal(result.providerRequests, 1);
  }
  const optionalRoles = ["bag", "shoes", "socks", "hat", "ring", "earrings", "bracelet", "detail"];
  const roles = ["pose", "person", "outfit", ...optionalRoles, "scene"];
  const roleImages = await Promise.all(roles.map(async (_role, index) => `data:image/png;base64,${(await sharp({ create: {
    width: 16, height: 24, channels: 3, background: { r: 10 + index * 19, g: 20, b: 90 },
  } }).png().toBuffer()).toString("base64")}`));
  // Every optional-role combination, reversed edge order, plus multiple identity
  // images. Compare actual request bytes and prompt numbers, not only counts.
  for (let mask = 0; mask < 256; mask++) {
    const expectedRoles = roles.filter(role => !optionalRoles.includes(role) || (mask & (1 << optionalRoles.indexOf(role))));
    const expected = expectedRoles.map(role => ({ role, image: roleImages[roles.indexOf(role)] }));
    if (mask === 0) expected.splice(2, 0, { role: "person", image: smallImage });
    const incoming = [...expected].reverse();
    const images = incoming.map(item => item.image);
    let snapshot: GenerationRequestSnapshot | undefined;
    const rolePhrases: Record<string, string> = {
      pose: "是用户手动选择的原始姿势参考图", person: "是主要完整人物身份图",
      outfit: "是服装与搭配风格的唯一来源", scene: "是纯场景环境参考",
      bag: "只控制目标包袋", shoes: "只控制目标鞋履", socks: "只控制目标袜子",
      hat: "只控制目标帽子", ring: "只控制目标戒指", earrings: "只控制目标耳环",
      bracelet: "只控制目标手镯", detail: "仅低权重补充主穿搭图",
    };
    const generate = async (request: ImageGenRequest) => {
      // Stable same-role order follows the incoming edges.
      const ordered = roles.flatMap(role => incoming.filter(item => item.role === role));
      assert.deepEqual(request.referenceImages, ordered.map(item => item.image));
      assert.ok(snapshot, "生图调用前必须已经记录最终请求");
      assert.equal(snapshot.prompt, request.prompt);
      assert.deepEqual(snapshot.references, ordered.map((item, index) => ({
        number: index + 1, role: item.role, image: item.image,
      })));
      for (const [index, item] of ordered.entries()) {
        assert.ok(request.prompt.includes(`参考图${index + 1}`), `${item.role} 的编号缺失`);
        if (item.role !== "person" || ordered.findIndex(ref => ref.role === "person") === index) {
          assert.ok(request.prompt.includes(`参考图${index + 1}${rolePhrases[item.role]}`), `${item.role} 的职责编号不匹配`);
        }
      }
      for (const role of optionalRoles.filter(role => !expectedRoles.includes(role))) {
        assert.ok(!request.prompt.includes(rolePhrases[role]), `未连接的 ${role} 不应进入提示词`);
      }
      const numbers = [...request.prompt.matchAll(/参考图(\d+)/g)].map(match => Number(match[1]));
      assert.ok(numbers.every(number => number >= 1 && number <= ordered.length));
      assert.doesNotMatch(request.prompt, /身份锚点|脸部锚点|pose-neutral|参考图undefined/);
      return { images: [smallImage], model: "stub" };
    };
    await executeStep({ nodeId: "reference-order", kind: "virtual-try-on", inputImages: images,
      params: { workflowStage: "scene-stabilize", modelId: ["gemini-3.1-flash-image", "gemini-3-pro-image-preview", "gpt-image-2", "gpt-image-2.5-flare"][mask % 4], imageSize: "2K",
        qualityMode: "fast", poseNeutralSource: "/api/files/removed-neutral.png", styleReferenceImage: "/api/files/unused-style.png" } }, images,
    () => ({ id: "stub", generate, edit: generate }), {
      referenceRoles: incoming.map(item => item.role),
      onSceneRequestPrepared: async request => { snapshot = request; },
      candidateSelector: async () => ({ selectedIndex: null, scores: [], model: 'stub', providerRequests: 0, allHardFail: false }),
      sceneAnalyzer: async () => ({ prompt: "摄影棚", providerRequests: 0, model: "stub", cacheHit: true }),
    });
  }
} finally {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.APIYI_API_KEY;
  else process.env.APIYI_API_KEY = originalKey;
}
console.log("通过一键换装质量流水线契约测试");

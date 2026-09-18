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
try {
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body));
    const parts = body.messages[0].content;
    assert.ok(parts.some((part: { text?: string }) => part.text?.includes("角色：scene")));
    assert.ok(parts.some((part: { text?: string }) => part.text?.includes("角色：pose")));
    const reviewInstructions = parts
      .filter((part: { type?: string; text?: string }) => part.type === "text")
      .map((part: { text?: string }) => part.text ?? "")
      .join("\n");
    assert.match(reviewInstructions, /pose 参考图是第一轮姿势判断的唯一标准/);
    assert.match(reviewInstructions, /poseChecks/);
    assert.match(reviewInstructions, /任一分项为 false/);
    assert.match(reviewInstructions, /用户手动选择的原图、骨骼图或深度图/);
    assert.match(reviewInstructions, /不因骨骼或深度图缺少外观而扣分/);
    assert.match(reviewInstructions, /不得偏好站姿、坐姿或任何所谓“标准姿势”/);
    const images = parts.filter((part: { type: string }) => part.type === "image_url");
    assert.equal(images.length, 4);
    const metadata = await sharp(Buffer.from(images[0].image_url.url.split(",")[1], "base64")).metadata();
    assert.equal(metadata.height, 1280);
    assert.ok(Math.abs(metadata.width! / metadata.height! - 2 / 3) < 0.002);
    return new Response(JSON.stringify(calls === 1 ? { choices: [{ message: { content: "invalid JSON" } }] } : responsePayload), { status: 200 });
  };
  const input = { stage: "scene-stabilize" as const, referenceImages: [image, image], referenceRoles: ["scene", "pose"], candidates: [image, image], prompt: "还原姿势", beforeProviderCall: async () => { marked += 1; } };
  const result = await selectBestTryOnCandidate(input);
  assert.equal(result.selectedIndex, 1);
  assert.equal(result.providerRequests, 2);
  assert.equal(marked, 2);
  assert.equal(input.referenceImages[0], image, "评审压缩不得修改生图参考");
  calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401 }); };
  await assert.rejects(selectBestTryOnCandidate(input));
  assert.equal(calls, 1, "鉴权错误不得重试");

  // Reproduce E3ceUhXiqN's erroneous prose at the real runner → generator →
  // selector seam. Old analysis text must reach neither paid request.
  globalThis.fetch = async () => { throw new Error("unexpected real network request"); };
  const inventedPose = "Both elbows bent; both hands tucked into front pockets; right leg positioned forward.";
  const smallImage = `data:image/png;base64,${(await sharp({ create: { width: 32, height: 48, channels: 3, background: "white" } }).png().toBuffer()).toString("base64")}`;
  for (const poseReferenceType of ["depth", "skeleton", "neutral-outfit", "original"]) {
    for (const withNeutral of [false, true]) {
      let poseCalls = 0;
      let generationCalls = 0;
      let judgeCalls = 0;
      const assertNoPoseProse = (prompt: string) => {
        assert.ok(!prompt.includes(inventedPose), "不得让模型臆测动作进入生图或评审");
        assert.doesNotMatch(prompt, /姿势分析对原图的几何复核|姿势分析不可用|身体姿势：|手部姿势：/);
        assert.match(prompt, /参考图1是用户手动选择的原始姿势参考图/);
      };
      const generate = async (request: ImageGenRequest) => {
        generationCalls++;
        assertNoPoseProse(request.prompt);
        assert.equal(request.referenceImages?.[0], smallImage);
        assert.equal(request.referenceImages?.length, withNeutral ? 6 : 5);
        return { images: [smallImage], model: "stub" };
      };
      // An extra legacy option deliberately remains in the fixture: it must
      // never be invoked, even by a caller still passing the former hook.
      const options = {
        referenceRoles: ["scene", "pose", "person", "outfit"],
        sceneAnalyzer: async () => ({ prompt: "环境：摄影棚", providerRequests: 0, model: "stub", cacheHit: true }),
        identityAnchorer: async () => ({ image: smallImage, providerRequests: 0, model: "stub", cacheHit: true, fallback: false }),
        poseAnalyzer: async () => {
          poseCalls++;
          return { guideImage: smallImage, prompt: inventedPose, providerRequests: 1, model: "stub", cacheHit: false };
        },
        candidateSelector: async (input: { prompt: string; referenceRoles: string[]; referenceImages: string[] }) => {
          judgeCalls++;
          assertNoPoseProse(input.prompt);
          assert.equal(input.referenceRoles[0], "pose");
          assert.equal(input.referenceRoles.includes("pose-neutral"), withNeutral);
          assert.equal(input.referenceImages.length, withNeutral ? 6 : 5);
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
} finally {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.APIYI_API_KEY;
  else process.env.APIYI_API_KEY = originalKey;
}
console.log("通过一键换装质量流水线契约测试");

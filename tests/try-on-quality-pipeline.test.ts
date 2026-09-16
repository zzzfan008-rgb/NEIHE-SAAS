import assert from "node:assert";
import {
  PROMPT_ENHANCER_SYSTEM_PROMPT,
  TRY_ON_PROMPT_ENHANCER_SYSTEM_PROMPT,
} from "../server/lib/promptEnhancement";
import { parseTryOnCandidateSelection, selectBestTryOnCandidate } from "../server/lib/tryOnCandidateSelection";
import sharp from "sharp";
import { tryOnCandidateCount } from "../src/lib/tryOnStylePresets";

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

const scores = [
  { index: 0, identity: 20, anatomy: 15, garment: 20, material: 20, accessories: 15, scene: 10, hardFail: false, poseMatches: false, reasons: ["头部与肩线不符"] },
  { index: 1, identity: 18, anatomy: 14, garment: 19, material: 18, accessories: 14, scene: 9, hardFail: false, poseMatches: true, reasons: [] },
];
const responsePayload = { choices: [{ message: { content: JSON.stringify({ scores }) } }] };
assert.equal(parseTryOnCandidateSelection(responsePayload, 2, "judge", true).selectedIndex, 1);
assert.throws(() => parseTryOnCandidateSelection({ choices: [{ message: { content: JSON.stringify({ scores: scores.map(({ poseMatches: _pose, ...score }) => score) }) } }] }, 2, "judge", true), /姿势/);

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
    const images = parts.filter((part: { type: string }) => part.type === "image_url");
    assert.equal(images.length, 3);
    const metadata = await sharp(Buffer.from(images[0].image_url.url.split(",")[1], "base64")).metadata();
    assert.equal(metadata.height, 1280);
    assert.ok(Math.abs(metadata.width! / metadata.height! - 2 / 3) < 0.002);
    return new Response(JSON.stringify(calls === 1 ? { choices: [{ message: { content: "invalid JSON" } }] } : responsePayload), { status: 200 });
  };
  const input = { stage: "scene-stabilize" as const, referenceImages: [image], referenceRoles: ["scene"], candidates: [image, image], prompt: "还原姿势", beforeProviderCall: async () => { marked += 1; } };
  const result = await selectBestTryOnCandidate(input);
  assert.equal(result.selectedIndex, 1);
  assert.equal(result.providerRequests, 2);
  assert.equal(marked, 2);
  assert.equal(input.referenceImages[0], image, "评审压缩不得修改生图参考");
  calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401 }); };
  await assert.rejects(selectBestTryOnCandidate(input));
  assert.equal(calls, 1, "鉴权错误不得重试");
} finally {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.APIYI_API_KEY;
  else process.env.APIYI_API_KEY = originalKey;
}
console.log("通过一键换装质量流水线契约测试");

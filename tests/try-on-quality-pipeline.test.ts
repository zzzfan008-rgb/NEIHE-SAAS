import assert from "node:assert";
import {
  PROMPT_ENHANCER_SYSTEM_PROMPT,
  TRY_ON_PROMPT_ENHANCER_SYSTEM_PROMPT,
} from "../server/lib/promptEnhancement";
import { parseTryOnCandidateSelection } from "../server/lib/tryOnCandidateSelection";
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

console.log("通过一键换装质量流水线契约测试");

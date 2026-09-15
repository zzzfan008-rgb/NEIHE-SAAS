import assert from "node:assert/strict";
import sharp from "sharp";
import {
  analyzeMaterialImage, cropMaterialImage, parseMaterialSuggestion, validateMaterialCrop,
} from "../server/lib/materialAnalysis";
import { MaterialAnalysisCapacityError, withMaterialAnalysisSlot } from "../server/lib/materialAnalysisLimit";

console.log("材质分析边界测试");

const input = await sharp({ create: { width: 100, height: 80, channels: 3, background: "#AABBCC" } }).png().toBuffer();
const prepared = await cropMaterialImage(`data:image/png;base64,${input.toString("base64")}`, {
  x: 0.1, y: 0.25, width: 0.5, height: 0.5,
});
const metadata = await sharp(Buffer.from(prepared.cropDataUrl.split(",")[1], "base64")).metadata();
assert.equal(metadata.width, 50);
assert.equal(metadata.height, 40);
assert.deepEqual(prepared.crop, { x: 0.1, y: 0.25, width: 0.5, height: 0.5 });
console.log("  ✓ 原图按归一化边界裁切并保留独立裁片");
const orientedInput = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#445566" } })
  .jpeg().withMetadata({ orientation: 6 }).toBuffer();
const orientedCrop = await cropMaterialImage(`data:image/jpeg;base64,${orientedInput.toString("base64")}`, {
  x: 0, y: 0, width: 1, height: 1,
});
const orientedMetadata = await sharp(Buffer.from(orientedCrop.cropDataUrl.split(",")[1], "base64")).metadata();
assert.deepEqual({ width: orientedMetadata.width, height: orientedMetadata.height }, { width: 20, height: 40 });
console.log("  ✓ EXIF 方向在归一化坐标裁切前应用");

assert.throws(() => validateMaterialCrop({ x: 0.8, y: 0, width: 0.3, height: 1 }), /超出/);
assert.throws(() => validateMaterialCrop({ x: 0, y: 0, width: 1, height: 1, extra: true }), /未知字段/);
await assert.rejects(() => cropMaterialImage(`data:image/png;base64,${input.toString("base64")}`, {
  x: 0, y: 0, width: 0.1, height: 0.1,
}), /16×16/);
console.log("  ✓ 非法、越界和过小裁切被拒绝");

const suggestion = parseMaterialSuggestion({
  materialDescription: "细密斜纹，哑光表面",
  observedAttributes: ["斜纹", "低光泽"],
  uncertainAttributes: ["成分待确认"],
  colors: [{ hex: "rgb(170, 187, 204)", name: "灰蓝" }],
});
assert.equal(suggestion.colors[0].hex, "#AABBCC");
assert.throws(() => parseMaterialSuggestion({
  materialDescription: "test", observedAttributes: [], uncertainAttributes: [], colors: [{ hex: "bad" }],
}), /颜色值无效/);
console.log("  ✓ 模型 JSON 仅接受有界材质字段并规范化 HEX");

let requestedUrl = "";
let requestedBody = "";
const analyzed = await analyzeMaterialImage(prepared.cropDataUrl, "gemini-test", (async (url: string, init: () => RequestInit) => {
  requestedUrl = url;
  requestedBody = String(init().body);
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
    materialDescription: "针织表面",
    observedAttributes: ["纹理清晰"],
    uncertainAttributes: ["纤维成分无法确定"],
    colors: [{ hex: "#123456", name: "深蓝" }],
  }) }] } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
}) as never);
assert.match(requestedUrl, /gemini-test:generateContent$/);
assert.match(requestedBody, /不得输出 Pantone/);
assert.match(requestedBody, /inlineData/);
assert.equal(analyzed.colors[0].hex, "#123456");
console.log("  ✓ 可选 Gemini 模型接收裁片且 Prompt 禁止伪造 Pantone 身份");

let releaseSlots!: () => void;
const held = new Promise<void>((resolve) => { releaseSlots = resolve; });
const first = withMaterialAnalysisSlot("owner", () => held);
const second = withMaterialAnalysisSlot("owner", () => held);
await assert.rejects(
  () => withMaterialAnalysisSlot("owner", async () => undefined),
  MaterialAnalysisCapacityError,
);
releaseSlots();
await Promise.all([first, second]);
await withMaterialAnalysisSlot("owner", async () => undefined);
console.log("  ✓ 单账号材质分析并发受限，完成后正确释放容量");

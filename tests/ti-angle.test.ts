import assert from "node:assert/strict";
import {
  compileTiAngleText,
  describeTiAngleText,
  encodeTiAngleSemantics,
  normalizeTiAngleConfig,
  validateTiAngleConfig,
  type TiAngleConfig,
} from "../src/lib/tiAngle";
import { IMAGE_MODEL_IDS, type ImageModelId } from "../src/types/imageModels";

console.log("TiAngelNode 角度契约测试");

const baseConfig: TiAngleConfig = {
  version: 1,
  enabled: true,
  azimuthDeg: 45,
  elevationDeg: 15,
  rollDeg: -10,
};

assert.deepEqual(encodeTiAngleSemantics(baseConfig), {
  horizontal: "左前方",
  vertical: "高处俯拍",
  roll: "逆时针",
});

const gptText = compileTiAngleText(baseConfig, "gpt-image-2");
assert.equal(gptText.targetModelId, "gpt-image-2");
assert.equal(gptText.adapterVersion, 1);
assert.match(gptText.text, /左前方/);
assert.match(gptText.text, /45/);
assert.match(gptText.text, /俯拍.*15/);
assert.match(gptText.text, /逆时针.*10/);
assert.doesNotMatch(gptText.text, /<sks>/);

const disabledText = compileTiAngleText(
  { ...baseConfig, enabled: false },
  "gpt-image-2",
);
assert.equal(disabledText.text, "", "禁用节点不得输出角度约束");

assert.match(
  describeTiAngleText(baseConfig),
  /通用视角描述（未绑定模型）.*左前方/s,
);

const zeroText = compileTiAngleText(
  { version: 1, enabled: true, azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 },
  "gemini-3.1-flash-image",
);
assert.match(zeroText.text, /正面/);
assert.match(zeroText.text, /平视/);
assert.match(zeroText.text, /保持竖直/);

for (const modelId of IMAGE_MODEL_IDS) {
  const compiled = compileTiAngleText(baseConfig, modelId);
  assert.equal(compiled.targetModelId, modelId);
  assert.equal(compiled.adapterVersion, 1);
  assert.ok(compiled.text.length > 0, `${modelId} 必须有非空适配文本`);
  assert.match(compiled.text, /45/);
  assert.match(compiled.text, /15/);
  assert.match(compiled.text, /10/);
  assert.doesNotMatch(compiled.text, /<sks>/);
}

assert.throws(
  () => compileTiAngleText(baseConfig, "unknown-model" as ImageModelId),
  /不支持的生图模型/,
);

assert.equal(normalizeTiAngleConfig({ ...baseConfig, azimuthDeg: 180 }).azimuthDeg, -180);
assert.equal(normalizeTiAngleConfig({ ...baseConfig, azimuthDeg: -0 }).azimuthDeg, 0);
assert.equal(normalizeTiAngleConfig({ ...baseConfig, azimuthDeg: 360 }).azimuthDeg, 0);
assert.equal(normalizeTiAngleConfig({ ...baseConfig, elevationDeg: 60 }).elevationDeg, 60);
assert.equal(normalizeTiAngleConfig({ ...baseConfig, rollDeg: -30 }).rollDeg, -30);
assert.equal(
  encodeTiAngleSemantics({ ...baseConfig, azimuthDeg: -22.5 }).horizontal,
  "正面",
);
assert.equal(
  encodeTiAngleSemantics({ ...baseConfig, azimuthDeg: 22.5 }).horizontal,
  "左前方",
);

assert.throws(
  () => validateTiAngleConfig({ ...baseConfig, azimuthDeg: Number.NaN }),
  /azimuthDeg.*finite/,
);
assert.throws(
  () => validateTiAngleConfig({ ...baseConfig, azimuthDeg: Number.POSITIVE_INFINITY }),
  /azimuthDeg.*finite/,
);
assert.throws(
  () => validateTiAngleConfig({ ...baseConfig, azimuthDeg: "45" } as unknown as TiAngleConfig),
  /azimuthDeg.*finite/,
);
assert.throws(
  () => validateTiAngleConfig({ ...baseConfig, rollDeg: undefined }),
  /rollDeg.*finite/,
);
assert.throws(
  () => validateTiAngleConfig({ ...baseConfig, elevationDeg: 61 }),
  /elevationDeg.*范围/,
);
assert.throws(
  () => validateTiAngleConfig({ ...baseConfig, rollDeg: -31 }),
  /rollDeg.*范围/,
);
assert.throws(
  () => validateTiAngleConfig({ ...baseConfig, enabled: "true" } as unknown as TiAngleConfig),
  /enabled.*boolean/,
);

console.log(`通过 ${IMAGE_MODEL_IDS.length} 个模型适配与角度边界测试`);

import assert from "node:assert/strict";
import {
  compileTiAngleText,
  describeTiAngleCameraParameters,
  describeTiAngleFraming,
  describeTiAngleLightPattern,
  describeTiAngleLightStyle,
  describeTiAngleLighting,
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

const cameraConfig: TiAngleConfig = {
  ...baseConfig,
  camera: {
    cameraModel: "sony-a7r-v",
    focalLengthMm: 85,
    iso: 200,
    shutterSpeed: "1/250",
    aperture: "f/2.8",
  },
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
assert.doesNotMatch(gptText.text, /摄影参数/);

assert.equal(
  describeTiAngleCameraParameters(cameraConfig.camera),
  "Sony α7R V · 85 mm · ISO 200 · 快门 1/250 s · 光圈 f/2.8",
);
assert.match(describeTiAngleText(cameraConfig), /摄影参数：Sony α7R V.*85 mm.*ISO 200.*1\/250 s.*f\/2\.8/s);


const framingConfig: TiAngleConfig = { ...baseConfig, framing: "medium-close-up" };
assert.equal(describeTiAngleFraming(framingConfig.framing), "中特写");
assert.equal(describeTiAngleFraming(undefined), "");
assert.match(describeTiAngleText(framingConfig), /构图景别：中特写（胸部以上构图）/);
assert.match(compileTiAngleText(framingConfig, "gemini-3.1-flash-image").text, /构图景别：中特写/);
assert.match(compileTiAngleText(framingConfig, "gpt-image-2").text, /构图景别：中特写/);
assert.match(compileTiAngleText(framingConfig, "flux-2-pro").text, /构图景别：中特写/);
assert.match(compileTiAngleText(framingConfig, "gpt-image-2").text, /观察视角和构图景别/);
assert.deepEqual(normalizeTiAngleConfig(framingConfig), framingConfig);
assert.equal(normalizeTiAngleConfig(baseConfig).framing, undefined);

const lightingConfig: TiAngleConfig = { ...baseConfig, lighting: { azimuthDeg: -45, elevationDeg: 30 } };
assert.equal(describeTiAngleLighting(lightingConfig.lighting), "光-45°/30°");
assert.equal(describeTiAngleLighting(undefined), "");
assert.match(
  describeTiAngleText(lightingConfig),
  /光源方向：光源位于主体右前方，自上向下照射（方位角 -45°、高度角 30°）/,
);
for (const modelId of ["gemini-3.1-flash-image", "gpt-image-2", "flux-2-pro"] as const) {
  const lightingText = compileTiAngleText(lightingConfig, modelId).text;
  assert.match(lightingText, /光源方向：/, `${modelId} 必须输出光源方向`);
  assert.doesNotMatch(lightingText, /光照不变|和光照/, `${modelId} 已指定光源时不得再保留"光照不变"`);
}
assert.match(compileTiAngleText(lightingConfig, "gpt-image-2").text, /光源方向/);
assert.deepEqual(normalizeTiAngleConfig(lightingConfig), lightingConfig);
assert.equal(normalizeTiAngleConfig(baseConfig).lighting, undefined);
assert.deepEqual(
  normalizeTiAngleConfig({ ...baseConfig, lighting: { azimuthDeg: -180, elevationDeg: 90 } }).lighting,
  { azimuthDeg: -180, elevationDeg: 90 },
);

const styledLightingConfig: TiAngleConfig = {
  ...baseConfig,
  lighting: { azimuthDeg: 45, elevationDeg: 45, pattern: "rembrandt", style: "cinematic" },
};
assert.equal(describeTiAngleLightPattern("rembrandt"), "伦勃朗光");
assert.equal(describeTiAngleLightPattern(undefined), "");
assert.equal(describeTiAngleLightStyle("cinematic"), "电影质感灯光");
assert.equal(describeTiAngleLightStyle(undefined), "");
assert.match(
  describeTiAngleText(styledLightingConfig),
  /光源方向：光源位于主体左前方，自上向下照射（方位角 45°、高度角 45°），伦勃朗光布局，电影质感灯光风格/,
);
for (const modelId of ["gemini-3.1-flash-image", "gpt-image-2", "flux-2-pro"] as const) {
  const styledText = compileTiAngleText(styledLightingConfig, modelId).text;
  assert.match(styledText, /伦勃朗光布局/, `${modelId} 必须输出布光模式`);
  assert.match(styledText, /电影质感灯光风格/, `${modelId} 必须输出照明风格`);
}
assert.deepEqual(normalizeTiAngleConfig(styledLightingConfig), styledLightingConfig);
assert.throws(
  () => validateTiAngleConfig({ ...baseConfig, lighting: { azimuthDeg: 0, elevationDeg: 0, pattern: "bogus" } } as unknown as TiAngleConfig),
  /lighting\.pattern.*不是支持的选项/,
);
assert.throws(
  () => validateTiAngleConfig({ ...baseConfig, lighting: { azimuthDeg: 0, elevationDeg: 0, style: "bogus" } } as unknown as TiAngleConfig),
  /lighting\.style.*不是支持的选项/,
);
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

  const cameraCompiled = compileTiAngleText(cameraConfig, modelId);
  assert.match(cameraCompiled.text, /摄影参数：Sony α7R V/);
  assert.match(cameraCompiled.text, /85 mm/);
  assert.match(cameraCompiled.text, /ISO 200/);
  assert.match(cameraCompiled.text, /快门 1\/250 s/);
  assert.match(cameraCompiled.text, /光圈 f\/2\.8/);
  assert.equal(cameraCompiled.text.match(/摄影参数：/g)?.length, 1);
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
assert.deepEqual(normalizeTiAngleConfig(baseConfig), baseConfig, "旧版无相机字段配置必须保持原形");
assert.deepEqual(normalizeTiAngleConfig({ ...baseConfig, camera: {} }), baseConfig, "空相机设置不得污染旧项目");
assert.deepEqual(normalizeTiAngleConfig(cameraConfig), cameraConfig);
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
  () => validateTiAngleConfig({ ...baseConfig, framing: "macro" } as unknown as TiAngleConfig),
  /framing.*支持/,
);
assert.throws(
  () => validateTiAngleConfig({ ...baseConfig, enabled: "true" } as unknown as TiAngleConfig),
  /enabled.*boolean/,
);
assert.throws(
  () => validateTiAngleConfig({ ...baseConfig, camera: { cameraModel: "unknown" } } as unknown as TiAngleConfig),
  /camera\.cameraModel.*支持/,
);
assert.throws(
  () => validateTiAngleConfig({ ...baseConfig, camera: { iso: 125 } } as unknown as TiAngleConfig),
  /camera\.iso.*支持/,
);
assert.throws(
  () => validateTiAngleConfig({ ...baseConfig, camera: { aperture: "f/2.8", runtimeDraft: true } } as unknown as TiAngleConfig),
  /camera\.runtimeDraft.*不受支持/,
);
assert.throws(
  () => validateTiAngleConfig({ ...baseConfig, lighting: "key" } as unknown as TiAngleConfig),
  /lighting 必须是对象/,
);
assert.throws(
  () => validateTiAngleConfig({ ...baseConfig, lighting: { azimuthDeg: 181, elevationDeg: 0 } } as unknown as TiAngleConfig),
  /lighting\.azimuthDeg.*范围/,
);
assert.throws(
  () => validateTiAngleConfig({ ...baseConfig, lighting: { azimuthDeg: 0, elevationDeg: 91 } } as unknown as TiAngleConfig),
  /lighting\.elevationDeg.*范围/,
);
assert.throws(
  () => validateTiAngleConfig({ ...baseConfig, lighting: { azimuthDeg: 0, elevationDeg: 0, power: 3 } } as unknown as TiAngleConfig),
  /lighting\.power.*不受支持/,
);

console.log(`通过 ${IMAGE_MODEL_IDS.length} 个模型适配与角度边界测试`);

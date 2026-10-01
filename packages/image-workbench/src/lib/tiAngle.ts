import {
  IMAGE_MODEL_IDS,
  isImageModelId,
  type ImageModelId,
} from "../types/imageModels";
import type {
  TiAngleAperture,
  TiAngleCameraModel,
  TiAngleCameraParameters,
  TiAngleConfig,
  TiAngleFocalLengthMm,
  TiAngleIso,
  TiAngleShutterSpeed,
} from "../types/workflow";

export type {
  TiAngleAperture,
  TiAngleCameraModel,
  TiAngleCameraParameters,
  TiAngleConfig,
  TiAngleFocalLengthMm,
  TiAngleIso,
  TiAngleShutterSpeed,
} from "../types/workflow";

export const TI_ANGLE_CONFIG_VERSION = 1 as const;
export const TI_ANGLE_ADAPTER_VERSION = 1 as const;

export interface TiAngleSemantics {
  horizontal: string;
  vertical: string;
  roll: string;
}

export interface TiAngleCompiledText {
  adapterVersion: typeof TI_ANGLE_ADAPTER_VERSION;
  targetModelId: ImageModelId;
  text: string;
}

const AZIMUTH_MIN = -180;
const AZIMUTH_MAX = 180;
const ELEVATION_MIN = -45;
const ELEVATION_MAX = 60;
const ROLL_MIN = -30;
const ROLL_MAX = 30;

export const TI_ANGLE_CAMERA_MODELS = [
  { value: "canon-eos-r5", label: "Canon EOS R5" },
  { value: "nikon-z8", label: "Nikon Z8" },
  { value: "sony-a7r-v", label: "Sony α7R V" },
  { value: "fujifilm-gfx100-ii", label: "FUJIFILM GFX100 II" },
  { value: "leica-sl3", label: "Leica SL3" },
  { value: "hasselblad-x2d-100c", label: "Hasselblad X2D 100C" },
] as const satisfies ReadonlyArray<{ value: TiAngleCameraModel; label: string }>;

export const TI_ANGLE_FOCAL_LENGTHS = [24, 35, 50, 85, 105, 135] as const satisfies readonly TiAngleFocalLengthMm[];
export const TI_ANGLE_ISO_VALUES = [100, 200, 400, 800, 1600, 3200] as const satisfies readonly TiAngleIso[];
export const TI_ANGLE_SHUTTER_SPEEDS = ["1/60", "1/125", "1/250", "1/500", "1/1000"] as const satisfies readonly TiAngleShutterSpeed[];
export const TI_ANGLE_APERTURES = ["f/1.4", "f/1.8", "f/2.8", "f/4", "f/5.6", "f/8"] as const satisfies readonly TiAngleAperture[];

const CAMERA_PARAMETER_KEYS = new Set([
  "cameraModel",
  "focalLengthMm",
  "iso",
  "shutterSpeed",
  "aperture",
]);

const HORIZONTAL_LABELS = [
  "正面",
  "左前方",
  "左侧",
  "左后方",
  "背面",
  "右后方",
  "右侧",
  "右前方",
] as const;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("TiAngelNode 角度配置必须是对象");
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${field} 必须是 finite number`);
  }
  return value;
}

function boundedNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  const number = finiteNumber(value, field);
  if (number < min || number > max) {
    throw new RangeError(`${field} 超出范围 [${min}, ${max}]`);
  }
  return number;
}

function optionalChoice<T extends string | number>(
  value: unknown,
  field: string,
  choices: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (!choices.includes(value as T)) {
    throw new RangeError(`${field} 不是支持的选项`);
  }
  return value as T;
}

function normalizeCameraParameters(value: unknown): TiAngleCameraParameters | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("camera 必须是对象");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!CAMERA_PARAMETER_KEYS.has(key)) {
      throw new TypeError(`camera.${key} 不受支持`);
    }
  }
  const cameraModel = optionalChoice(
    raw.cameraModel,
    "camera.cameraModel",
    TI_ANGLE_CAMERA_MODELS.map((option) => option.value),
  );
  const focalLengthMm = optionalChoice(raw.focalLengthMm, "camera.focalLengthMm", TI_ANGLE_FOCAL_LENGTHS);
  const iso = optionalChoice(raw.iso, "camera.iso", TI_ANGLE_ISO_VALUES);
  const shutterSpeed = optionalChoice(raw.shutterSpeed, "camera.shutterSpeed", TI_ANGLE_SHUTTER_SPEEDS);
  const aperture = optionalChoice(raw.aperture, "camera.aperture", TI_ANGLE_APERTURES);
  const camera: TiAngleCameraParameters = {
    ...(cameraModel === undefined ? {} : { cameraModel }),
    ...(focalLengthMm === undefined ? {} : { focalLengthMm }),
    ...(iso === undefined ? {} : { iso }),
    ...(shutterSpeed === undefined ? {} : { shutterSpeed }),
    ...(aperture === undefined ? {} : { aperture }),
  };
  return Object.keys(camera).length > 0 ? camera : undefined;
}

/** Validate the persisted, canonical shape without silently repairing values. */
export function validateTiAngleConfig(value: unknown): asserts value is TiAngleConfig {
  const raw = record(value);
  if (raw.version !== TI_ANGLE_CONFIG_VERSION) {
    throw new RangeError(`version 必须是 ${TI_ANGLE_CONFIG_VERSION}`);
  }
  if (typeof raw.enabled !== "boolean") {
    throw new TypeError("enabled 必须是 boolean");
  }
  boundedNumber(raw.azimuthDeg, "azimuthDeg", AZIMUTH_MIN, AZIMUTH_MAX);
  boundedNumber(raw.elevationDeg, "elevationDeg", ELEVATION_MIN, ELEVATION_MAX);
  boundedNumber(raw.rollDeg, "rollDeg", ROLL_MIN, ROLL_MAX);
  normalizeCameraParameters(raw.camera);
}

function wrapAzimuth(value: number): number {
  const wrapped = ((value + 180) % 360 + 360) % 360 - 180;
  return wrapped === 0 ? 0 : wrapped;
}

/** Normalize transient pointer/input values before they enter document history. */
export function normalizeTiAngleConfig(value: unknown): TiAngleConfig {
  const raw = record(value);
  if (raw.version !== TI_ANGLE_CONFIG_VERSION) {
    throw new RangeError(`version 必须是 ${TI_ANGLE_CONFIG_VERSION}`);
  }
  if (typeof raw.enabled !== "boolean") {
    throw new TypeError("enabled 必须是 boolean");
  }
  const azimuth = finiteNumber(raw.azimuthDeg, "azimuthDeg");
  const elevation = boundedNumber(raw.elevationDeg, "elevationDeg", ELEVATION_MIN, ELEVATION_MAX);
  const roll = boundedNumber(raw.rollDeg, "rollDeg", ROLL_MIN, ROLL_MAX);
  const camera = normalizeCameraParameters(raw.camera);
  return {
    version: TI_ANGLE_CONFIG_VERSION,
    enabled: raw.enabled,
    azimuthDeg: wrapAzimuth(Math.round(azimuth)),
    elevationDeg: Math.round(elevation) || 0,
    rollDeg: Math.round(roll) || 0,
    ...(camera ? { camera } : {}),
  };
}

function roundedAzimuthSector(azimuthDeg: number): number {
  const normalized = wrapAzimuth(azimuthDeg);
  // Ties belong to the numerically increasing sector: -22.5° remains front,
  // while +22.5° becomes left-front.
  return ((Math.floor((normalized + 22.5) / 45) % 8) + 8) % 8;
}

function signedDegree(value: number): string {
  return `${Math.abs(value)}°`;
}

export function encodeTiAngleSemantics(config: TiAngleConfig): TiAngleSemantics {
  validateTiAngleConfig(config);
  const horizontal = HORIZONTAL_LABELS[roundedAzimuthSector(config.azimuthDeg)];
  const vertical = config.elevationDeg > 0
    ? "高处俯拍"
    : config.elevationDeg < 0
      ? "低处仰拍"
      : "平视";
  const roll = config.rollDeg > 0
    ? "顺时针"
    : config.rollDeg < 0
      ? "逆时针"
      : "保持竖直";
  return { horizontal, vertical, roll };
}

function viewDescription(config: TiAngleConfig): string {
  const semantics = encodeTiAngleSemantics(config);
  const horizontal = `从人物正面向其${semantics.horizontal}观察（环绕角 ${config.azimuthDeg}°）`;
  const vertical = config.elevationDeg === 0
    ? "平视"
    : `${semantics.vertical}${signedDegree(config.elevationDeg)}`;
  const roll = config.rollDeg === 0
    ? "画面保持竖直"
    : `画面${semantics.roll}${signedDegree(config.rollDeg)}`;
  return `${horizontal}；${vertical}；${roll}`;
}

export function describeTiAngleCameraParameters(camera: TiAngleCameraParameters | undefined): string {
  if (!camera) return "";
  const cameraModel = camera.cameraModel
    ? TI_ANGLE_CAMERA_MODELS.find((option) => option.value === camera.cameraModel)?.label
    : undefined;
  return [
    cameraModel,
    camera.focalLengthMm === undefined ? undefined : `${camera.focalLengthMm} mm`,
    camera.iso === undefined ? undefined : `ISO ${camera.iso}`,
    camera.shutterSpeed === undefined ? undefined : `快门 ${camera.shutterSpeed} s`,
    camera.aperture === undefined ? undefined : `光圈 ${camera.aperture}`,
  ].filter((part): part is string => Boolean(part)).join(" · ");
}

function cameraConstraint(config: TiAngleConfig): string {
  const description = describeTiAngleCameraParameters(config.camera);
  return description
    ? `摄影参数：${description}。参数用于镜头透视、景深、运动表现与曝光表现，并保持场景布光方向和主体内容不变。`
    : "";
}

function appendCameraConstraint(config: TiAngleConfig, text: string): string {
  const camera = cameraConstraint(config);
  return camera ? `${text}\n${camera}` : text;
}

/** Text shown before a downstream image model is selected. It is not a model adapter. */
export function describeTiAngleText(config: TiAngleConfig): string {
  validateTiAngleConfig(config);
  const scope = config.camera
    ? "仅改变观察视角和已指定的相机成像参数，不把画面倾斜理解为身体侧倾。"
    : "仅改变观察视角，不把画面倾斜理解为身体侧倾。";
  return appendCameraConstraint(
    config,
    `通用视角描述（未绑定模型）：${viewDescription(config)}。保持人物身份、姿势、服装、材质、场景和光照不变；${scope}`,
  );
}

type TiAngleAdapter = (config: TiAngleConfig) => string;

const adaptNaturalLanguage: TiAngleAdapter = (config) => {
  const scope = config.camera
    ? "只改变观察视角和已指定的相机成像参数，不把画面倾斜理解为身体侧倾。"
    : "只改变观察视角，不把画面倾斜理解为身体侧倾。";
  return appendCameraConstraint(
    config,
    `将最终画面改为${viewDescription(config)}。保持人物身份、脸部、姿势、服装、材质、场景和光照；${scope}`,
  );
};

const adaptSegmentedChinese: TiAngleAdapter = (config) => {
  const semantics = encodeTiAngleSemantics(config);
  const camera = cameraConstraint(config);
  return [
    "镜头约束：",
    `${viewDescription(config)}。`,
    `方位语义：${semantics.horizontal}；垂直方向：${semantics.vertical}；画面旋转：${semantics.roll}。`,
    camera,
    "保持人物身份、身体姿势、服装版型与材质、场景内容和光照方向；仅重新生成目标视角下可见的表面。",
    "画面 roll 只表示最终画面倾斜，不表示人物身体或头部倾斜。",
  ].filter(Boolean).join("\n");
};

const adaptConciseEdit: TiAngleAdapter = (config) => appendCameraConstraint(
  config,
  config.camera
    ? `相机约束：${viewDescription(config)}。保持人物、姿势、服装、材质、场景和光照不变；只调整观察视角和已指定的相机成像参数，不要把画面倾斜改成身体倾斜。`
    : `只改变相机观察视角：${viewDescription(config)}。保持人物、姿势、服装、材质、场景和光照不变；不要把画面倾斜改成身体倾斜。`,
);

const ADAPTERS: Record<ImageModelId, TiAngleAdapter> = {
  "gemini-3-pro-image-preview": adaptSegmentedChinese,
  "gemini-3.1-flash-image": adaptSegmentedChinese,
  "gpt-image-2.5-sunburst": adaptConciseEdit,
  "gpt-image-2.5-flare": adaptConciseEdit,
  "gpt-image-2": adaptConciseEdit,
  "gpt-image-2-vip": adaptConciseEdit,
  "flux-2-pro": adaptNaturalLanguage,
  "seedream-5-0-260128": adaptSegmentedChinese,
  "grok-imagine-image": adaptNaturalLanguage,
};

export function compileTiAngleText(
  config: TiAngleConfig,
  targetModelId: ImageModelId,
): TiAngleCompiledText {
  validateTiAngleConfig(config);
  if (!isImageModelId(targetModelId) || !IMAGE_MODEL_IDS.includes(targetModelId)) {
    throw new RangeError(`不支持的生图模型: ${String(targetModelId)}`);
  }
  return {
    adapterVersion: TI_ANGLE_ADAPTER_VERSION,
    targetModelId,
    text: config.enabled ? ADAPTERS[targetModelId](config) : "",
  };
}

import type { DWPoseKeypointV1, DWPosePoseV1 } from '../types/poseReference';
import type {
  PoseDocumentV1,
  PosePersonV1,
  PosePointV1,
  PoseSourceV1,
} from '../types/poseDocument';

export const BODY_25_TO_COCO_17 = [0, 16, 15, 18, 17, 5, 2, 6, 3, 7, 4, 12, 9, 13, 10, 14, 11] as const;
export const BODY_18_TO_COCO_17 = [0, 15, 14, 17, 16, 5, 2, 6, 3, 7, 4, 11, 8, 12, 9, 13, 10] as const;
export const BODY_CONNECTIONS = [
  [0, 1], [0, 2], [1, 3], [2, 4], [5, 6], [5, 7], [7, 9], [6, 8],
  [8, 10], [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
] as const;
export const FOOT_CONNECTIONS = [[15, 0], [15, 1], [15, 2], [16, 3], [16, 4], [16, 5]] as const;
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12], [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
] as const;
export const POSE_PALETTE = [
  '#ff4040', '#ff8c00', '#ffd400', '#9cff00', '#00e676', '#00e5ff',
  '#2979ff', '#651fff', '#d500f9', '#ff4081', '#ff6e40', '#c6ff00',
  '#64ffda', '#40c4ff', '#448aff', '#b388ff', '#f50057', '#ffffff',
] as const;

const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_IMPORT_BYTES = 1024 * 1024;
const MAX_CANVAS_DIMENSION = 8192;
const MAX_CANVAS_PIXELS = 40_000_000;
const LOCAL_IMAGE_REFERENCE = /^\/api\/files\/[A-Za-z0-9_-]{1,128}\.(?:png|jpe?g|webp|gif)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function fail(message: string): never {
  throw new Error(message);
}

function validCanvas(value: unknown): value is { width: number; height: number } {
  return isRecord(value) && hasOnlyKeys(value, ['width', 'height']) &&
    Number.isInteger(value.width) && Number.isInteger(value.height) &&
    Number(value.width) > 0 && Number(value.height) > 0 &&
    Number(value.width) <= MAX_CANVAS_DIMENSION && Number(value.height) <= MAX_CANVAS_DIMENSION &&
    Number(value.width) * Number(value.height) <= MAX_CANVAS_PIXELS;
}

function validateImageReference(value: unknown, nullable = false): value is string | null {
  if (nullable && value === null) return true;
  return typeof value === 'string' && LOCAL_IMAGE_REFERENCE.test(value);
}

function validatePoint(value: unknown, width: number, height: number): value is PosePointV1 {
  if (value === null) return true;
  if (!isRecord(value) || !hasOnlyKeys(value, ['x', 'y', 'confidence', 'origin'])) return false;
  const { x, y, confidence, origin } = value;
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= width &&
    typeof y === 'number' && Number.isFinite(y) && y >= 0 && y <= height &&
    typeof confidence === 'number' && Number.isFinite(confidence) && confidence > 0 && confidence <= 1 &&
    (origin === 'detected' || origin === 'manual') && (origin !== 'manual' || confidence === 1);
}

function validateSource(value: unknown): value is PoseSourceV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, ['analysisImage', 'kind', 'model'], ['checkpoint', 'recordId'])) return false;
  if (!validateImageReference(value.analysisImage) ||
      !['image', 'depth', 'openpose-json', 'manual'].includes(String(value.kind)) ||
      typeof value.model !== 'string' || value.model.length < 1 || value.model.length > 128 || /[\u0000-\u001f]/.test(value.model)) return false;
  if (value.checkpoint !== undefined && (typeof value.checkpoint !== 'string' || !/^[a-f0-9]{64}$/.test(value.checkpoint))) return false;
  if (value.recordId !== undefined && (typeof value.recordId !== 'string' || !UUID.test(value.recordId))) return false;
  return true;
}

function validatePose3D(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ['body25', 'camera'], ['stale']) ||
      !Array.isArray(value.body25) || value.body25.length !== 25 ||
      (value.stale !== undefined && typeof value.stale !== 'boolean')) return false;
  const valid3DPoint = (point: unknown): boolean => {
    if (point === null) return true;
    if (!isRecord(point) || !hasOnlyKeys(point, ['x', 'y', 'z', 'confidence', 'origin'])) return false;
    const coordinates = [point.x, point.y, point.z];
    return coordinates.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate) && Math.abs(coordinate) <= 4) &&
      typeof point.confidence === 'number' && Number.isFinite(point.confidence) && point.confidence > 0 && point.confidence <= 1 &&
      (point.origin === 'detected' || point.origin === 'manual') && (point.origin !== 'manual' || point.confidence === 1);
  };
  if (!value.body25.every(valid3DPoint)) return false;
  const camera = value.camera;
  if (!isRecord(camera) || !hasOnlyKeys(camera, ['target', 'yawDeg', 'pitchDeg', 'scale']) || !isRecord(camera.target) ||
      !hasOnlyKeys(camera.target, ['x', 'y', 'z'])) return false;
  const target = [camera.target.x, camera.target.y, camera.target.z];
  return target.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate) && Math.abs(coordinate) <= 4) &&
    typeof camera.yawDeg === 'number' && Number.isFinite(camera.yawDeg) && camera.yawDeg >= -180 && camera.yawDeg <= 180 &&
    typeof camera.pitchDeg === 'number' && Number.isFinite(camera.pitchDeg) && camera.pitchDeg >= -89 && camera.pitchDeg <= 89 &&
    typeof camera.scale === 'number' && Number.isFinite(camera.scale) && camera.scale >= 0.25 && camera.scale <= 4;
}

function serializeWithinLimit(value: unknown, maxBytes: number, label: string): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail(`${label}不是有效 JSON`);
  }
  if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).byteLength > maxBytes) {
    fail(`${label}超过大小限制`);
  }
  return serialized;
}

export function validatePoseDocument(value: unknown): PoseDocumentV1 {
  serializeWithinLimit(value, MAX_DOCUMENT_BYTES, '姿势编辑稿');
  if (!isRecord(value) || !hasOnlyKeys(value, ['version', 'canvas', 'people', 'source', 'imageBinding'], ['pose3d']) || value.version !== 1) {
    fail('姿势编辑稿版本或字段无效');
  }
  if (!validCanvas(value.canvas)) fail('姿势画布尺寸无效');
  if (!Array.isArray(value.people) || value.people.length < 1 || value.people.length > 8) fail('姿势人物数量无效');
  if (!validateSource(value.source)) fail('姿势来源必须是可访问的本地图片引用');
  if (!validateImageReference(value.imageBinding, true)) fail('姿势图像绑定必须是本地图片引用');
  const { width, height } = value.canvas;
  for (const person of value.people) {
    if (!isRecord(person) || !hasOnlyKeys(person,
      ['id', 'topology', 'neck', 'midHip', 'body', 'feet', 'face', 'hands'], ['faceTopology'])) fail('姿势人物结构无效');
    if (typeof person.id !== 'string' || !UUID.test(person.id) ||
        !['coco-wholebody-133', 'openpose-body-18', 'openpose-body-25'].includes(String(person.topology))) fail('姿势人物标识或拓扑无效');
    if (person.faceTopology !== undefined && !['face68', 'face70'].includes(String(person.faceTopology))) fail('人脸拓扑无效');
    if (!validatePoint(person.neck, width, height) || !validatePoint(person.midHip, width, height)) fail('颈部或骨盆关键点无效');
    const groups: Array<[unknown, number, string]> = [
      [person.body, 17, 'body'], [person.feet, 6, 'feet'], [person.face, 70, 'face'],
    ];
    for (const [group, length, name] of groups) {
      if (!Array.isArray(group) || group.length !== length || !group.every((point) => validatePoint(point, width, height))) {
        fail(`姿势 ${name} 关键点数组长度或坐标无效`);
      }
    }
    if (!isRecord(person.hands) || !hasOnlyKeys(person.hands, ['left', 'right']) ||
        !Array.isArray(person.hands.left) || person.hands.left.length !== 21 ||
        !Array.isArray(person.hands.right) || person.hands.right.length !== 21 ||
        !person.hands.left.every((point) => validatePoint(point, width, height)) ||
        !person.hands.right.every((point) => validatePoint(point, width, height))) fail('手部关键点数组长度或坐标无效');
  }
  if (value.pose3d !== undefined && !validatePose3D(value.pose3d)) fail('3D 姿势或相机参数无效');
  return value as unknown as PoseDocumentV1;
}

export function isPoseDocumentBoundToImage(value: unknown, image: unknown): value is PoseDocumentV1 {
  if (typeof image !== 'string') return false;
  try {
    return validatePoseDocument(value).imageBinding === image;
  } catch {
    return false;
  }
}

export function normalizedToCanvas(
  point: Pick<DWPoseKeypointV1, 'x' | 'y' | 'confidence'> | null,
  width: number,
  height: number,
): { x: number; y: number; confidence: number } | null {
  if (point === null || point.confidence === 0) return null;
  if (![point.x, point.y, point.confidence].every(Number.isFinite) || point.x < 0 || point.x >= 1 ||
      point.y < 0 || point.y >= 1 || point.confidence <= 0 || point.confidence > 1) fail('归一化关键点超出画布');
  return { x: point.x * width, y: point.y * height, confidence: point.confidence };
}

export function canvasToNormalized(
  point: { x: number; y: number; confidence: number } | null,
  width: number,
  height: number,
): { x: number; y: number; confidence: number } | null {
  if (point === null) return null;
  if (![width, height].every((value) => Number.isFinite(value) && value > 0) ||
      ![point.x, point.y, point.confidence].every(Number.isFinite) || point.x < 0 || point.x > width ||
      point.y < 0 || point.y > height || point.confidence <= 0 || point.confidence > 1) fail('画布关键点无效');
  return { x: point.x / width, y: point.y / height, confidence: point.confidence };
}

function detectedPoint(
  point: { x: number; y: number; confidence: number } | null,
): PosePointV1 {
  if (point === null || point.confidence === 0) return null;
  return { ...point, origin: 'detected' };
}

function midpoint(a: PosePointV1, b: PosePointV1): PosePointV1 {
  if (!a || !b) return null;
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    confidence: Math.min(a.confidence, b.confidence),
    origin: a.origin === 'manual' || b.origin === 'manual' ? 'manual' : 'detected',
  };
}

function createId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') fail('当前环境无法生成姿势人物标识');
  return globalThis.crypto.randomUUID();
}

export function poseDocumentFromDWPose(
  pose: DWPosePoseV1,
  options: { source: PoseSourceV1; imageBinding: string | null; idFactory?: () => string },
): PoseDocumentV1 {
  const { width, height } = pose.canvas;
  if (!validCanvas(pose.canvas) || pose.schemaVersion !== 1 || !Array.isArray(pose.people) || pose.people.length < 1 || pose.people.length > 8) {
    fail('DWPose 结果画布或人物结构无效');
  }
  const idFactory = options.idFactory ?? createId;
  const people: PosePersonV1[] = pose.people.map(({ keypoints }) => {
    if (!Array.isArray(keypoints) || keypoints.length !== 133) fail('DWPose 关键点数量必须为 133');
    const pointAt = (index: number): PosePointV1 => detectedPoint(normalizedToCanvas(keypoints[index], width, height));
    const body = Array.from({ length: 17 }, (_, index) => pointAt(index));
    const feet = Array.from({ length: 6 }, (_, index) => pointAt(17 + index));
    const face = [...Array.from({ length: 68 }, (_, index) => pointAt(23 + index)), null, null];
    const left = Array.from({ length: 21 }, (_, index) => pointAt(91 + index));
    const right = Array.from({ length: 21 }, (_, index) => pointAt(112 + index));
    const id = idFactory();
    if (!UUID.test(id)) fail('姿势人物标识生成失败');
    return {
      id,
      topology: 'coco-wholebody-133',
      neck: midpoint(body[5], body[6]),
      midHip: midpoint(body[11], body[12]),
      body,
      feet,
      face,
      faceTopology: 'face68',
      hands: { left, right },
    };
  });
  return validatePoseDocument({
    version: 1,
    canvas: { width, height },
    people,
    source: options.source,
    imageBinding: options.imageBinding,
  });
}

function parseOpenPoseTriples(value: unknown, expectedPoints: number, label: string, width: number, height: number): PosePointV1[] {
  if (!Array.isArray(value) || value.length !== expectedPoints * 3 ||
      !value.every((item) => typeof item === 'number' && Number.isFinite(item))) fail(`${label} 数组长度或数值无效`);
  const points: PosePointV1[] = [];
  for (let index = 0; index < expectedPoints; index++) {
    const x = value[index * 3] as number;
    const y = value[index * 3 + 1] as number;
    const confidence = value[index * 3 + 2] as number;
    if (confidence < 0 || confidence > 1) fail(`${label} 置信度无效`);
    if (confidence === 0) {
      points.push(null);
      continue;
    }
    if (x < 0 || x > width || y < 0 || y > height) fail(`${label} 坐标超出画布`);
    points.push({ x, y, confidence, origin: 'detected' });
  }
  return points;
}


function validateImportSource(analysisImage: string, imageBinding: string | null): void {
  if (!validateImageReference(analysisImage) || !validateImageReference(imageBinding, true)) fail('导入姿势必须绑定本地图片引用');
}

export function importOpenPoseJson(
  input: unknown,
  options: { analysisImage: string; imageBinding: string | null; idFactory?: () => string },
): PoseDocumentV1 {
  let value = input;
  if (typeof input === 'string') {
    serializeWithinLimit(input, MAX_IMPORT_BYTES, 'OpenPose 导入文件');
    try {
      value = JSON.parse(input);
    } catch {
      fail('OpenPose JSON 格式无效');
    }
  }
  serializeWithinLimit(value, MAX_IMPORT_BYTES, 'OpenPose 导入文件');
  validateImportSource(options.analysisImage, options.imageBinding);
  if (!isRecord(value) || !hasOnlyKeys(value, ['canvas_width', 'canvas_height', 'people'], ['version']) ||
      !validCanvas({ width: value.canvas_width, height: value.canvas_height }) ||
      (value.version !== undefined && typeof value.version !== 'number') ||
      !Array.isArray(value.people) || value.people.length < 1 || value.people.length > 8) fail('OpenPose JSON 画布或人物结构无效');
  const width = value.canvas_width as number;
  const height = value.canvas_height as number;
  const idFactory = options.idFactory ?? createId;
  const people: PosePersonV1[] = value.people.map((rawPerson) => {
    if (!isRecord(rawPerson) || !hasOnlyKeys(rawPerson, ['pose_keypoints_2d'], [
      'face_keypoints_2d', 'hand_left_keypoints_2d', 'hand_right_keypoints_2d',
    ])) fail('OpenPose 人物字段无效');
    const bodyValues = rawPerson.pose_keypoints_2d;
    if (!Array.isArray(bodyValues) || ![54, 75].includes(bodyValues.length)) fail('OpenPose body 数组长度必须为 BODY_18 或 BODY_25');
    const bodyCount = bodyValues.length === 75 ? 25 : 18;
    const sourceBody = parseOpenPoseTriples(bodyValues, bodyCount, 'OpenPose body', width, height);
    const bodyIndices = bodyCount === 25 ? BODY_25_TO_COCO_17 : BODY_18_TO_COCO_17;
    const body = bodyIndices.map((index) => sourceBody[index]);
    const feet = bodyCount === 25 ? sourceBody.slice(19, 25) : Array.from({ length: 6 }, () => null);
    const neck = sourceBody[1];
    const midHip = bodyCount === 25 ? sourceBody[8] : midpoint(sourceBody[8], sourceBody[11]);
    const faceValues = rawPerson.face_keypoints_2d;
    let face: PosePointV1[];
    let faceTopology: PosePersonV1['faceTopology'];
    if (faceValues === undefined || (Array.isArray(faceValues) && faceValues.length === 0)) {
      face = Array.from({ length: 70 }, () => null);
    } else if (Array.isArray(faceValues) && faceValues.length === 204) {
      face = [...parseOpenPoseTriples(faceValues, 68, 'OpenPose face', width, height), null, null];
      faceTopology = 'face68';
    } else if (Array.isArray(faceValues) && faceValues.length === 210) {
      face = parseOpenPoseTriples(faceValues, 70, 'OpenPose face', width, height);
      faceTopology = 'face70';
    } else {
      fail('OpenPose face 数组长度必须为 68 或 70 点');
    }
    const parseHand = (hand: unknown, label: string) => {
      if (hand === undefined || (Array.isArray(hand) && hand.length === 0)) return Array.from({ length: 21 }, () => null);
      if (!Array.isArray(hand) || hand.length !== 63) fail(`${label} 数组长度必须为 21 点`);
      return parseOpenPoseTriples(hand, 21, label, width, height);
    };
    const id = idFactory();
    if (!UUID.test(id)) fail('姿势人物标识生成失败');
    return {
      id,
      topology: bodyCount === 25 ? 'openpose-body-25' : 'openpose-body-18',
      neck,
      midHip,
      body,
      feet,
      face,
      ...(faceTopology ? { faceTopology } : {}),
      hands: {
        left: parseHand(rawPerson.hand_left_keypoints_2d, 'OpenPose 左手'),
        right: parseHand(rawPerson.hand_right_keypoints_2d, 'OpenPose 右手'),
      },
    };
  });
  return validatePoseDocument({
    version: 1,
    canvas: { width, height },
    people,
    source: { analysisImage: options.analysisImage, kind: 'openpose-json', model: 'openpose-json' },
    imageBinding: options.imageBinding,
  });
}

function openPoseTriples(points: PosePointV1[]): number[] {
  return points.flatMap((point) => point ? [point.x, point.y, point.confidence] : [0, 0, 0]);
}

export interface OpenPoseJsonV1 {
  version: 1.3;
  canvas_width: number;
  canvas_height: number;
  people: Array<{
    pose_keypoints_2d: number[];
    face_keypoints_2d: number[];
    hand_left_keypoints_2d: number[];
    hand_right_keypoints_2d: number[];
  }>;
}

export function exportOpenPoseJson(value: unknown): OpenPoseJsonV1 {
  const document = validatePoseDocument(value);
  const people = document.people.map((person) => {
    const body25: PosePointV1[] = Array.from({ length: 25 }, () => null);
    BODY_25_TO_COCO_17.forEach((sourceIndex, cocoIndex) => { body25[sourceIndex] = person.body[cocoIndex]; });
    body25[1] = person.neck;
    body25[8] = person.midHip;
    person.feet.forEach((point, index) => { body25[19 + index] = point; });
    return {
      pose_keypoints_2d: openPoseTriples(body25),
      face_keypoints_2d: openPoseTriples(person.face),
      hand_left_keypoints_2d: openPoseTriples(person.hands.left),
      hand_right_keypoints_2d: openPoseTriples(person.hands.right),
    };
  });
  return {
    version: 1.3,
    canvas_width: document.canvas.width,
    canvas_height: document.canvas.height,
    people,
  };
}

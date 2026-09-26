import {
  BODY_25_TO_COCO_17,
  validatePoseDocument,
} from './poseTopology';
import {
  addPoseVectors,
  dotPoseVectors,
  normalizePoseVector,
  scalePoseVector,
  solveTwoBoneIk,
  subtractPoseVectors,
  type PoseIkStatus,
  type PoseVector3,
} from './poseIk';
import type {
  Pose3DV1,
  PoseCameraV1,
  PoseDocumentV1,
  PosePersonV1,
  PosePoint3DV1,
  PosePointV1,
} from '../types/poseDocument';

export const BODY25_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [1, 5], [5, 6], [6, 7],
  [1, 8], [8, 9], [9, 10], [10, 11],
  [8, 12], [12, 13], [13, 14],
  [8, 15], [15, 16], [16, 17],
  [14, 19], [14, 20], [14, 21],
  [11, 22], [11, 23], [11, 24],
] as const;

export type Pose3DChainId = 'left-arm' | 'right-arm' | 'left-leg' | 'right-leg';

export interface Pose3DChainDefinition {
  id: Pose3DChainId;
  label: string;
  root: number;
  joint: number;
  end: number;
}

export const POSE3D_CHAINS: readonly Pose3DChainDefinition[] = [
  { id: 'left-arm', label: '左臂（肩—肘—腕）', root: 5, joint: 6, end: 7 },
  { id: 'right-arm', label: '右臂（肩—肘—腕）', root: 2, joint: 3, end: 4 },
  { id: 'left-leg', label: '左腿（髋—膝—踝）', root: 12, joint: 13, end: 14 },
  { id: 'right-leg', label: '右腿（髋—膝—踝）', root: 9, joint: 10, end: 11 },
] as const;

export const DEFAULT_POSE_CAMERA: PoseCameraV1 = {
  target: { x: 0, y: 0, z: 0 },
  yawDeg: 0,
  pitchDeg: 0,
  scale: 1,
};

export interface PoseCanvasSize {
  width: number;
  height: number;
}

export interface PoseProjection {
  x: number;
  y: number;
  depth: number;
}

export interface Pose3DChainSolveResult {
  status: PoseIkStatus;
  document: PoseDocumentV1;
  requestedTarget: PoseVector3;
  achievedTarget: PoseVector3 | null;
  reason?: string;
}

const COCO_INDEX_BY_BODY25_INDEX = new Map<number, number>(
  BODY_25_TO_COCO_17.map((body25Index, cocoIndex) => [body25Index, cocoIndex]),
);
const DEFAULT_CANVAS_POINT: PoseVector3 = { x: 0, y: 0, z: 0 };

function degreesToRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function cloneCamera(camera: PoseCameraV1): PoseCameraV1 {
  return {
    target: { ...camera.target },
    yawDeg: camera.yawDeg,
    pitchDeg: camera.pitchDeg,
    scale: camera.scale,
  };
}

function clonePose3DPoint(point: PosePoint3DV1): PosePoint3DV1 {
  return point ? { ...point } : null;
}

function clonePose3D(pose3d: Pose3DV1): Pose3DV1 {
  return {
    body25: pose3d.body25.map(clonePose3DPoint),
    camera: cloneCamera(pose3d.camera),
    ...(pose3d.stale === undefined ? {} : { stale: pose3d.stale }),
  };
}

function pointToVector(point: PosePoint3DV1): PoseVector3 | null {
  return point ? { x: point.x, y: point.y, z: point.z } : null;
}

function vectorToPoint(vector: PoseVector3, source: PosePoint3DV1, origin: 'detected' | 'manual' = 'manual'): PosePoint3DV1 {
  return {
    x: vector.x,
    y: vector.y,
    z: vector.z,
    confidence: origin === 'manual' ? 1 : source?.confidence ?? 1,
    origin,
  };
}

function pointToVector2D(point: PosePointV1, canvas: PoseCanvasSize): PoseVector3 {
  if (!point) return DEFAULT_CANVAS_POINT;
  return {
    x: (point.x / canvas.width - 0.5) * 2,
    y: (0.5 - point.y / canvas.height) * 2,
    z: 0,
  };
}

function vectorToPoint2D(point: PoseProjection, canvas: PoseCanvasSize): PosePointV1 {
  return {
    x: Math.max(0, Math.min(canvas.width, point.x)),
    y: Math.max(0, Math.min(canvas.height, point.y)),
    confidence: 1,
    origin: 'manual',
  };
}

function getPerson(document: PoseDocumentV1, personId: string): PosePersonV1 {
  const person = document.people.find((candidate) => candidate.id === personId);
  if (!person) throw new Error('未找到当前姿势人物');
  return person;
}

function body25PointFromPerson(
  person: PosePersonV1,
  body25Index: number,
  canvas: PoseCanvasSize,
): PosePointV1 {
  if (body25Index === 1) return person.neck;
  if (body25Index === 8) return person.midHip;
  if (body25Index >= 19 && body25Index <= 24) return person.feet[body25Index - 19] ?? null;
  const cocoIndex = COCO_INDEX_BY_BODY25_INDEX.get(body25Index);
  return cocoIndex === undefined ? null : person.body[cocoIndex] ?? null;
}

function projectedBody25Point(
  body25Index: number,
  pose3d: Pose3DV1,
  canvas: PoseCanvasSize,
): PosePointV1 {
  const point = pose3d.body25[body25Index];
  if (!point) return null;
  const projected = projectPose3DPointToDocumentCanvas(point, pose3d.camera, canvas);
  return projected ? vectorToPoint2D(projected, canvas) : null;
}

function translateAttachedPoint(
  point: PosePointV1,
  sourceAnchor: PosePointV1,
  targetAnchor: PosePointV1,
  canvas: PoseCanvasSize,
): PosePointV1 {
  if (!point || !sourceAnchor || !targetAnchor) return point;
  const dx = targetAnchor.x - sourceAnchor.x;
  const dy = targetAnchor.y - sourceAnchor.y;
  return {
    x: Math.max(0, Math.min(canvas.width, point.x + dx)),
    y: Math.max(0, Math.min(canvas.height, point.y + dy)),
    confidence: 1,
    origin: 'manual',
  };
}

function translateAttachedPoints(
  points: PosePointV1[],
  sourceAnchor: PosePointV1,
  targetAnchor: PosePointV1,
  canvas: PoseCanvasSize,
): PosePointV1[] {
  return points.map((point) => translateAttachedPoint(point, sourceAnchor, targetAnchor, canvas));
}

function cameraPointToView(point: PoseVector3, camera: PoseCameraV1): PoseVector3 {
  const relative = subtractPoseVectors(point, camera.target);
  const yaw = degreesToRadians(camera.yawDeg);
  const pitch = degreesToRadians(camera.pitchDeg);
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const yawed = {
    x: cosYaw * relative.x - sinYaw * relative.z,
    y: relative.y,
    z: sinYaw * relative.x + cosYaw * relative.z,
  };
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  return {
    x: yawed.x,
    y: cosPitch * yawed.y - sinPitch * yawed.z,
    z: sinPitch * yawed.y + cosPitch * yawed.z,
  };
}

function viewPointToCamera(point: PoseVector3, camera: PoseCameraV1): PoseVector3 {
  const pitch = degreesToRadians(camera.pitchDeg);
  const yaw = degreesToRadians(camera.yawDeg);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const unpitched = {
    x: point.x,
    y: cosPitch * point.y + sinPitch * point.z,
    z: -sinPitch * point.y + cosPitch * point.z,
  };
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  return addPoseVectors(camera.target, {
    x: cosYaw * unpitched.x + sinYaw * unpitched.z,
    y: unpitched.y,
    z: -sinYaw * unpitched.x + cosYaw * unpitched.z,
  });
}

function getViewportUnit(size: PoseCanvasSize, scale: number): number {
  return Math.min(size.width, size.height) * 0.42 / Math.max(0.25, scale);
}

export function projectPose3DPoint(
  point: PosePoint3DV1,
  camera: PoseCameraV1,
  size: PoseCanvasSize,
): PoseProjection | null {
  if (!point || size.width <= 0 || size.height <= 0) return null;
  const view = cameraPointToView({ x: point.x, y: point.y, z: point.z }, camera);
  const unit = getViewportUnit(size, camera.scale);
  return {
    x: size.width / 2 + view.x * unit,
    y: size.height / 2 - view.y * unit,
    depth: view.z,
  };
}

export function projectPose3DPointToDocumentCanvas(
  point: PosePoint3DV1,
  camera: PoseCameraV1,
  size: PoseCanvasSize,
): PoseProjection | null {
  if (!point || size.width <= 0 || size.height <= 0 || camera.scale <= 0) return null;
  const view = cameraPointToView({ x: point.x, y: point.y, z: point.z }, camera);
  return {
    x: size.width * (0.5 + view.x / (2 * camera.scale)),
    y: size.height * (0.5 - view.y / (2 * camera.scale)),
    depth: view.z,
  };
}

export function unprojectPose3DPointOnDepth(
  point: { x: number; y: number; depth: number },
  camera: PoseCameraV1,
  size: PoseCanvasSize,
): PoseVector3 | null {
  if (![point.x, point.y, point.depth].every(Number.isFinite) || size.width <= 0 || size.height <= 0) return null;
  const unit = getViewportUnit(size, camera.scale);
  const viewPoint = {
    x: (point.x - size.width / 2) / unit,
    y: -(point.y - size.height / 2) / unit,
    z: point.depth,
  };
  return viewPointToCamera(viewPoint, camera);
}

export function createPose3DFromDocument(document: PoseDocumentV1, personId: string): Pose3DV1 {
  const source = validatePoseDocument(document);
  const person = getPerson(source, personId);
  const canvas = source.canvas;
  return {
    body25: Array.from({ length: 25 }, (_, body25Index) => {
      const point = body25PointFromPerson(person, body25Index, canvas);
      return point ? {
        ...pointToVector2D(point, canvas),
        confidence: point.confidence,
        origin: point.origin,
      } : null;
    }),
    camera: cloneCamera(DEFAULT_POSE_CAMERA),
    stale: false,
  };
}

export function projectPose3DToDocument(
  document: PoseDocumentV1,
  pose3d: Pose3DV1,
  personId: string,
): PoseDocumentV1 {
  const source = validatePoseDocument(document);
  const person = getPerson(source, personId);
  const canvas = source.canvas;
  const nextNose = projectedBody25Point(0, pose3d, canvas);
  const nextLeftWrist = projectedBody25Point(7, pose3d, canvas);
  const nextRightWrist = projectedBody25Point(4, pose3d, canvas);
  const nextPerson: PosePersonV1 = {
    ...person,
    neck: projectedBody25Point(1, pose3d, canvas) ?? person.neck,
    midHip: projectedBody25Point(8, pose3d, canvas) ?? person.midHip,
    body: person.body.map((point, cocoIndex) => projectedBody25Point(BODY_25_TO_COCO_17[cocoIndex], pose3d, canvas) ?? point),
    feet: person.feet.map((point, footIndex) => projectedBody25Point(19 + footIndex, pose3d, canvas) ?? point),
    face: translateAttachedPoints(person.face, person.body[0], nextNose, canvas),
    hands: {
      left: translateAttachedPoints(person.hands.left, person.body[9], nextLeftWrist, canvas),
      right: translateAttachedPoints(person.hands.right, person.body[10], nextRightWrist, canvas),
    },
  };
  const nextPose3D: Pose3DV1 = { ...clonePose3D(pose3d), stale: false };
  return validatePoseDocument({
    ...source,
    people: source.people.map((candidate) => candidate.id === personId ? nextPerson : candidate),
    pose3d: nextPose3D,
  });
}

export function markPose3DStale(document: PoseDocumentV1): PoseDocumentV1 {
  const source = validatePoseDocument(document);
  if (!source.pose3d || source.pose3d.stale) return source;
  return validatePoseDocument({
    ...source,
    pose3d: { ...clonePose3D(source.pose3d), stale: true },
  });
}

export function ensurePose3DDocument(document: PoseDocumentV1, personId: string): PoseDocumentV1 {
  const source = validatePoseDocument(document);
  if (source.pose3d && !source.pose3d.stale) return source;
  const pose3d = createPose3DFromDocument(source, personId);
  return projectPose3DToDocument(source, pose3d, personId);
}

export function getPose3DChain(chainId: Pose3DChainId): Pose3DChainDefinition {
  const chain = POSE3D_CHAINS.find((candidate) => candidate.id === chainId);
  if (!chain) throw new Error(`未知的 3D IK 链条：${chainId}`);
  return chain;
}

export function getPose3DChainTarget(pose3d: Pose3DV1 | undefined, chainId: Pose3DChainId): PoseVector3 | null {
  if (!pose3d) return null;
  const chain = getPose3DChain(chainId);
  return pointToVector(pose3d.body25[chain.end]);
}

export function getPose3DBendDirection(pose3d: Pose3DV1, chainId: Pose3DChainId): PoseVector3 {
  const chain = getPose3DChain(chainId);
  const root = pointToVector(pose3d.body25[chain.root]);
  const joint = pointToVector(pose3d.body25[chain.joint]);
  const end = pointToVector(pose3d.body25[chain.end]);
  if (!root || !joint || !end) return { x: 0, y: 0, z: 1 };

  const rootToEnd = subtractPoseVectors(end, root);
  const rootToJoint = subtractPoseVectors(joint, root);
  const direction = normalizePoseVector(rootToEnd);
  if (!direction) return { x: 0, y: 0, z: 1 };
  const offset = subtractPoseVectors(rootToJoint, scalePoseVector(direction, dotPoseVectors(rootToJoint, direction)));
  return normalizePoseVector(offset) ?? { x: 0, y: 0, z: 1 };
}

export function solvePose3DChain(
  document: PoseDocumentV1,
  personId: string,
  chainId: Pose3DChainId,
  target: PoseVector3,
  bendSign = 1,
): Pose3DChainSolveResult {
  const source = validatePoseDocument(document);
  const pose3d = source.pose3d;
  const chain = getPose3DChain(chainId);
  if (!pose3d || pose3d.stale) {
    return {
      status: 'invalid',
      document: source,
      requestedTarget: target,
      achievedTarget: null,
      reason: '3D 姿势尚未建立或已因 2D 修改而过期',
    };
  }
  const root = pointToVector(pose3d.body25[chain.root]);
  const joint = pointToVector(pose3d.body25[chain.joint]);
  const end = pointToVector(pose3d.body25[chain.end]);
  if (!root || !joint || !end) {
    return {
      status: 'invalid',
      document: source,
      requestedTarget: target,
      achievedTarget: null,
      reason: '当前 IK 链条缺少必要关键点',
    };
  }

  const ik = solveTwoBoneIk({
    root,
    joint,
    end,
    target,
    bendDirection: scalePoseVector(getPose3DBendDirection(pose3d, chainId), bendSign),
  });
  if (ik.status === 'invalid') {
    return {
      status: ik.status,
      document: source,
      requestedTarget: target,
      achievedTarget: null,
      reason: ik.reason,
    };
  }

  const body25 = pose3d.body25.map(clonePose3DPoint);
  body25[chain.root] = vectorToPoint(ik.root, pose3d.body25[chain.root]);
  body25[chain.joint] = vectorToPoint(ik.joint, pose3d.body25[chain.joint]);
  body25[chain.end] = vectorToPoint(ik.end, pose3d.body25[chain.end]);
  const nextPose3D: Pose3DV1 = { ...clonePose3D(pose3d), body25, stale: false };
  return {
    status: ik.status,
    document: projectPose3DToDocument(source, nextPose3D, personId),
    requestedTarget: target,
    achievedTarget: ik.achievedTarget,
  };
}

export function resetPose3DFromCurrent2D(document: PoseDocumentV1, personId: string): PoseDocumentV1 {
  const source = validatePoseDocument(document);
  return projectPose3DToDocument(source, createPose3DFromDocument(source, personId), personId);
}

export function getPose3DPointFrom2D(point: PosePointV1, canvas: PoseCanvasSize): PoseVector3 {
  return pointToVector2D(point, canvas);
}

export function addPose3DVector(left: PoseVector3, right: PoseVector3): PoseVector3 {
  return addPoseVectors(left, right);
}

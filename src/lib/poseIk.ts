export type PoseVector3 = {
  x: number;
  y: number;
  z: number;
};

export type PoseIkStatus = 'ok' | 'unreachable' | 'invalid';

export interface TwoBoneIkInput {
  root: PoseVector3;
  joint: PoseVector3;
  end: PoseVector3;
  target: PoseVector3;
  bendDirection?: PoseVector3;
  epsilon?: number;
}

export interface TwoBoneIkResult {
  status: PoseIkStatus;
  root: PoseVector3;
  joint: PoseVector3;
  end: PoseVector3;
  requestedTarget: PoseVector3;
  achievedTarget: PoseVector3;
  firstLength: number;
  secondLength: number;
  requestedDistance: number;
  minReach: number;
  maxReach: number;
  reason?: string;
}

const DEFAULT_EPSILON = 1e-8;
const DEFAULT_BEND_DIRECTION: PoseVector3 = { x: 0, y: 0, z: 1 };

export function addPoseVectors(left: PoseVector3, right: PoseVector3): PoseVector3 {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

export function subtractPoseVectors(left: PoseVector3, right: PoseVector3): PoseVector3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

export function scalePoseVector(vector: PoseVector3, factor: number): PoseVector3 {
  return { x: vector.x * factor, y: vector.y * factor, z: vector.z * factor };
}

export function dotPoseVectors(left: PoseVector3, right: PoseVector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

export function crossPoseVectors(left: PoseVector3, right: PoseVector3): PoseVector3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

export function poseVectorLength(vector: PoseVector3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

export function normalizePoseVector(vector: PoseVector3, epsilon = DEFAULT_EPSILON): PoseVector3 | null {
  const length = poseVectorLength(vector);
  if (!Number.isFinite(length) || length <= epsilon) return null;
  return scalePoseVector(vector, 1 / length);
}

function isFinitePoseVector(vector: PoseVector3): boolean {
  return [vector.x, vector.y, vector.z].every((value) => Number.isFinite(value));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function findPerpendicular(
  direction: PoseVector3,
  preferred: PoseVector3,
  epsilon: number,
): PoseVector3 {
  const projected = subtractPoseVectors(preferred, scalePoseVector(direction, dotPoseVectors(preferred, direction)));
  const normalized = normalizePoseVector(projected, epsilon);
  if (normalized) return normalized;

  const fallbackAxes: PoseVector3[] = [
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 1, z: 0 },
    { x: 1, y: 0, z: 0 },
  ];
  for (const axis of fallbackAxes) {
    const fallback = normalizePoseVector(crossPoseVectors(direction, axis), epsilon);
    if (fallback) return fallback;
  }
  return { x: 0, y: 1, z: 0 };
}

function invalidResult(input: TwoBoneIkInput, reason: string): TwoBoneIkResult {
  return {
    status: 'invalid',
    root: input.root,
    joint: input.joint,
    end: input.end,
    requestedTarget: input.target,
    achievedTarget: input.end,
    firstLength: 0,
    secondLength: 0,
    requestedDistance: Number.NaN,
    minReach: 0,
    maxReach: 0,
    reason,
  };
}

export function solveTwoBoneIk(input: TwoBoneIkInput): TwoBoneIkResult {
  const epsilon = input.epsilon ?? DEFAULT_EPSILON;
  if (![input.root, input.joint, input.end, input.target].every(isFinitePoseVector)) {
    return invalidResult(input, 'IK 输入包含非有限坐标');
  }

  const firstVector = subtractPoseVectors(input.joint, input.root);
  const secondVector = subtractPoseVectors(input.end, input.joint);
  const firstLength = poseVectorLength(firstVector);
  const secondLength = poseVectorLength(secondVector);
  if (firstLength <= epsilon || secondLength <= epsilon) {
    return invalidResult(input, 'IK 链条长度必须大于零');
  }

  const targetVector = subtractPoseVectors(input.target, input.root);
  const requestedDistance = poseVectorLength(targetVector);
  const fallbackDirection = normalizePoseVector(firstVector, epsilon) ?? { x: 1, y: 0, z: 0 };
  const direction = normalizePoseVector(targetVector, epsilon) ?? fallbackDirection;
  const minReach = Math.abs(firstLength - secondLength);
  const maxReach = firstLength + secondLength;
  const clampedDistance = clamp(requestedDistance, minReach, maxReach);
  const achievedTarget = addPoseVectors(input.root, scalePoseVector(direction, clampedDistance));
  const bendDirection = findPerpendicular(direction, input.bendDirection ?? DEFAULT_BEND_DIRECTION, epsilon);

  const denominator = 2 * firstLength * Math.max(clampedDistance, epsilon);
  const cosine = denominator <= epsilon
    ? 1
    : clamp((firstLength ** 2 + clampedDistance ** 2 - secondLength ** 2) / denominator, -1, 1);
  const along = firstLength * cosine;
  const height = Math.sqrt(Math.max(0, firstLength ** 2 - along ** 2));
  const solvedJoint = addPoseVectors(
    input.root,
    addPoseVectors(
      scalePoseVector(direction, along),
      scalePoseVector(bendDirection, height),
    ),
  );

  const status: PoseIkStatus = requestedDistance < minReach - epsilon || requestedDistance > maxReach + epsilon
    ? 'unreachable'
    : 'ok';
  return {
    status,
    root: input.root,
    joint: solvedJoint,
    end: achievedTarget,
    requestedTarget: input.target,
    achievedTarget,
    firstLength,
    secondLength,
    requestedDistance,
    minReach,
    maxReach,
  };
}

import type { PoseReferenceCanvasKind } from '@/types/poseReference';

export const POSE_REVIEW_LABELS = {
  headAndTorso: '头部与躯干',
  screenLeftArm: '画面左臂',
  screenRightArm: '画面右臂',
  screenLeftHand: '画面左手位置',
  screenRightHand: '画面右手位置',
  screenLeftLeg: '画面左腿',
  screenRightLeg: '画面右腿',
  weightAndCrossing: '承重、交叉与前后关系',
  notMirrored: '无左右镜像',
  gaze: '视线',
} as const;
export type PoseReviewField = keyof typeof POSE_REVIEW_LABELS;
export type PoseReviewStatus = 'match' | 'mismatch' | 'indeterminate' | 'not-observable';
export type PoseReviewReferenceType = PoseReferenceCanvasKind | 'unspecified';
export interface PoseReviewCheck {
  status: PoseReviewStatus;
  reference: string;
  candidate: string;
}
export interface PoseReviewCandidate {
  index: number;
  status: Exclude<PoseReviewStatus, 'not-observable'>;
  checks: Record<PoseReviewField, PoseReviewCheck>;
}
export interface TryOnPoseReview {
  version: 1;
  referenceType: PoseReviewReferenceType;
  candidates: PoseReviewCandidate[];
}

export function poseReviewReferenceType(value: unknown): PoseReviewReferenceType {
  return value === 'original' || value === 'neutral-outfit' || value === 'skeleton' || value === 'depth'
    ? value : 'unspecified';
}

/** The same strict boundary is used for model responses and persisted record details. */
export function parsePoseReviewCandidates(value: unknown, count: number, referenceType: PoseReviewReferenceType): PoseReviewCandidate[] {
  if (!Array.isArray(value) || value.length !== count || count < 1) throw new Error('姿势评审数量不匹配');
  const seen = new Set<number>();
  return value.map((raw): PoseReviewCandidate => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('姿势评审格式无效');
    const row = raw as Record<string, unknown>;
    const index = row.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count || seen.has(index)) {
      throw new Error('姿势评审索引无效或重复');
    }
    seen.add(index);
    if (!row.checks || typeof row.checks !== 'object' || Array.isArray(row.checks)) throw new Error('姿势评审缺少分项');
    const checks = {} as Record<PoseReviewField, PoseReviewCheck>;
    for (const field of Object.keys(POSE_REVIEW_LABELS) as PoseReviewField[]) {
      const check = (row.checks as Record<string, unknown>)[field];
      if (!check || typeof check !== 'object' || Array.isArray(check)) throw new Error(`姿势评审缺少分项 ${field}`);
      const { status, reference, candidate } = check as Record<string, unknown>;
      if (status !== 'match' && status !== 'mismatch' && status !== 'indeterminate' && status !== 'not-observable') {
        throw new Error(`姿势评审状态无效 ${field}`);
      }
      if (typeof reference !== 'string' || !reference.trim() || reference.length > 600 ||
          typeof candidate !== 'string' || !candidate.trim() || candidate.length > 600) {
        throw new Error(`姿势评审缺少可见对照依据 ${field}`);
      }
      checks[field] = { status, reference: reference.trim(), candidate: candidate.trim() };
    }
    if (referenceType === 'depth' || referenceType === 'skeleton') {
      checks.gaze = { status: 'not-observable', reference: '该参考类型不提供可靠视线信息', candidate: '本项不参与姿势通过判定' };
    }
    const entries = Object.entries(checks) as Array<[PoseReviewField, PoseReviewCheck]>;
    const mismatched = entries.some(([, check]) => check.status === 'mismatch');
    // Only gaze may be inapplicable for skeleton/depth; missing core geometry never passes.
    const matched = entries.every(([field, check]) => check.status === 'match' ||
      (field === 'gaze' && check.status === 'not-observable' && (referenceType === 'skeleton' || referenceType === 'depth')));
    return { index, checks, status: mismatched ? 'mismatch' : matched ? 'match' : 'indeterminate' };
  }).sort((a, b) => a.index - b.index);
}

export function readTryOnPoseReview(value: unknown): TryOnPoseReview | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.candidates)) return undefined;
  const referenceType = poseReviewReferenceType(raw.referenceType);
  try {
    return { version: 1, referenceType, candidates: parsePoseReviewCandidates(raw.candidates, raw.candidates.length, referenceType) };
  } catch {
    return undefined;
  }
}

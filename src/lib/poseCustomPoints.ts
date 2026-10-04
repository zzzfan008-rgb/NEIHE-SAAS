import type { PosePersonV1, PosePointReferenceV1, PosePointV1 } from '../types/poseDocument';

export const MAX_CUSTOM_POSE_POINTS = 128;

export function poseReferencePoint(person: PosePersonV1, ref: PosePointReferenceV1): PosePointV1 {
  if (ref.group === 'neck' || ref.group === 'midHip') return person[ref.group];
  if (!('index' in ref)) return null;
  if (ref.group === 'custom') return person.custom?.[ref.index]?.point ?? null;
  if (ref.group === 'leftHand') return person.hands.left[ref.index] ?? null;
  if (ref.group === 'rightHand') return person.hands.right[ref.index] ?? null;
  return person[ref.group][ref.index] ?? null;
}

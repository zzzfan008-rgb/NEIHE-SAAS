import type { PoseDocumentV1 } from "../types/poseDocument";

export interface PoseEditorHistory {
  past: PoseDocumentV1[];
  present: PoseDocumentV1;
  future: PoseDocumentV1[];
  limit: number;
}

const sameDocument = (left: PoseDocumentV1, right: PoseDocumentV1): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export function createPoseEditorHistory(initial: PoseDocumentV1, limit = 100): PoseEditorHistory {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("姿势历史记录上限无效");
  return { past: [], present: initial, future: [], limit };
}

export function commitPoseEditorHistory(
  history: PoseEditorHistory,
  next: PoseDocumentV1,
): PoseEditorHistory {
  if (sameDocument(history.present, next)) return history;
  const past = [...history.past, history.present].slice(-history.limit);
  return { ...history, past, present: next, future: [] };
}

export function canUndoPoseEditorHistory(history: PoseEditorHistory): boolean {
  return history.past.length > 0;
}

export function canRedoPoseEditorHistory(history: PoseEditorHistory): boolean {
  return history.future.length > 0;
}

export function undoPoseEditorHistory(history: PoseEditorHistory): PoseEditorHistory {
  if (!canUndoPoseEditorHistory(history)) return history;
  const present = history.past[history.past.length - 1];
  return {
    ...history,
    past: history.past.slice(0, -1),
    present,
    future: [history.present, ...history.future],
  };
}

export function redoPoseEditorHistory(history: PoseEditorHistory): PoseEditorHistory {
  if (!canRedoPoseEditorHistory(history)) return history;
  const [present, ...future] = history.future;
  return {
    ...history,
    past: [...history.past, history.present].slice(-history.limit),
    present,
    future,
  };
}

export function resetPoseEditorHistory(
  history: PoseEditorHistory,
  initial: PoseDocumentV1,
): PoseEditorHistory {
  return commitPoseEditorHistory(history, initial);
}

export const WORKBENCH_TUTORIAL_KEY = "workbench-onboarding" as const;
export const WORKBENCH_TUTORIAL_VERSION = "V1.2.0" as const;

export const TUTORIAL_OUTCOMES = ["dismissed", "completed"] as const;

export type TutorialOutcome = (typeof TUTORIAL_OUTCOMES)[number];

export interface TutorialReceiptState {
  tutorialKey: typeof WORKBENCH_TUTORIAL_KEY;
  tutorialVersion: typeof WORKBENCH_TUTORIAL_VERSION;
  acknowledged: boolean;
  outcome: TutorialOutcome | null;
  acknowledgedAt: string | null;
}

export function isTutorialOutcome(value: unknown): value is TutorialOutcome {
  return typeof value === "string" && TUTORIAL_OUTCOMES.includes(value as TutorialOutcome);
}

export function parseTutorialReceiptState(value: unknown): TutorialReceiptState {
  if (!value || typeof value !== "object") throw new Error("教程状态格式无效");
  const state = value as Partial<TutorialReceiptState>;
  if (
    state.tutorialKey !== WORKBENCH_TUTORIAL_KEY ||
    state.tutorialVersion !== WORKBENCH_TUTORIAL_VERSION ||
    typeof state.acknowledged !== "boolean" ||
    (state.outcome !== null && !isTutorialOutcome(state.outcome)) ||
    (state.acknowledgedAt !== null && typeof state.acknowledgedAt !== "string") ||
    state.acknowledged !== (state.outcome !== null && state.acknowledgedAt !== null)
  ) {
    throw new Error("教程状态格式无效");
  }
  return state as TutorialReceiptState;
}

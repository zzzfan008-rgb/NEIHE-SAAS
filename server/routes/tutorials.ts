import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { requestUser } from "../lib/auth";
import { queryOne } from "../lib/database";
import {
  WORKBENCH_TUTORIAL_KEY,
  WORKBENCH_TUTORIAL_VERSION,
  isTutorialOutcome,
  type TutorialOutcome,
  type TutorialReceiptState,
} from "../../src/tutorials/tutorialContract";

export const tutorialsRouter = Router();

interface TutorialReceiptRow {
  outcome: TutorialOutcome;
  acknowledged_at: string;
}

function tutorialState(row?: TutorialReceiptRow): TutorialReceiptState {
  return {
    tutorialKey: WORKBENCH_TUTORIAL_KEY,
    tutorialVersion: WORKBENCH_TUTORIAL_VERSION,
    acknowledged: Boolean(row),
    outcome: row?.outcome ?? null,
    acknowledgedAt: row?.acknowledged_at ?? null,
  };
}

async function currentReceipt(userId: string): Promise<TutorialReceiptRow | undefined> {
  return queryOne<TutorialReceiptRow>(`
    SELECT outcome, acknowledged_at
    FROM user_tutorial_receipts
    WHERE user_id = $1 AND tutorial_key = $2 AND tutorial_version = $3
  `, [userId, WORKBENCH_TUTORIAL_KEY, WORKBENCH_TUTORIAL_VERSION]);
}

tutorialsRouter.get("/workbench-onboarding", asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const row = await currentReceipt(requestUser(req).id);
  res.json(tutorialState(row));
}));

tutorialsRouter.post("/workbench-onboarding/acknowledge", asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const body = req.body as Record<string, unknown> | null;
  if (
    !body ||
    body.tutorialKey !== WORKBENCH_TUTORIAL_KEY ||
    body.tutorialVersion !== WORKBENCH_TUTORIAL_VERSION ||
    !isTutorialOutcome(body.outcome)
  ) {
    res.status(400).json({ error: "教程标识、版本或确认结果无效" });
    return;
  }

  const now = new Date().toISOString();
  const row = await queryOne<TutorialReceiptRow>(`
    INSERT INTO user_tutorial_receipts (
      user_id, tutorial_key, tutorial_version, outcome, acknowledged_at
    ) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (user_id, tutorial_key, tutorial_version) DO UPDATE SET
      outcome = CASE
        WHEN user_tutorial_receipts.outcome = 'completed' OR excluded.outcome = 'completed'
          THEN 'completed'
        ELSE user_tutorial_receipts.outcome
      END,
      acknowledged_at = CASE
        WHEN user_tutorial_receipts.outcome = excluded.outcome
          OR user_tutorial_receipts.outcome = 'completed'
          THEN user_tutorial_receipts.acknowledged_at
        ELSE excluded.acknowledged_at
      END
    RETURNING outcome, acknowledged_at
  `, [
    requestUser(req).id,
    WORKBENCH_TUTORIAL_KEY,
    WORKBENCH_TUTORIAL_VERSION,
    body.outcome,
    now,
  ]);
  if (!row) throw new Error("教程确认记录写入失败");
  res.json(tutorialState(row));
}));

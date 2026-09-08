import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { optimizePromptText, PROMPT_ENHANCER_MODEL } from "../lib/promptEnhancement";

export const promptOptimizeRouter = Router();

promptOptimizeRouter.post("/", asyncHandler(async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return res.status(400).json({ error: "提示词不能为空" });
  if (text.length > 12_000) return res.status(400).json({ error: "提示词过长，请缩短后重试" });
  const result = await optimizePromptText(text);
  return res.json({ text: result, model: PROMPT_ENHANCER_MODEL });
}));

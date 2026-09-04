import { Router } from "express";
import { config } from "../config";
import { asyncHandler } from "../lib/asyncHandler";
import { fetchWithRetry, ProviderError } from "../providers/base";

const PROMPT_OPTIMIZER_MODEL = "gpt-5.6-terra";

function optimizedText(payload: unknown): string {
  const body = payload as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    }).join("").trim();
  }
  return "";
}

export const promptOptimizeRouter = Router();

promptOptimizeRouter.post("/", asyncHandler(async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return res.status(400).json({ error: "提示词不能为空" });
  if (text.length > 12_000) return res.status(400).json({ error: "提示词过长，请缩短后重试" });
  const response = await fetchWithRetry(
    `${config.apiyiBaseUrl()}/v1/chat/completions`,
    () => ({
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
      body: JSON.stringify({
        model: PROMPT_OPTIMIZER_MODEL,
        temperature: 0.2,
        messages: [
          { role: "system", content: "你是专业服装 SaaS 的视觉生成提示词编辑器。优化用户提示词，使目标、主体、服装结构、材质工艺、动作、场景、构图和负面约束清晰且无歧义。必须保持原意；禁止虚构用户没有提供的配饰、品牌、图案、文字、人物或面料参数。只返回可直接用于生成的优化后提示词，不解释、不加标题、不使用 Markdown。" },
          { role: "user", content: text },
        ],
      }),
    }),
    { timeoutMs: config.aiTimeoutMs(120_000), providerId: PROMPT_OPTIMIZER_MODEL, maxRetries: 0 },
  );
  const result = optimizedText(await response.json());
  if (!result) throw new ProviderError("提示词优化模型未返回文本", 502, PROMPT_OPTIMIZER_MODEL, "empty_response");
  return res.json({ text: result, model: PROMPT_OPTIMIZER_MODEL });
}));

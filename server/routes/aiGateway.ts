import { Router, type RequestHandler } from "express";
import { isAiGatewayId } from "../../src/types/aiGateway";
import { config } from "../config";
import { requireAdmin } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { readAiGatewaySelection, readAiGatewaySettings, switchAiGateway } from "../lib/aiGatewayStore";
import { withAiGateway } from "../providers/gatewayContext";

export const aiGatewayRouter = Router();
aiGatewayRouter.get("/", asyncHandler(async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await readAiGatewaySettings());
}));

aiGatewayRouter.put("/", requireAdmin, asyncHandler(async (req, res) => {
  const { activeGateway, revision } = req.body ?? {};
  if (!isAiGatewayId(activeGateway) || !Number.isSafeInteger(revision) || revision < 0) {
    res.status(400).json({ error: "供应商或设置版本无效" });
    return;
  }
  if (!config.aiConfigReady(activeGateway)) {
    res.status(409).json({ error: "该供应商尚未配置，请先在服务端配置 HTTPS 地址和 API Key" });
    return;
  }
  if (!await switchAiGateway(activeGateway, revision)) {
    res.status(409).json({ error: "供应商已由其他管理员更新，请重新选择" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(await readAiGatewaySettings());
}));

/** Only server state can select a supplier; client headers/body cannot override it. */
export const captureAiGateway: RequestHandler = asyncHandler(async (_req, _res, next) => {
  const { activeGateway } = await readAiGatewaySelection();
  withAiGateway(activeGateway, next);
});

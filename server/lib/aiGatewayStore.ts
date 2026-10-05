import type { PoolClient } from "pg";
import { AI_GATEWAY_IDS, AI_GATEWAY_LABELS, type AiGatewayId, type AiGatewaySettings } from "../../src/types/aiGateway";
import { IMAGE_MODEL_IDS } from "../../src/types/imageModels";
import { TUZI_IMAGE_MODEL_IDS } from "../../src/lib/aiGatewayPolicy";
import { config } from "../config";
import { queryOne, transaction } from "./database";

export async function readAiGatewaySelection(client?: PoolClient): Promise<Pick<AiGatewaySettings, "activeGateway" | "revision">> {
  const row = await queryOne<{ active_gateway: AiGatewayId; revision: number }>(
    "SELECT active_gateway, revision FROM ai_gateway_settings WHERE singleton = TRUE", [], client,
  );
  if (!row) throw new Error("供应商设置尚未初始化");
  return { activeGateway: row.active_gateway, revision: row.revision };
}

export async function readAiGatewaySettings(): Promise<AiGatewaySettings> {
  return {
    ...await readAiGatewaySelection(),
    gateways: AI_GATEWAY_IDS.map((id) => ({
      id, label: AI_GATEWAY_LABELS[id], configured: config.aiConfigReady(id),
      imageModelIds: [...(id === "tuzi" ? TUZI_IMAGE_MODEL_IDS : IMAGE_MODEL_IDS)],
    })),
  };
}

export async function switchAiGateway(gateway: AiGatewayId, revision: number): Promise<boolean> {
  return transaction(async (client) => {
    const result = await client.query(`
      UPDATE ai_gateway_settings SET active_gateway = $1, revision = revision + 1, updated_at = now()
      WHERE singleton = TRUE AND revision = $2
    `, [gateway, revision]);
    return result.rowCount === 1;
  });
}

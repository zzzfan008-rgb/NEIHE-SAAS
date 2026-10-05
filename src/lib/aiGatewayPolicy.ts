import contracts from "../../docs/ai/tuzi/model-contracts.json";
import { DEFAULT_GENERATION_MODEL_ID, MASK_REDRAW_MODEL_ID, type ImageModelId } from "../types/imageModels";
import { NODE_SPECS, type NodeKind } from "../types/workflow";
import type { AiGatewayId } from "../types/aiGateway";

export const TUZI_IMAGE_MODEL_IDS = contracts.models.map((model) => model.id as ImageModelId);

export function gatewayModelUnavailableReason(gateway: AiGatewayId, modelId: string): string | undefined {
  if (gateway !== "tuzi" || TUZI_IMAGE_MODEL_IDS.includes(modelId as ImageModelId)) return undefined;
  return `${modelId}：${contracts.unsupportedReason}`;
}

export function gatewayNodeUnavailableReason(
  gateway: AiGatewayId,
  kind: NodeKind,
  params: Record<string, unknown>,
): string | undefined {
  if (gateway !== "tuzi" || !NODE_SPECS[kind]?.providerId) return undefined;
  if (kind === "video-generate") {
    if (params.mode === "video-edit") return contracts.video.unsupportedReason;
    if (params.seconds === -1) return "TuziAPI 需要明确的视频时长，请关闭智能时长";
    return undefined;
  }
  const modelId = typeof params.modelId === "string" ? params.modelId
    : kind === "mask-redraw" || kind === "sketch-optimize" ? MASK_REDRAW_MODEL_ID
    : DEFAULT_GENERATION_MODEL_ID;
  return gatewayModelUnavailableReason(gateway, modelId);
}

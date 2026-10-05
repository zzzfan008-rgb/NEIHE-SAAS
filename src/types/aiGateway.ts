export const AI_GATEWAY_IDS = ["apiyi", "tuzi"] as const;
export type AiGatewayId = (typeof AI_GATEWAY_IDS)[number];

export const AI_GATEWAY_LABELS: Record<AiGatewayId, string> = {
  apiyi: "APIYI",
  tuzi: "TuziAPI",
};

export function isAiGatewayId(value: unknown): value is AiGatewayId {
  return value === "apiyi" || value === "tuzi";
}

export interface AiGatewayOption {
  id: AiGatewayId;
  label: string;
  configured: boolean;
  imageModelIds: string[];
}

export interface AiGatewaySettings {
  activeGateway: AiGatewayId;
  revision: number;
  gateways: AiGatewayOption[];
}

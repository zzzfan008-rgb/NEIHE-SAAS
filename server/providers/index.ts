/** Provider 工厂。模型清单与 docs/ai/apiyi/model-contracts.json 保持一致。 */
import type { AIProvider } from "../../src/types/workflow";
import { apiyiProviders } from "./apiyi";
import { ProviderError } from "./base";
import { tuziProviders } from "./tuzi";
import { currentAiGateway } from "./gatewayContext";
import { gatewayModelUnavailableReason } from "../../src/lib/aiGatewayPolicy";

const providers: Record<string, AIProvider> = { ...apiyiProviders };

export function getProvider(id: string): AIProvider {
  const gateway = currentAiGateway();
  const reason = gatewayModelUnavailableReason(gateway, id);
  if (reason) throw new ProviderError(reason, 400, id, "invalid_request");
  const p = (gateway === "tuzi" ? tuziProviders : providers)[id];
  if (!p) {
    throw new ProviderError(`Unknown provider id: ${id}`, 400);
  }
  return p;
}

export function listProviderIds(): string[] {
  return Object.keys(currentAiGateway() === "tuzi" ? tuziProviders : providers);
}

export * from "./base";

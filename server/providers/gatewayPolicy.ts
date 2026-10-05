import type { NodeExecution } from "../../src/types/workflow";
import type { AiGatewayId } from "../../src/types/aiGateway";
import { gatewayNodeUnavailableReason } from "../../src/lib/aiGatewayPolicy";
import { ProviderError } from "./base";
import { currentAiGateway } from "./gatewayContext";

export function assertGatewayStep(step: Pick<NodeExecution, "kind" | "params">, gateway: AiGatewayId = currentAiGateway()): void {
  const reason = gatewayNodeUnavailableReason(gateway, step.kind, step.params);
  if (reason) throw new ProviderError(reason, 400, gateway, "invalid_request");
}

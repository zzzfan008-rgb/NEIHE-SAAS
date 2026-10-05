import { AsyncLocalStorage } from "node:async_hooks";
import type { AiGatewayId } from "../../src/types/aiGateway";

// Request/worker-local routing. Never mutate process.env to switch suppliers.
const gatewayContext = new AsyncLocalStorage<AiGatewayId>();

export function currentAiGateway(): AiGatewayId {
  return gatewayContext.getStore() ?? "apiyi";
}

export function capturedAiGateway(): AiGatewayId | undefined {
  return gatewayContext.getStore();
}

export function withAiGateway<T>(gateway: AiGatewayId, operation: () => T): T {
  return gatewayContext.run(gateway, operation);
}

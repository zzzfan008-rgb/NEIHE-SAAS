import { createHash } from "node:crypto";
import type { ExecutionPlan } from "../../src/types/workflow";

export interface ExecutionInputFingerprintContext {
  runType: "workflow" | "direct";
  projectId?: string | null;
  nodeId: string;
  plan: ExecutionPlan;
}

/**
 * Hash the immutable execution inputs that are persisted with a generation run.
 * Keep the framing identical for idempotency and later approval verification.
 */
export function createExecutionInputFingerprint({
  runType,
  projectId,
  nodeId,
  plan,
}: ExecutionInputFingerprintContext): string {
  return createHash("sha256")
    .update(JSON.stringify({
      runType,
      projectId: projectId ?? null,
      nodeId,
    }))
    .update("\0")
    .update(JSON.stringify(plan))
    .digest("hex");
}

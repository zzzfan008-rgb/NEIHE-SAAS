import type { PersistedWorkflow } from "../../src/types/workflow";
import { isMultiImageTryOn } from "../../src/lib/multiImageTryOn";

export class TryOnModeConflictError extends Error {
  constructor() {
    super("多图换装节点的模式信息缺失，项目尚未保存。请重新打开最新项目后再编辑，避免切换到旧换装流程。");
  }
}

/** An incomplete/stale document must not silently downgrade a known mode. */
export function assertTryOnModeContinuity(previous: unknown, next: PersistedWorkflow): void {
  // Inspect only established mode markers. Legacy partial documents must remain
  // saveable; incoming documents are already validated by the route.
  const nodes = previous && typeof previous === "object" && "nodes" in previous ? previous.nodes : undefined;
  if (!Array.isArray(nodes)) return;
  const previousModes = new Set<string>();
  for (const node of nodes) {
    if (!node || typeof node !== "object" || typeof node.id !== "string" ||
        !node.data || typeof node.data !== "object") continue;
    if (node.data.kind === "virtual-try-on" && isMultiImageTryOn(node.data)) previousModes.add(node.id);
  }
  for (const node of next.nodes) {
    if (previousModes.has(node.id) &&
        node.data.kind === "virtual-try-on" && node.data.workflowStage === "scene-stabilize" &&
        node.data.sceneInputMode === undefined) {
      throw new TryOnModeConflictError();
    }
  }
}

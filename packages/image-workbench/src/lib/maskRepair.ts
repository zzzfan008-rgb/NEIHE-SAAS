import type {
  MaskRepairFocus,
  WorkflowInputRole,
  WorkflowNodeData,
} from "../types/workflow";

export const MASK_REPAIR_FOCUSES = [
  "custom",
  "upper-garment",
  "pants",
  "accessories",
  "logo-text",
] as const satisfies readonly MaskRepairFocus[];

export const MASK_ACCESSORY_REFERENCE_ROLES = [
  "bag",
  "shoes",
  "hat",
  "ring",
  "earrings",
  "bracelet",
  "eyewear",
  "neckwear",
  "belt",
  "watch",
] as const satisfies readonly WorkflowInputRole[];

export const MASK_REPAIR_REFERENCE_LIMIT = 6;

export function isBypassedMaskRepair(data: WorkflowNodeData): boolean {
  return data.kind === "mask-redraw" && data.executionMode === "bypass";
}

export interface MaskRepairGraphNode {
  id: string;
  data: WorkflowNodeData;
}

export interface MaskRepairGraphEdge {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface EffectiveIncomingSource {
  node: MaskRepairGraphNode;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

/** Resolve a consumer's inputs through any consecutive bypassed mask-repair nodes. */
export function effectiveIncomingSources(
  nodes: readonly MaskRepairGraphNode[],
  edges: readonly MaskRepairGraphEdge[],
  targetNodeId: string,
): EffectiveIncomingSource[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  const resolveSource = (
    sourceNodeId: string,
    sourceHandle: string | null | undefined,
    visited: Set<string>,
  ): Pick<EffectiveIncomingSource, "node" | "sourceHandle"> | undefined => {
    if (visited.has(sourceNodeId)) return undefined;
    const source = nodesById.get(sourceNodeId);
    if (!source) return undefined;
    if (!isBypassedMaskRepair(source.data)) return { node: source, sourceHandle };

    const sourceEdge = edges.find((edge) => (
      edge.target === source.id && edge.targetHandle === "repair-source"
    ));
    if (!sourceEdge) return undefined;
    const nextVisited = new Set(visited);
    nextVisited.add(sourceNodeId);
    return resolveSource(sourceEdge.source, sourceEdge.sourceHandle, nextVisited);
  };

  const incoming = edges.filter((edge) => edge.target === targetNodeId);
  incoming.sort((a, b) => (
    Number(b.targetHandle === "repair-source") - Number(a.targetHandle === "repair-source")
  ));
  return incoming.flatMap((edge) => {
    const resolved = resolveSource(edge.source, edge.sourceHandle, new Set([targetNodeId]));
    return resolved ? [{ ...resolved, targetHandle: edge.targetHandle }] : [];
  });
}

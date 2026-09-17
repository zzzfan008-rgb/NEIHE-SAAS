export type PoseReferenceKind = 'skeleton' | 'depth';
export interface PoseReferenceRecord {
  id: string;
  kind: PoseReferenceKind;
  source: string;
  status: 'running' | 'succeeded' | 'failed' | 'outcome_unknown';
  result?: { image: string; model: string; checkpoint?: string; convention?: string; inputSize?: number };
  error?: string;
}

/** Recognize the pose port, never a mutable translated node title or a fixed node ID. */
export function isPoseReferenceNode(
  nodeId: string,
  nodes: ReadonlyArray<{id: string; data: {kind: string; workflowStage?: string; poseReference?: boolean; autoConnectTargets?: Array<{targetHandle: string}>}}>,
  edges: ReadonlyArray<{source: string; target: string; targetHandle?: string | null}>,
): boolean {
  const node = nodes.find(n => n.id === nodeId && n.data.kind === 'image-input');
  return !!node && (node.data.poseReference === true ||
    node.data.autoConnectTargets?.some(t => t.targetHandle === 'pose') === true ||
    edges.some(e => e.source === nodeId && e.targetHandle === 'pose' && nodes.some(n =>
      n.id === e.target && n.data.kind === 'virtual-try-on' && n.data.workflowStage === 'scene-stabilize')));
}

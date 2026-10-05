export type PosePromptMode = 'single' | 'three-view';
export type PoseReferenceKind = 'skeleton' | 'depth';
export const CALIBRATED_POSE_SUPPLEMENT_HEADER = '三图校准补充（仅补充图1不可见关系）';
const CALIBRATED_POSE_SUPPLEMENT_LABELS = ['前后深度', '手部接触', '视线方向', '面部神态'] as const;

function usesExplicitScreenDirections(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const direction = text[index];
    if (direction !== '左' && direction !== '右') continue;
    if ((direction === '左' && text[index + 1] === '右') || (direction === '右' && text[index - 1] === '左')) continue;
    if (text.slice(Math.max(0, index - 2), index) !== '画面') return false;
  }
  return true;
}

/** Only server-validated, non-geometric three-view supplements may reach image generation. */
export function isCalibratedPoseSupplement(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const lines = value.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines[0] !== CALIBRATED_POSE_SUPPLEMENT_HEADER || lines.length < 2 || lines.length > 5) return false;
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf('：');
    if (separator < 1) return false;
    const label = line.slice(0, separator);
    const detail = line.slice(separator + 1).trim();
    if (!(CALIBRATED_POSE_SUPPLEMENT_LABELS as readonly string[]).includes(label) || seen.has(label) || !detail) return false;
    if (/无法判断|无法识别|无法确认|无法确定|不构成.*约束|交叉|越过.*中线|重心|承重|支撑腿|二维|坐标|关节位置|肩线|髋线/.test(detail)) return false;
    if (!usesExplicitScreenDirections(detail)) return false;
    seen.add(label);
  }
  return true;
}

export function posePromptForImage(data: { imageUrl?: string; posePrompt?: string; posePromptImage?: string; posePromptMode?: PosePromptMode }): string | undefined {
  return data.imageUrl && data.posePromptImage === data.imageUrl && typeof data.posePrompt === 'string'
    ? data.posePrompt : undefined;
}
export function optimizedPosePromptForImage(data: { imageUrl?: string; posePromptImage?: string; posePromptOptimized?: string }): string | undefined {
  return data.imageUrl && data.posePromptImage === data.imageUrl && typeof data.posePromptOptimized === 'string'
    ? data.posePromptOptimized : undefined;
}
export type PoseReferenceCanvasKind = PoseReferenceKind | 'original' | 'neutral-outfit';
/** Bound to an immutable image reference; replacing the image invalidates the tag. */
export interface PoseReferenceSource {
  kind: PoseReferenceCanvasKind;
  image: string;
  /** Neutral outfit image actually used to derive this depth/skeleton image. */
  neutralSource?: string;
}
export function validPoseReferenceSource(value: unknown, image: unknown): value is PoseReferenceSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<PoseReferenceSource>;
  return typeof image === 'string' && source.image === image &&
    ['original', 'neutral-outfit', 'skeleton', 'depth'].includes(source.kind ?? '') &&
    (source.neutralSource === undefined ||
      (['depth', 'skeleton'].includes(source.kind ?? '') &&
        typeof source.neutralSource === 'string' &&
        /^\/api\/files\/[\w.-]+$/.test(source.neutralSource)));
}
export interface DWPoseKeypointV1 { x: number; y: number; confidence: number }
export interface DWPosePoseV1 {
  schemaVersion: 1;
  canvas: { width: number; height: number };
  people: Array<{ keypoints: Array<DWPoseKeypointV1 | null> }>;
}
export interface PoseReferenceRecord {
  id: string;
  kind: PoseReferenceKind;
  source: string;
  status: 'running' | 'succeeded' | 'failed' | 'outcome_unknown';
  result?: { image: string; model: string; checkpoint?: string; convention?: string; inputSize?: number; pose?: DWPosePoseV1 | null };
  error?: string;
}

export type PoseOutfitReferenceStatus =
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'outcome_unknown'
  | 'cancelled';

export interface PoseOutfitReferenceRecord {
  id: string;
  runId: string;
  source: string;
  status: PoseOutfitReferenceStatus;
  result?: { image: string; model: string; providerOutputSize?: string | null };
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

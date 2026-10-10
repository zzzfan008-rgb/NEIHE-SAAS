export type PosePromptMode = 'single' | 'three-view';
export type PoseReferenceKind = 'skeleton' | 'depth';
export const CALIBRATED_POSE_SUPPLEMENT_HEADER = '三图校准补充（仅补充图1不可见关系）';
const CALIBRATED_POSE_SUPPLEMENT_LABELS = ['前后深度', '手部接触', '视线方向', '面部神态'] as const;

export const SEQUENTIAL_POSE_HEADER = '三图校准姿势';
export const EDITED_POSE_HEADER = '三图校准姿势（用户编辑）';
export const SEQUENTIAL_POSE_LABELS = ['整体姿势', '头部', '视线', '面部', '上肢', '肩部', '腰部', '胯部', '下肢'] as const;
export interface PoseCalibrationStages { original: string; depth: string; skeleton: string }

/** 完整姿势与旧版四类补充使用不同格式，旧文档不会自动升级为新语义。 */
export function isSequentialPosePrompt(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 4000) return false;
  const [header, ...lines] = value.split('\n').map(line => line.trim()).filter(Boolean);
  if (![SEQUENTIAL_POSE_HEADER, EDITED_POSE_HEADER].includes(header) || !lines.length || lines.length > 9) return false;
  const seen = new Set<string>();
  return lines.every(line => {
    const separator = line.indexOf('：');
    const label = line.slice(0, separator);
    const detail = line.slice(separator + 1).trim();
    if (separator < 1 || !(SEQUENTIAL_POSE_LABELS as readonly string[]).includes(label) || seen.has(label) || !detail || !usesExplicitScreenDirections(detail)) return false;
    seen.add(label);
    return true;
  });
}

/** 用户编辑稿：标记头 + 任意非空正文；格式与内容由人工核对，不做结构校验。 */
export function isEditedPosePrompt(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4000) return false;
  const [header, ...lines] = value.split('\n').map(line => line.trim()).filter(Boolean);
  return header === EDITED_POSE_HEADER && lines.length > 0;
}

export function isPoseCalibrationStages(value: unknown): value is PoseCalibrationStages {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const stages = value as Record<string, unknown>;
  return ['original', 'depth', 'skeleton'].every(key => typeof stages[key] === 'string' && stages[key].length > 0 && stages[key].length <= 4000);
}

/** 画面左/画面右是唯一允许的方位写法；“偏/略/稍/微 + 左/右”只是方向修饰，仍是画面方向。 */
const SCREEN_DIRECTION_MODIFIER = /[偏略稍微]$/;
export function usesExplicitScreenDirections(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const direction = text[index];
    if (direction !== '左' && direction !== '右') continue;
    if ((direction === '左' && text[index + 1] === '右') || (direction === '右' && text[index - 1] === '左')) continue;
    if (SCREEN_DIRECTION_MODIFIER.test(text.slice(Math.max(0, index - 1), index))) continue;
    if (text.slice(Math.max(0, index - 2), index) !== '画面') return false;
  }
  return true;
}

/** 不得进入生图的措辞：不确定、交叉、重心或坐标类表达。 */
const CALIBRATED_DETAIL_FORBIDDEN = /无法判断|无法识别|无法确认|无法确定|不构成.*约束|交叉|越过.*中线|重心|承重|支撑腿|二维|坐标|关节位置|肩线|髋线/;

/** 可放入校准补充的细节文本：非空且不含不得进入生图的措辞。 */
export function isCalibratedPoseDetail(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !CALIBRATED_DETAIL_FORBIDDEN.test(value);
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
    if (!isCalibratedPoseDetail(detail)) return false;
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

import type { PoseDocumentV1 } from '../types/poseDocument';
import { validatePoseDocument } from './poseTopology';

export interface PoseSkeletonEdit {
  source: string;
  analysisSource: string;
  analysisSourceKind: 'image' | 'depth';
  analysisSourceRecordId?: string;
  image: string;
  poseDocument: PoseDocumentV1;
}

const LOCAL_IMAGE = /^\/api\/files\/[A-Za-z0-9_-]{1,128}\.(png|jpg|jpeg|webp|gif)$/i;
export function skeletonEditKey(edit: Pick<PoseSkeletonEdit, 'analysisSource' | 'analysisSourceRecordId'>): string {
  return JSON.stringify([edit.analysisSource, edit.analysisSourceRecordId ?? null]);
}

export function validatePoseSkeletonEdits(value: unknown): PoseSkeletonEdit[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error('最多保存 8 组骨骼来源编辑稿');
  const keys = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some(key => !['source', 'analysisSource', 'analysisSourceKind', 'analysisSourceRecordId', 'image', 'poseDocument'].includes(key)) ||
        ![item.source, item.analysisSource, item.image].every(image => typeof image === 'string' && LOCAL_IMAGE.test(image)) ||
        !['image', 'depth'].includes(item.analysisSourceKind) ||
        (item.analysisSourceKind === 'depth' ? typeof item.analysisSourceRecordId !== 'string' || !/^[\w-]{1,128}$/.test(item.analysisSourceRecordId) : item.analysisSourceRecordId !== undefined)) {
      throw new Error('骨骼编辑稿来源无效');
    }
    const document = validatePoseDocument(item.poseDocument);
    if (document.imageBinding !== item.image || document.source.analysisImage !== item.analysisSource) throw new Error('骨骼编辑稿图像绑定无效');
    const key = skeletonEditKey(item);
    if (keys.has(key)) throw new Error('骨骼编辑稿来源重复');
    keys.add(key);
  }
  return value as PoseSkeletonEdit[];
}

export function boundSkeletonEdits(value: unknown, source: unknown): PoseSkeletonEdit[] {
  try { return validatePoseSkeletonEdits(value).filter(edit => edit.source === source); }
  catch { return []; }
}

export function findSkeletonEdit(value: unknown, source: string, analysisSource: string, analysisSourceRecordId?: string): PoseSkeletonEdit | undefined {
  const key = skeletonEditKey({ analysisSource, analysisSourceRecordId });
  return boundSkeletonEdits(value, source).find(edit => skeletonEditKey(edit) === key);
}

export function skeletonEditRevision(data: { poseSkeletonEdits?: unknown; poseDocument?: unknown }): string {
  return JSON.stringify([data.poseSkeletonEdits ?? null, data.poseDocument ?? null]);
}

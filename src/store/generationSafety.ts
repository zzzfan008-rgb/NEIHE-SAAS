import { useSyncExternalStore } from "react";

type Listener = () => void;

const listeners = new Set<Listener>();
export const INITIAL_GENERATION_SAFETY_BLOCK_REASON =
  "正在确认运行历史，完成前暂停新的生成任务";

// 冷启动必须默认拒绝新的付费运行；Workspace 只有在历史与活动任务完成对账后才解除。
let blockReason: string | null = INITIAL_GENERATION_SAFETY_BLOCK_REASON;

/**
 * 运行历史尚未完成对账时，只封锁新的付费生成，不影响画布查看、编辑和保存。
 * 该门禁不进入项目快照与撤销栈，避免安全状态污染用户工作流。
 */
export function setGenerationSafetyBlockReason(reason: string | null): void {
  if (blockReason === reason) return;
  blockReason = reason;
  for (const listener of listeners) listener();
}

export function getGenerationSafetyBlockReason(): string | null {
  return blockReason;
}

export function subscribeGenerationSafety(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useGenerationSafetyBlockReason(): string | null {
  return useSyncExternalStore(
    subscribeGenerationSafety,
    getGenerationSafetyBlockReason,
    getGenerationSafetyBlockReason,
  );
}

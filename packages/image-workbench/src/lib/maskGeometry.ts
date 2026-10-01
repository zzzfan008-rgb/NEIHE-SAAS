/**
 * 蒙版生成安全带宽度：给模型留出完整构图与柔和衔接空间。
 * 小尺寸测试夹具不扩张；真实图片按短边比例扩张，并限制处理成本。
 */
export function maskSafetyRadius(width: number, height: number): number {
  const shortEdge = Math.min(width, height);
  if (!Number.isFinite(shortEdge) || shortEdge < 64) return 0;
  return Math.max(4, Math.min(64, Math.round(shortEdge * 0.03)));
}

export function maskFeatherSigma(width: number, height: number): number {
  const radius = maskSafetyRadius(width, height);
  return radius > 0 ? Math.max(1, Math.min(12, radius / 3)) : 0;
}

export interface MaskSelectionExtent {
  width: number;
  height: number;
}

/**
 * 用户涂抹区只是修改意图的核心，不是新内容的裁切框。
 * 延展半径同时参考整幅画面与核心选区尺寸，避免小选区把完整图案压小或截断。
 */
export function adaptiveMaskExpansionRadius(
  width: number,
  height: number,
  selection: MaskSelectionExtent,
): number {
  const shortEdge = Math.min(width, height);
  if (!Number.isFinite(shortEdge) || shortEdge < 64) return 0;
  const selectionWidth = Number.isFinite(selection.width) ? Math.max(1, selection.width) : 1;
  const selectionHeight = Number.isFinite(selection.height) ? Math.max(1, selection.height) : 1;
  const geometricSpan = Math.sqrt(selectionWidth * selectionHeight);
  // 扩张区只承载越过核心的必要轮廓、阴影和边缘融合。大选区若继续按 30%
  // 扩张，会把相邻文字和独立图案也开放给模型重绘。
  const selectionFactor = 0.16;
  const desired = Math.max(shortEdge * 0.025, geometricSpan * selectionFactor);
  const minimum = Math.max(4, Math.min(18, Math.round(shortEdge * 0.018)));
  const maximum = Math.max(minimum, Math.min(160, Math.round(shortEdge * 0.12)));
  return Math.max(minimum, Math.min(maximum, Math.round(desired)));
}

/** 最外圈只负责衔接，完整图案可在它以内保持全强度。 */
export function adaptiveMaskFeatherRadius(width: number, height: number, expansionRadius: number): number {
  const shortEdge = Math.min(width, height);
  if (!Number.isFinite(shortEdge) || shortEdge < 64 || expansionRadius <= 0) return 0;
  return Math.max(4, Math.min(32, Math.round(Math.max(expansionRadius * 0.18, shortEdge * 0.006))));
}

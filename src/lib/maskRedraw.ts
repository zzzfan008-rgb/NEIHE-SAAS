export interface MaskRedrawReadinessInput {
  source?: string;
  mask?: string;
  maskSourceRef?: string;
  prompt: string;
}

/**
 * 蒙版保存后即可进入“局部修改”动作；提示词在点击时单独校验并就地提示。
 * 这样按钮状态只表达蒙版是否就绪，不再把缺失原因藏在 disabled 中。
 */
export function maskRedrawReadiness({
  source,
  mask,
  maskSourceRef,
  prompt,
}: MaskRedrawReadinessInput) {
  const hasCurrentMask = Boolean(source && mask && maskSourceRef === source);
  const hasPrompt = Boolean(prompt.trim());
  return {
    hasCurrentMask,
    hasPrompt,
    canOpenRunAction: hasCurrentMask,
    canSubmit: hasCurrentMask && hasPrompt,
  } as const;
}

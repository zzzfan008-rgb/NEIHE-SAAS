export interface CanvasLandingIntent {
  tabId: string;
  nodeId?: string;
  fitView: boolean;
  activateFilePicker?: boolean;
  selectText?: boolean;
}

export const CANVAS_LANDING_EVENT = "garment-canvas:landing";

const pendingByTab = new Map<string, CanvasLandingIntent>();

/**
 * 跨越页签切换与 React Flow 重挂载传递一次性视口/焦点意图。
 * 该状态只存在内存中，不进入项目文档、撤销栈或会话草稿。
 */
export function requestCanvasLanding(intent: CanvasLandingIntent): void {
  pendingByTab.set(intent.tabId, intent);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CANVAS_LANDING_EVENT, { detail: intent }));
  }
}

export function peekCanvasLanding(tabId: string): CanvasLandingIntent | undefined {
  return pendingByTab.get(tabId);
}

export function consumeCanvasLanding(tabId: string): CanvasLandingIntent | undefined {
  const intent = pendingByTab.get(tabId);
  if (intent) pendingByTab.delete(tabId);
  return intent;
}

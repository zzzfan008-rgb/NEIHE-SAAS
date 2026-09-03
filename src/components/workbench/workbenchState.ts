export interface WorkbenchUiState {
  activePanel: "library" | "inspector" | null;
}

export type WorkbenchUiAction =
  | { type: "toggle-panel"; panel: "library" | "inspector" };

export const INITIAL_WORKBENCH_UI_STATE: WorkbenchUiState = {
  // 首屏优先保留画布空间，需要节点、属性或结果时再展开左侧 Dock。
  activePanel: null,
};

/**
 * 工作台外壳的纯 UI 状态。不保存项目、节点或运行数据，
 * 避免面板开合污染工作流的撤销和持久化链路。
 */
export function workbenchUiReducer(
  state: WorkbenchUiState,
  action: WorkbenchUiAction,
): WorkbenchUiState {
  switch (action.type) {
    case "toggle-panel":
      return { activePanel: state.activePanel === action.panel ? null : action.panel };
    default:
      return state;
  }
}

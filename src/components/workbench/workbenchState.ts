import type { ToolGroupId, WorkbenchUiState as WorkbenchUiStateContract } from "@/types/workbench";

export interface WorkbenchUiState extends WorkbenchUiStateContract {
  focusReturnGroupId: ToolGroupId | null;
}

export type WorkbenchUiAction =
  | { type: "hover-group"; groupId: ToolGroupId }
  | { type: "leave-group"; groupId: ToolGroupId }
  | { type: "close-hover"; groupId: ToolGroupId }
  | { type: "toggle-pin"; groupId: ToolGroupId }
  | { type: "close-group"; groupId: ToolGroupId }
  | { type: "escape" }
  | { type: "consume-focus-return" }
  | { type: "toggle-right-dock" }
  | { type: "toggle-results-flyout" }
  | { type: "close-results-flyout" };

export const INITIAL_WORKBENCH_UI_STATE: WorkbenchUiState = {
  hoveredToolGroupId: null,
  openToolGroupId: null,
  pinnedToolGroupId: null,
  rightDockOpen: false,
  resultsFlyoutOpen: false,
  focusReturnGroupId: null,
};

/** Pure, non-persisted interaction state for the tool flyout and right dock. */
export function workbenchUiReducer(
  state: WorkbenchUiState,
  action: WorkbenchUiAction,
): WorkbenchUiState {
  switch (action.type) {
    case "hover-group":
      return {
        ...state,
        hoveredToolGroupId: action.groupId,
        openToolGroupId: state.pinnedToolGroupId ?? action.groupId,
      };
    case "leave-group":
      return state.hoveredToolGroupId === action.groupId
        ? { ...state, hoveredToolGroupId: null }
        : state;
    case "close-hover":
      return state.pinnedToolGroupId === null
        && state.hoveredToolGroupId === null
        && state.openToolGroupId === action.groupId
        ? { ...state, openToolGroupId: null }
        : state;
    case "toggle-pin":
      if (state.pinnedToolGroupId === action.groupId) {
        return {
          ...state,
          hoveredToolGroupId: null,
          openToolGroupId: null,
          pinnedToolGroupId: null,
          focusReturnGroupId: action.groupId,
        };
      }
      return {
        ...state,
        openToolGroupId: action.groupId,
        pinnedToolGroupId: action.groupId,
        focusReturnGroupId: null,
      };
    case "close-group":
      if (state.openToolGroupId !== action.groupId) return state;
      return {
        ...state,
        hoveredToolGroupId: null,
        openToolGroupId: null,
        pinnedToolGroupId: null,
      };
    case "escape": {
      const focusReturnGroupId = state.pinnedToolGroupId ?? state.openToolGroupId;
      return {
        ...state,
        hoveredToolGroupId: null,
        openToolGroupId: null,
        pinnedToolGroupId: null,
        focusReturnGroupId,
      };
    }
    case "consume-focus-return":
      return state.focusReturnGroupId === null ? state : { ...state, focusReturnGroupId: null };
    case "toggle-right-dock":
      return { ...state, rightDockOpen: !state.rightDockOpen };
    case "toggle-results-flyout":
      return { ...state, resultsFlyoutOpen: !state.resultsFlyoutOpen };
    case "close-results-flyout":
      return { ...state, resultsFlyoutOpen: false };
    default:
      return state;
  }
}

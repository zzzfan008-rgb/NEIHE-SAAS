export interface WorkspaceUnloadState {
  hasDirtyTabs: boolean;
  tabSessionPersistenceError: string | null;
  pendingMaskWorkCount: number;
}

let workspaceUnloadWarningSuppressed = false;

/** 账号/会话切换必须完成整页隔离，不能被草稿确认框取消。 */
export function suppressWorkspaceUnloadWarning(): void {
  workspaceUnloadWarningSuppressed = true;
}

export function isWorkspaceUnloadWarningSuppressed(): boolean {
  return workspaceUnloadWarningSuppressed;
}

/**
 * 会话快照可用时，普通 dirty 项目能在刷新后恢复，不需要打扰用户；
 * 蒙版编辑/上传尚未进入快照，或 dirty 快照写失败时才需要原生离页确认。
 */
export function shouldWarnBeforeWorkspaceUnload(state: WorkspaceUnloadState): boolean {
  return state.pendingMaskWorkCount > 0 || (
    state.hasDirtyTabs && Boolean(state.tabSessionPersistenceError)
  );
}

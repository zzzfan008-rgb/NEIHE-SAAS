let projectTabSessionWorkspaceRestored = false;

/**
 * Lightweight auth/workspace boundary signal. Auth must know whether an
 * in-memory document was restored without importing the full flow store (and
 * therefore the entire authenticated workbench) into the login entry chunk.
 */
export function markProjectTabSessionWorkspaceRestored(restored: boolean): void {
  projectTabSessionWorkspaceRestored = restored;
}

export function didRestoreProjectTabSessionWorkspace(): boolean {
  return projectTabSessionWorkspaceRestored;
}

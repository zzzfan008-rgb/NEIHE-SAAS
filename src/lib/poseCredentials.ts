// User-supplied credentials are browser-local, never part of a project snapshot.
const PREFIX = 'gc:pose-deepseek-key:';

export function readPoseCredential(ownerId: string): string {
  try { return window.localStorage.getItem(PREFIX + ownerId) ?? ''; }
  catch { return ''; }
}

export function savePoseCredential(ownerId: string, value: string): boolean {
  if (!ownerId) return false;
  try {
    if (value.trim()) window.localStorage.setItem(PREFIX + ownerId, value.trim());
    else window.localStorage.removeItem(PREFIX + ownerId);
    return true;
  } catch { return false; }
}

export function clearPoseCredential(ownerId: string | null): void {
  if (!ownerId) return;
  try { window.localStorage.removeItem(PREFIX + ownerId); } catch { /* Storage unavailable. */ }
}

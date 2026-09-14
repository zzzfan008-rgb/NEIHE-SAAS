/** Ephemeral input revisions reject a late recognition even after disconnect/reconnect. */
const revisions = new Map<string, number>();
interface Target { tabId: string; projectId: string; documentEpoch: number }
const key = (target: Target, nodeId: string) => JSON.stringify([target.tabId, target.projectId, target.documentEpoch, nodeId]);
export const stylingRequestVersion = (target: Target, nodeId: string) => revisions.get(key(target, nodeId)) ?? 0;
export function invalidateStylingRequest(target: Target, nodeId: string): void {
  revisions.set(key(target, nodeId), stylingRequestVersion(target, nodeId) + 1);
}

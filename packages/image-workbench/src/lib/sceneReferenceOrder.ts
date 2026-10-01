/** Shared by the node preview and the provider request. Stable within each role. */
export const SCENE_REFERENCE_ORDER = [
  "pose", "person", "outfit", "bag", "shoes", "socks", "hat",
  "ring", "earrings", "bracelet", "detail", "scene",
] as const;

export function orderSceneReferences<T extends { role: string }>(references: readonly T[]): T[] {
  const rank = (role: string) => {
    const index = (SCENE_REFERENCE_ORDER as readonly string[]).indexOf(role);
    return index < 0 ? SCENE_REFERENCE_ORDER.length : index;
  };
  return [...references].sort((a, b) => rank(a.role) - rank(b.role));
}

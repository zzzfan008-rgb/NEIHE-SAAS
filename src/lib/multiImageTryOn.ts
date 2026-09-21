/** Opt-in policy for the two-stage template; legacy try-on modes are unchanged. */
export const MULTI_IMAGE_TRY_ON_MODE = "multi-reference-edit" as const;
export const MULTI_IMAGE_TRY_ON_MAX_SOURCES = 20;
export const MULTI_IMAGE_TRY_ON_ROLES = [
  "pose", "person", "scene", "outfit", "detail", "shoes", "socks",
  "bag", "hat", "eyewear", "neckwear", "earrings", "ring", "bracelet", "belt", "watch",
] as const;
export const MULTI_IMAGE_ROLE_LABELS: Readonly<Record<string, string>> = {
  pose: "姿势", person: "人物", scene: "场景", outfit: "主穿搭", detail: "服装细节 / 面料",
  shoes: "鞋子", socks: "袜子", bag: "包袋", hat: "帽子", eyewear: "眼镜 / 墨镜",
  neckwear: "项链 / 围巾", earrings: "耳环", ring: "戒指", bracelet: "手镯 / 手环",
  belt: "腰带", watch: "手表",
};

export function isMultiImageTryOn(data: { workflowStage?: unknown; sceneInputMode?: unknown }): boolean {
  return data.workflowStage === "scene-stabilize" && data.sceneInputMode === MULTI_IMAGE_TRY_ON_MODE;
}

/** A source shared with a legacy stage must retain that stage's pose editor. */
export function isDirectMultiImagePoseNode(
  nodeId: string,
  nodes: ReadonlyArray<{ id: string; data: { kind: string; workflowStage?: unknown; sceneInputMode?: unknown;
    autoConnectTargets?: Array<{ targetNodeId: string; targetHandle: string }> } }>,
  edges: ReadonlyArray<{ source: string; target: string; targetHandle?: string | null }>,
): boolean {
  const declared = nodes.find(node => node.id === nodeId)?.data.autoConnectTargets ?? [];
  const targetIds = new Set([
    ...declared.filter(target => target.targetHandle === "pose").map(target => target.targetNodeId),
    ...edges.filter(edge => edge.source === nodeId && edge.targetHandle === "pose").map(edge => edge.target),
  ]);
  const targets = nodes.filter(node => targetIds.has(node.id) && node.data.kind === "virtual-try-on");
  return targets.length > 0 && targets.every(node => isMultiImageTryOn(node.data));
}

export function multiImageReferenceError(roles: readonly string[]): string | undefined {
  if (roles.length > MULTI_IMAGE_TRY_ON_MAX_SOURCES) return `多图编辑最多连接 ${MULTI_IMAGE_TRY_ON_MAX_SOURCES} 张原始参考图`;
  for (const role of roles) {
    if (!(MULTI_IMAGE_TRY_ON_ROLES as readonly string[]).includes(role)) return `多图编辑不支持输入角色：${role || "未命名"}`;
  }
  for (const role of MULTI_IMAGE_TRY_ON_ROLES) {
    const count = roles.filter(value => value === role).length;
    if (["pose", "person", "scene", "outfit"].includes(role) && count !== 1) return `${MULTI_IMAGE_ROLE_LABELS[role]}必须且只能提供 1 张图片`;
    if (count > (role === "detail" ? 5 : 1)) return `${MULTI_IMAGE_ROLE_LABELS[role]}参考图过多`;
  }
  return undefined;
}

export interface MultiImageReferenceGroup<T> {
  number: number;
  role: string;
  members: T[];
}

/** Runtime history may repeat a provider index for several source tiles. */
export function readMultiImageReferenceManifest(value: unknown): Array<{ number: number; role: string; image: string }> | undefined {
  if (!Array.isArray(value) || value.length < 4 || value.length > MULTI_IMAGE_TRY_ON_MAX_SOURCES) return undefined;
  let previous = 0;
  const result: Array<{ number: number; role: string; image: string }> = [];
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== "object" || !Number.isInteger(entry.number)
      || typeof entry.role !== "string" || typeof entry.image !== "string") return undefined;
    if (index < 3) {
      if (entry.number !== index + 1 || entry.role !== ["pose", "person", "scene"][index]) return undefined;
    } else if (entry.number < 4 || (entry.number !== previous && entry.number !== previous + 1)) return undefined;
    previous = entry.number;
    result.push({ number: entry.number, role: entry.role, image: entry.image });
  }
  return result;
}

/** Shared by UI numbering and provider preparation. Never drop a source or mutate inputs. */
export function planMultiImageReferences<T extends { role: string }>(
  references: readonly T[], modelId: string,
): MultiImageReferenceGroup<T>[] {
  const rank = (role: string) => {
    const index = (MULTI_IMAGE_TRY_ON_ROLES as readonly string[]).indexOf(role);
    return index < 0 ? MULTI_IMAGE_TRY_ON_ROLES.length : index;
  };
  const ordered = [...references].sort((a, b) => rank(a.role) - rank(b.role));
  if (modelId !== "gemini-3-pro-image-preview" || ordered.length <= 6) {
    return ordered.map((reference, index) => ({ number: index + 1, role: reference.role, members: [reference] }));
  }
  let groups = ordered.map(ref => ({ role: ref.role, members: [ref] }));
  // Only merge while necessary. Preserve clothing/detail originals if grouping
  // accessories and footwear already meets the budget; never combine the first 3.
  const protectedRoles = ["pose", "person", "scene", "outfit", "detail", "shoes", "socks"];
  for (const [role, matches] of [
    ["accessories", (ref: T) => !protectedRoles.includes(ref.role)],
    ["footwear", (ref: T) => ["shoes", "socks"].includes(ref.role)],
    ["garments", (ref: T) => ["outfit", "detail"].includes(ref.role)],
  ] as const) {
    if (groups.length <= 6) break;
    const members = ordered.filter(matches);
    if (members.length < 2) continue;
    const first = groups.findIndex(group => matches(group.members[0]));
    groups = groups.filter(group => !matches(group.members[0]));
    groups.splice(first, 0, { role, members });
  }
  return groups.map((group, index) => ({ ...group, number: index + 1 }));
}

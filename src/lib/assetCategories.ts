import type { Asset } from "@/types/workflow";

export const ASSET_CATEGORIES = [
  ["upload", "用户上传"],
  ["generated", "生成结果"],
  ["print", "印花"],
  ["fabric", "布料"],
] as const satisfies ReadonlyArray<readonly [Asset["category"], string]>;

export type EditableAssetCategory = (typeof ASSET_CATEGORIES)[number][0];

export function isEditableAssetCategory(value: unknown): value is EditableAssetCategory {
  return ASSET_CATEGORIES.some(([category]) => category === value);
}

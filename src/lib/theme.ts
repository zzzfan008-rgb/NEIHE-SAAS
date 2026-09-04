/** Coin AI 工作台只保留经典暗金主题。 */
import { useSyncExternalStore } from "react";

export type ThemeId = "current";

export const THEMES = [
  { id: "current" as const, label: "经典暗金", swatch: "#9A7333", desc: "专注服装设计的暗金工作台" },
];

export function getTheme(): ThemeId {
  return "current";
}

export function applyTheme(_id: ThemeId = "current"): void {
  if (typeof document !== "undefined") document.documentElement.dataset.theme = "current";
}

export function getAppliedTheme(): ThemeId {
  return "current";
}

export function subscribeTheme(_listener: () => void): () => void {
  return () => undefined;
}

if (typeof window !== "undefined") applyTheme();

export function useTheme(): [ThemeId, (id: ThemeId) => void] {
  const theme = useSyncExternalStore(subscribeTheme, getAppliedTheme, getAppliedTheme);
  return [theme, applyTheme];
}

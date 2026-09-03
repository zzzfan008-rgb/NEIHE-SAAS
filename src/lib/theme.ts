/** 主题系统：三套主题，data-theme 属性 + CSS 覆盖，localStorage 持久化 */
import { useSyncExternalStore } from "react";

export type ThemeId = "current" | "white" | "eye";

export const THEMES: { id: ThemeId; label: string; swatch: string; desc: string }[] = [
  { id: "current", label: "经典暗金", swatch: "#9A7333", desc: "简白节点 + 暗金圆珠" },
  { id: "white", label: "简白", swatch: "#E98FA8", desc: "高级灰黑节点 + 粉红圆珠" },
  { id: "eye", label: "护眼绿", swatch: "#173B63", desc: "浅蓝节点 + 藏蓝圆珠" },
];

const STORAGE_KEY = "garment-canvas-theme";
type ThemeListener = () => void;
const themeListeners = new Set<ThemeListener>();
let appliedTheme: ThemeId = "current";

export function getTheme(): ThemeId {
  try {
    // URL 参数优先（便于预览/分享指定主题）
    const q = new URLSearchParams(window.location.search).get("theme");
    if (q === "current" || q === "white" || q === "eye") return q;
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "current" || v === "white" || v === "eye") return v;
    if (v === "black") return "white"; // 旧版「纯黑」迁移为「简白」
  } catch {
    // ignore
  }
  return "current";
}

export function applyTheme(id: ThemeId): void {
  const changed = appliedTheme !== id;
  appliedTheme = id;
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = id;
  }
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // ignore
    }
  }
  if (changed) for (const listener of themeListeners) listener();
}

export function getAppliedTheme(): ThemeId {
  return appliedTheme;
}

export function subscribeTheme(listener: ThemeListener): () => void {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

// 模块加载即应用（避免闪烁）
if (typeof window !== "undefined") {
  applyTheme(getTheme());
}

export function useTheme(): [ThemeId, (id: ThemeId) => void] {
  const theme = useSyncExternalStore(subscribeTheme, getAppliedTheme, getAppliedTheme);
  return [theme, applyTheme];
}

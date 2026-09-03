export type DesktopShortcutPlatform = "macos" | "windows";

export interface WorkbenchShortcutRow {
  label: string;
  shortcut: string;
}

export type CanvasZoomCommand = "in" | "out";

export const CANVAS_ZOOM_COMMAND_EVENT = "garment-canvas:canvas-zoom-command";

export function desktopShortcutPlatformFromValues(
  platform = "",
  userAgent = "",
  userAgentDataPlatform = "",
): DesktopShortcutPlatform {
  const candidate = `${userAgentDataPlatform} ${platform} ${userAgent}`;
  return /macintosh|macintel|mac os|macos/i.test(candidate) ? "macos" : "windows";
}

export function detectDesktopShortcutPlatform(
  navigatorValue: Navigator | undefined = typeof navigator === "undefined" ? undefined : navigator,
): DesktopShortcutPlatform {
  if (!navigatorValue) return "windows";
  const userAgentDataPlatform = (
    navigatorValue as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData?.platform;
  return desktopShortcutPlatformFromValues(
    navigatorValue.platform,
    navigatorValue.userAgent,
    userAgentDataPlatform,
  );
}

export function workbenchShortcutRows(
  platform: DesktopShortcutPlatform,
): WorkbenchShortcutRow[] {
  const mac = platform === "macos";
  const modifier = mac ? "⌘" : "Ctrl";
  return [
    { label: "移动画布", shortcut: "鼠标右键拖动" },
    { label: "放大", shortcut: `${modifier} +` },
    { label: "缩小", shortcut: `${modifier} −` },
    { label: "复制节点", shortcut: `${modifier} C` },
    { label: "粘贴节点", shortcut: `${modifier} V` },
    { label: "复制并粘贴", shortcut: `${modifier} D` },
    { label: "选择全部", shortcut: `${modifier} A` },
    { label: "多选节点", shortcut: `${modifier} + 左键` },
    { label: "删除", shortcut: mac ? "⌫" : "Delete" },
    { label: "撤销", shortcut: `${modifier} Z` },
    { label: "取消撤销", shortcut: mac ? "⇧⌘ Z" : "Ctrl Y" },
    { label: "保存", shortcut: `${modifier} S` },
    { label: "关闭浮层", shortcut: "Esc" },
  ];
}

export function requestCanvasZoom(command: CanvasZoomCommand): void {
  window.dispatchEvent(new CustomEvent<CanvasZoomCommand>(CANVAS_ZOOM_COMMAND_EVENT, {
    detail: command,
  }));
}

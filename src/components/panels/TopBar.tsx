import { useState } from "react";
import { ChevronDownIcon, CircleHelpIcon, KeyboardIcon, PaletteIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  retryTabSessionPersistence,
  selectActiveReadOnly,
  useFlowStore,
} from "@/store/flowStore";
import { THEMES, useTheme, type ThemeId } from "@/lib/theme";
import { OPEN_TUTORIAL_EVENT } from "@/tutorials/tutorialRuntime";
import {
  detectDesktopShortcutPlatform,
  workbenchShortcutRows,
  type WorkbenchShortcutRow,
} from "@/lib/keyboardShortcuts";
import { AccountMenu } from "./AccountMenu";

const SHORTCUTS_PANEL_ID = "workbench-shortcuts";

function themePreviewColors(theme: ThemeId) {
  if (theme === "white") {
    return { shell: "#f5f5f7", panel: "#ffffff", line: "#d3d3d8", accent: "#e98fa8" };
  }
  if (theme === "eye") {
    return { shell: "#dcebd0", panel: "#eef5e8", line: "#a4bb94", accent: "#173b63" };
  }
  return { shell: "#101010", panel: "#1b1b1b", line: "#3a3a3a", accent: "#c9a66b" };
}

function ThemeMiniature({ theme }: { theme: ThemeId }) {
  const colors = themePreviewColors(theme);
  return (
    <span
      aria-hidden="true"
      className="relative block h-10 w-16 shrink-0 overflow-hidden rounded-md border border-white/10"
      style={{ backgroundColor: colors.shell }}
    >
      <span className="absolute inset-x-0 top-0 h-2" style={{ backgroundColor: colors.panel }} />
      <span className="absolute bottom-1.5 left-1.5 top-3 w-2 rounded-sm" style={{ backgroundColor: colors.panel }} />
      <span className="absolute left-5 top-3 h-3 w-4 rounded-sm border" style={{ borderColor: colors.line }} />
      <span className="absolute left-10 top-4 h-px w-3" style={{ backgroundColor: colors.line }} />
      <span className="absolute bottom-1.5 right-1.5 h-3 w-4 rounded-sm border" style={{ borderColor: colors.accent }} />
      <span className="absolute left-[35px] top-[19px] size-1 rounded-full" style={{ backgroundColor: colors.accent }} />
    </span>
  );
}

function ThemeSwitcher() {
  const [theme, switchTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const current = THEMES.find((item) => item.id === theme) ?? THEMES[0];

  const selectTheme = (value: string) => {
    if (THEMES.some((item) => item.id === value)) {
      switchTheme(value as ThemeId);
      setOpen(false);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        type="button"
        aria-label={`切换主题，当前为${current.label}`}
        className="inline-flex h-8 min-w-32 items-center justify-between gap-2 rounded-md border border-[var(--gc-border)] bg-[var(--gc-panel)] px-3 text-[11px] font-medium text-[var(--gc-text)] outline-hidden transition-colors hover:border-[var(--gc-accent)] focus-visible:ring-2 focus-visible:ring-[var(--gc-accent)]/50"
      >
        <PaletteIcon aria-hidden="true" className="size-3.5 text-[var(--gc-accent)]" />
        <span>{current.label}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 text-[var(--gc-text-muted)]" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="center"
        sideOffset={8}
        className="w-64 border border-[var(--gc-border)] bg-[var(--gc-panel)] p-2 text-[var(--gc-text)] shadow-2xl shadow-black/60 ring-0"
      >
        <DropdownMenuRadioGroup value={theme} onValueChange={selectTheme} className="space-y-1">
          <DropdownMenuLabel className="px-2 pb-2 pt-1 text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--gc-text-muted)]">
            主题
          </DropdownMenuLabel>
          {THEMES.map((item) => (
            <DropdownMenuRadioItem
              key={item.id}
              value={item.id}
              className="gap-3 border border-transparent p-2 pr-8 text-left text-[var(--gc-text)] focus:border-[var(--gc-border)] focus:bg-[var(--gc-panel-hover)] data-checked:border-[var(--gc-accent)] data-checked:bg-[var(--gc-panel-hover)]"
            >
              <ThemeMiniature theme={item.id} />
              <span className="min-w-0 flex-1">
                <span className={`block text-[11px] font-medium ${theme === item.id ? "text-[var(--gc-accent)]" : "text-[var(--gc-text)]"}`}>
                  {item.label}
                </span>
                <span className="mt-0.5 block truncate text-[9px] text-[var(--gc-text-muted)]">{item.desc}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ShortcutRow({ label, shortcut }: WorkbenchShortcutRow) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3 rounded-md px-2 text-[11px] text-[var(--gc-text)] hover:bg-[var(--gc-panel-hover)]">
      <span>{label}</span>
      <DropdownMenuShortcut className="shrink-0 text-[10px] tracking-normal text-[var(--gc-text-muted)]">
        {shortcut}
      </DropdownMenuShortcut>
    </div>
  );
}

function ShortcutMenu() {
  const platform = detectDesktopShortcutPlatform();
  const shortcuts = workbenchShortcutRows(platform);
  const canvasShortcuts = shortcuts.slice(0, -2);
  const projectShortcuts = shortcuts.slice(-2);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="查看快捷键"
            aria-controls={SHORTCUTS_PANEL_ID}
            title="快捷键"
            className="border-[var(--gc-border)] bg-[var(--gc-panel)] text-[var(--gc-text-muted)] hover:border-[var(--gc-accent)] hover:text-[var(--gc-text)]"
          />
        )}
      >
        <KeyboardIcon aria-hidden="true" className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        id={SHORTCUTS_PANEL_ID}
        aria-label="快捷键说明"
        align="center"
        sideOffset={8}
        className="w-56 min-w-56 border border-[var(--gc-border)] bg-[var(--gc-panel)] p-1.5 text-[var(--gc-text)] shadow-2xl shadow-black/60 ring-0"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-2 pb-1.5 pt-1 text-[11px] font-semibold text-[var(--gc-accent)]">
            {platform === "macos" ? "macOS" : "Windows"}
          </DropdownMenuLabel>
          {canvasShortcuts.map((shortcut) => (
            <ShortcutRow key={shortcut.label} {...shortcut} />
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator className="mx-1 bg-[var(--gc-border)]" />
        <DropdownMenuGroup>
          {projectShortcuts.map((shortcut) => (
            <ShortcutRow key={shortcut.label} {...shortcut} />
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TopBar() {
  const readOnly = useFlowStore(selectActiveReadOnly);
  const tabSessionPersistenceError = useFlowStore((state) => state.tabSessionPersistenceError);

  return (
    <header className="gc-panel relative z-40 grid h-12 min-w-[1024px] shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-[var(--gc-border)] bg-[var(--gc-panel)] px-4">
      <div className="flex min-w-0 items-center gap-3 justify-self-start">
        <span className="whitespace-nowrap text-sm font-semibold tracking-[0.08em] text-[var(--gc-accent)]">Coin AI - Canvas</span>
        <span aria-hidden="true" className="h-5 w-px bg-[var(--gc-border)]" />
        <AccountMenu />
      </div>

      <div className="relative flex items-center justify-center">
        <ThemeSwitcher />
        <div className="absolute left-full ml-2">
          <ShortcutMenu />
        </div>
      </div>

      <div className="flex min-w-0 items-center justify-end gap-2 justify-self-end">
        {tabSessionPersistenceError && (
          <Button
            type="button"
            variant="destructive"
            size="xs"
            onClick={retryTabSessionPersistence}
            title={tabSessionPersistenceError}
          >
            本地恢复失败 · 重试
          </Button>
        )}
        {readOnly && (
          <span className="rounded-md border border-blue-400/40 px-2 py-1 text-[10px] text-blue-400">管理员只读</span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="打开使用教程"
          title="使用教程"
          onClick={() => window.dispatchEvent(new Event(OPEN_TUTORIAL_EVENT))}
          className="text-[var(--gc-text-muted)] hover:text-[var(--gc-text)]"
        >
          <CircleHelpIcon aria-hidden="true" className="size-4" />
        </Button>
      </div>
    </header>
  );
}

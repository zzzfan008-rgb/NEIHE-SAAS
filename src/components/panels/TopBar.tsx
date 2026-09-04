import { useEffect, useRef, useState } from "react";
import { CircleHelpIcon, KeyboardIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  retryTabSessionPersistence,
  selectActiveReadOnly,
  useFlowStore,
} from "@/store/flowStore";
import { OPEN_TUTORIAL_EVENT } from "@/tutorials/tutorialRuntime";
import {
  detectDesktopShortcutPlatform,
  workbenchShortcutRows,
  type WorkbenchShortcutRow,
} from "@/lib/keyboardShortcuts";
import { AccountMenu } from "./AccountMenu";

const SHORTCUTS_PANEL_ID = "workbench-shortcuts";

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

/** 悬停展开、移开自动收起；键盘焦点仍可完整访问。 */
function ShortcutMenu() {
  const platform = detectDesktopShortcutPlatform();
  const shortcuts = workbenchShortcutRows(platform);
  const canvasShortcuts = shortcuts.slice(0, -2);
  const projectShortcuts = shortcuts.slice(-2);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openMenu = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setOpen(true);
  };
  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 100);
  };
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={(
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="查看快捷键"
            title="快捷键"
            onPointerEnter={openMenu}
            onPointerLeave={scheduleClose}
            onFocus={openMenu}
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
        onPointerEnter={openMenu}
        onPointerLeave={scheduleClose}
        className="w-56 min-w-56 border border-[var(--gc-border)] bg-[var(--gc-panel)] p-1.5 text-[var(--gc-text)] shadow-2xl shadow-black/60 ring-0"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-2 pb-1.5 pt-1 text-[11px] font-semibold text-[var(--gc-accent)]">
            {platform === "macos" ? "macOS" : "Windows"}
          </DropdownMenuLabel>
          {canvasShortcuts.map((shortcut) => <ShortcutRow key={shortcut.label} {...shortcut} />)}
        </DropdownMenuGroup>
        <DropdownMenuSeparator className="mx-1 bg-[var(--gc-border)]" />
        <DropdownMenuGroup>
          {projectShortcuts.map((shortcut) => <ShortcutRow key={shortcut.label} {...shortcut} />)}
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

      <div className="relative flex items-center justify-center"><ShortcutMenu /></div>

      <div className="flex min-w-0 items-center justify-end gap-2 justify-self-end">
        {tabSessionPersistenceError && (
          <Button type="button" variant="destructive" size="xs" onClick={retryTabSessionPersistence} title={tabSessionPersistenceError}>
            本地恢复失败 · 重试
          </Button>
        )}
        {readOnly && <span className="rounded-md border border-blue-400/40 px-2 py-1 text-[10px] text-blue-400">管理员只读</span>}
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

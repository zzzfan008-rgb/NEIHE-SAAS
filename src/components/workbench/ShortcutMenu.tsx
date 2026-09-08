import { KeyboardIcon } from "lucide-react";
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
  detectDesktopShortcutPlatform,
  workbenchShortcutRows,
  type WorkbenchShortcutRow,
} from "@/lib/keyboardShortcuts";
import { cn } from "@/lib/utils";

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

export function ShortcutMenu({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const platform = detectDesktopShortcutPlatform();
  const shortcuts = workbenchShortcutRows(platform);
  const canvasShortcuts = shortcuts.slice(0, -2);
  const projectShortcuts = shortcuts.slice(-2);

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen, eventDetails) => {
        const isMousePress = eventDetails.reason === "trigger-press"
          && eventDetails.event.detail > 0;
        if (!isMousePress) onOpenChange(nextOpen);
      }}
    >
      <DropdownMenuTrigger
        openOnHover
        delay={0}
        closeDelay={100}
        render={(
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            aria-label="查看快捷键"
            aria-controls={SHORTCUTS_PANEL_ID}
            aria-expanded={open}
            aria-haspopup="menu"
            className={cn(
              "text-[var(--gc-text-muted)] hover:bg-[var(--gc-panel-hover)] hover:text-[var(--gc-text)]",
              open && "bg-[var(--gc-panel-hover)] text-[var(--gc-accent)]",
            )}
          />
        )}
      >
        <KeyboardIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        id={SHORTCUTS_PANEL_ID}
        aria-label="快捷键说明"
        side="right"
        align="start"
        sideOffset={8}
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

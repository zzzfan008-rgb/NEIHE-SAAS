import { CircleHelpIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  retryTabSessionPersistence,
  selectActiveReadOnly,
  useFlowStore,
} from "@/store/flowStore";
import { OPEN_TUTORIAL_EVENT } from "@/tutorials/tutorialRuntime";
import { AccountMenu } from "./AccountMenu";

export function TopBar() {
  const readOnly = useFlowStore(selectActiveReadOnly);
  const tabSessionPersistenceError = useFlowStore((state) => state.tabSessionPersistenceError);

  return (
    <header className="gc-panel relative z-40 flex h-12 min-w-[1024px] shrink-0 items-center justify-between border-b border-[var(--gc-border)] bg-[var(--gc-panel)] px-4">
      <div className="flex min-w-0 items-center gap-3 justify-self-start">
        <span className="whitespace-nowrap text-sm font-semibold tracking-[0.08em] text-[var(--gc-accent)]">Coin AI - Canvas</span>
        <span aria-hidden="true" className="h-5 w-px bg-[var(--gc-border)]" />
        <AccountMenu />
      </div>

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

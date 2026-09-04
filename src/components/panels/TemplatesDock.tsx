import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Edge } from "@xyflow/react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { selectActiveDocument, useFlowStore, type FlowNode } from "@/store/flowStore";
import type { WorkflowTemplate } from "@/types/workflow";
import { WorkflowMini } from "./WorkflowMini";
import { thumbnailImageUrl } from "@/lib/images";
import {
  createDocumentSnapshot,
  documentSnapshotToPersistedWorkflow,
} from "@/lib/documentSnapshot";
import { launchTemplateInNewTab } from "@/lib/templateLaunch";

const TEMPLATES_PANEL_ID = "templates-dock-panel";

export function createTemplateRequestPayload(input: {
  name: string;
  description: string;
  projectName: string;
  nodes: FlowNode[];
  edges: Edge[];
}) {
  const document = createDocumentSnapshot(input);
  return {
    name: input.name,
    description: input.description,
    flow: documentSnapshotToPersistedWorkflow(document),
  };
}

/**
 * 画布顶部中央的模板悬浮入口：
 * 默认只显示一枚「模板库」胶囊按钮；点击后向下展开完整浮窗，
 * 内部是卡片式模板（微缩图 + 名称 + 文字介绍）。
 */
export function TemplatesDock() {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);

  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/templates");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTemplates((await res.json()) as WorkflowTemplate[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // 打开时拉取最新模板
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // 点击浮窗外部 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (saving) return;
      if (!rootRef.current?.contains(e.target as globalThis.Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || saving) return;
      const panel = document.getElementById(TEMPLATES_PANEL_ID);
      const shouldRestoreFocus = document.activeElement === triggerRef.current ||
        panel?.contains(document.activeElement) === true;
      if (shouldRestoreFocus) {
        e.preventDefault();
        closeAndRestoreFocus();
      } else {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [closeAndRestoreFocus, open, saving]);

  const applyTemplate = (tpl: WorkflowTemplate) => {
    launchTemplateInNewTab(tpl);
    setOpen(false);
  };

  const removeTemplate = async (tpl: WorkflowTemplate) => {
    try {
      const res = await fetch(`/api/templates/${tpl.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTemplates((list) => list.filter((t) => t.id !== tpl.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-x-0 top-3 z-30 px-2">
      {/* 悬浮入口胶囊（独立居中，不随浮窗开合移动） */}
      <div className="flex justify-center">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-controls={TEMPLATES_PANEL_ID}
          aria-expanded={open}
          className={`pointer-events-auto flex items-center gap-1.5 rounded-full border px-4 py-1.5 text-[11px] font-medium shadow-lg shadow-black/40 backdrop-blur-sm transition-colors ${
            open
              ? "border-gold bg-[#1a1a1a] text-gold"
              : "border-[#333] bg-[#141414]/90 text-neutral-300 hover:border-gold/60 hover:text-gold"
          }`}
        >
          <span className="text-[13px] leading-none">▦</span>
          模板库
          <span className="text-[9px] text-neutral-500">{open ? "▲" : "▼"}</span>
        </button>
      </div>

      {/* 点击展开的完整浮窗（相对画布独立居中，不影响按钮位置） */}
      {open && (
        <div
          id={TEMPLATES_PANEL_ID}
          role="region"
          aria-label="工作流模板"
          className="gc-panel pointer-events-auto mx-auto mt-2 w-full max-w-[660px] rounded-xl border border-[#333] bg-[#141414] shadow-2xl shadow-black/60"
        >
          <div className="flex items-center justify-between border-b border-[#262626] px-4 py-2.5">
            <span className="text-xs font-medium text-neutral-200">工作流模板</span>
            <div className="flex items-center gap-2">
              <button
                ref={saveButtonRef}
                type="button"
                onClick={() => setSaving(true)}
                className="rounded-md border border-gold/50 bg-gold/10 px-2.5 py-1 text-[10px] font-medium text-gold transition-colors hover:bg-gold/20"
              >
                当前画布存为模板
              </button>
              <button
                type="button"
                onClick={closeAndRestoreFocus}
                className="rounded-md border border-[#333] px-2 py-1 text-[10px] text-neutral-400 hover:text-neutral-200"
              >
                关闭 Esc
              </button>
            </div>
          </div>

          <div data-slot="templates-scroll-area" className="max-h-[60vh] overflow-y-auto p-4">
            {error ? (
              <div className="py-6 text-center">
                <p className="text-[11px] text-neutral-600">模板服务暂不可用（{error}）</p>
                <button
                  type="button"
                  onClick={() => void load()}
                  className="mt-2 rounded-sm border border-[#262626] px-2 py-1 text-[10px] text-neutral-400 hover:border-gold/50 hover:text-gold"
                >
                  重试
                </button>
              </div>
            ) : templates.length === 0 ? (
              <p className="py-6 text-center text-[11px] text-neutral-600">暂无模板</p>
            ) : (
              <div
                data-slot="templates-grid"
                className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3"
              >
                {templates.map((tpl) => (
                  <div
                    key={tpl.id}
                    className="group flex flex-col overflow-hidden rounded-lg border border-[#262626] bg-[#1a1a1a] transition-colors hover:border-gold/50"
                  >
                    <button
                      type="button"
                      title="从模板新建"
                      onClick={() => applyTemplate(tpl)}
                      className="block w-full"
                    >
                      {tpl.thumbnail ? (
                        <img
                          src={thumbnailImageUrl(tpl.thumbnail)}
                          loading="lazy"
                          decoding="async"
                          alt={tpl.name}
                          className="aspect-video w-full object-cover"
                        />
                      ) : (
                        <WorkflowMini flow={tpl.flow} className="aspect-video w-full" />
                      )}
                    </button>
                    <div className="flex flex-1 flex-col gap-1 p-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[11px] font-medium text-neutral-200">
                          {tpl.name}
                        </span>
                        {tpl.builtIn && (
                          <span className="shrink-0 rounded-sm border border-gold/40 px-1 py-px text-[8px] text-gold">
                            内置
                          </span>
                        )}
                      </div>
                      {tpl.description && (
                        <p className="line-clamp-2 text-[10px] leading-relaxed text-neutral-500">
                          {tpl.description}
                        </p>
                      )}
                      <div className="mt-auto flex gap-1.5 pt-1.5">
                        <button
                          type="button"
                          onClick={() => applyTemplate(tpl)}
                          className="flex-1 rounded-sm border border-[#262626] px-1.5 py-1 text-[10px] text-neutral-300 transition-colors hover:border-gold/60 hover:text-gold"
                        >
                          从模板新建
                        </button>
                        {!tpl.builtIn && (
                          <button
                            type="button"
                            onClick={() => void removeTemplate(tpl)}
                            className="rounded-sm border border-[#262626] px-1.5 py-1 text-[10px] text-neutral-500 transition-colors hover:border-red-900 hover:text-red-400"
                          >
                            删除
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <SaveTemplateForm
        open={saving}
        onOpenChange={setSaving}
        onSaved={load}
        finalFocusRef={saveButtonRef}
      />
    </div>
  );
}

export function SaveTemplateForm({
  open,
  onOpenChange,
  onSaved,
  finalFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  finalFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const submissionVersionRef = useRef(0);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) submissionVersionRef.current += 1;
    onOpenChange(nextOpen);
  }, [onOpenChange]);

  useEffect(() => {
    if (open) return;
    submissionVersionRef.current += 1;
    setName("");
    setDescription("");
    setSubmitting(false);
    setError(null);
  }, [open]);

  const submit = async () => {
    if (!name.trim()) {
      setError("请填写模板名称");
      return;
    }
    setSubmitting(true);
    setError(null);
    const submissionVersion = ++submissionVersionRef.current;
    try {
      const { projectName, nodes, edges } = selectActiveDocument(useFlowStore.getState());
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createTemplateRequestPayload({
          name: name.trim(),
          description: description.trim(),
          projectName,
          nodes,
          edges,
        })),
      });
      if (submissionVersion !== submissionVersionRef.current) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onSaved();
      handleOpenChange(false);
    } catch (err) {
      if (submissionVersion !== submissionVersionRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (submissionVersion === submissionVersionRef.current) setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        initialFocus={initialFocusRef}
        finalFocus={finalFocusRef}
        showCloseButton={false}
        overlayClassName="z-[70] bg-black/75 backdrop-blur-sm"
        className="z-[71] w-80 max-w-[calc(100vw-4rem)] gap-3 border border-[var(--gc-border)] bg-[var(--gc-panel)] p-4 text-[var(--gc-text)] shadow-2xl ring-0"
      >
        <div>
          <DialogTitle className="text-sm font-medium text-[var(--gc-text)]">存为模板</DialogTitle>
          <DialogDescription className="mt-1 text-[10px] text-[var(--gc-text-muted)]">
            保存当前节点、连线和参数配置，供之后快速复用。
          </DialogDescription>
        </div>
        <label className="block space-y-1">
          <span className="text-[10px] text-[var(--gc-text-muted)]">名称</span>
          <input
            ref={initialFocusRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：草图→改款→放大 标准流"
            className="w-full rounded-md border border-[var(--gc-border)] bg-[var(--gc-control)] px-2 py-1.5 text-xs text-[var(--gc-text)] placeholder:text-[var(--gc-text-muted)] focus:border-[var(--gc-accent)] focus:outline-hidden"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[10px] text-[var(--gc-text-muted)]">描述</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="这个模板适用于什么场景"
            className="w-full resize-none rounded-md border border-[var(--gc-border)] bg-[var(--gc-control)] px-2 py-1.5 text-xs text-[var(--gc-text)] placeholder:text-[var(--gc-text-muted)] focus:border-[var(--gc-accent)] focus:outline-hidden"
          />
        </label>
        {error && <p role="alert" className="text-[10px] text-red-400">{error}</p>}
        <DialogFooter className="border-[var(--gc-border)] bg-[var(--gc-control)]">
          <DialogClose render={<Button type="button" variant="outline" />}>
            取消
          </DialogClose>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            className="bg-[var(--gc-accent)] text-[var(--gc-primary-foreground)] hover:opacity-90"
          >
            {submitting ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

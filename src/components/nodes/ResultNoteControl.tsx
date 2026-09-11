import { useId, useState } from "react";
import { MessageSquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useFlowStore, type DocumentTarget } from "@/store/flowStore";

/** Draft and dialog state stay local; only explicit confirmation edits the document. */
export function ResultNoteControl({ nodeId, target }: { nodeId: string; target: DocumentTarget }) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readOnly = useFlowStore((s) => s.tabs.find((t) => t.id === target.tabId)?.readOnly ?? true);
  const savedNote = useFlowStore((s) => {
    const node = s.tabs.find((t) => t.id === target.tabId)?.nodes.find((n) => n.id === nodeId);
    return node?.data.kind === "result" ? node.data.note ?? "" : "";
  });

  const save = async () => {
    const state = useFlowStore.getState();
    const tab = state.tabs.find((t) => t.id === target.tabId && t.projectId === target.projectId && t.documentEpoch === target.documentEpoch);
    if (!tab || tab.readOnly || !tab.nodes.some((n) => n.id === nodeId && n.data.kind === "result")) return;
    setBusy(true);
    setError(null);
    try {
      if (draft !== savedNote) state.updateNodeDataInTab(target, nodeId, { note: draft });
      if (await state.saveProjectInTab(target)) setOpen(false);
      else setError("备注已保留在当前项目，但项目保存失败。请重试保存。");
    } catch {
      setError("备注已保留在当前项目，但项目保存失败。请重试保存。");
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open={open} onOpenChange={(next) => {
    if (busy) return;
    if (next) { setDraft(savedNote); setError(null); }
    setOpen(next);
  }}>
    <DialogTrigger render={<Button variant="outline" className="gc-result-action" title={savedNote ? "编辑已保存的备注" : "添加备注"} />}>
      <MessageSquareIcon aria-hidden="true" />备注
    </DialogTrigger>
    <DialogContent showCloseButton={false} className="nodrag nopan nowheel space-y-4 motion-reduce:animate-none" overlayClassName="motion-reduce:animate-none" onKeyDown={(event) => event.stopPropagation()}>
      <DialogTitle>结果备注</DialogTitle>
      <DialogDescription>{readOnly ? "当前项目为只读，可查看已保存的备注。" : "记录这一版结果的说明，确定后随项目保存。"}</DialogDescription>
      <label htmlFor={inputId} className="sr-only">备注内容</label>
      <Textarea id={inputId} value={draft} onChange={(event) => setDraft(event.target.value)} readOnly={readOnly} disabled={busy} rows={5} className="max-h-72 min-h-32 resize-y" placeholder="输入备注…" />
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>{readOnly ? "关闭" : "取消"}</Button>
        {!readOnly && <Button disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "确定保存"}</Button>}
      </div>
    </DialogContent>
  </Dialog>;
}

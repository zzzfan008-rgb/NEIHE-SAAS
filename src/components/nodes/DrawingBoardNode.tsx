import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { nanoid } from "nanoid";
import { useAuth } from "@/auth/AuthContext";
import { createEmptyDrawingDocument, type DrawingDocument } from "@/components/drawing/drawingModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  loadDrawingBoardVersion,
  saveDrawingBoardVersion,
  uploadDrawingPreview,
} from "@/lib/drawingBoardClient";
import { browserDrawingDraftStore, type DrawingDraftTarget } from "@/lib/drawingDraftStore";
import { documentTargetMatches } from "@/lib/canvasCreation";
import {
  selectActiveDocumentTarget,
  useFlowStore,
} from "@/store/flowStore";
import type { DrawingBoardNodeData } from "@/types/workflow";
import { NodeFrame } from "./NodeFrame";

const DrawingEditor = lazy(async () => {
  const module = await import("@/components/drawing/DrawingEditor");
  return { default: module.DrawingEditor };
});

interface EditorSession {
  target: ReturnType<typeof selectActiveDocumentTarget>;
  draftTarget: DrawingDraftTarget;
  initialDocument: DrawingDocument;
}

export function DrawingBoardNode({ id, data, selected }: NodeProps<Node<DrawingBoardNodeData>>) {
  const { user } = useAuth();
  const saveProject = useFlowStore((state) => state.saveProject);
  const commitDrawingBoard = useFlowStore((state) => state.commitDrawingBoard);
  const exportDrawingBoardImageNode = useFlowStore((state) => state.exportDrawingBoardImageNode);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [session, setSession] = useState<EditorSession>();
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRevision = useRef(0);
  const requestId = useRef<string | undefined>(undefined);

  const clearDraftTimer = () => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = null;
  };
  useEffect(() => () => clearDraftTimer(), []);

  const beginEditing = async () => {
    if (!user) return;
    clearDraftTimer();
    setOpen(true);
    setLoading(true);
    setError(undefined);
    requestId.current = undefined;
    try {
      const target = selectActiveDocumentTarget(useFlowStore.getState());
      let document = createEmptyDrawingDocument(data.width, data.height, data.background);
      let baseContentHash: string | null = null;
      if (data.contentRef) {
        const loaded = await loadDrawingBoardVersion(data.contentRef);
        document = loaded.document;
        baseContentHash = loaded.sha256;
      }
      const draftTarget: DrawingDraftTarget = {
        ownerId: user.id,
        ...target,
        nodeId: id,
        baseContentRef: data.contentRef ?? null,
        baseContentHash,
      };
      const recovery = await browserDrawingDraftStore().findRecovery(draftTarget);
      if (recovery?.status === "matching") {
        if (window.confirm("检测到这个画板的未保存恢复稿，是否继续编辑恢复稿？")) {
          document = recovery.draft.document;
          draftRevision.current = recovery.draft.draftRevision;
        }
      } else if (recovery?.status === "base-mismatch") {
        setError("检测到旧版本恢复稿，但画板基准已变化。为避免覆盖新内容，未自动恢复。");
      }
      setSession({ target, draftTarget, initialDocument: document });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "画板打开失败");
    } finally {
      setLoading(false);
    }
  };

  const scheduleDraft = useCallback((document: DrawingDocument) => {
    if (!session) return;
    clearDraftTimer();
    draftTimer.current = setTimeout(() => {
      draftRevision.current += 1;
      void browserDrawingDraftStore().save({
        ...session.draftTarget,
        draftRevision: draftRevision.current,
        document,
        updatedAt: new Date().toISOString(),
      }).catch((failure) => setError(failure instanceof Error ? failure.message : "恢复稿保存失败"));
    }, 500);
  }, [session]);

  const persist = async (document: DrawingDocument, previewDataUrl: string) => {
    if (!session) return;
    setSaving(true);
    setError(undefined);
    clearDraftTimer();
    try {
      const stateBefore = useFlowStore.getState();
      if (!documentTargetMatches(session.target, selectActiveDocumentTarget(stateBefore))) {
        throw new Error("项目页签已变化，请回到原项目重新打开画板");
      }
      if (!await saveProject()) throw new Error("请先成功保存当前项目快照，再保存画板");
      requestId.current ??= `drawing-save-${nanoid(18)}`;
      const version = await saveDrawingBoardVersion({
        clientRequestId: requestId.current,
        projectId: session.target.projectId,
        nodeId: id,
        baseContentRef: session.draftTarget.baseContentRef ?? undefined,
        document,
      });
      const preview = await uploadDrawingPreview(previewDataUrl);
      if (!commitDrawingBoard(session.target, id, {
        contentRef: version.contentRef,
        previewImageRef: preview.url,
      })) throw new Error("画板所属项目已变化，未写入当前画布");
      if (!await saveProject()) throw new Error("画板版本已创建，但项目保存失败；恢复稿已保留，可直接重试");
      await browserDrawingDraftStore().discard(session.draftTarget);
      requestId.current = undefined;
      setOpen(false);
      setSession(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "画板保存失败");
      draftRevision.current += 1;
      await browserDrawingDraftStore().save({
        ...session.draftTarget,
        draftRevision: draftRevision.current,
        document,
        updatedAt: new Date().toISOString(),
      }).catch(() => undefined);
    } finally {
      setSaving(false);
    }
  };

  const exportPreview = async () => {
    const target = selectActiveDocumentTarget(useFlowStore.getState());
    const created = exportDrawingBoardImageNode(target, id);
    if (created && !await saveProject()) setError("已在本地创建图片节点，但项目保存失败，请重试保存项目");
  };

  return (
    <>
      <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected}>
        {data.previewImageRef ? (
          <img src={data.previewImageRef} alt="画板已保存预览" className="h-40 w-full rounded-lg border border-[var(--gc-node-border)] object-contain" />
        ) : (
          <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-[var(--gc-node-border)] text-[10px] text-[var(--gc-node-muted)]">
            尚未保存，不可连接或运行
          </div>
        )}
        <div className="grid grid-cols-2 gap-1">
          <Button type="button" size="sm" onClick={() => void beginEditing()}>{data.contentRef ? "继续编辑" : "打开画板"}</Button>
          <Button type="button" size="sm" variant="outline" disabled={!data.previewImageRef || !data.contentRef} onClick={() => void exportPreview()}>导出为图片节点</Button>
        </div>
        {error && !open && <p role="alert" className="text-[10px] text-red-500">{error}</p>}
      </NodeFrame>
      <Handle type="source" position={Position.Right} id="image" title={data.previewImageRef ? "已提交画板预览" : "请先保存画板"} />

      <Dialog open={open} onOpenChange={(next) => { if (!saving) setOpen(next); }}>
        <DialogContent className="flex h-[min(92vh,880px)] max-w-[min(96vw,1180px)] flex-col sm:max-w-[min(96vw,1180px)]" showCloseButton={!saving}>
          <DialogHeader>
            <DialogTitle>{data.label}</DialogTitle>
            <DialogDescription>浏览器每 500ms 保存恢复稿；只有点击“保存画板”后，预览才可连接到生成节点。</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto">
            {loading ? <p className="p-6 text-sm text-[var(--gc-text-muted)]">正在载入画板…</p> : session ? (
              <Suspense fallback={<p className="p-6 text-sm text-[var(--gc-text-muted)]">正在载入绘画工具…</p>}>
                <DrawingEditor
                  key={`${session.target.documentEpoch}:${session.draftTarget.baseContentRef ?? "new"}`}
                  initialDocument={session.initialDocument}
                  saving={saving}
                  error={error}
                  onDocumentChange={scheduleDraft}
                  onSave={persist}
                  onCancel={() => { if (!saving) setOpen(false); }}
                />
              </Suspense>
            ) : error ? <p role="alert" className="p-6 text-sm text-red-500">{error}</p> : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

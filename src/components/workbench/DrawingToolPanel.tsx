import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import {
  createEmptyDrawingDocument,
  type DrawingDocument,
} from "@/components/drawing/drawingModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { documentTargetMatches } from "@/lib/canvasCreation";
import {
  createDrawingBoard,
  drawingBoardCreationOutcomeIsUnknown,
  uploadDrawingPreview,
} from "@/lib/drawingBoardClient";
import {
  OPEN_DRAWING_TOOL_EVENT,
  type OpenDrawingToolRequest,
} from "@/lib/drawingTool";
import {
  acquireDrawingCreationLock,
  commitCreatedDrawingBoard,
  selectActiveDocumentTarget,
  useFlowStore,
} from "@/store/flowStore";

const DrawingEditor = lazy(async () => {
  const module = await import("@/components/drawing/DrawingEditor");
  return { default: module.DrawingEditor };
});

interface DrawingToolSession extends OpenDrawingToolRequest {
  nodeId: string;
  initialDocument: DrawingDocument;
}

export function DrawingToolPanel() {
  const saveProjectInTab = useFlowStore((state) => state.saveProjectInTab);
  const [session, setSession] = useState<DrawingToolSession>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const requestId = useRef<string | undefined>(undefined);
  const releaseCreationLock = useRef<(() => void) | undefined>(undefined);
  const pendingPreview = useRef<
    | {
        dataUrl: string;
        url: string;
        documentJson: string;
        baselineRevision: number;
      }
    | undefined
  >(undefined);
  const [creationMayExist, setCreationMayExist] = useState(false);

  useEffect(() => {
    const listener = (event: Event) => {
      const request = (event as CustomEvent<OpenDrawingToolRequest>).detail;
      if (!request?.target || !request.position || saving) return;
      const current = selectActiveDocumentTarget(useFlowStore.getState());
      if (!documentTargetMatches(request.target, current)) return;
      setError(undefined);
      requestId.current = undefined;
      pendingPreview.current = undefined;
      setCreationMayExist(false);
      setSession({
        ...request,
        nodeId: `drawing-${nanoid(10)}`,
        initialDocument: createEmptyDrawingDocument(),
      });
    };
    window.addEventListener(OPEN_DRAWING_TOOL_EVENT, listener);
    return () => window.removeEventListener(OPEN_DRAWING_TOOL_EVENT, listener);
  }, [saving]);

  const close = () => {
    if (saving) return;
    if (creationMayExist) {
      setError(
        "创建请求的结果尚未确认，请再次点击保存以安全确认，当前不能直接取消",
      );
      return;
    }
    requestId.current = undefined;
    pendingPreview.current = undefined;
    setError(undefined);
    setSession(undefined);
  };

  const persist = async (document: DrawingDocument, previewDataUrl: string) => {
    if (!session) return;
    setSaving(true);
    setError(undefined);
    try {
      const state = useFlowStore.getState();
      const targetExists = state.tabs.some(
        (tab) =>
          tab.id === session.target.tabId &&
          tab.projectId === session.target.projectId &&
          tab.documentEpoch === session.target.documentEpoch,
      );
      if (!targetExists) throw new Error("项目页签已关闭或变化，不能创建画板");

      const documentJson = JSON.stringify(document);
      let preview = pendingPreview.current;
      if (creationMayExist) {
        if (
          !preview ||
          preview.dataUrl !== previewDataUrl ||
          preview.documentJson !== documentJson
        ) {
          throw new Error(
            "上次创建结果尚未确认；请撤销本次错误后的画板编辑，再次保存以安全确认",
          );
        }
      } else {
        if (!(await saveProjectInTab(session.target))) {
          throw new Error("请先成功保存当前项目快照，再创建画板");
        }
        const baselineTab = useFlowStore
          .getState()
          .tabs.find(
            (tab) =>
              tab.id === session.target.tabId &&
              tab.projectId === session.target.projectId &&
              tab.documentEpoch === session.target.documentEpoch,
          );
        if (!baselineTab) throw new Error("项目页签已关闭或变化，不能创建画板");
        releaseCreationLock.current = acquireDrawingCreationLock(session.target);
        if (!releaseCreationLock.current) throw new Error("项目保存仍在进行，请稍后重试创建画板");
        const uploaded = await uploadDrawingPreview(previewDataUrl);
        preview = {
          dataUrl: previewDataUrl,
          url: uploaded.url,
          documentJson,
          baselineRevision: baselineTab.revision,
        };
        pendingPreview.current = preview;
        requestId.current = `drawing-create-${nanoid(18)}`;
      }

      if (!preview || !requestId.current)
        throw new Error("画板创建请求尚未准备完成");
      const version = await createDrawingBoard({
        clientRequestId: requestId.current,
        projectId: session.target.projectId,
        nodeId: session.nodeId,
        position: session.position,
        previewImageRef: preview.url,
        document,
      });
      setCreationMayExist(false);
      if (
        !commitCreatedDrawingBoard(session.target, {
          nodeId: session.nodeId,
          baselineRevision: preview.baselineRevision,
          position: session.position,
          document,
          contentRef: version.contentRef,
          previewImageRef: preview.url,
        })
      ) {
        const latest = useFlowStore
          .getState()
          .tabs.find((tab) => tab.id === session.target.tabId);
        if (
          latest &&
          latest.projectId === session.target.projectId &&
          latest.documentEpoch === session.target.documentEpoch
        ) {
          throw new Error(
            "画板已在服务端创建，但本地文档无法接收该节点，请重新打开项目",
          );
        }
      }
      releaseCreationLock.current?.();
      releaseCreationLock.current = undefined;
      requestId.current = undefined;
      pendingPreview.current = undefined;
      setSession(undefined);
    } catch (failure) {
      const requestCouldHaveCommitted =
        drawingBoardCreationOutcomeIsUnknown(failure) &&
        Boolean(requestId.current && pendingPreview.current);
      setCreationMayExist(requestCouldHaveCommitted);
      if (!requestCouldHaveCommitted) {
        releaseCreationLock.current?.();
        releaseCreationLock.current = undefined;
        requestId.current = undefined;
        pendingPreview.current = undefined;
      }
      setError(failure instanceof Error ? failure.message : "画板创建失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={Boolean(session)}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="flex h-[min(92vh,880px)] max-w-[min(96vw,1180px)] flex-col sm:max-w-[min(96vw,1180px)]"
        showCloseButton={!saving}
      >
        <DialogHeader>
          <DialogTitle>绘画板</DialogTitle>
          <DialogDescription>
            取消不会创建节点；只有画板与预览均保存成功后，节点才会出现在当前视口。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto">
          {session && (
            <Suspense
              fallback={
                <p className="p-6 text-sm text-[var(--gc-text-muted)]">
                  正在载入绘画工具…
                </p>
              }
            >
              <DrawingEditor
                key={session.nodeId}
                initialDocument={session.initialDocument}
                saving={saving}
                error={error}
                onDocumentChange={() => undefined}
                onSave={persist}
                onCancel={close}
              />
            </Suspense>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

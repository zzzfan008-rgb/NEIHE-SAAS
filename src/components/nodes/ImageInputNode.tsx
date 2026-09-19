import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  NodeResizeControl,
  Position,
  type NodeChange,
  type NodeProps,
  type Node,
  type ResizeParams,
} from "@xyflow/react";
import { NodeHandle as Handle } from "./NodeHandle";
import { CropIcon, ImagesIcon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  selectActiveDocumentTarget,
  selectActiveNodes,
  selectActiveEdges,
  selectActiveReadOnly,
  useFlowStore,
  type FlowNode,
  type DocumentTarget,
} from "@/store/flowStore";
import type { ImageInputNodeData } from "@/types/workflow";
import {
  OPEN_ASSET_PICKER_EVENT,
  type AssetPickerRequest,
} from "@/lib/overlayEvents";
import { NodeFrame } from "./NodeFrame";
import { MediaNodeActionToolbar } from "./NodeActionToolbar";
import { isPoseReferenceNode } from "@/types/poseReference";

const ImageCropEditor = lazy(() => import("./ImageCropEditor"));
const PoseReferenceComparison = lazy(() => import("../PoseReferenceComparison"));
const PosePromptInferenceDialog = lazy(() => import("../PosePromptInferenceDialog"));
const PosePromptEditor = lazy(() => import("../PosePromptEditor"));
interface CropSession {
  source: string;
  target: DocumentTarget;
}

interface NormalizedUploadResponse {
  id: string;
  url: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  width: number;
  height: number;
  byteLength: number;
  normalized: true;
}

export async function uploadFile(
  file: File,
  sourceNote = "来自图片上传节点",
): Promise<NormalizedUploadResponse> {
  const dataUrl = await readAsDataURL(file);
  const assetName =
    file.name
      .replace(/\.[^.]+$/, "")
      .trim()
      .slice(0, 180) || "上传图片";
  const res = await fetch("/api/assets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: assetName,
      category: "upload",
      scope: "private",
      image: dataUrl,
      sourceNote,
    }),
  });
  const data = (await res
    .json()
    .catch(() => ({}))) as Partial<NormalizedUploadResponse> & {
    error?: string;
  };
  if (!res.ok) throw new Error(data.error || `上传失败 HTTP ${res.status}`);
  if (
    data.normalized !== true ||
    typeof data.url !== "string" ||
    !data.url ||
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
      data.mimeType ?? "",
    ) ||
    !Number.isInteger(data.width) ||
    !Number.isInteger(data.height) ||
    !Number.isInteger(data.byteLength)
  ) {
    throw new Error("服务端未完成素材标准化，请重试");
  }
  return data as NormalizedUploadResponse;
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function ImageFileInput({
  label,
  onFile,
  disabled = false,
  className = "nodrag nopan absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0",
}: {
  label: string;
  onFile: (file: File | undefined) => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="file"
      disabled={disabled}
      accept="image/*"
      multiple={false}
      aria-label={label}
      className={className}
      onChange={(event) => {
        onFile(event.target.files?.[0]);
        event.target.value = "";
      }}
    />
  );
}

const IMAGE_NODE_MIN_WIDTH = 180;
const IMAGE_NODE_MIN_HEIGHT = 120;
const IMAGE_NODE_MAX_SIZE = 800;
const IMAGE_NODE_LONG_EDGE = 280;
const IMAGE_RESIZE_CORNERS = [
  "top-left",
  "top-right",
  "bottom-right",
  "bottom-left",
] as const;

/** Display-only geometry: a legacy free-resize height must never stretch the source. */
export function aspectLockedImageDimensions(
  naturalWidth: number,
  naturalHeight: number,
  preferredWidth?: number,
) {
  const valid =
    Number.isFinite(naturalWidth) &&
    Number.isFinite(naturalHeight) &&
    naturalWidth > 0 &&
    naturalHeight > 0;
  const ratio = valid ? naturalWidth / naturalHeight : 280 / 180;
  const fittedWidth = IMAGE_NODE_LONG_EDGE * Math.min(1, ratio);
  const requestedWidth =
    typeof preferredWidth === "number" &&
    Number.isFinite(preferredWidth) &&
    preferredWidth > 0
      ? preferredWidth
      : fittedWidth;
  const width = Math.min(
    requestedWidth,
    IMAGE_NODE_MAX_SIZE,
    IMAGE_NODE_MAX_SIZE * ratio,
  );
  return { width, height: width / ratio };
}

export function fitImageNodeDimensions(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return { width: IMAGE_NODE_LONG_EDGE, height: 180 };
  }
  const scale = IMAGE_NODE_LONG_EDGE / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
export function boundedImageNodeScale(
  width: number,
  height: number,
  factor: number,
): number {
  const minimumScale = Math.max(
    IMAGE_NODE_MIN_WIDTH / width,
    IMAGE_NODE_MIN_HEIGHT / height,
  );
  const maximumScale = Math.min(
    IMAGE_NODE_MAX_SIZE / width,
    IMAGE_NODE_MAX_SIZE / height,
  );
  return factor < 1
    ? Math.min(1, Math.max(factor, minimumScale))
    : Math.max(1, Math.min(factor, maximumScale));
}

export function canInferPosePrompt(isPose: boolean, imageUrl?: string): boolean {
  return isPose && typeof imageUrl === "string" && !imageUrl.startsWith("asset://");
}

export function FilePickerButton({
  label,
  onFile,
  compact = false,
  disabled = false,
}: {
  label: string;
  onFile: (file: File | undefined) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="nodrag nopan relative rounded-lg focus-within:ring-1 focus-within:ring-[var(--gc-node-accent)] focus-within:ring-offset-2 focus-within:ring-offset-[var(--gc-node-main)]">
      <Button
        type="button"
        variant="outline"
        size={compact ? "xs" : "sm"}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        className="border-[var(--gc-node-border)] bg-white text-[var(--gc-node-text)] hover:bg-neutral-100"
      >
        <UploadIcon aria-hidden="true" />
        {label}
      </Button>
      <ImageFileInput label={label} onFile={onFile} disabled={disabled} />
    </div>
  );
}

export function ImageInputNode({
  id,
  data,
  selected,
  width,
  height,
}: NodeProps<Node<ImageInputNodeData>>) {
  const updateNodeDataInTab = useFlowStore((s) => s.updateNodeDataInTab);
  const assignImageInputInTab = useFlowStore((s) => s.assignImageInputInTab);
  const onNodesChange = useFlowStore((s) => s.onNodesChange);
  const explicitWidth = useFlowStore(
    (state) => selectActiveNodes(state).find((node) => node.id === id)?.width,
  );
  const explicitHeight = useFlowStore(
    (state) => selectActiveNodes(state).find((node) => node.id === id)?.height,
  );
  const readOnly = useFlowStore(selectActiveReadOnly);
  const isPose = useFlowStore(s => isPoseReferenceNode(id, selectActiveNodes(s), selectActiveEdges(s)));
  const poseConnected = useFlowStore(s => selectActiveEdges(s).some(edge => edge.source === id && edge.targetHandle === 'pose' && selectActiveNodes(s).some(node => node.id === edge.target && node.data.kind === 'virtual-try-on' && node.data.workflowStage === 'scene-stabilize')));
  const [poseSession, setPoseSession] = useState<CropSession | null>(null);
  const poseTriggerRef = useRef<HTMLButtonElement>(null);
  const [posePromptSession, setPosePromptSession] = useState<CropSession | null>(null);
  const posePromptTriggerRef = useRef<HTMLButtonElement>(null);
  const uploadRequestRef = useRef(0);
  const [cropSession, setCropSession] = useState<CropSession | null>(null);
  const cropSessionRef = useRef<CropSession | null>(null);
  const activeDocumentKey = useFlowStore((state) =>
    JSON.stringify(selectActiveDocumentTarget(state)),
  );
  useEffect(() => {
    setPoseSession(null);
    setPosePromptSession(null);
  }, [activeDocumentKey, data.imageUrl, isPose]);
  const cropTriggerRef = useRef<HTMLButtonElement>(null);
  const closeCrop = useCallback(() => {
    cropSessionRef.current = null;
    setCropSession(null);
    requestAnimationFrame(() =>
      cropTriggerRef.current?.focus({ preventScroll: true }),
    );
  }, []);
  useEffect(() => {
    // A replaced document, a new source or a read-only transition invalidates the editor.
    if (cropSessionRef.current) closeCrop();
  }, [activeDocumentKey, data.imageUrl, readOnly, selected, closeCrop]);
  useEffect(
    () => () => {
      cropSessionRef.current = null;
    },
    [],
  );
  const saveCrop = async (file: File) => {
    // Capture this render's session: an older canvas export must not adopt a newer editor.
    const session = cropSession;
    if (!session) return;
    const stillCurrent = () => {
      const state = useFlowStore.getState();
      const tab = state.tabs.find(
        (tab) =>
          tab.id === session.target.tabId &&
          tab.projectId === session.target.projectId &&
          tab.documentEpoch === session.target.documentEpoch,
      );
      return (
        cropSessionRef.current === session &&
        state.activeTabId === session.target.tabId &&
        tab?.readOnly === false &&
        tab.nodes.some(
          (node) =>
            node.id === id &&
            node.data.kind === "image-input" &&
            node.data.imageUrl === session.source,
        )
      );
    };
    if (!stillCurrent()) throw new Error("图片或项目已变更，请重新打开裁切");
    const requestId = ++uploadRequestRef.current;
    const upload = await uploadFile(file);
    if (!stillCurrent() || requestId !== uploadRequestRef.current) return;
    assignImageInputInTab(session.target, id, upload.url);
    closeCrop();
  };
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [resizeDirection, setResizeDirection] = useState<"out" | "in">("out");
  const previousResizeArea = useRef(0);
  // Keep callbacks stable: changing them during a drag recreates XYFlow's resizer.
  const onResizeStart = useCallback((_: unknown, params: ResizeParams) => {
    previousResizeArea.current = params.width * params.height;
    setResizeDirection("out");
  }, []);
  const onResize = useCallback((_: unknown, params: ResizeParams) => {
    const area = params.width * params.height;
    if (Math.abs(area - previousResizeArea.current) > 0.1) {
      setResizeDirection(area > previousResizeArea.current ? "out" : "in");
      previousResizeArea.current = area;
    }
  }, []);
  const onResizeEnd = useCallback(() => setResizeDirection("out"), []);
  const [imageDimensions, setImageDimensions] = useState<{
    url: string;
    width: number;
    height: number;
  } | null>(null);

  const openAssetPicker = useCallback(() => {
    const detail: AssetPickerRequest = {
      target: selectActiveDocumentTarget(useFlowStore.getState()),
      nodeId: id,
    };
    window.dispatchEvent(new CustomEvent(OPEN_ASSET_PICKER_EVENT, { detail }));
  }, [id]);

  const handleFile = useCallback(
    async (file: File | undefined | null) => {
      if (!file || !file.type.startsWith("image/")) return;
      const requestId = ++uploadRequestRef.current;
      const target = selectActiveDocumentTarget(useFlowStore.getState());
      setUploading(true);
      try {
        const upload = await uploadFile(file);
        if (requestId !== uploadRequestRef.current) return;
        setImageDimensions({
          url: upload.url,
          width: upload.width,
          height: upload.height,
        });
        assignImageInputInTab(target, id, upload.url);
      } catch (err) {
        if (requestId !== uploadRequestRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        updateNodeDataInTab(target, id, {
          status: "error",
          error: message || "上传失败，请重试",
        });
      } finally {
        if (requestId === uploadRequestRef.current) setUploading(false);
      }
    },
    [assignImageInputInTab, id, updateNodeDataInTab],
  );

  // Ctrl+V 粘贴（节点被选中时生效）
  useEffect(() => {
    if (!selected || cropSession) return;
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? []).find((f) =>
        f.type.startsWith("image/"),
      );
      if (file) {
        e.preventDefault();
        void handleFile(file);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [selected, cropSession, handleFile]);

  const fittedImage =
    imageDimensions && imageDimensions.url === data.imageUrl
      ? fitImageNodeDimensions(imageDimensions.width, imageDimensions.height)
      : fitImageNodeDimensions(280, 180);
  const resizedWidth =
    typeof explicitWidth === "number" && explicitWidth > 0
      ? explicitWidth
      : undefined;
  const resizedHeight =
    typeof explicitHeight === "number" && explicitHeight > 0
      ? explicitHeight
      : undefined;
  const hasLoadedImage = Boolean(
    imageDimensions && imageDimensions.url === data.imageUrl,
  );
  const lockedSize = aspectLockedImageDimensions(
    hasLoadedImage ? imageDimensions!.width : 280,
    hasLoadedImage ? imageDimensions!.height : 180,
    resizedWidth,
  );
  const hasDisplayImage = Boolean(
    data.imageUrl && !data.imageUrl.startsWith("asset://"),
  );
  const imageNodeStyle = {
    width: hasDisplayImage
      ? lockedSize.width
      : (resizedWidth ?? IMAGE_NODE_LONG_EDGE),
    height: hasDisplayImage ? lockedSize.height : resizedHeight,
  } satisfies CSSProperties;
  useEffect(() => {
    if (!hasLoadedImage || readOnly || resizedWidth === undefined) return;
    if (
      Math.abs(resizedWidth - lockedSize.width) < 0.6 &&
      resizedHeight !== undefined &&
      Math.abs(resizedHeight - lockedSize.height) < 0.6
    )
      return;
    // The store treats dimensions as transient, outside document history/save data.
    onNodesChange([
      { id, type: "dimensions", dimensions: lockedSize, setAttributes: true },
    ]);
  }, [
    hasLoadedImage,
    readOnly,
    id,
    resizedWidth,
    resizedHeight,
    lockedSize.width,
    lockedSize.height,
    onNodesChange,
  ]);
  const resizeNodeBy = (factor: number) => {
    const currentWidth = hasDisplayImage
      ? lockedSize.width
      : (resizedWidth ?? width ?? IMAGE_NODE_LONG_EDGE);
    const currentHeight = hasDisplayImage
      ? lockedSize.height
      : (resizedHeight ?? height ?? IMAGE_NODE_MIN_HEIGHT);
    const boundedScale = boundedImageNodeScale(
      currentWidth,
      currentHeight,
      factor,
    );
    if (boundedScale === 1) return;
    const changes: NodeChange<FlowNode>[] = [
      {
        id,
        type: "dimensions",
        dimensions: {
          width: currentWidth * boundedScale,
          height: currentHeight * boundedScale,
        },
        setAttributes: true,
      },
    ];
    onNodesChange(changes);
  };
  const dropHandlers = {
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault();
      setDragOver(true);
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      setDragOver(false);
      void handleFile(event.dataTransfer.files?.[0]);
    },
  };

  return (
    <div
      className={`gc-image-node relative${cropSession ? " nodrag nopan" : ""}`}
      style={imageNodeStyle}
      data-resize-direction={resizeDirection}
      onKeyDownCapture={(event) => {
        // During dialog autofocus, Escape may still target the canvas trigger.
        // Isolate it from React Flow even before focus enters the portal.
        if ((poseSession || posePromptSession) && event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          setPoseSession(null);
          setPosePromptSession(null);
        }
      }}
    >
      {selected &&
        !readOnly &&
        !cropSession &&
        (!hasDisplayImage || hasLoadedImage) &&
        IMAGE_RESIZE_CORNERS.map((corner) => (
          <NodeResizeControl
            key={corner}
            position={corner}
            className="gc-image-resize-corner nopan"
            // Keep this inline: CSS optimization can fold translate:none into
            // transform, leaving the separate vendor stylesheet's -50% translate.
            style={{ translate: "none" }}
            minWidth={
              hasDisplayImage
                ? Math.min(IMAGE_NODE_MIN_WIDTH, fittedImage.width)
                : IMAGE_NODE_MIN_WIDTH
            }
            minHeight={
              hasDisplayImage
                ? Math.min(IMAGE_NODE_MIN_HEIGHT, fittedImage.height)
                : IMAGE_NODE_MIN_HEIGHT
            }
            maxWidth={IMAGE_NODE_MAX_SIZE}
            maxHeight={IMAGE_NODE_MAX_SIZE}
            keepAspectRatio={hasDisplayImage}
            autoScale={false}
            onResizeStart={onResizeStart}
            onResize={onResize}
            onResizeEnd={onResizeEnd}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="gc-image-resize-keyboard"
              aria-label={`调整参考图尺寸：${corner}`}
              title="拖动缩放；聚焦后按上/右键放大，下/左键缩小"
              onKeyDown={(event) => {
                const grow = ["ArrowUp", "ArrowRight", "+", "="].includes(
                  event.key,
                );
                const shrink = ["ArrowDown", "ArrowLeft", "-"].includes(
                  event.key,
                );
                if (!grow && !shrink) return;
                event.preventDefault();
                event.stopPropagation();
                resizeNodeBy(grow ? 1.1 : 0.9);
              }}
            >
              <svg
                className="gc-image-resize-arrows"
                width="28"
                height="28"
                viewBox="0 0 28 28"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M5 10 10.5 15.5 Q14 19 17.5 15.5 L23 10" />
                <svg
                  className="gc-image-resize-arrow-inner"
                  x="9.5"
                  y="4.5"
                  width="9"
                  height="9"
                  viewBox="0 0 28 28"
                  stroke="currentColor"
                >
                  <path
                    d="M5 10 10.5 15.5 Q14 19 17.5 15.5 L23 10"
                    strokeWidth={(1.5 * 28) / 9}
                  />
                </svg>
              </svg>
            </Button>
          </NodeResizeControl>
        ))}
      <NodeFrame
        nodeId={cropSession ? undefined : id}
        title={data.label}
        status={data.status}
        error={data.error}
        selected={selected}
        toolbar={
          cropSession ? undefined : (
            <MediaNodeActionToolbar
              nodeId={id}
              hasImage={Boolean(data.imageUrl)}
              sourceHandle="image"
            />
          )
        }
      >
        {data.imageUrl?.startsWith("asset://") ? (
          <div className="rounded-md border border-[var(--gc-node-border)] bg-[var(--gc-node-inner)] px-3 py-5 text-center text-[10px] text-[var(--gc-node-text)]">
            API易图片素材
          </div>
        ) : data.imageUrl ? (
          <div
            {...(cropSession ? {} : dropHandlers)}
            className={`gc-image-input-media relative overflow-hidden bg-white ${dragOver ? "gc-image-input-media--dragging" : ""}`}
            style={{ height: "100%" }}
          >
            {cropSession ? (
              <Suspense fallback={<span role="status">正在加载裁切工具…</span>}>
                <ImageCropEditor
                  source={cropSession.source}
                  onSave={saveCrop}
                  onClose={closeCrop}
                />
              </Suspense>
            ) : (
              <img
                src={data.imageUrl}
                loading="lazy"
                decoding="async"
                draggable={false}
                alt="已上传图片"
                className="block h-full w-full select-none object-contain"
                onLoad={(event) => {
                  const image = event.currentTarget;
                  setImageDimensions({
                    url: data.imageUrl!,
                    width: image.naturalWidth,
                    height: image.naturalHeight,
                  });
                }}
              />
            )}
            {uploading && (
              <div
                role="status"
                className="absolute inset-0 grid place-items-center bg-white/80 text-[10px] text-[var(--gc-node-muted)]"
              >
                素材处理中…
              </div>
            )}
          </div>
        ) : (
          <div
            {...dropHandlers}
            className={`gc-image-input-empty nodrag nopan rounded-lg border border-dashed px-4 py-5 text-center transition-colors ${
              dragOver
                ? "border-[var(--gc-node-accent)] bg-amber-50"
                : "border-[var(--gc-node-border)] bg-white"
            }`}
          >
            <div className="flex items-center justify-center gap-2">
              <FilePickerButton
                label={uploading ? "处理中…" : "本地上传"}
                onFile={(file) => void handleFile(file)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={openAssetPicker}
                className="nodrag border-[var(--gc-node-border)] bg-white text-[var(--gc-node-text)] hover:bg-neutral-100"
              >
                <ImagesIcon aria-hidden="true" />
                从素材库选择
              </Button>
            </div>
            <p className="mt-3 text-[9px] leading-4 text-[var(--gc-node-muted)]">
              支持拖拽图片到节点，或选中节点后粘贴
            </p>
          </div>
        )}
      </NodeFrame>
      {selected && !readOnly && data.imageUrl && !cropSession && (
        <div className="gc-image-node-actions nodrag nopan absolute left-1/2 top-[calc(100%+8px)] z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-[var(--gc-border)] bg-[var(--gc-panel)] p-1 shadow-xl">
          <FilePickerButton
            label="重新上传"
            compact
            onFile={(file) => void handleFile(file)}
          />
          {hasDisplayImage && (
            <Button
              ref={cropTriggerRef}
              type="button"
              variant="ghost"
              size="xs"
              disabled={!hasLoadedImage || uploading}
              onClick={() => {
                const session = {
                  source: data.imageUrl!,
                  target: selectActiveDocumentTarget(useFlowStore.getState()),
                };
                cropSessionRef.current = session;
                setCropSession(session);
              }}
            >
              <CropIcon aria-hidden="true" />
              裁切
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={openAssetPicker}
            className="text-[var(--gc-text-muted)] hover:text-[var(--gc-text)]"
          >
            <ImagesIcon aria-hidden="true" />
            素材库
          </Button>
        </div>
      )}
      <Handle
        id="image"
        type="source"
        position={Position.Right}
        title="图片输出"
        isConnectable={!cropSession}
        onContextMenu={
          cropSession ? (event) => event.preventDefault() : undefined
        }
      />
      {selected && isPose && data.imageUrl && !cropSession && (
        <div className="nodrag nopan absolute left-1/2 top-[calc(100%+48px)] z-20 flex -translate-x-1/2 gap-2 whitespace-nowrap rounded-lg border border-[var(--gc-border)] bg-[var(--gc-panel)] p-1 shadow-xl">
          {!readOnly && <Button size="xs" variant="outline" onClick={(event) => { poseTriggerRef.current = event.currentTarget; setPoseSession({ source: data.imageUrl!, target: selectActiveDocumentTarget(useFlowStore.getState()) }); }}>生成姿势参考</Button>}
          <Button ref={poseTriggerRef} size="xs" variant="outline" onClick={(event) => { poseTriggerRef.current = event.currentTarget; setPoseSession({ source: data.imageUrl!, target: selectActiveDocumentTarget(useFlowStore.getState()) }); }}>查看对比</Button>
          {canInferPosePrompt(isPose, data.imageUrl) && <Button ref={posePromptTriggerRef} size="xs" variant="outline" title="反推姿势提示词，默认用于第一轮生图，可在节点下方编辑" onClick={(event) => { posePromptTriggerRef.current = event.currentTarget; setPosePromptSession({ source: data.imageUrl!, target: selectActiveDocumentTarget(useFlowStore.getState()) }); }}>反推人物姿势</Button>}
        </div>
      )}
      {poseSession && <Suspense fallback={<span role="status">正在加载姿势对比…</span>}>
        <PoseReferenceComparison target={poseSession.target} nodeId={id} source={poseSession.source} readOnly={readOnly} triggerRef={poseTriggerRef} onClose={() => setPoseSession(null)} />
      </Suspense>}
      {posePromptSession && <Suspense fallback={<span role="status">正在加载姿势反推…</span>}>
        <PosePromptInferenceDialog target={posePromptSession.target} nodeId={id} source={posePromptSession.source} triggerRef={posePromptTriggerRef} onClose={() => setPosePromptSession(null)} />
      </Suspense>}
      {isPose && data.imageUrl && !cropSession && <Suspense fallback={<span role="status">正在加载姿势提示词…</span>}>
        <PosePromptEditor key={`${activeDocumentKey}:${id}:${data.imageUrl}`} target={selectActiveDocumentTarget(useFlowStore.getState())} nodeId={id} source={data.imageUrl} connected={poseConnected} readOnly={readOnly} />
      </Suspense>}
    </div>
  );
}

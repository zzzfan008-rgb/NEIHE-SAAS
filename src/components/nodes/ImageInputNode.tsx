import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Handle, NodeResizer, Position, type NodeChange, type NodeProps, type Node } from "@xyflow/react";
import { ImagesIcon, MinusIcon, PlusIcon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  selectActiveDocumentTarget,
  selectActiveNodes,
  selectActiveReadOnly,
  useFlowStore,
  type FlowNode,
} from "@/store/flowStore";
import type { ImageInputNodeData } from "@/types/workflow";
import { OPEN_ASSET_PICKER_EVENT, type AssetPickerRequest } from "@/lib/overlayEvents";
import { NodeFrame } from "./NodeFrame";
import { MediaNodeActionToolbar } from "./NodeActionToolbar";

interface NormalizedUploadResponse {
  id: string;
  url: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  width: number;
  height: number;
  byteLength: number;
  normalized: true;
}

async function uploadFile(file: File): Promise<NormalizedUploadResponse> {
  const dataUrl = await readAsDataURL(file);
  const assetName = file.name.replace(/\.[^.]+$/, "").trim().slice(0, 180) || "上传图片";
  const res = await fetch("/api/assets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: assetName,
      category: "upload",
      scope: "private",
      image: dataUrl,
      sourceNote: "来自图片上传节点",
    }),
  });
  const data = await res.json().catch(() => ({})) as Partial<NormalizedUploadResponse> & { error?: string };
  if (!res.ok) throw new Error(data.error || `上传失败 HTTP ${res.status}`);
  if (
    data.normalized !== true || typeof data.url !== "string" || !data.url ||
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(data.mimeType ?? "") ||
    !Number.isInteger(data.width) || !Number.isInteger(data.height) || !Number.isInteger(data.byteLength)
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
  className = "nodrag nopan absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0",
}: {
  label: string;
  onFile: (file: File | undefined) => void;
  className?: string;
}) {
  return (
    <input
      type="file"
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

export function fitImageNodeDimensions(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: IMAGE_NODE_LONG_EDGE, height: 180 };
  }
  const scale = IMAGE_NODE_LONG_EDGE / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
export function boundedImageNodeScale(width: number, height: number, factor: number): number {
  const minimumScale = Math.max(IMAGE_NODE_MIN_WIDTH / width, IMAGE_NODE_MIN_HEIGHT / height);
  const maximumScale = Math.min(IMAGE_NODE_MAX_SIZE / width, IMAGE_NODE_MAX_SIZE / height);
  return factor < 1
    ? Math.min(1, Math.max(factor, minimumScale))
    : Math.max(1, Math.min(factor, maximumScale));
}

function FilePickerButton({
  label,
  onFile,
  compact = false,
}: {
  label: string;
  onFile: (file: File | undefined) => void;
  compact?: boolean;
}) {
  return (
    <div className="nodrag nopan relative rounded-lg focus-within:ring-1 focus-within:ring-[var(--gc-node-accent)] focus-within:ring-offset-2 focus-within:ring-offset-[var(--gc-node-main)]">
      <Button
        type="button"
        variant="outline"
        size={compact ? "xs" : "sm"}
        tabIndex={-1}
        aria-hidden="true"
        className="border-[var(--gc-node-border)] bg-white text-[var(--gc-node-text)] hover:bg-neutral-100"
      >
        <UploadIcon aria-hidden="true" />
        {label}
      </Button>
      <ImageFileInput label={label} onFile={onFile} />
    </div>
  );
}

export function ImageInputNode({ id, data, selected, width, height }: NodeProps<Node<ImageInputNodeData>>) {
  const updateNodeDataInTab = useFlowStore((s) => s.updateNodeDataInTab);
  const assignImageInputInTab = useFlowStore((s) => s.assignImageInputInTab);
  const onNodesChange = useFlowStore((s) => s.onNodesChange);
  const explicitWidth = useFlowStore((state) => selectActiveNodes(state).find((node) => node.id === id)?.width);
  const explicitHeight = useFlowStore((state) => selectActiveNodes(state).find((node) => node.id === id)?.height);
  const readOnly = useFlowStore(selectActiveReadOnly);
  const uploadRequestRef = useRef(0);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
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
        setImageDimensions({ url: upload.url, width: upload.width, height: upload.height });
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
    if (!selected) return;
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
  }, [selected, handleFile]);

  const fittedImage = imageDimensions && imageDimensions.url === data.imageUrl
    ? fitImageNodeDimensions(imageDimensions.width, imageDimensions.height)
    : fitImageNodeDimensions(280, 180);
  const resizedWidth = typeof explicitWidth === "number" && explicitWidth > 0 ? explicitWidth : undefined;
  const resizedHeight = typeof explicitHeight === "number" && explicitHeight > 0 ? explicitHeight : undefined;
  const imageNodeStyle = {
    width: resizedWidth ?? (data.imageUrl ? fittedImage.width : IMAGE_NODE_LONG_EDGE),
    height: resizedHeight,
  } satisfies CSSProperties;
  const resizeNodeBy = (factor: number) => {
    const currentWidth = resizedWidth ?? (data.imageUrl ? fittedImage.width : width ?? IMAGE_NODE_LONG_EDGE);
    const currentHeight = resizedHeight ?? (data.imageUrl ? fittedImage.height : height ?? IMAGE_NODE_MIN_HEIGHT);
    const boundedScale = boundedImageNodeScale(currentWidth, currentHeight, factor);
    if (boundedScale === 1) return;
    const changes: NodeChange<FlowNode>[] = [{
      id,
      type: "dimensions",
      dimensions: {
        width: Math.round(currentWidth * boundedScale),
        height: Math.round(currentHeight * boundedScale),
      },
      setAttributes: true,
    }];
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
    <div className="gc-image-node relative" style={imageNodeStyle}>
      <NodeResizer
        isVisible={selected && !readOnly}
        minWidth={IMAGE_NODE_MIN_WIDTH}
        minHeight={IMAGE_NODE_MIN_HEIGHT}
        maxWidth={IMAGE_NODE_MAX_SIZE}
        maxHeight={IMAGE_NODE_MAX_SIZE}
        color="var(--gc-node-accent)"
        lineStyle={{ pointerEvents: "none" }}
        handleStyle={{
          zIndex: 30,
          width: 12,
          height: 12,
          border: "2px solid var(--gc-node-accent)",
          borderRadius: 3,
          background: "var(--gc-node-main)",
        }}
      />
      <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected} toolbar={<MediaNodeActionToolbar nodeId={id} hasImage={Boolean(data.imageUrl)} sourceHandle="image" />}>
        {data.imageUrl?.startsWith("asset://") ? (
          <div className="rounded-md border border-[var(--gc-node-border)] bg-[var(--gc-node-inner)] px-3 py-5 text-center text-[10px] text-[var(--gc-node-text)]">
            API易图片素材
          </div>
        ) : data.imageUrl ? (
          <div
            {...dropHandlers}
            className={`gc-image-input-media relative overflow-hidden bg-white ${dragOver ? "gc-image-input-media--dragging" : ""}`}
            style={{ height: resizedHeight ? "100%" : fittedImage.height }}
          >
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
            {uploading && (
              <div role="status" className="absolute inset-0 grid place-items-center bg-white/80 text-[10px] text-[var(--gc-node-muted)]">
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
              <FilePickerButton label={uploading ? "处理中…" : "本地上传"} onFile={(file) => void handleFile(file)} />
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
      {selected && !readOnly && (
        <div className="gc-image-node-actions nodrag nopan absolute left-1/2 top-[calc(100%+8px)] z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-[var(--gc-border)] bg-[var(--gc-panel)] p-1 shadow-xl">
          <Button type="button" variant="ghost" size="icon-xs" onClick={() => resizeNodeBy(0.9)} aria-label="缩小参考图节点" title="缩小参考图节点">
            <MinusIcon aria-hidden="true" />
          </Button>
          <Button type="button" variant="ghost" size="icon-xs" onClick={() => resizeNodeBy(1.1)} aria-label="放大参考图节点" title="放大参考图节点">
            <PlusIcon aria-hidden="true" />
          </Button>
          {data.imageUrl && (
            <>
          <FilePickerButton label="重新上传" compact onFile={(file) => void handleFile(file)} />
          <Button type="button" variant="ghost" size="xs" onClick={openAssetPicker} className="text-[var(--gc-text-muted)] hover:text-[var(--gc-text)]">
            <ImagesIcon aria-hidden="true" />
            素材库
          </Button>
            </>
          )}
        </div>
      )}
      <Handle id="image" type="source" position={Position.Right} title="图片输出" />
    </div>
  );
}

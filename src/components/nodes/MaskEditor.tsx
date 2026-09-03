import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { createLatestMaskLoadGuard } from "@/lib/maskUpload";
import { adaptiveMaskExpansionRadius, adaptiveMaskFeatherRadius } from "@/lib/maskGeometry";

interface MaskEditorProps {
  source: string;
  initialMask?: string;
  onSave: (mask: string) => void | Promise<void>;
  onClose: () => void;
}

type BrushMode = "edit" | "preserve";
const MAX_MASK_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY = 12;

export function MaskEditor({ source, initialMask, onSave, onClose }: MaskEditorProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const maskRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const savingRef = useRef(false);
  const loadGuardRef = useRef(createLatestMaskLoadGuard());
  const snapshotLoadGuardRef = useRef(createLatestMaskLoadGuard());
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<BrushMode>("edit");
  const [brushSize, setBrushSize] = useState(80);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const renderOverlay = () => {
    const mask = maskRef.current;
    const overlay = overlayRef.current;
    if (!mask || !overlay) return;
    const context = overlay.getContext("2d");
    if (!context) return;
    const selectionLayer = (fillStyle: string) => {
      const layer = document.createElement("canvas");
      layer.width = overlay.width;
      layer.height = overlay.height;
      const layerContext = layer.getContext("2d");
      if (!layerContext) return layer;
      layerContext.fillStyle = fillStyle;
      layerContext.fillRect(0, 0, layer.width, layer.height);
      layerContext.globalCompositeOperation = "destination-out";
      layerContext.drawImage(mask, 0, 0);
      layerContext.globalCompositeOperation = "source-over";
      return layer;
    };
    context.clearRect(0, 0, overlay.width, overlay.height);
    context.globalCompositeOperation = "source-over";
    const maskContext = mask.getContext("2d");
    const pixels = maskContext?.getImageData(0, 0, mask.width, mask.height).data;
    let left = mask.width;
    let right = -1;
    let top = mask.height;
    let bottom = -1;
    if (pixels) {
      for (let offset = 3; offset < pixels.length; offset += 4) {
        if (pixels[offset] > 242) continue;
        const index = (offset - 3) / 4;
        const x = index % mask.width;
        const y = Math.floor(index / mask.width);
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
    const extent = right >= left && bottom >= top
      ? { width: right - left + 1, height: bottom - top + 1 }
      : { width: 1, height: 1 };
    const expansionRadius = adaptiveMaskExpansionRadius(overlay.width, overlay.height, extent);
    const featherRadius = adaptiveMaskFeatherRadius(overlay.width, overlay.height, expansionRadius);
    if (expansionRadius > 0) {
      context.save();
      context.filter = `blur(${Math.max(2, Math.round((expansionRadius + featherRadius) / 2))}px)`;
      context.drawImage(selectionLayer("rgba(245, 158, 11, 0.3)"), 0, 0);
      context.restore();
    }
    context.drawImage(selectionLayer("rgba(239, 68, 68, 0.48)"), 0, 0);
    context.globalCompositeOperation = "source-over";
  };

  const loadMaskSnapshot = (snapshot: string) => {
    const mask = maskRef.current;
    if (!mask) return;
    const isCurrentLoad = snapshotLoadGuardRef.current.begin();
    const image = new Image();
    image.onload = () => {
      if (!isCurrentLoad()) return;
      const context = mask.getContext("2d");
      if (!context) return;
      context.globalCompositeOperation = "source-over";
      context.clearRect(0, 0, mask.width, mask.height);
      context.drawImage(image, 0, 0, mask.width, mask.height);
      renderOverlay();
    };
    image.src = snapshot;
  };

  const captureMask = () => maskRef.current?.toDataURL("image/png") ?? "";

  const pushUndo = () => {
    const snapshot = captureMask();
    if (!snapshot) return;
    setUndoStack((current) => [...current.slice(-(MAX_HISTORY - 1)), snapshot]);
    setRedoStack([]);
  };

  const initializeCanvases = () => {
    const image = imageRef.current;
    const mask = maskRef.current;
    const overlay = overlayRef.current;
    if (!image || !mask || !overlay || !image.naturalWidth || !image.naturalHeight) return;
    snapshotLoadGuardRef.current.invalidate();
    const isCurrentLoad = loadGuardRef.current.begin();
    setReady(false);
    mask.width = image.naturalWidth;
    mask.height = image.naturalHeight;
    overlay.width = image.naturalWidth;
    overlay.height = image.naturalHeight;
    const context = mask.getContext("2d");
    if (!context) return;
    context.fillStyle = "rgba(255,255,255,1)";
    context.fillRect(0, 0, mask.width, mask.height);
    if (initialMask) {
      const existing = new Image();
      existing.onload = () => {
        if (!isCurrentLoad()) return;
        if (existing.naturalWidth !== mask.width || existing.naturalHeight !== mask.height) {
          setError("已保存蒙版与当前原图尺寸不一致，请重新绘制");
          renderOverlay();
          setReady(true);
          return;
        }
        context.clearRect(0, 0, mask.width, mask.height);
        context.drawImage(existing, 0, 0);
        renderOverlay();
        setReady(true);
      };
      existing.onerror = () => {
        if (!isCurrentLoad()) return;
        setError("无法读取已保存蒙版，请重新绘制");
        renderOverlay();
        setReady(true);
      };
      existing.src = initialMask;
      return;
    }
    renderOverlay();
    setReady(true);
  };

  useLayoutEffect(() => {
    // 同一组件实例可能因上游 Run 完成而收到新 source；先使旧 Image 回调失效。
    loadGuardRef.current.invalidate();
    snapshotLoadGuardRef.current.invalidate();
    drawingRef.current = false;
    lastPointRef.current = null;
    setReady(false);
    setError(null);
    setUndoStack([]);
    setRedoStack([]);
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth && image.naturalHeight) initializeCanvases();
    return () => {
      loadGuardRef.current.invalidate();
      snapshotLoadGuardRef.current.invalidate();
    };
  }, [source, initialMask]);

  const pointForEvent = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = overlayRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  const drawSegment = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const mask = maskRef.current;
    const overlay = overlayRef.current;
    if (!mask || !overlay) return;
    const maskContext = mask.getContext("2d");
    const overlayContext = overlay.getContext("2d");
    if (!maskContext || !overlayContext) return;
    snapshotLoadGuardRef.current.invalidate();
    for (const [context, target] of [[maskContext, "mask"], [overlayContext, "overlay"]] as const) {
      context.save();
      context.lineCap = "round";
      context.lineJoin = "round";
      context.lineWidth = brushSize;
      context.globalCompositeOperation = mode === "edit"
        ? target === "mask" ? "destination-out" : "source-over"
        : target === "mask" ? "source-over" : "destination-out";
      context.strokeStyle = target === "mask" ? "rgba(255,255,255,1)" : "rgba(239,68,68,0.48)";
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
      context.restore();
    }
  };

  const startDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!ready || savingRef.current) return;
    snapshotLoadGuardRef.current.invalidate();
    pushUndo();
    drawingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointForEvent(event);
    lastPointRef.current = point;
    drawSegment(point, point);
  };

  const continueDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (savingRef.current || !drawingRef.current || !lastPointRef.current) return;
    const point = pointForEvent(event);
    drawSegment(lastPointRef.current, point);
    lastPointRef.current = point;
  };

  const stopDrawing = () => {
    drawingRef.current = false;
    lastPointRef.current = null;
    renderOverlay();
  };

  const clearMask = () => {
    if (savingRef.current) return;
    snapshotLoadGuardRef.current.invalidate();
    const mask = maskRef.current;
    if (!mask) return;
    pushUndo();
    const context = mask.getContext("2d");
    if (!context) return;
    context.globalCompositeOperation = "source-over";
    context.fillStyle = "rgba(255,255,255,1)";
    context.fillRect(0, 0, mask.width, mask.height);
    renderOverlay();
  };

  const invertMask = () => {
    if (savingRef.current) return;
    snapshotLoadGuardRef.current.invalidate();
    const mask = maskRef.current;
    if (!mask) return;
    pushUndo();
    const temporary = document.createElement("canvas");
    temporary.width = mask.width;
    temporary.height = mask.height;
    temporary.getContext("2d")?.drawImage(mask, 0, 0);
    const context = mask.getContext("2d");
    if (!context) return;
    context.globalCompositeOperation = "source-over";
    context.fillStyle = "rgba(255,255,255,1)";
    context.fillRect(0, 0, mask.width, mask.height);
    context.globalCompositeOperation = "destination-out";
    context.drawImage(temporary, 0, 0);
    context.globalCompositeOperation = "source-over";
    renderOverlay();
  };

  const undo = () => {
    if (savingRef.current) return;
    const snapshot = undoStack.at(-1);
    if (!snapshot) return;
    const current = captureMask();
    setUndoStack((stack) => stack.slice(0, -1));
    if (current) setRedoStack((stack) => [...stack.slice(-(MAX_HISTORY - 1)), current]);
    loadMaskSnapshot(snapshot);
  };

  const redo = () => {
    if (savingRef.current) return;
    const snapshot = redoStack.at(-1);
    if (!snapshot) return;
    const current = captureMask();
    setRedoStack((stack) => stack.slice(0, -1));
    if (current) setUndoStack((stack) => [...stack.slice(-(MAX_HISTORY - 1)), current]);
    loadMaskSnapshot(snapshot);
  };

  const save = async () => {
    const mask = maskRef.current;
    if (!mask || savingRef.current) return;
    snapshotLoadGuardRef.current.invalidate();
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        mask.toBlob((value) => value ? resolve(value) : reject(new Error("蒙版编码失败")), "image/png");
      });
      if (blob.size > MAX_MASK_BYTES) throw new Error("蒙版 PNG 超过 4MB，请减少画布尺寸后重试");
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("蒙版读取失败"));
        reader.readAsDataURL(blob);
      });
      await onSave(dataUrl);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-100 flex flex-col bg-[#0b0b0b]">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[#262626] px-4">
        <strong className="text-sm font-medium text-neutral-100">局部修改</strong>
        <span className="text-[10px] text-neutral-500">GPT Image 2</span>
        <div className="ml-auto flex items-center gap-1.5">
          <ToolbarButton label="撤销" disabled={saving || !undoStack.length} onClick={undo} />
          <ToolbarButton label="重做" disabled={saving || !redoStack.length} onClick={redo} />
          <ToolbarButton label="清空" disabled={saving} onClick={clearMask} />
          <ToolbarButton label="反选" disabled={saving} onClick={invertMask} />
          <button type="button" onClick={onClose} disabled={saving} className="ml-2 rounded-md border border-[#333] px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-500 disabled:opacity-40">
            关闭
          </button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#101010] p-4">
        <div className="relative inline-flex max-h-full max-w-full shadow-2xl shadow-black">
          <img
            ref={imageRef}
            src={source}
            alt="局部修改原图"
            onLoad={initializeCanvases}
            onError={() => setError("无法读取原图")}
            className="block max-h-[calc(100vh-132px)] max-w-[calc(100vw-32px)] select-none object-contain"
            draggable={false}
          />
          <canvas
            ref={overlayRef}
            onPointerDown={startDrawing}
            onPointerMove={continueDrawing}
            onPointerUp={stopDrawing}
            onPointerCancel={stopDrawing}
            aria-disabled={saving}
            className={`absolute inset-0 h-full w-full touch-none ${ready && !saving ? "cursor-crosshair" : "cursor-wait"} ${saving ? "pointer-events-none" : ""}`}
          />
          <canvas ref={maskRef} className="hidden" />
        </div>
      </main>

      <footer className="flex min-h-16 shrink-0 items-center gap-4 border-t border-[#262626] px-4 py-2">
        <div className="flex rounded-md border border-[#333] p-0.5">
          <ModeButton active={mode === "edit"} label="涂抹修改区" disabled={saving} onClick={() => setMode("edit")} />
          <ModeButton active={mode === "preserve"} label="恢复保留区" disabled={saving} onClick={() => setMode("preserve")} />
        </div>
        <label className="flex min-w-56 items-center gap-2 text-[10px] text-neutral-500">
          笔刷 {brushSize}px
          <input
            type="range" min={8} max={300} step={4} value={brushSize}
            onChange={(event) => setBrushSize(Number(event.target.value))}
            disabled={saving}
            className="accent-gold disabled:opacity-40"
          />
        </label>
        <span className="text-[10px] text-neutral-600">红色是修改中心，不是裁切框 · 新内容可在金色融合区内完整延展</span>
        {error && <p className="min-w-0 flex-1 truncate text-[10px] text-red-400" title={error}>{error}</p>}
        <button
          type="button"
          onClick={() => void save()}
          disabled={!ready || saving}
          className="ml-auto rounded-md bg-gold px-4 py-2 text-xs font-medium text-ink disabled:opacity-40"
        >
          {saving ? "保存中…" : "保存蒙版"}
        </button>
      </footer>
    </div>,
    document.body,
  );
}

function ToolbarButton({ label, onClick, disabled = false }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="rounded-md border border-[#333] px-2.5 py-1.5 text-[10px] text-neutral-400 hover:border-gold/50 hover:text-gold disabled:opacity-30">
      {label}
    </button>
  );
}

function ModeButton({ active, label, onClick, disabled = false }: { active: boolean; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`rounded-sm px-3 py-1.5 text-[10px] disabled:opacity-40 ${active ? "bg-gold text-ink" : "text-neutral-400 hover:text-neutral-200"}`}>
      {label}
    </button>
  );
}

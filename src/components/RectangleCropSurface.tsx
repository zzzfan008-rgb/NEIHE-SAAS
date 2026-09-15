import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Fractions of the displayed, orientation-corrected source image. */
export interface ImageCropRect { x: number; y: number; width: number; height: number }
interface Point { x: number; y: number }
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function boundImageCrop(rect: ImageCropRect, minWidth = 0.001, minHeight = 0.001): ImageCropRect {
  const width = clamp(rect.width, Math.min(minWidth, 1), 1);
  const height = clamp(rect.height, Math.min(minHeight, 1), 1);
  return { x: clamp(rect.x, 0, 1 - width), y: clamp(rect.y, 0, 1 - height), width, height };
}

const handles = [
  { key: "tl", label: "左上角", x: 0, y: 0 },
  { key: "t", label: "上边", x: 0.5, y: 0 },
  { key: "tr", label: "右上角", x: 1, y: 0 },
  { key: "r", label: "右边", x: 1, y: 0.5 },
  { key: "br", label: "右下角", x: 1, y: 1 },
  { key: "b", label: "下边", x: 0.5, y: 1 },
  { key: "bl", label: "左下角", x: 0, y: 1 },
  { key: "l", label: "左边", x: 0, y: 0.5 },
] as const;
type Handle = typeof handles[number]["key"];

export function RectangleCropSurface({
  source, alt, crop, onCropChange, disabled = false, minimumPixels = 1,
  className, imageClassName, actions, controlScale = 1, autoFocus = false,
  onImageLoad, onImageError, onConfirm, onCancel,
}: {
  source: string;
  alt: string;
  crop: ImageCropRect | null;
  onCropChange: (crop: ImageCropRect) => void;
  disabled?: boolean;
  minimumPixels?: number;
  className?: string;
  imageClassName?: string;
  actions?: ReactNode;
  controlScale?: number;
  autoFocus?: boolean;
  onImageLoad?: (image: HTMLImageElement) => void;
  onImageError?: () => void;
  onConfirm?: () => void;
  onCancel?: () => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ id: number; start: Point; before: ImageCropRect | null; mode: "draw" | "move" | Handle } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);
  const helpId = useId();
  const ready = size.width > 0 && size.height > 0;
  const minWidth = ready ? Math.min(1, minimumPixels / size.width) : 1;
  const minHeight = ready ? Math.min(1, minimumPixels / size.height) : 1;

  useEffect(() => {
    const element = surface.current!;
    const observer = new ResizeObserver(() => setLayout({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    if (autoFocus) element.focus({ preventScroll: true });
    return () => observer.disconnect();
  }, [autoFocus]);

  const bounded = (rect: ImageCropRect) => boundImageCrop(rect, minWidth, minHeight);
  const point = (event: PointerEvent): Point => {
    // Client bounds already include React Flow's zoom and all ancestor transforms.
    const box = surface.current!.getBoundingClientRect();
    return { x: clamp((event.clientX - box.left) / box.width, 0, 1), y: clamp((event.clientY - box.top) / box.height, 0, 1) };
  };
  const start = (event: PointerEvent, mode: "draw" | "move" | Handle) => {
    event.stopPropagation();
    if (disabled || !ready || event.button !== 0) return;
    event.preventDefault();
    surface.current!.focus({ preventScroll: true });
    gesture.current = { id: event.pointerId, start: point(event), before: crop, mode };
    surface.current!.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const resize = (rect: ImageCropRect, mode: Handle, p: Point): ImageCropRect => {
    let left = rect.x, right = rect.x + rect.width, top = rect.y, bottom = rect.y + rect.height;
    if (mode.includes("l")) left = clamp(p.x, 0, right - minWidth);
    if (mode.includes("r")) right = clamp(p.x, left + minWidth, 1);
    if (mode.includes("t")) top = clamp(p.y, 0, bottom - minHeight);
    if (mode.includes("b")) bottom = clamp(p.y, top + minHeight, 1);
    return bounded({ x: left, y: top, width: right - left, height: bottom - top });
  };
  const move = (event: PointerEvent) => {
    const drag = gesture.current;
    if (disabled || !drag || drag.id !== event.pointerId) return;
    const p = point(event);
    if (drag.mode === "draw") {
      // A click alone does not replace a selection with an accidental tiny crop.
      const box = surface.current!.getBoundingClientRect();
      if (Math.hypot((p.x - drag.start.x) * box.width, (p.y - drag.start.y) * box.height) < 3) return;
      onCropChange(bounded({ x: Math.min(p.x, drag.start.x), y: Math.min(p.y, drag.start.y), width: Math.abs(p.x - drag.start.x), height: Math.abs(p.y - drag.start.y) }));
    } else if (drag.before) {
      onCropChange(drag.mode === "move"
        ? bounded({ ...drag.before, x: drag.before.x + p.x - drag.start.x, y: drag.before.y + p.y - drag.start.y })
        : resize(drag.before, drag.mode, p));
    }
  };
  const finish = (event: PointerEvent) => {
    if (gesture.current?.id !== event.pointerId) return;
    gesture.current = null;
    setDragging(false);
    if (surface.current!.hasPointerCapture(event.pointerId)) surface.current!.releasePointerCapture(event.pointerId);
  };
  const moveWithKeyboard = (event: KeyboardEvent) => {
    if (disabled || !ready || !event.key.startsWith("Arrow")) return;
    event.preventDefault();
    const rect = crop ?? { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
    const step = event.shiftKey ? 10 : 1;
    onCropChange(bounded({ ...rect,
      x: rect.x + (event.key === "ArrowRight" ? step / size.width : event.key === "ArrowLeft" ? -step / size.width : 0),
      y: rect.y + (event.key === "ArrowDown" ? step / size.height : event.key === "ArrowUp" ? -step / size.height : 0),
    }));
  };
  const scale = Math.min(controlScale, layout.width > 0 ? layout.width / 80 : controlScale);
  const toolWidth = 72 * scale, toolHeight = 32 * scale, gap = 6 * scale;
  const cropBottom = crop ? (crop.y + crop.height) * layout.height : 0;
  const toolStyle: CSSProperties = {
    left: clamp(crop ? (crop.x + crop.width) * layout.width - toolWidth : (layout.width - toolWidth) / 2, 0, Math.max(0, layout.width - toolWidth)),
    top: crop
      ? clamp(cropBottom + gap + toolHeight <= layout.height ? cropBottom + gap : cropBottom - toolHeight - gap, 0, Math.max(0, layout.height - toolHeight))
      : Math.max(0, layout.height - toolHeight - gap),
    transform: `scale(${scale})`, transformOrigin: "top left",
  };

  return <div
    ref={surface}
    data-testid="crop-surface"
    role="group"
    aria-label="矩形裁切编辑区"
    aria-describedby={helpId}
    data-disabled={disabled}
    tabIndex={disabled ? -1 : 0}
    className={cn("nodrag nopan nowheel relative isolate touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--gc-accent)", className)}
    onPointerDown={(event) => start(event, "draw")}
    onPointerMove={move}
    onPointerUp={finish}
    onPointerCancel={finish}
    onLostPointerCapture={finish}
    onDoubleClick={(event) => event.stopPropagation()}
    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Escape" && onCancel) { event.preventDefault(); onCancel(); return; }
      if (event.key === "Enter" && event.target === event.currentTarget && !disabled && crop && onConfirm) { event.preventDefault(); onConfirm(); return; }
      if ((event.ctrlKey || event.metaKey) || ["Backspace", "Delete"].includes(event.key) || (event.key === " " && event.target === event.currentTarget)) { event.preventDefault(); return; }
      if (event.target === event.currentTarget) moveWithKeyboard(event);
    }}
  >
    <img src={source} alt={alt} draggable={false} className={cn("block max-w-full select-none", imageClassName)} style={{ filter: "grayscale(1) brightness(0.7)" }} onLoad={(event) => {
      const image = event.currentTarget;
      setSize({ width: image.naturalWidth, height: image.naturalHeight });
      onImageLoad?.(image);
    }} onError={onImageError} />
    {crop && <>
      <img src={source} alt="" aria-hidden="true" draggable={false} data-testid="crop-color-preview" className="pointer-events-none absolute inset-0 h-full w-full select-none" style={{ clipPath: `inset(${crop.y * 100}% ${(1 - crop.x - crop.width) * 100}% ${(1 - crop.y - crop.height) * 100}% ${crop.x * 100}%)` }} />
      <div
        data-testid="crop-selection"
        role="group"
        aria-label="裁切选区，方向键移动"
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        className="absolute cursor-move outline outline-(--gc-accent) focus-visible:outline-2"
        style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }}
        onPointerDown={(event) => start(event, "move")}
        onKeyDown={(event) => { if (event.target === event.currentTarget) { moveWithKeyboard(event); if (event.key === " ") event.preventDefault(); if (event.key === "Enter" && !disabled && onConfirm) { event.preventDefault(); onConfirm(); } } }}
      >
        {handles.map((handle) => <Button
          key={handle.key} type="button" variant="ghost" size="icon-xs"
          aria-label={`调整裁切${handle.label}`} disabled={disabled}
          className="absolute z-10 size-4 min-w-0 rounded-none p-0 hover:bg-transparent active:translate-y-0"
          style={{ left: `${handle.x * 100}%`, top: `${handle.y * 100}%`, transform: `translate(-50%, -50%) scale(${scale})`, cursor: handle.key === "tl" || handle.key === "br" ? "nwse-resize" : handle.key === "tr" || handle.key === "bl" ? "nesw-resize" : handle.x === 0.5 ? "ns-resize" : "ew-resize" }}
          onPointerDown={(event) => start(event, handle.key)}
          onKeyDown={(event) => {
            if (!ready || !event.key.startsWith("Arrow")) return;
            event.preventDefault(); event.stopPropagation();
            const step = event.shiftKey ? 10 : 1;
            onCropChange(resize(crop, handle.key, {
              x: crop.x + crop.width * handle.x + (event.key === "ArrowRight" ? step / size.width : event.key === "ArrowLeft" ? -step / size.width : 0),
              y: crop.y + crop.height * handle.y + (event.key === "ArrowDown" ? step / size.height : event.key === "ArrowUp" ? -step / size.height : 0),
            }));
          }}
        ><span aria-hidden="true" className="pointer-events-none size-1.5 border border-white bg-(--gc-accent)" /></Button>)}
      </div>
    </>}
    {actions && !dragging && <div className="absolute z-20" style={toolStyle} onPointerDown={(event) => event.stopPropagation()}>{actions}</div>}
    <span id={helpId} className="sr-only">鼠标左键拖动框选，框外灰度、框内原色。拖动选区移动，拖动边角调整。方向键微调，Shift 加速。</span>
  </div>;
}

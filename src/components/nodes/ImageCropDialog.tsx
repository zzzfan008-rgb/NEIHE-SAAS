import { useId, useRef, useState, type PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

type Shape = "rectangle" | "circle" | "ellipse";
type Ratio = "free" | "original" | "square";
interface Rect { x: number; y: number; width: number; height: number }
interface Point { x: number; y: number }
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** All geometry is in decoded source pixels, never CSS pixels or canvas zoom. */
function fitRect(rect: Rect, width: number, height: number, ratio?: number): Rect {
  let w = clamp(rect.width, 1, width);
  let h = clamp(rect.height, 1, height);
  if (ratio) {
    w = Math.min(w, h * ratio);
    h = w / ratio;
  }
  return { x: clamp(rect.x, 0, width - w), y: clamp(rect.y, 0, height - h), width: w, height: h };
}

export default function ImageCropDialog({ source, onSave, onClose }: {
  source: string;
  onSave: (file: File) => Promise<void>;
  onClose: () => void;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ pointerId: number; start: Point; rect: Rect; anchor?: Point } | null>(null);
  const maskId = useId();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [shape, setShape] = useState<Shape>("rectangle");
  const [ratio, setRatio] = useState<Ratio>("free");
  const [rect, setRect] = useState<Rect>({ x: 0, y: 0, width: 1, height: 1 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const aspect = shape === "circle" || (shape === "rectangle" && ratio === "square") ? 1
    : shape === "rectangle" && ratio === "original" ? size.width / size.height : undefined;
  const ready = size.width > 0;
  const initialRect = (width: number, height: number) => ({ x: width * .1, y: height * .1, width: width * .8, height: height * .8 });
  const chooseShape = (next: Shape) => {
    setShape(next);
    setRect(fitRect(rect, size.width, size.height, next === "circle" ? 1 : next === "rectangle" && ratio !== "free" ? ratio === "square" ? 1 : size.width / size.height : undefined));
  };
  const chooseRatio = (next: Ratio) => {
    setRatio(next);
    setRect(fitRect(rect, size.width, size.height, next === "square" ? 1 : next === "original" ? size.width / size.height : undefined));
  };
  const point = (event: PointerEvent): Point => {
    const box = surfaceRef.current!.getBoundingClientRect();
    return { x: clamp((event.clientX - box.x) / box.width * size.width, 0, size.width), y: clamp((event.clientY - box.y) / box.height * size.height, 0, size.height) };
  };
  const start = (event: PointerEvent, mode: "draw" | "move" | "tl" | "tr" | "br" | "bl") => {
    if (!ready || busy || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const p = point(event);
    const anchor = mode === "draw" ? p : mode === "move" ? undefined : {
      x: mode.endsWith("l") ? rect.x + rect.width : rect.x,
      y: mode.startsWith("t") ? rect.y + rect.height : rect.y,
    };
    gesture.current = { pointerId: event.pointerId, start: p, rect, anchor };
    surfaceRef.current!.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    const drag = gesture.current;
    if (!drag || drag.pointerId !== event.pointerId || busy) return;
    const p = point(event);
    if (!drag.anchor) {
      setRect(fitRect({ ...drag.rect, x: drag.rect.x + p.x - drag.start.x, y: drag.rect.y + p.y - drag.start.y }, size.width, size.height, aspect));
      return;
    }
    const a = drag.anchor;
    let width = Math.max(1, Math.abs(p.x - a.x));
    let height = Math.max(1, Math.abs(p.y - a.y));
    if (aspect) {
      width = Math.min(width, height * aspect);
      height = width / aspect;
    }
    setRect(fitRect({ x: p.x < a.x ? a.x - width : a.x, y: p.y < a.y ? a.y - height : a.y, width, height }, size.width, size.height, aspect));
  };
  const finishGesture = () => { gesture.current = null; };
  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      // Integer source coordinates avoid resampling/stretching the selected pixels.
      const x = Math.floor(rect.x), y = Math.floor(rect.y);
      const width = Math.max(1, Math.min(size.width - x, Math.floor(rect.width)));
      const height = Math.max(1, Math.min(size.height - y, Math.floor(rect.height)));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("浏览器暂不支持裁切，请重试");
      if (shape !== "rectangle") {
        ctx.beginPath();
        ctx.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
        ctx.clip();
      }
      ctx.drawImage(imageRef.current!, x, y, width, height, 0, 0, width, height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("裁切导出失败，请重试")), "image/png"));
      await onSave(new File([blob], "裁切图片.png", { type: "image/png" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "裁切保存失败，请重试");
    } finally {
      setBusy(false);
    }
  };
  const corners = [
    { key: "tl", label: "左上", x: 0, y: 0 }, { key: "tr", label: "右上", x: 1, y: 0 },
    { key: "br", label: "右下", x: 1, y: 1 }, { key: "bl", label: "左下", x: 0, y: 1 },
  ] as const;
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent showCloseButton={false} overlayClassName="motion-reduce:animate-none" className="nodrag nopan flex max-h-[calc(100vh-32px)] flex-col gap-3 overflow-auto border border-(--gc-border) bg-(--gc-panel) text-(--gc-text) motion-reduce:animate-none sm:max-w-[820px]" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <DialogTitle>裁切图片</DialogTitle>
      <DialogDescription>选择形状后拖动框选；拖动选区移动，拖动四角调整。保存后替换当前图片，原素材保留。</DialogDescription>
      <div className="flex items-center gap-2" role="group" aria-label="裁切形状">
        {([["rectangle", "矩形"], ["circle", "圆形"], ["ellipse", "椭圆"]] as const).map(([value, label]) => <Button key={value} size="sm" variant={shape === value ? "secondary" : "ghost"} aria-pressed={shape === value} disabled={!ready || busy} onClick={() => chooseShape(value)}>{label}</Button>)}
        {shape === "rectangle" && <div className="ml-auto flex gap-1" role="group" aria-label="裁切比例">
          {([["free", "自由比例"], ["original", "原图比例"], ["square", "1:1"]] as const).map(([value, label]) => <Button key={value} size="sm" variant={ratio === value ? "secondary" : "ghost"} aria-pressed={ratio === value} disabled={!ready || busy} onClick={() => chooseRatio(value)}>{label}</Button>)}
        </div>}
      </div>
      <div className="flex min-h-0 justify-center overflow-hidden rounded-xl border border-(--gc-border) bg-(--gc-bg) p-3">
        <div ref={surfaceRef} className="relative touch-none select-none" style={{ lineHeight: 0 }} onPointerDown={(event) => start(event, "draw")} onPointerMove={move} onPointerUp={finishGesture} onPointerCancel={finishGesture} onLostPointerCapture={finishGesture}>
          <img ref={imageRef} src={source} alt="裁切原图" draggable={false} className="block max-h-[42vh] max-w-full object-contain" onLoad={(event) => {
            const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
            if (!width || !height || width * height > 40_000_000) { setError("图片尺寸过大，无法裁切"); return; }
            setSize({ width, height }); setRect(initialRect(width, height));
          }} onError={() => setError("图片加载失败，请关闭后重试")} />
          {ready && <>
            <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden="true">
              <defs><mask id={maskId}><rect width={size.width} height={size.height} fill="white" />{shape === "rectangle" ? <rect {...rect} fill="black" /> : <ellipse cx={rect.x + rect.width / 2} cy={rect.y + rect.height / 2} rx={rect.width / 2} ry={rect.height / 2} fill="black" />}</mask></defs>
              <rect width={size.width} height={size.height} fill="black" opacity=".55" mask={`url(#${maskId})`} />
            </svg>
            <div data-testid="crop-selection" role="group" aria-label="裁切选区，方向键移动" tabIndex={busy ? -1 : 0} className="absolute cursor-move border-2 border-(--gc-accent) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--gc-accent)" style={{ left: `${rect.x / size.width * 100}%`, top: `${rect.y / size.height * 100}%`, width: `${rect.width / size.width * 100}%`, height: `${rect.height / size.height * 100}%`, borderRadius: shape === "rectangle" ? 0 : "50%" }} onPointerDown={(event) => start(event, "move")} onKeyDown={(event) => {
              if (busy || event.target !== event.currentTarget || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
              event.preventDefault(); const step = event.shiftKey ? 10 : 1;
              setRect(fitRect({ ...rect, x: rect.x + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0), y: rect.y + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0) }, size.width, size.height, aspect));
            }}>
              {corners.map((corner) => <Button key={corner.key} size="icon-xs" variant="outline" aria-label={`调整裁切${corner.label}角`} disabled={busy} className="absolute size-5 rounded-sm border-(--gc-accent) bg-(--gc-panel)" style={{ left: `${corner.x * 100}%`, top: `${corner.y * 100}%`, transform: "translate(-50%, -50%)", cursor: corner.key === "tl" || corner.key === "br" ? "nwse-resize" : "nesw-resize" }} onPointerDown={(event) => start(event, corner.key)} onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
                event.preventDefault(); event.stopPropagation();
                const delta = (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) * (event.shiftKey ? 10 : 1);
                const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
                const w = rect.width + (horizontal ? (corner.x ? delta : -delta) : aspect ? (corner.y ? delta : -delta) * aspect : 0);
                const h = rect.height + (!horizontal ? (corner.y ? delta : -delta) : aspect ? (corner.x ? delta : -delta) / aspect : 0);
                setRect(fitRect({ x: corner.x ? rect.x : rect.x + rect.width - w, y: corner.y ? rect.y : rect.y + rect.height - h, width: w, height: h }, size.width, size.height, aspect));
              }} />)}
            </div>
          </>}
        </div>
      </div>
      <div className="grid grid-cols-4 gap-3">
        {([["x", "左边距"], ["y", "上边距"], ["width", "宽度"], ["height", "高度"]] as const).map(([field, label]) => <label key={field} className="space-y-1 text-xs text-(--gc-text-muted)">{label}（px）<Input type="number" aria-label={`裁切${label}`} min={field === "x" || field === "y" ? 0 : 1} max={field === "x" || field === "width" ? size.width : size.height} value={Math.floor(rect[field])} disabled={!ready || busy} onChange={(event) => {
          const value = event.currentTarget.valueAsNumber;
          if (!Number.isFinite(value)) return;
          const next = { ...rect, [field]: value };
          if (aspect && field === "width") next.height = value / aspect;
          if (aspect && field === "height") next.width = value * aspect;
          setRect(fitRect(next, size.width, size.height, aspect));
        }} /></label>)}
      </div>
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      <div className="flex items-center gap-2 border-t border-(--gc-border) pt-3">
        <Button variant="ghost" disabled={!ready || busy} onClick={() => { setShape("rectangle"); setRatio("free"); setRect(initialRect(size.width, size.height)); setError(""); }}>重置</Button>
        <span className="mr-auto text-xs text-(--gc-text-muted)">{shape === "rectangle" ? "按源图像素裁切，不拉伸" : "形状外透明 · PNG"}</span>
        <Button variant="outline" onClick={onClose}>取消</Button>
        <Button disabled={!ready || busy} onClick={() => void save()}>{busy ? "保存中…" : "确认裁切"}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}

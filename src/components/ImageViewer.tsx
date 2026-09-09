import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { selectActiveSelectedResultId, useFlowStore } from "@/store/flowStore";
import { thumbnailImageUrl } from "@/lib/images";
import { useGenerationSafetyBlockReason } from "@/store/generationSafety";
import { Button } from "@/components/ui/button";
import { XIcon } from "lucide-react";

const MIN_SCALE = 1;
const MAX_SCALE = 5;

interface ViewTransform {
  scale: number;
  x: number;
  y: number;
}

interface DragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
}

const INITIAL_TRANSFORM: ViewTransform = { scale: MIN_SCALE, x: 0, y: 0 };

/**
 * 全局图片查看器：单击任意图片弹出，
 * 滚轮缩放（1x ~ 5x）、放大后拖动查看，双击复位，Esc / 点击背景关闭。
 * 附带运行记录信息栏（来自最近生成的条目）。
 */
export function ImageViewer() {
  const viewer = useFlowStore((s) => s.viewer);
  const selectedResultId = useFlowStore(selectActiveSelectedResultId);
  const record = useFlowStore((s) => s.recentResults.find((item) => item.id === selectedResultId));
  const closeViewer = useFlowStore((s) => s.closeViewer);
  const generationSafetyBlockReason = useGenerationSafetyBlockReason();
  const [transform, setTransform] = useState<ViewTransform>(INITIAL_TRANSFORM);
  const [dragging, setDragging] = useState(false);
  const [assetState, setAssetState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const imgRef = useRef<HTMLImageElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  const clampPan = (x: number, y: number, scale: number) => {
    const image = imgRef.current;
    const stage = stageRef.current;
    if (!image || !stage || scale <= MIN_SCALE) return { x: 0, y: 0 };

    const stageStyle = window.getComputedStyle(stage);
    const availableWidth = Math.max(
      0,
      stage.clientWidth - Number.parseFloat(stageStyle.paddingLeft) - Number.parseFloat(stageStyle.paddingRight),
    );
    const availableHeight = Math.max(
      0,
      stage.clientHeight - Number.parseFloat(stageStyle.paddingTop) - Number.parseFloat(stageStyle.paddingBottom),
    );
    const maxX = Math.max(0, (image.offsetWidth * scale - availableWidth) / 2);
    const maxY = Math.max(0, (image.offsetHeight * scale - availableHeight) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, x)),
      y: Math.min(maxY, Math.max(-maxY, y)),
    };
  };

  // 每次打开新图时复位缩放
  useEffect(() => {
    setTransform(INITIAL_TRANSFORM);
    setDragging(false);
    dragRef.current = null;
    setAssetState("idle");
  }, [viewer?.url]);

  useEffect(() => {
    overlayRef.current?.focus();
  }, [viewer?.url]);

  // 使用原生非 passive 监听，保证滚轮缩放时页面不会跟随滚动。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !viewer) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const stageRect = stage.getBoundingClientRect();
      const pointerX = e.clientX - (stageRect.left + stageRect.width / 2);
      const pointerY = e.clientY - (stageRect.top + stageRect.height / 2);
      setTransform((current) => {
        const scale = Math.min(
          MAX_SCALE,
          Math.max(MIN_SCALE, current.scale * Math.exp(-e.deltaY * 0.0015)),
        );
        const ratio = scale / current.scale;
        const next = clampPan(
          pointerX - ratio * (pointerX - current.x),
          pointerY - ratio * (pointerY - current.y),
          scale,
        );
        return { scale, ...next };
      });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [viewer]);

  useEffect(() => {
    const stage = stageRef.current;
    const image = imgRef.current;
    if (!stage || !image) return;
    const observer = new ResizeObserver(() => {
      setTransform((current) => ({
        ...current,
        ...clampPan(current.x, current.y, current.scale),
      }));
    });
    observer.observe(stage);
    observer.observe(image);
    return () => observer.disconnect();
  }, [viewer?.url]);

  if (!viewer) return null;

  const saveAsAsset = async () => {
    setAssetState("saving");
    try {
      const response = await fetch("/api/assets", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${record?.nodeLabel ?? viewer.title ?? "生成素材"}-${new Date().toLocaleDateString("zh-CN")}`,
          category: viewer.assetCategory ?? "generated",
          image: viewer.url,
          sourceNote: record?.projectName ? `来自项目「${record.projectName}」` : "来自生成记录",
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setAssetState("saved");
    } catch {
      setAssetState("error");
    }
  };

  const runAgain = () => {
    if (!record || generationSafetyBlockReason) return;
    const store = useFlowStore.getState();
    const tab = store.tabs.find((item) => item.projectId === record.projectId);
    if (!tab || !tab.nodes.some((node) => node.id === record.nodeId)) return;
    store.switchTab(tab.id);
    closeViewer();
    window.setTimeout(() => void useFlowStore.getState().runNode(record.nodeId), 0);
  };

  const startPan = (event: ReactPointerEvent<HTMLImageElement>) => {
    event.stopPropagation();
    if (event.button !== 0 || transform.scale <= MIN_SCALE) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: transform.x,
      startY: transform.y,
    };
    setDragging(true);
  };

  const movePan = (event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const next = clampPan(
      drag.startX + event.clientX - drag.startClientX,
      drag.startY + event.clientY - drag.startClientY,
      transform.scale,
    );
    setTransform((current) => ({ ...current, ...next }));
  };

  const stopPan = (event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
  };

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-stretch bg-black/85"
      onClick={closeViewer}
      role="dialog"
      aria-modal="true"
      aria-label="图片查看器"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          closeViewer();
        }
      }}
    >
      <div
        ref={stageRef}
        data-testid="image-viewer-stage"
        className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden p-8"
      >
        <img
          ref={imgRef}
          data-testid="image-viewer-image"
          src={viewer.url}
          alt={viewer.title ?? "图片预览"}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setTransform(INITIAL_TRANSFORM);
          }}
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={stopPan}
          onPointerCancel={stopPan}
          className={`max-h-full max-w-full touch-none select-none rounded-lg object-contain shadow-2xl ${
            transform.scale > MIN_SCALE
              ? dragging ? "cursor-grabbing" : "cursor-grab"
              : "cursor-default"
          }`}
          style={{ transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})` }}
          draggable={false}
        />
      </div>
      <span aria-hidden="true" className="absolute left-4 top-4 text-[11px] text-neutral-400">
        滚轮缩放 {Math.round(transform.scale * 100)}%（最大 500%）· 放大后拖动查看 · 双击复位 · Esc 关闭
      </span>
      <aside className="w-[400px] shrink-0 overflow-y-auto border-l border-[#333] bg-[#141414]/98 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium text-neutral-100">{record?.nodeLabel ?? viewer.title ?? "生成结果"}</h2>
            <p className="mt-1 text-[10px] text-neutral-500">{record?.projectName ?? "当前项目"}</p>
          </div>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭图片查看器" onClick={closeViewer}>
            <XIcon className="size-4" />
          </Button>
        </div>
        <dl className="mt-5 space-y-2 border-y border-[#2b2b2b] py-4 text-[11px]">
          {[
            ["状态", record?.status === "success" ? "成功" : record?.status === "error" ? "失败" : "生成中"],
            ["模型", record?.model ?? "—"],
            ["数量", record?.requestedCount ? `${record.successfulCount ?? 0}/${record.requestedCount}` : "—"],
            ["服务请求", record?.providerRequests ?? "—"],
            ["开始时间", record?.startedAt ? new Date(record.startedAt).toLocaleString("zh-CN") : "—"],
            ["耗时", record?.finishedAt && record.startedAt ? `${((record.finishedAt - record.startedAt) / 1000).toFixed(1)}s` : "—"],
          ].map(([label, value]) => <div key={String(label)} className="flex justify-between gap-4"><dt className="text-neutral-500">{label}</dt><dd className="text-right text-neutral-300">{value}</dd></div>)}
        </dl>
        {(record?.prompt || viewer.prompt) && <div className="mt-4"><p className="text-[10px] text-neutral-500">提示词</p><p className="mt-1 whitespace-pre-wrap rounded-lg border border-[#2b2b2b] bg-[#0f0f0f] p-3 text-[11px] leading-relaxed text-neutral-300">{record?.prompt ?? viewer.prompt}</p><Button type="button" variant="outline" size="xs" onClick={() => void navigator.clipboard.writeText(record?.prompt ?? viewer.prompt ?? "")} className="mt-2">复制提示词</Button></div>}
        {record?.referenceImages && record.referenceImages.length > 0 && <div className="mt-4"><p className="text-[10px] text-neutral-500">参考图 · {record.referenceImages.length} 张</p><div className="mt-2 grid grid-cols-4 gap-2">{record.referenceImages.map((image, index) => <img key={`${image}-${index}`} src={thumbnailImageUrl(image)} alt={`参考图 ${index + 1}`} loading="lazy" decoding="async" className="aspect-square w-full rounded-sm border border-[#333] object-cover" />)}</div></div>}
        {record?.parameters && Object.keys(record.parameters).length > 0 && <details className="mt-4 rounded-lg border border-[#2b2b2b] p-3 text-[10px] text-neutral-400"><summary className="cursor-pointer">生成参数</summary><pre className="mt-2 whitespace-pre-wrap break-all">{JSON.stringify(record.parameters, null, 2)}</pre></details>}
        {record?.error && <div className="mt-4 rounded-lg border border-red-900/50 bg-red-950/20 p-3 text-[11px] text-red-300">{record.error}</div>}
        <div className="mt-5 flex flex-wrap gap-2">
          <a href={viewer.url} download className="rounded-sm bg-gold px-3 py-1.5 text-[11px] font-medium text-ink">下载图片</a>
          <Button type="button" variant="outline" size="xs" onClick={() => void saveAsAsset()} disabled={assetState === "saving" || assetState === "saved"} className="text-[11px] text-neutral-300 disabled:opacity-60">{assetState === "saving" ? "收藏中…" : assetState === "saved" ? "已收藏" : assetState === "error" ? "收藏失败，重试" : "收藏为资产"}</Button>
          {record && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={runAgain}
              disabled={Boolean(generationSafetyBlockReason)}
              title={generationSafetyBlockReason ?? undefined}
              className="text-[11px] text-neutral-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {generationSafetyBlockReason ? "生成暂不可用" : "重新生成"}
            </Button>
          )}
        </div>
      </aside>
    </div>
  );
}

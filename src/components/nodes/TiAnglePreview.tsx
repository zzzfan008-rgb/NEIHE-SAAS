import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { RefreshCwIcon, Rotate3dIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createTiAngleScene, type TiAngleSceneApi } from "@/lib/tiAngleScene";
import type { TiAngleDragMode } from "@/lib/tiAngleGeometry";
import type { TiAngleConfig } from "@/types/workflow";

interface TiAnglePreviewProps {
  image?: string;
  config: TiAngleConfig;
  disabled?: boolean;
  onCommit: (config: TiAngleConfig) => void;
}

interface ActiveDrag {
  pointerId: number;
  startX: number;
  startY: number;
  start: TiAngleConfig;
  mode: TiAngleDragMode;
  changed: boolean;
}

type PreviewScene = TiAngleSceneApi;

type TextureState = "empty" | "loading" | "loaded" | "error";


function signedAngle(value: number): string {
  return `${value > 0 ? "+" : ""}${value}°`;
}

function sameAngle(left: TiAngleConfig, right: TiAngleConfig): boolean {
  return (
    left.azimuthDeg === right.azimuthDeg &&
    left.elevationDeg === right.elevationDeg &&
    left.rollDeg === right.rollDeg &&
    left.enabled === right.enabled &&
    left.framing === right.framing &&
    left.lighting?.azimuthDeg === right.lighting?.azimuthDeg &&
    left.lighting?.elevationDeg === right.lighting?.elevationDeg &&
    left.lighting?.pattern === right.lighting?.pattern &&
    left.lighting?.style === right.lighting?.style
  );
}


export function TiAnglePreview({ image, config, disabled = false, onCommit }: TiAnglePreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draftRef = useRef(config);
  const activeDragRef = useRef<ActiveDrag | null>(null);
  const sceneRef = useRef<PreviewScene | null>(null);
  const [draft, setDraft] = useState(config);
  const [rendererError, setRendererError] = useState<string | null>(null);
  const [textureState, setTextureState] = useState<TextureState>(image ? "loading" : "empty");
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (activeDragRef.current) return;
    draftRef.current = config;
    setDraft(config);
  }, [config]);

  useEffect(() => {
    draftRef.current = draft;
    sceneRef.current?.render();
  }, [draft]);

  useEffect(() => {
    let cancelled = false;
    let currentScene: PreviewScene | null = null;
    sceneRef.current?.dispose();
    sceneRef.current = null;
    setRendererError(null);
    setTextureState(image ? "loading" : "empty");

    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return undefined;

    void Promise.all([
      import("@/lib/tiAngleThreeRuntime"),
      import("@/lib/tiAngleThreeRenderer"),
    ]).then(([THREE, rendererModule]) => {
      if (cancelled) return;

      try {
        const renderer = new rendererModule.WebGLRenderer({
          canvas,
          antialias: true,
          alpha: true,
          powerPreference: "low-power",
        });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        renderer.setPixelRatio(dpr);
        renderer.setClearColor(0x000000, 0);

        const scene = createTiAngleScene({
          THREE,
          renderer,
          canvas,
          image,
          getConfig: () => draftRef.current,
          onTextureState: (state) => {
            if (cancelled) return;
            setTextureState(state);
            if (state === "error") {
              setRendererError("示意参考图无法加载，仍可使用空场景调整视角");
            }
          },
        });

        const resize = () => {
          const rect = host.getBoundingClientRect();
          const width = Math.max(1, Math.floor(rect.width || host.clientWidth || 280));
          const height = Math.max(1, Math.floor(rect.height || host.clientHeight || 208));
          scene.resize(width, height);
        };

        const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
        resizeObserver?.observe(host);
        window.addEventListener("resize", resize);

        const handleContextLost = (event: Event) => {
          event.preventDefault();
          setRendererError("WebGL 预览暂时不可用，可重试恢复");
        };
        const handleContextRestored = () => {
          setRendererError(null);
          resize();
        };
        canvas.addEventListener("webglcontextlost", handleContextLost, false);
        canvas.addEventListener("webglcontextrestored", handleContextRestored, false);

        currentScene = {
          render: scene.render,
          hitTest: scene.hitTest,
          drag: scene.drag,
          resize: scene.resize,
          zoom: scene.zoom,
          dispose: () => {
            resizeObserver?.disconnect();
            window.removeEventListener("resize", resize);
            canvas.removeEventListener("webglcontextlost", handleContextLost);
            canvas.removeEventListener("webglcontextrestored", handleContextRestored);
            scene.dispose();
          },
        };
        sceneRef.current = currentScene;
        resize();
      } catch {
        setTextureState(image ? "error" : "empty");
        setRendererError("WebGL 预览暂时不可用，可重试恢复");
      }
    }).catch(() => {
      if (!cancelled) {
        setTextureState(image ? "error" : "empty");
        setRendererError("Three.js 预览加载失败，可重试恢复");
      }
    });

    return () => {
      cancelled = true;
      if (sceneRef.current === currentScene) {
        sceneRef.current?.dispose();
        sceneRef.current = null;
      }
    };
  }, [image, retryNonce]);

  useEffect(() => {
    const cancelDrag = () => {
      const active = activeDragRef.current;
      if (!active) return;
      activeDragRef.current = null;
      draftRef.current = active.start;
      setDraft(active.start);
    };
    window.addEventListener("blur", cancelDrag);
    return () => window.removeEventListener("blur", cancelDrag);
  }, []);

  const updateDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const active = activeDragRef.current;
    if (!active) {
      const mode = disabled
        ? null
        : sceneRef.current?.hitTest(event.clientX, event.clientY);
      event.currentTarget.style.cursor = mode ? "grab" : "default";
      return;
    }
    if (event.pointerId !== active.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.style.cursor = "grabbing";
    const next: TiAngleConfig = sceneRef.current?.drag(
      active.start,
      active.mode,
      active.startX,
      active.startY,
      event.clientX,
      event.clientY,
    ) ?? active.start;
    active.changed = !sameAngle(active.start, next);
    // Render straight from the ref so the canvas tracks the pointer even when
    // the committed draft value (and therefore React state) has not changed.
    draftRef.current = next;
    sceneRef.current?.render();
    setDraft((previous) => (sameAngle(previous, next) ? previous : next));
  };

  const finishDrag = (event: ReactPointerEvent<HTMLCanvasElement>, commit: boolean) => {
    const active = activeDragRef.current;
    if (!active || event.pointerId !== active.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const next = draftRef.current;
    activeDragRef.current = null;
    if (commit && active.changed && !sameAngle(active.start, next)) onCommit(next);
    if (!commit) {
      draftRef.current = active.start;
      setDraft(active.start);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.currentTarget.style.cursor = "default";
  };

  const cancelDrag = () => {
    const active = activeDragRef.current;
    if (!active) return;
    activeDragRef.current = null;
    draftRef.current = active.start;
    setDraft(active.start);
    if (canvasRef.current) canvasRef.current.style.cursor = "default";
  };


  const handleWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    sceneRef.current?.zoom(event.deltaY);
  };
  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const mode = sceneRef.current?.hitTest(event.clientX, event.clientY);
    event.currentTarget.focus();
    if (!mode) return;
    event.preventDefault();
    event.stopPropagation();
    activeDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      start: draftRef.current,
      mode,
      changed: false,
    };
    event.currentTarget.style.cursor = "grabbing";
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  return (
    <div
      ref={hostRef}
      data-ti-angle-preview="true"
      data-ti-angle-image-state={textureState}
      aria-label="3D 视角预览"
      className="relative h-52 overflow-hidden rounded-lg border border-[var(--gc-node-border)] bg-[#38383b]"
    >
      <canvas
        ref={canvasRef}
        aria-label="Three.js 3D 视角交互预览"
        className="nodrag nopan nowheel absolute inset-0 size-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-[var(--gc-accent)]"
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        data-disabled={disabled ? "true" : undefined}
        style={{ opacity: disabled ? 0.72 : 1 }}
        onPointerDown={handlePointerDown}
        onPointerMove={updateDrag}
        onPointerUp={(event) => finishDrag(event, true)}
        onPointerCancel={(event) => finishDrag(event, false)}
        onPointerLeave={(event) => {
          if (!activeDragRef.current) event.currentTarget.style.cursor = "default";
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") cancelDrag();
        }}
        onBlur={cancelDrag}
        onWheel={handleWheel}
      />
      <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-1 text-[9px] text-[var(--gc-node-muted)]">
        <Rotate3dIcon aria-hidden="true" className="size-3" />
        拖动调整视角 · 旋钮倾斜 · 滚轮缩放
      </div>
      <span className="sr-only">示意参考图</span>
      <div className="pointer-events-none absolute top-2 right-2 rounded bg-[var(--gc-node-main)]/80 px-1.5 py-0.5 font-mono text-[9px] text-[var(--gc-node-muted)]">
        {signedAngle(draft.azimuthDeg)} / {signedAngle(draft.elevationDeg)} / {signedAngle(draft.rollDeg)}
        {draft.lighting ? ` · 光 ${draft.lighting.azimuthDeg}°/${draft.lighting.elevationDeg}°` : ""}
      </div>
      {rendererError && (
        <div className="absolute inset-x-2 bottom-2 flex items-center justify-between gap-2 rounded-md border border-[var(--gc-node-border)] bg-[var(--gc-node-main)]/90 px-2 py-1 text-[9px] text-[var(--gc-node-muted)]">
          <span>{rendererError}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="重试 3D 预览"
            onClick={() => setRetryNonce((value) => value + 1)}
            className="nodrag"
          >
            <RefreshCwIcon aria-hidden="true" />
          </Button>
        </div>
      )}
      {image && textureState === "loading" && <span className="sr-only">正在加载示意参考图</span>}
      {image && textureState === "loaded" && <span className="sr-only">已加载示意参考图</span>}
      {image && textureState === "error" && <span className="sr-only">示意参考图加载失败</span>}
    </div>
  );
}

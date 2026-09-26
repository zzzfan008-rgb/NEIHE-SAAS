import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { BODY_CONNECTIONS, FOOT_CONNECTIONS, HAND_CONNECTIONS } from "@/lib/poseTopology";
import { screenToPosePoint, type PosePointPath } from "@/lib/poseEditorModel";
import type { PoseDocumentV1, PosePersonV1, PosePointV1 } from "@/types/poseDocument";
import { posePointLabel, posePointLayer, type PoseEditorLayer } from "./poseEditorLabels";

const LAYER_COLORS: Record<PoseEditorLayer, string> = {
  body: "#69a8ff",
  hands: "#58d6a7",
  feet: "#ffb15e",
  face: "#e58bc4",
};
const FACE_CONNECTIONS = [
  ...Array.from({ length: 16 }, (_, index) => [index, index + 1] as const),
  ...Array.from({ length: 4 }, (_, index) => [17 + index, 18 + index] as const),
  ...Array.from({ length: 4 }, (_, index) => [22 + index, 23 + index] as const),
  ...Array.from({ length: 8 }, (_, index) => [27 + index, 28 + index] as const),
  ...Array.from({ length: 6 }, (_, index) => [36 + index, 36 + ((index + 1) % 6)] as const),
  ...Array.from({ length: 6 }, (_, index) => [42 + index, 42 + ((index + 1) % 6)] as const),
  ...Array.from({ length: 11 }, (_, index) => [48 + index, 49 + index] as const),
  [48, 59],
  ...Array.from({ length: 7 }, (_, index) => [60 + index, 61 + index] as const),
  [60, 67],
] as const;

type DragAction =
  | { kind: "point"; pointerId: number; path: PosePointPath }
  | { kind: "pan"; pointerId: number; startX: number; startY: number; startPan: { x: number; y: number } }
  | null;

type PoseEditor2DProps = {
  imageUrl: string;
  document: PoseDocumentV1;
  activePersonId: string;
  activePoint: PosePointPath | null;
  layers: Record<PoseEditorLayer, boolean>;
  zoom: number;
  pan: { x: number; y: number };
  onZoomChange: (zoom: number) => void;
  onPanChange: (pan: { x: number; y: number }) => void;
  onSelectPoint: (path: PosePointPath) => void;
  onBeginPointDrag: (path: PosePointPath) => void;
  onDraftPoint: (path: PosePointPath, point: PosePointV1) => void;
  onFinishPointDrag: () => void;
  onNudgePoint: (path: PosePointPath, dx: number, dy: number) => void;
  onSetMissingPoint: (path: PosePointPath, point: { x: number; y: number }) => void;
};

type PointMark = { path: PosePointPath; label: string; point: NonNullable<PosePointV1>; layer: PoseEditorLayer };

function pointKey(path: PosePointPath): string {
  return `${path.personId}:${path.group}:${"index" in path ? path.index : "center"}`;
}

function personPoint(person: PosePersonV1, group: PosePointPath["group"], index?: number): PosePointV1 {
  if (group === "neck" || group === "midHip") return person[group];
  if (group === "leftHand") return person.hands.left[index ?? -1] ?? null;
  if (group === "rightHand") return person.hands.right[index ?? -1] ?? null;
  return person[group][index ?? -1] ?? null;
}

function samePath(a: PosePointPath | null, b: PosePointPath): boolean {
  return a !== null && pointKey(a) === pointKey(b);
}

export function PoseEditor2D({
  imageUrl,
  document,
  activePersonId,
  activePoint,
  layers,
  zoom,
  pan,
  onZoomChange,
  onPanChange,
  onSelectPoint,
  onBeginPointDrag,
  onDraftPoint,
  onFinishPointDrag,
  onNudgePoint,
  onSetMissingPoint,
}: PoseEditor2DProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragAction>(null);
  const movedRef = useRef(false);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [panMode, setPanMode] = useState(false);
  const person = document.people.find((candidate) => candidate.id === activePersonId) ?? document.people[0];
  const scale = viewportSize.width > 0 && viewportSize.height > 0
    ? Math.min(viewportSize.width / document.canvas.width, viewportSize.height / document.canvas.height) * zoom
    : 1;
  const imageWidth = document.canvas.width * scale;
  const imageHeight = document.canvas.height * scale;
  const imageLeft = (viewportSize.width - imageWidth) / 2 + pan.x;
  const imageTop = (viewportSize.height - imageHeight) / 2 + pan.y;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    });
    observer.observe(viewport);
    setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    return () => observer.disconnect();
  }, []);

  const marks = useMemo(() => {
    const result: PointMark[] = [];
    const push = (group: PosePointPath["group"], points: PosePointV1[]) => {
      points.forEach((point, index) => {
        if (!point) return;
        const path: PosePointPath = group === "neck" || group === "midHip"
          ? { personId: person.id, group }
          : { personId: person.id, group: group as "body" | "feet" | "face" | "leftHand" | "rightHand", index };
        const layer = posePointLayer(path);
        if (layers[layer]) result.push({ path, label: posePointLabel(path), point, layer });
      });
    };
    push("body", person.body);
    push("feet", person.feet);
    push("face", person.face);
    push("leftHand", person.hands.left);
    push("rightHand", person.hands.right);
    push("neck", [person.neck]);
    push("midHip", [person.midHip]);
    return result;
  }, [layers, person]);

  const toPosePoint = useCallback((clientX: number, clientY: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return null;
    const rect = viewport.getBoundingClientRect();
    return screenToPosePoint({
      clientX,
      clientY,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      canvas: document.canvas,
      zoom,
      pan,
    });
  }, [document.canvas, pan, zoom]);

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = {
      kind: "pan",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPan: pan,
    };
    movedRef.current = false;
    viewportRef.current?.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    movedRef.current = false;
    if (event.button === 1 || panMode) beginPan(event);
  };

  const handlePointPointerDown = (event: ReactPointerEvent<SVGCircleElement>, path: PosePointPath) => {
    if (event.button !== 0 || panMode) return;
    event.preventDefault();
    event.stopPropagation();
    onSelectPoint(path);
    onBeginPointDrag(path);
    dragRef.current = { kind: "point", pointerId: event.pointerId, path };
    movedRef.current = false;
    viewportRef.current?.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const action = dragRef.current;
    if (!action || action.pointerId !== event.pointerId) return;
    movedRef.current = true;
    if (action.kind === "pan") {
      onPanChange({
        x: action.startPan.x + event.clientX - action.startX,
        y: action.startPan.y + event.clientY - action.startY,
      });
      return;
    }
    const point = toPosePoint(event.clientX, event.clientY);
    if (point) onDraftPoint(action.path, { ...point, confidence: 1, origin: "manual" });
  };

  const finishPointerAction = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (dragRef.current.kind === "point") onFinishPointDrag();
    dragRef.current = null;
    if (viewportRef.current?.hasPointerCapture(event.pointerId)) viewportRef.current.releasePointerCapture(event.pointerId);
  };

  const selectMissingPointAtClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || movedRef.current || !activePoint || activePoint.personId !== person.id) return;
    if (event.target instanceof Element && event.target.closest("[data-pose-editor-point]")) return;
    if (personPoint(person, activePoint.group, "index" in activePoint ? activePoint.index : undefined)) return;
    const point = toPosePoint(event.clientX, event.clientY);
    if (point) onSetMissingPoint(activePoint, point);
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    onZoomChange(Math.max(0.25, Math.min(4, zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1))));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === " ") {
      event.preventDefault();
      setPanMode(true);
    }
  };

  const handleKeyUp = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === " ") {
      event.preventDefault();
      setPanMode(false);
    }
  };

  const renderLine = (key: string, a: PosePointV1, b: PosePointV1, layer: PoseEditorLayer) => a && b ? (
    <line
      key={key}
      x1={a.x}
      y1={a.y}
      x2={b.x}
      y2={b.y}
      stroke={LAYER_COLORS[layer]}
      strokeOpacity={Math.max(0.32, Math.min(a.confidence, b.confidence))}
      strokeWidth={Math.max(1, 2 / scale)}
      strokeLinecap="round"
      vectorEffect="non-scaling-stroke"
    />
  ) : null;

  const bodyLines = layers.body ? [
    ...BODY_CONNECTIONS.map(([a, b], index) => renderLine(`body-${index}`, person.body[a], person.body[b], "body")),
    renderLine("left-shoulder-neck", person.body[5], person.neck, "body"),
    renderLine("neck-right-shoulder", person.neck, person.body[6], "body"),
    renderLine("left-hip-mid", person.body[11], person.midHip, "body"),
    renderLine("mid-right-hip", person.midHip, person.body[12], "body"),
  ] : [];
  const footLines = layers.feet ? FOOT_CONNECTIONS.map(([bodyIndex, footIndex], index) =>
    renderLine(`foot-${index}`, person.body[bodyIndex], person.feet[footIndex], "feet")) : [];
  const handLines = layers.hands ? ([
    ...HAND_CONNECTIONS.map(([a, b], index) => renderLine(`left-hand-${index}`, person.hands.left[a], person.hands.left[b], "hands")),
    ...HAND_CONNECTIONS.map(([a, b], index) => renderLine(`right-hand-${index}`, person.hands.right[a], person.hands.right[b], "hands")),
    renderLine("left-wrist-hand", person.body[9], person.hands.left[0], "hands"),
    renderLine("right-wrist-hand", person.body[10], person.hands.right[0], "hands"),
  ]) : [];
  const faceLines = layers.face ? FACE_CONNECTIONS.map(([a, b], index) =>
    renderLine(`face-${index}`, person.face[a], person.face[b], "face")) : [];

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="2D 姿势编辑画布">
      <div
        ref={viewportRef}
        role="group"
        aria-label="2D 骨架编辑画布；滚轮缩放，按住空格拖动画布，拖动关节点调整"
        tabIndex={0}
        className={`relative min-h-0 flex-1 touch-none select-none overflow-hidden rounded-lg border border-border bg-[var(--gc-canvas)] outline-none focus-visible:ring-2 focus-visible:ring-ring ${panMode ? "cursor-grab" : "cursor-crosshair"}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointerAction}
        onPointerCancel={finishPointerAction}
        onWheel={handleWheel}
        onClick={selectMissingPointAtClick}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
      >
        <div
          className="absolute overflow-hidden"
          style={{ left: imageLeft, top: imageTop, width: imageWidth, height: imageHeight }}
        >
          <img src={imageUrl} alt="姿势编辑参考图" draggable={false} className="absolute inset-0 h-full w-full object-fill" />
          <svg
            className="absolute inset-0 h-full w-full overflow-visible"
            viewBox={`0 0 ${document.canvas.width} ${document.canvas.height}`}
            preserveAspectRatio="none"
          >
            {bodyLines}
            {footLines}
            {handLines}
            {faceLines}
            {marks.map(({ path, label, point, layer }) => {
              const selected = samePath(activePoint, path);
              return (
                <circle
                  key={pointKey(path)}
                  data-pose-editor-point={pointKey(path)}
                  cx={point.x}
                  cy={point.y}
                  r={selected ? 11 / scale : 8 / scale}
                  fill={LAYER_COLORS[layer]}
                  fillOpacity={point.origin === "detected" ? 0.84 : 1}
                  stroke={selected ? "#ffffff" : "#111827"}
                  strokeWidth={selected ? 3 / scale : 1.5 / scale}
                  vectorEffect="non-scaling-stroke"
                  role="button"
                  aria-label={`${posePointLabel(path)}${point.origin === "detected" ? "（检测）" : "（手动）"}`}
                  aria-pressed={selected}
                  tabIndex={selected ? 0 : -1}
                  onPointerDown={(event) => handlePointPointerDown(event, path)}
                  onClick={(event) => { event.stopPropagation(); onSelectPoint(path); }}
                  onKeyDown={(event) => {
                    const deltas: Record<string, [number, number]> = {
                      ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
                    };
                    const delta = deltas[event.key];
                    if (!delta) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const multiplier = event.shiftKey ? 10 : 1;
                    onNudgePoint(path, delta[0] * multiplier, delta[1] * multiplier);
                  }}
                >
                  <title>{label}</title>
                </circle>
              );
            })}
          </svg>
        </div>
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-background/90 px-2.5 py-1.5 text-xs text-muted-foreground shadow-sm">
          滚轮缩放 · 按住空格拖动画布 · 拖动关节点调整 · 方向键微调
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {activePoint ? `当前选中${posePointLabel(activePoint)}` : "尚未选择关键点"}
      </p>
    </section>
  );
}

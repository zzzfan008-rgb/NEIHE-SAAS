import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BODY_CONNECTIONS, FOOT_CONNECTIONS, HAND_CONNECTIONS } from '@/lib/poseTopology';
import {
  BODY25_CONNECTIONS,
  DEFAULT_POSE_CAMERA,
  POSE3D_CHAINS,
  getPose3DChain,
  getPose3DChainTarget,
  projectPose3DToDocument,
  projectPose3DPoint,
  resetPose3DFromCurrent2D,
  solvePose3DChain,
  unprojectPose3DPointOnDepth,
  type Pose3DChainId,
  type PoseCanvasSize,
  type PoseProjection,
} from '@/lib/pose3dModel';
import type { PoseDocumentV1, PosePointV1 } from '@/types/poseDocument';
import type { PoseIkStatus, PoseVector3 } from '@/lib/poseIk';

type PoseEditor3DProps = {
  imageUrl: string;
  document: PoseDocumentV1;
  activePersonId: string;
  onBeginDraft: () => void;
  onDraft: (document: PoseDocumentV1) => void;
  onFinishDraft: () => void;
  onCommit: (document: PoseDocumentV1) => void;
};

type ViewPreset = 'front' | 'side' | 'top';
type Coordinate = 'x' | 'y' | 'z';

type DragState = {
  pointerId: number;
  chainId: Pose3DChainId;
  depth: number;
};

const VIEW_PRESETS: Record<ViewPreset, { label: string; camera: typeof DEFAULT_POSE_CAMERA }> = {
  front: { label: '正面', camera: { ...DEFAULT_POSE_CAMERA, target: { ...DEFAULT_POSE_CAMERA.target }, scale: 1.1 } },
  side: { label: '侧面', camera: { ...DEFAULT_POSE_CAMERA, target: { ...DEFAULT_POSE_CAMERA.target }, yawDeg: 90, scale: 1.1 } },
  top: { label: '俯视', camera: { ...DEFAULT_POSE_CAMERA, target: { ...DEFAULT_POSE_CAMERA.target }, pitchDeg: 89, scale: 1.1 } },
};

function renderLine(
  points: PosePointV1[],
  connection: readonly [number, number],
  key: string,
  stroke: string,
  strokeWidth: number,
) {
  const start = points[connection[0]];
  const end = points[connection[1]];
  if (!start || !end) return null;
  return <line key={key} x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" />;
}

function PoseProjectionPreview({ imageUrl, document, activePersonId }: { imageUrl: string; document: PoseDocumentV1; activePersonId: string }) {
  const bodyStroke = 'var(--gc-accent)';
  const auxiliaryStroke = 'var(--gc-text-muted)';
  const pointRadius = Math.max(4, document.canvas.width / 240);
  const strokeWidth = Math.max(2, document.canvas.width / 500);

  return (
    <div role="img" aria-label="固定输出相机的 2D 姿势预览" className="relative aspect-[4/3] min-h-[240px] overflow-hidden rounded-md border border-[var(--gc-border)] bg-[var(--gc-canvas)]">
      <img src={imageUrl} alt="" className="absolute inset-0 h-full w-full object-fill opacity-80" />
      <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${document.canvas.width} ${document.canvas.height}`} preserveAspectRatio="none" aria-hidden="true">
        {document.people.map((person) => {
          const active = person.id === activePersonId;
          const body = person.body;
          const feet = person.feet;
          return (
            <g key={person.id} opacity={active ? 1 : 0.35}>
              {BODY_CONNECTIONS.map((connection, index) => renderLine(body, connection, `${person.id}-body-${index}`, bodyStroke, strokeWidth))}
              {FOOT_CONNECTIONS.map((connection, index) => renderLine([body[15], body[16], ...feet], connection, `${person.id}-feet-${index}`, auxiliaryStroke, strokeWidth))}
              {HAND_CONNECTIONS.map((connection, index) => renderLine(person.hands.left, connection, `${person.id}-left-hand-${index}`, auxiliaryStroke, strokeWidth))}
              {HAND_CONNECTIONS.map((connection, index) => renderLine(person.hands.right, connection, `${person.id}-right-hand-${index}`, auxiliaryStroke, strokeWidth))}
              {[...body, person.neck, person.midHip, ...feet].map((point, index) => point ? <circle key={`${person.id}-point-${index}`} cx={point.x} cy={point.y} r={pointRadius} fill={active ? bodyStroke : auxiliaryStroke} /> : null)}
            </g>
          );
        })}
      </svg>
      <span className="absolute left-2 top-2 rounded bg-black/55 px-2 py-1 text-[11px] text-white">输出相机 · 2D</span>
    </div>
  );
}

export function PoseEditor3D({ imageUrl, document, activePersonId, onBeginDraft, onDraft, onFinishDraft, onCommit }: PoseEditor3DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const workingDocumentRef = useRef(document);
  const initialPoseRef = useRef(document.pose3d && !document.pose3d.stale ? document.pose3d : null);
  const [canvasSize, setCanvasSize] = useState<PoseCanvasSize>({ width: 0, height: 0 });
  const [canvasUnavailable, setCanvasUnavailable] = useState(false);
  const [viewCamera, setViewCamera] = useState(VIEW_PRESETS.front.camera);
  const [selectedChain, setSelectedChain] = useState<Pose3DChainId>('left-arm');
  const [bendSigns, setBendSigns] = useState<Record<Pose3DChainId, 1 | -1>>({
    'left-arm': 1,
    'right-arm': 1,
    'left-leg': 1,
    'right-leg': 1,
  });
  const [solveStatus, setSolveStatus] = useState<{ status: PoseIkStatus; reason?: string } | null>(null);

  const pose3d = document.pose3d;
  const chain = getPose3DChain(selectedChain);
  const selectedTarget = getPose3DChainTarget(pose3d, selectedChain);
  const selectedChainAvailable = Boolean(pose3d && selectedTarget);

  useEffect(() => {
    if (!initialPoseRef.current && document.pose3d && !document.pose3d.stale) {
      initialPoseRef.current = document.pose3d;
    }
    workingDocumentRef.current = document;
  }, [document]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) setCanvasSize({ width: rect.width, height: rect.height });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasSize.width <= 0 || canvasSize.height <= 0) return;
    const context = canvas.getContext('2d');
    if (!context) {
      setCanvasUnavailable(true);
      return;
    }
    setCanvasUnavailable(false);
    const devicePixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvasSize.width * devicePixelRatio);
    canvas.height = Math.round(canvasSize.height * devicePixelRatio);
    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    context.clearRect(0, 0, canvasSize.width, canvasSize.height);
    context.fillStyle = '#101417';
    context.fillRect(0, 0, canvasSize.width, canvasSize.height);

    context.strokeStyle = 'rgba(255,255,255,0.08)';
    context.lineWidth = 1;
    for (let x = 0; x <= canvasSize.width; x += 32) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, canvasSize.height);
      context.stroke();
    }
    for (let y = 0; y <= canvasSize.height; y += 32) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(canvasSize.width, y);
      context.stroke();
    }

    if (!pose3d) return;
    const projected = pose3d.body25.map((point) => projectPose3DPoint(point, viewCamera, canvasSize));
    context.lineWidth = 3;
    context.strokeStyle = '#d7e5e1';
    BODY25_CONNECTIONS.forEach(([startIndex, endIndex]) => {
      const start = projected[startIndex];
      const end = projected[endIndex];
      if (!start || !end) return;
      context.beginPath();
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
      context.stroke();
    });

    const endpointIndices = new Set(POSE3D_CHAINS.map((candidate) => candidate.end));
    projected.forEach((point, index) => {
      if (!point) return;
      const endpoint = endpointIndices.has(index);
      const selected = index === chain.end;
      context.beginPath();
      context.arc(point.x, point.y, selected ? 10 : endpoint ? 8 : 5, 0, Math.PI * 2);
      context.fillStyle = selected ? '#f0a35b' : endpoint ? '#8bd0c4' : '#f5f7f6';
      context.fill();
      context.strokeStyle = '#101417';
      context.lineWidth = 2;
      context.stroke();
    });

    const axisOrigin = { x: canvasSize.width - 62, y: canvasSize.height - 52 };
    const axisLength = 30;
    context.lineWidth = 2;
    ([['x', '#ef6b73'], ['y', '#80c98d'], ['z', '#76a7e8']] as const).forEach(([axis, color]) => {
      const endpoint = axis === 'x'
        ? { x: axisOrigin.x + axisLength, y: axisOrigin.y }
        : axis === 'y'
          ? { x: axisOrigin.x, y: axisOrigin.y - axisLength }
          : { x: axisOrigin.x - 18, y: axisOrigin.y + 12 };
      context.strokeStyle = color;
      context.beginPath();
      context.moveTo(axisOrigin.x, axisOrigin.y);
      context.lineTo(endpoint.x, endpoint.y);
      context.stroke();
      context.fillStyle = color;
      context.font = '11px sans-serif';
      context.fillText(axis.toUpperCase(), endpoint.x + 3, endpoint.y + 3);
    });
  }, [canvasSize, chain.end, pose3d, viewCamera]);

  const applyTarget = useCallback((target: PoseVector3, mode: 'draft' | 'commit', bendSign = bendSigns[selectedChain]) => {
    const result = solvePose3DChain(workingDocumentRef.current, activePersonId, selectedChain, target, bendSign);
    setSolveStatus({ status: result.status, reason: result.reason });
    if (result.status === 'invalid') return;
    workingDocumentRef.current = result.document;
    if (mode === 'draft') onDraft(result.document);
    else onCommit(result.document);
  }, [activePersonId, bendSigns, onCommit, onDraft, selectedChain]);

  const targetFromPointer = useCallback((clientX: number, clientY: number, depth: number): PoseVector3 | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return unprojectPose3DPointOnDepth({ x: clientX - rect.left, y: clientY - rect.top, depth }, viewCamera, { width: rect.width, height: rect.height });
  }, [viewCamera]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!pose3d || canvasUnavailable || canvasSize.width <= 0 || canvasSize.height <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const local = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const hit = POSE3D_CHAINS.map((candidate) => {
      const projection = projectPose3DPoint(pose3d.body25[candidate.end], viewCamera, canvasSize);
      return projection ? { candidate, projection, distance: Math.hypot(projection.x - local.x, projection.y - local.y) } : null;
    }).filter((candidate): candidate is { candidate: typeof POSE3D_CHAINS[number]; projection: PoseProjection; distance: number } => Boolean(candidate)).sort((left, right) => left.distance - right.distance)[0];
    if (!hit || hit.distance > 24) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    viewportRef.current?.focus();
    setSelectedChain(hit.candidate.id);
    setSolveStatus(null);
    workingDocumentRef.current = document;
    dragRef.current = { pointerId: event.pointerId, chainId: hit.candidate.id, depth: hit.projection.depth };
    onBeginDraft();
    event.preventDefault();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const target = targetFromPointer(event.clientX, event.clientY, drag.depth);
    if (!target) return;
    const result = solvePose3DChain(workingDocumentRef.current, activePersonId, drag.chainId, target, bendSigns[drag.chainId]);
    setSolveStatus({ status: result.status, reason: result.reason });
    if (result.status === 'invalid') return;
    workingDocumentRef.current = result.document;
    onDraft(result.document);
    event.preventDefault();
  };

  const finishDrag = (event?: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;
    if (event && dragRef.current.pointerId === event.pointerId && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    onFinishDraft();
  };

  const handleViewportKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!selectedTarget || !pose3d) return;
    const direction = event.key === 'ArrowLeft' ? { x: -1, y: 0 } : event.key === 'ArrowRight' ? { x: 1, y: 0 } : event.key === 'ArrowUp' ? { x: 0, y: -1 } : event.key === 'ArrowDown' ? { x: 0, y: 1 } : null;
    if (!direction) return;
    const projection = projectPose3DPoint(pose3d.body25[chain.end], viewCamera, canvasSize);
    if (!projection) return;
    const step = event.shiftKey ? 10 : 3;
    const target = unprojectPose3DPointOnDepth({ x: projection.x + direction.x * step, y: projection.y + direction.y * step, depth: projection.depth }, viewCamera, canvasSize);
    if (!target) return;
    applyTarget(target, 'commit');
    event.preventDefault();
  };

  const updateCoordinate = (axis: Coordinate, value: number) => {
    if (!selectedTarget || !Number.isFinite(value)) return;
    applyTarget({ ...selectedTarget, [axis]: value }, 'commit');
  };

  const toggleBendDirection = () => {
    if (!selectedTarget) return;
    const nextSign = bendSigns[selectedChain] === 1 ? -1 : 1;
    setBendSigns((current) => ({ ...current, [selectedChain]: nextSign }));
    applyTarget(selectedTarget, 'commit', nextSign);
  };

  const resetPose = () => {
    const initialPose = initialPoseRef.current;
    const next = initialPose
      ? projectPose3DToDocument(document, initialPose, activePersonId)
      : resetPose3DFromCurrent2D(document, activePersonId);
    workingDocumentRef.current = next;
    setSolveStatus(null);
    onCommit(next);
  };


  const applyViewAsOutput = () => {
    if (!pose3d) return;
    const nextPose3D = {
      ...pose3d,
      camera: { ...viewCamera, target: { ...viewCamera.target } },
      stale: false,
    };
    const next = projectPose3DToDocument(document, nextPose3D, activePersonId);
    workingDocumentRef.current = next;
    setSolveStatus(null);
    onCommit(next);
  };
  const previewCamera = pose3d?.camera ?? DEFAULT_POSE_CAMERA;
  const currentStatusLabel = solveStatus?.status === 'unreachable' ? '目标超出可达范围，已夹紧到最近可达位置' : solveStatus?.status === 'invalid' ? solveStatus.reason ?? '当前链条不可用' : '目标可达';

  return (
    <div data-pose-editor-3d className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_360px] xl:overflow-hidden">
      <section className="grid min-h-[520px] min-w-0 grid-rows-[auto_minmax(360px,1fr)] gap-2 rounded-lg border border-[var(--gc-border)] bg-[var(--gc-canvas)] p-3" aria-label="3D 姿势操作区">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">3D 骨架 · 当前人物</p>
            <p className="text-xs text-[var(--gc-text-muted)]">拖动腕部或踝部，IK 会保持骨骼长度；箭头键可进行微调。</p>
          </div>
          <div className="flex flex-wrap gap-1" aria-label="观察视角">
            {(Object.entries(VIEW_PRESETS) as Array<[ViewPreset, (typeof VIEW_PRESETS)[ViewPreset]]>).map(([preset, option]) => (
              <Button key={preset} size="sm" variant="outline" aria-pressed={viewCamera.yawDeg === option.camera.yawDeg && viewCamera.pitchDeg === option.camera.pitchDeg} onClick={() => setViewCamera(option.camera)}>{option.label}</Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setViewCamera(VIEW_PRESETS.front.camera)}>复位视角</Button>
          </div>
        </div>
        <div ref={viewportRef} tabIndex={0} onKeyDown={handleViewportKeyDown} className="relative min-h-0 overflow-hidden rounded-md border border-[var(--gc-border)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--gc-accent)]">
          <canvas data-pose-3d-canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none cursor-crosshair" aria-label="3D 骨架画布，拖动腕部或踝部调整姿势" onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={finishDrag} onPointerCancel={finishDrag} />
          {canvasUnavailable && <p role="alert" className="absolute inset-0 flex items-center justify-center bg-[var(--gc-canvas)] p-4 text-sm text-[var(--gc-text-muted)]">当前浏览器无法创建 3D 画布，请使用支持 Canvas 的桌面浏览器。</p>}
          {!pose3d && <p className="absolute inset-0 flex items-center justify-center text-sm text-[var(--gc-text-muted)]">切换到 3D 后建立骨架。</p>}
          <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/55 px-2 py-1 text-[11px] text-white">红 X · 绿 Y · 蓝 Z · 观察相机不写入输出</div>
        </div>
      </section>

      <aside aria-label="3D 姿势属性与 2D 输出预览" className="flex min-h-0 flex-col gap-3 rounded-lg border border-[var(--gc-border)] bg-[var(--gc-canvas)] p-3 xl:overflow-y-auto">
        <PoseProjectionPreview imageUrl={imageUrl} document={document} activePersonId={activePersonId} />
        <div className="space-y-2">
          <p className="text-xs font-medium">IK 链条</p>
          <Select value={selectedChain} onValueChange={(value) => { if (value) { setSelectedChain(value as Pose3DChainId); setSolveStatus(null); } }}>
            <SelectTrigger aria-label="选择 3D IK 链条"><SelectValue /></SelectTrigger>
            <SelectContent>{POSE3D_CHAINS.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <p className="text-xs text-[var(--gc-text-muted)]">当前链条：{chain.label} · {selectedChainAvailable ? '可编辑' : '缺少必要关键点'}</p>
        {selectedTarget && (
          <div className="grid grid-cols-3 gap-2">
            {(['x', 'y', 'z'] as Coordinate[]).map((axis) => (
              <label key={axis} className="text-xs uppercase">{axis}
                <Input aria-label={`3D 目标 ${axis.toUpperCase()} 坐标`} type="number" step="0.01" value={selectedTarget[axis]} onChange={(event) => updateCoordinate(axis, Number(event.currentTarget.value))} />
              </label>
            ))}
          </div>
        )}
        <Button size="sm" variant="outline" disabled={!selectedTarget} onClick={toggleBendDirection}>反转弯曲方向（{bendSigns[selectedChain] === 1 ? '当前方向' : '已反转'}）</Button>
        {solveStatus && <p role="status" className={`text-xs ${solveStatus.status === 'invalid' ? 'text-destructive' : 'text-[var(--gc-text-muted)]'}`}>{currentStatusLabel}</p>}
        <div className="space-y-1 rounded-md border border-[var(--gc-border)] p-2 text-xs text-[var(--gc-text-muted)]">
          <p className="font-medium text-[var(--gc-text)]">固定输出相机</p>
          <p>yaw {previewCamera.yawDeg.toFixed(1)}° · pitch {previewCamera.pitchDeg.toFixed(1)}° · scale {previewCamera.scale.toFixed(2)}</p>
          <p>输出 2D 预览会随 3D 草稿更新；观察视角不会改变它。</p>
          <Button size="sm" variant="outline" className="w-full" disabled={!pose3d} onClick={applyViewAsOutput}>将当前视角设为输出投影</Button>
        </div>
        <div className="mt-auto space-y-2 border-t border-[var(--gc-border)] pt-3">
          <Button size="sm" variant="outline" className="w-full" onClick={resetPose}>重置 3D 姿态</Button>
          <p className="text-[11px] leading-4 text-[var(--gc-text-muted)]">3D 编辑只作用于当前人物。2D 编辑会让 3D 草稿标记为过期，重新切换到 3D 时会按当前 2D 姿势重建。</p>
        </div>
      </aside>
    </div>
  );
}

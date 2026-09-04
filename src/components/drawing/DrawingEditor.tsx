import { useEffect, useMemo, useRef, useState } from "react";
import { Arrow, Ellipse, Layer, Line, Rect, Stage, Text, Transformer } from "react-konva";
import type Konva from "konva";
import { nanoid } from "nanoid";
import {
  applyDrawingCommand,
  createDrawingHistory,
  drawingKeyboardCommand,
  redoDrawingCommand,
  undoDrawingCommand,
  type DrawingHistory,
} from "./drawingHistory";
import {
  DRAWING_LIMITS,
  simplifyStrokePoints,
  validateDrawingDocument,
  type DrawingDocument,
  type DrawingObject,
  type DrawingStroke,
} from "./drawingModel";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/nodes/NodeFrame";

type Tool = "select" | "brush" | "eraser" | "rectangle" | "ellipse" | "line" | "arrow" | "text";
const TOOLS: Array<{ id: Tool; label: string }> = [
  { id: "select", label: "选择" }, { id: "brush", label: "画笔" }, { id: "eraser", label: "橡皮" },
  { id: "rectangle", label: "矩形" }, { id: "ellipse", label: "椭圆" },
  { id: "line", label: "直线" }, { id: "arrow", label: "箭头" }, { id: "text", label: "文字" },
];

interface ActiveGesture {
  layerId: string;
  object: DrawingObject;
}

export interface DrawingEditorProps {
  initialDocument: DrawingDocument;
  saving: boolean;
  error?: string;
  onDocumentChange: (document: DrawingDocument) => void;
  onSave: (document: DrawingDocument, previewDataUrl: string) => Promise<void>;
  onCancel: () => void;
}

function stageBlob(stage: Konva.Stage, pixelRatio: number): Promise<string> {
  return new Promise((resolve, reject) => {
    stage.toBlob({
      pixelRatio,
      callback: (blob) => {
        if (!blob) { reject(new Error("画板预览生成失败")); return; }
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("画板预览读取失败"));
        reader.readAsDataURL(blob);
      },
    });
  });
}

function objectElement(
  object: DrawingObject,
  selected: boolean,
  select: (id: string) => void,
  move: (id: string, x: number, y: number) => void,
) {
  const common = {
    id: object.id,
    listening: true,
    draggable: true,
    onClick: () => select(object.id),
    onTap: () => select(object.id),
    onDragEnd: (event: Konva.KonvaEventObject<DragEvent>) => move(object.id, event.target.x(), event.target.y()),
    shadowColor: selected ? "#69A7FF" : undefined,
    shadowBlur: selected ? 8 : 0,
  };
  switch (object.kind) {
    case "stroke":
      return <Line key={object.id} {...common} points={object.points} stroke={object.color} strokeWidth={object.width}
        lineCap="round" lineJoin="round" globalCompositeOperation={object.composite} />;
    case "line":
      return <Line key={object.id} {...common} points={[object.x1, object.y1, object.x2, object.y2]}
        stroke={object.color} strokeWidth={object.width} />;
    case "arrow":
      return <Arrow key={object.id} {...common} points={[object.x1, object.y1, object.x2, object.y2]}
        stroke={object.color} fill={object.color} strokeWidth={object.width} />;
    case "rectangle":
      return <Rect key={object.id} {...common} x={object.x} y={object.y} width={object.width} height={object.height}
        stroke={object.color} strokeWidth={object.strokeWidth} fill={object.fill} />;
    case "ellipse":
      return <Ellipse key={object.id} {...common} x={object.x} y={object.y} radiusX={object.radiusX} radiusY={object.radiusY}
        stroke={object.color} strokeWidth={object.strokeWidth} fill={object.fill} />;
    case "text":
      return <Text key={object.id} {...common} x={object.x} y={object.y} width={object.width} text={object.text}
        fontSize={object.fontSize} fontFamily={object.fontFamily} align={object.align} fill={object.color} />;
  }
}

export function DrawingEditor({ initialDocument, saving, error, onDocumentChange, onSave, onCancel }: DrawingEditorProps) {
  const [history, setHistory] = useState<DrawingHistory>(() => createDrawingHistory(initialDocument));
  const [tool, setTool] = useState<Tool>("brush");
  const [activeLayerId, setActiveLayerId] = useState(initialDocument.layers.at(-1)?.id ?? initialDocument.layers[0].id);
  const [color, setColor] = useState("#111111");
  const [strokeWidth, setStrokeWidth] = useState(6);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [gesture, setGesture] = useState<ActiveGesture | null>(null);
  const [textValue, setTextValue] = useState("");
  const stageRef = useRef<Konva.Stage>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const scale = Math.min(1, 760 / history.present.canvas.width, 520 / history.present.canvas.height);
  const activeLayer = history.present.layers.find((layer) => layer.id === activeLayerId) ?? history.present.layers[0];

  useEffect(() => onDocumentChange(history.present), [history.present, onDocumentChange]);
  useEffect(() => {
    const transformer = transformerRef.current;
    const stage = stageRef.current;
    if (!transformer || !stage) return;
    const selected = selectedObjectId ? stage.findOne(`#${selectedObjectId}`) : undefined;
    transformer.nodes(selected ? [selected] : []);
    transformer.getLayer()?.batchDraw();
  }, [history.present, selectedObjectId]);

  const apply = (command: Parameters<typeof applyDrawingCommand>[1]) => {
    try { setHistory((current) => applyDrawingCommand(current, command)); }
    catch (failure) { window.alert(failure instanceof Error ? failure.message : "画板操作失败"); }
  };
  const pointer = () => {
    const point = stageRef.current?.getPointerPosition();
    return point ? { x: point.x / scale, y: point.y / scale } : null;
  };
  const pointerDown = () => {
    if (!activeLayer || activeLayer.locked || tool === "select" || tool === "text") return;
    const point = pointer();
    if (!point) return;
    const id = `object-${nanoid(10)}`;
    if (tool === "brush" || tool === "eraser") {
      setGesture({
        layerId: activeLayer.id,
        object: {
          id, kind: "stroke", points: [point.x, point.y, point.x, point.y], color,
          width: strokeWidth, composite: tool === "eraser" ? "destination-out" : "source-over",
        },
      });
      return;
    }
    if (tool === "rectangle") {
      setGesture({ layerId: activeLayer.id, object: { id, kind: "rectangle", x: point.x, y: point.y, width: 1, height: 1, color, strokeWidth } });
    } else if (tool === "ellipse") {
      setGesture({ layerId: activeLayer.id, object: { id, kind: "ellipse", x: point.x, y: point.y, radiusX: 1, radiusY: 1, color, strokeWidth } });
    } else {
      setGesture({ layerId: activeLayer.id, object: { id, kind: tool, x1: point.x, y1: point.y, x2: point.x, y2: point.y, color, width: strokeWidth } });
    }
  };
  const pointerMove = () => {
    if (!gesture) return;
    const point = pointer();
    if (!point) return;
    setGesture((current) => {
      if (!current) return null;
      const object = current.object;
      if (object.kind === "stroke") return { ...current, object: { ...object, points: [...object.points, point.x, point.y] } };
      if (object.kind === "rectangle") return { ...current, object: { ...object, width: point.x - object.x, height: point.y - object.y } };
      if (object.kind === "ellipse") return { ...current, object: { ...object, radiusX: Math.abs(point.x - object.x), radiusY: Math.abs(point.y - object.y) } };
      if (object.kind === "line" || object.kind === "arrow") return { ...current, object: { ...object, x2: point.x, y2: point.y } };
      return current;
    });
  };
  const pointerUp = () => {
    if (!gesture) return;
    let object = gesture.object;
    if (object.kind === "stroke") object = { ...object, points: simplifyStrokePoints(object.points) } as DrawingStroke;
    apply({ type: "add-object", layerId: gesture.layerId, object });
    setGesture(null);
  };
  const moveObject = (objectId: string, x: number, y: number) => {
    const layer = history.present.layers.find((candidate) => candidate.objects.some((object) => object.id === objectId));
    const object = layer?.objects.find((candidate) => candidate.id === objectId);
    if (!layer || !object) return;
    if (object.kind === "stroke") {
      apply({ type: "update-object", layerId: layer.id, objectId, patch: {
        points: object.points.map((value, index) => value + (index % 2 === 0 ? x : y)),
      } as Partial<DrawingStroke> });
      return;
    }
    if (object.kind === "line" || object.kind === "arrow") {
      apply({ type: "update-object", layerId: layer.id, objectId, patch: {
        x1: object.x1 + x, y1: object.y1 + y, x2: object.x2 + x, y2: object.y2 + y,
      } });
      return;
    }
    apply({ type: "update-object", layerId: layer.id, objectId, patch: { x, y } as never });
  };
  const deleteSelection = () => {
    if (!selectedObjectId) return;
    const layer = history.present.layers.find((candidate) => candidate.objects.some((object) => object.id === selectedObjectId));
    if (layer) apply({ type: "remove-object", layerId: layer.id, objectId: selectedObjectId });
    setSelectedObjectId(null);
  };
  const addText = () => {
    if (!textValue.trim() || !activeLayer || activeLayer.locked) return;
    apply({ type: "add-object", layerId: activeLayer.id, object: {
      id: `text-${nanoid(10)}`, kind: "text", text: textValue, x: 40, y: 40,
      width: Math.min(600, history.present.canvas.width - 80), fontSize: 32,
      fontFamily: "sans-serif", align: "left", color,
    } });
    setTextValue("");
  };
  const addLayer = () => {
    if (history.present.layers.length >= DRAWING_LIMITS.maxLayers) return;
    const id = `layer-${nanoid(8)}`;
    apply({ type: "add-layer", layer: { id, name: `图层 ${history.present.layers.length + 1}`, visible: true, locked: false, opacity: 1, objects: [] } });
    setActiveLayerId(id);
  };

  const visibleObjects = useMemo(() => gesture ? [gesture.object] : [], [gesture]);
  return (
    <div
      className="grid min-h-0 grid-cols-[minmax(0,1fr)_15rem] gap-3"
      onKeyDown={(event) => {
        const command = drawingKeyboardCommand(event, (event.target as HTMLElement).tagName);
        if (!command) return;
        event.preventDefault();
        if (command === "undo") setHistory(undoDrawingCommand);
        else if (command === "redo") setHistory(redoDrawingCommand);
        else if (command === "delete-selection") deleteSelection();
        else setSelectedObjectId(null);
      }}
    >
      <div className="min-w-0 space-y-2">
        <div role="toolbar" aria-label="绘画工具" className="flex flex-wrap gap-1">
          {TOOLS.map((item) => <Button key={item.id} size="sm" variant={tool === item.id ? "default" : "outline"}
            aria-pressed={tool === item.id} onClick={() => setTool(item.id)}>{item.label}</Button>)}
        </div>
        <div className="overflow-auto rounded-xl border border-[var(--gc-border)] bg-[var(--gc-control)] p-2">
          <Stage ref={stageRef} width={history.present.canvas.width * scale} height={history.present.canvas.height * scale}
            scaleX={scale} scaleY={scale} onMouseDown={pointerDown} onTouchStart={pointerDown}
            onMouseMove={pointerMove} onTouchMove={pointerMove} onMouseUp={pointerUp} onTouchEnd={pointerUp}
            aria-label="可编辑绘画画布">
            <Layer><Rect width={history.present.canvas.width} height={history.present.canvas.height} fill={history.present.canvas.background} listening={false} /></Layer>
            {history.present.layers.map((layer) => <Layer key={layer.id} visible={layer.visible} opacity={layer.opacity}>
              {layer.objects.map((object) => objectElement(object, selectedObjectId === object.id, setSelectedObjectId, moveObject))}
              {gesture?.layerId === layer.id && visibleObjects.map((object) => objectElement(object, false, () => undefined, () => undefined))}
            </Layer>)}
            <Layer><Transformer ref={transformerRef} rotateEnabled={false} /></Layer>
          </Stage>
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex gap-1">
            <Button size="sm" variant="outline" disabled={history.past.length === 0} onClick={() => setHistory(undoDrawingCommand)}>撤销</Button>
            <Button size="sm" variant="outline" disabled={history.future.length === 0} onClick={() => setHistory(redoDrawingCommand)}>重做</Button>
            <Button size="sm" variant="outline" disabled={!selectedObjectId} onClick={deleteSelection}>删除对象</Button>
          </div>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" onClick={onCancel}>取消</Button>
            <Button size="sm" disabled={saving} onClick={async () => {
              validateDrawingDocument(history.present, { exportPixelRatio: 1 });
              const stage = stageRef.current;
              if (!stage) return;
              await onSave(history.present, await stageBlob(stage, 1));
            }}>{saving ? "保存中…" : "保存画板"}</Button>
          </div>
        </div>
        {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
      </div>
      <aside aria-label="画板属性" className="space-y-3 overflow-auto rounded-xl border border-[var(--gc-border)] p-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs">颜色<input type="color" value={color} onChange={(event) => setColor(event.target.value.toUpperCase())} className="mt-1 h-9 w-full" /></label>
          <label className="text-xs">线宽<input type="number" min="1" max="256" value={strokeWidth} onChange={(event) => setStrokeWidth(Math.max(1, Math.min(256, Number(event.target.value) || 1)))} className={`${inputClass} mt-1`} /></label>
        </div>
        {tool === "text" && <div className="space-y-1">
          <label className="text-xs" htmlFor="drawing-text">文字内容</label>
          <textarea id="drawing-text" value={textValue} onChange={(event) => setTextValue(event.target.value)} maxLength={4000} rows={4} className={`${inputClass} resize-none`} />
          <Button size="sm" className="w-full" disabled={!textValue.trim()} onClick={addText}>添加文字</Button>
        </div>}
        <section aria-label="图层" className="space-y-2">
          <div className="flex items-center justify-between"><h3 className="text-xs font-semibold">图层（最多 5 层）</h3><Button size="sm" variant="outline" disabled={history.present.layers.length >= 5} onClick={addLayer}>新建</Button></div>
          {[...history.present.layers].reverse().map((layer, reverseIndex) => {
            const index = history.present.layers.length - 1 - reverseIndex;
            return <div key={layer.id} className="space-y-1 rounded-lg border border-[var(--gc-border)] p-2">
              <button className="w-full text-left text-xs font-medium" aria-pressed={activeLayerId === layer.id} onClick={() => setActiveLayerId(layer.id)}>{layer.name}</button>
              <div className="flex flex-wrap gap-1">
                <Button size="sm" variant="outline" onClick={() => apply({ type: "update-layer", layerId: layer.id, patch: { visible: !layer.visible } })}>{layer.visible ? "隐藏" : "显示"}</Button>
                <Button size="sm" variant="outline" onClick={() => apply({ type: "update-layer", layerId: layer.id, patch: { locked: !layer.locked } })}>{layer.locked ? "解锁" : "锁定"}</Button>
                <Button size="sm" variant="outline" disabled={index === history.present.layers.length - 1} onClick={() => apply({ type: "move-layer", layerId: layer.id, index: index + 1 })}>上移</Button>
                <Button size="sm" variant="outline" disabled={index === 0} onClick={() => apply({ type: "move-layer", layerId: layer.id, index: index - 1 })}>下移</Button>
              </div>
              <label className="block text-[10px]">不透明度
                <input type="range" min="0" max="1" step="0.05" value={layer.opacity} onChange={(event) => apply({ type: "update-layer", layerId: layer.id, patch: { opacity: Number(event.target.value) } })} className="w-full" />
              </label>
            </div>;
          })}
        </section>
      </aside>
    </div>
  );
}

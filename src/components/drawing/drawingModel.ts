export const DRAWING_LIMITS = {
  minCanvasSize: 256,
  maxCanvasSize: 4096,
  maxLayers: 5,
  maxObjects: 2_000,
  maxPoints: 100_000,
  maxTextBytes: 4_000,
  maxDocumentBytes: 2 * 1024 * 1024,
  maxExportPixels: 16_777_216,
  maxExportPixelRatio: 2,
  minStrokeWidth: 1,
  maxStrokeWidth: 256,
} as const;

export type DrawingCompositeMode = "source-over" | "destination-out";

export interface DrawingStroke {
  id: string;
  kind: "stroke";
  points: number[];
  color: string;
  width: number;
  composite: DrawingCompositeMode;
}

export interface DrawingLine {
  id: string;
  kind: "line" | "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
}

export interface DrawingRectangle {
  id: string;
  kind: "rectangle";
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  strokeWidth: number;
  fill?: string;
}

export interface DrawingEllipse {
  id: string;
  kind: "ellipse";
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  color: string;
  strokeWidth: number;
  fill?: string;
}

export interface DrawingText {
  id: string;
  kind: "text";
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  fontFamily: string;
  align: "left" | "center" | "right";
  color: string;
}

export type DrawingObject = DrawingStroke | DrawingLine | DrawingRectangle | DrawingEllipse | DrawingText;

export interface DrawingLayer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  objects: DrawingObject[];
}

export interface DrawingDocument {
  version: 1;
  canvas: { width: number; height: number; background: string };
  layers: DrawingLayer[];
}

export class DrawingBoardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DrawingBoardValidationError";
  }
}

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const fail = (message: string): never => { throw new DrawingBoardValidationError(message); };
const finite = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label}必须是有限数值`);
  return value as number;
};
const boundedStrokeWidth = (value: unknown, label: string) => {
  const width = finite(value, label);
  if (width < DRAWING_LIMITS.minStrokeWidth || width > DRAWING_LIMITS.maxStrokeWidth) {
    fail(`${label}必须在 1–256 px 之间`);
  }
};
const nonEmptyText = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) fail(`${label}不能为空`);
  return value as string;
};

export function createEmptyDrawingDocument(
  width = 1024,
  height = 1024,
  background = "#FFFFFF",
): DrawingDocument {
  return {
    version: 1,
    canvas: { width, height, background },
    layers: [{ id: "layer-1", name: "图层 1", visible: true, locked: false, opacity: 1, objects: [] }],
  };
}

function validateObject(object: unknown, path: string, ids: Set<string>): number {
  if (!object || typeof object !== "object" || Array.isArray(object)) fail(`${path}不是有效对象`);
  const value = object as Record<string, unknown>;
  const id = nonEmptyText(value.id, `${path}.id`);
  if (ids.has(id)) fail("图层与对象 id 不能重复");
  ids.add(id);
  if (!["stroke", "line", "arrow", "rectangle", "ellipse", "text"].includes(String(value.kind))) {
    return fail(`${path}包含不支持的绘画对象`);
  }
  if (typeof value.color !== "string" || !value.color) fail(`${path}.color不能为空`);
  switch (value.kind) {
    case "stroke": {
      if (!Array.isArray(value.points) || value.points.length < 4 || value.points.length % 2 !== 0) {
        fail(`${path}.points必须包含至少两个坐标点`);
      }
      const points = value.points as unknown[];
      points.forEach((coordinate, index) => finite(coordinate, `${path}.points[${index}]`));
      boundedStrokeWidth(value.width, `${path}.width`);
      if (value.composite !== "source-over" && value.composite !== "destination-out") {
        fail(`${path}.composite不受支持`);
      }
      return points.length / 2;
    }
    case "line":
    case "arrow":
      ["x1", "y1", "x2", "y2"].forEach((key) => finite(value[key], `${path}.${key}`));
      boundedStrokeWidth(value.width, `${path}.width`);
      return 0;
    case "rectangle":
      ["x", "y", "width", "height"].forEach((key) => finite(value[key], `${path}.${key}`));
      boundedStrokeWidth(value.strokeWidth, `${path}.strokeWidth`);
      return 0;
    case "ellipse":
      ["x", "y", "radiusX", "radiusY"].forEach((key) => finite(value[key], `${path}.${key}`));
      boundedStrokeWidth(value.strokeWidth, `${path}.strokeWidth`);
      return 0;
    case "text":
      if (typeof value.text !== "string") fail(`${path}.text必须是字符串`);
      if (utf8Bytes(value.text as string) > DRAWING_LIMITS.maxTextBytes) fail("单个文字对象最多 4000 字节");
      ["x", "y", "width", "fontSize"].forEach((key) => finite(value[key], `${path}.${key}`));
      nonEmptyText(value.fontFamily, `${path}.fontFamily`);
      if (!(["left", "center", "right"] as unknown[]).includes(value.align)) fail(`${path}.align不受支持`);
      return 0;
    default:
      return fail(`${path}包含不支持的绘画对象`);
  }
}

export function validateDrawingDocument(
  input: unknown,
  options?: { exportPixelRatio?: number },
): DrawingDocument {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("画板文档必须是对象");
  const document = input as Record<string, unknown>;
  if (document.version !== 1) fail("只支持 DrawingDocument v1");
  if (!document.canvas || typeof document.canvas !== "object" || Array.isArray(document.canvas)) fail("canvas无效");
  const canvas = document.canvas as Record<string, unknown>;
  const width = finite(canvas.width, "canvas.width");
  const height = finite(canvas.height, "canvas.height");
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) fail("画布宽高必须是整数");
  if (
    width < DRAWING_LIMITS.minCanvasSize || width > DRAWING_LIMITS.maxCanvasSize ||
    height < DRAWING_LIMITS.minCanvasSize || height > DRAWING_LIMITS.maxCanvasSize
  ) fail("画布宽高必须在 256–4096 px 之间");
  nonEmptyText(canvas.background, "canvas.background");

  if (!Array.isArray(document.layers) || document.layers.length < 1) fail("画板至少需要 1 个图层");
  const layers = document.layers as unknown[];
  if (layers.length > DRAWING_LIMITS.maxLayers) fail("画板最多 5 个图层");
  const ids = new Set<string>();
  let objectCount = 0;
  let pointCount = 0;
  layers.forEach((layerValue, layerIndex) => {
    const path = `layers[${layerIndex}]`;
    if (!layerValue || typeof layerValue !== "object" || Array.isArray(layerValue)) fail(`${path}无效`);
    const layer = layerValue as Record<string, unknown>;
    const id = nonEmptyText(layer.id, `${path}.id`);
    if (ids.has(id)) fail("图层与对象 id 不能重复");
    ids.add(id);
    nonEmptyText(layer.name, `${path}.name`);
    if (typeof layer.visible !== "boolean" || typeof layer.locked !== "boolean") fail(`${path}可见与锁定状态无效`);
    const opacity = finite(layer.opacity, `${path}.opacity`);
    if (opacity < 0 || opacity > 1) fail(`${path}.opacity必须在 0–1 之间`);
    if (!Array.isArray(layer.objects)) fail(`${path}.objects必须是数组`);
    const objects = layer.objects as unknown[];
    objectCount += objects.length;
    if (objectCount > DRAWING_LIMITS.maxObjects) fail("画板最多 2000 个对象");
    objects.forEach((object, objectIndex) => {
      pointCount += validateObject(object, `${path}.objects[${objectIndex}]`, ids);
      if (pointCount > DRAWING_LIMITS.maxPoints) fail("画板最多 100000 个笔迹点");
    });
  });

  const bytes = utf8Bytes(JSON.stringify(input));
  if (bytes > DRAWING_LIMITS.maxDocumentBytes) fail("画板文档最多 2 MiB");
  if (options?.exportPixelRatio !== undefined) {
    const ratio = finite(options.exportPixelRatio, "导出像素倍率");
    if (ratio <= 0 || ratio > DRAWING_LIMITS.maxExportPixelRatio) fail("导出像素倍率最多为 2");
    if (width * height * ratio * ratio > DRAWING_LIMITS.maxExportPixels) fail("导出像素总量超过 16777216");
  }
  return input as DrawingDocument;
}

function squareDistanceToSegment(
  px: number, py: number, x1: number, y1: number, x2: number, y2: number,
): number {
  let x = x1;
  let y = y1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx !== 0 || dy !== 0) {
    const t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = x2; y = y2; }
    else if (t > 0) { x += dx * t; y += dy * t; }
  }
  const ox = px - x;
  const oy = py - y;
  return ox * ox + oy * oy;
}

/** Deterministic Ramer–Douglas–Peucker simplification over a flat [x,y,...] list. */
export function simplifyStrokePoints(points: readonly number[], tolerance = 0.75): number[] {
  if (points.length < 6 || points.length % 2 !== 0 || tolerance <= 0) return [...points];
  const keep = new Set([0, points.length / 2 - 1]);
  const threshold = tolerance * tolerance;
  const visit = (start: number, end: number) => {
    let furthest = -1;
    let distance = threshold;
    for (let index = start + 1; index < end; index += 1) {
      const candidate = squareDistanceToSegment(
        points[index * 2], points[index * 2 + 1],
        points[start * 2], points[start * 2 + 1],
        points[end * 2], points[end * 2 + 1],
      );
      if (candidate > distance) { distance = candidate; furthest = index; }
    }
    if (furthest < 0) return;
    keep.add(furthest);
    visit(start, furthest);
    visit(furthest, end);
  };
  visit(0, points.length / 2 - 1);
  return [...keep].sort((a, b) => a - b).flatMap((index) => [points[index * 2], points[index * 2 + 1]]);
}

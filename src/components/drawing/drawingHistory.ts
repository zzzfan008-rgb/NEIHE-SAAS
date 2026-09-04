import {
  validateDrawingDocument,
  type DrawingDocument,
  type DrawingLayer,
  type DrawingObject,
} from "./drawingModel";

export interface DrawingHistory {
  past: DrawingDocument[];
  present: DrawingDocument;
  future: DrawingDocument[];
}

export type DrawingCommand =
  | { type: "add-object"; layerId: string; object: DrawingObject }
  | { type: "update-object"; layerId: string; objectId: string; patch: Partial<DrawingObject> }
  | { type: "remove-object"; layerId: string; objectId: string }
  | { type: "add-layer"; layer: DrawingLayer; index?: number }
  | { type: "remove-layer"; layerId: string }
  | { type: "move-layer"; layerId: string; index: number }
  | { type: "update-layer"; layerId: string; patch: Partial<Pick<DrawingLayer, "name" | "visible" | "locked" | "opacity">> }
  | { type: "replace-document"; document: DrawingDocument };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function createDrawingHistory(document: DrawingDocument): DrawingHistory {
  validateDrawingDocument(document);
  return { past: [], present: clone(document), future: [] };
}

function applyToDocument(current: DrawingDocument, command: DrawingCommand): DrawingDocument {
  if (command.type === "replace-document") return clone(command.document);
  const next = clone(current);
  if (command.type === "add-layer") {
    const index = Math.max(0, Math.min(command.index ?? next.layers.length, next.layers.length));
    next.layers.splice(index, 0, clone(command.layer));
    return next;
  }
  const index = next.layers.findIndex((layer) => layer.id === command.layerId);
  if (index < 0) throw new Error("找不到目标图层");
  const layer = next.layers[index];
  switch (command.type) {
    case "remove-layer":
      if (next.layers.length === 1) throw new Error("画板至少需要 1 个图层");
      next.layers.splice(index, 1);
      break;
    case "move-layer": {
      const [moved] = next.layers.splice(index, 1);
      next.layers.splice(Math.max(0, Math.min(command.index, next.layers.length)), 0, moved);
      break;
    }
    case "update-layer":
      Object.assign(layer, command.patch);
      break;
    case "add-object":
      if (layer.locked) throw new Error("锁定图层不能编辑");
      layer.objects.push(clone(command.object));
      break;
    case "update-object": {
      if (layer.locked) throw new Error("锁定图层不能编辑");
      const objectIndex = layer.objects.findIndex((object) => object.id === command.objectId);
      if (objectIndex < 0) throw new Error("找不到目标对象");
      layer.objects[objectIndex] = { ...layer.objects[objectIndex], ...clone(command.patch) } as DrawingObject;
      break;
    }
    case "remove-object":
      if (layer.locked) throw new Error("锁定图层不能编辑");
      layer.objects = layer.objects.filter((object) => object.id !== command.objectId);
      break;
  }
  return next;
}

export function applyDrawingCommand(history: DrawingHistory, command: DrawingCommand): DrawingHistory {
  const next = applyToDocument(history.present, command);
  validateDrawingDocument(next);
  if (JSON.stringify(next) === JSON.stringify(history.present)) return history;
  return { past: [...history.past, history.present], present: next, future: [] };
}

export function undoDrawingCommand(history: DrawingHistory): DrawingHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redoDrawingCommand(history: DrawingHistory): DrawingHistory {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}

export type DrawingKeyboardCommand = "undo" | "redo" | "delete-selection" | "escape";

export function drawingKeyboardCommand(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey">,
  targetTagName?: string,
): DrawingKeyboardCommand | null {
  if (["input", "textarea", "select"].includes(targetTagName?.toLowerCase() ?? "")) return null;
  const modifier = Boolean(event.metaKey || event.ctrlKey);
  if (modifier && event.key.toLowerCase() === "z") return event.shiftKey ? "redo" : "undo";
  if (modifier && event.key.toLowerCase() === "y") return "redo";
  if (event.key === "Delete" || event.key === "Backspace") return "delete-selection";
  if (event.key === "Escape") return "escape";
  return null;
}

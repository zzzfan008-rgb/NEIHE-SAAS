import { NODE_SPECS, type NodeKind } from "../types/workflow";
import type { CanvasCreationIntent, WorkbenchDocumentTarget } from "../types/workbench";

export const CANVAS_CREATION_EVENT = "garment:canvas-creation";
export const CANVAS_CREATION_MIME = "application/garment-canvas-creation";
export const OPEN_BUILTIN_TEMPLATE_EVENT = "garment:open-builtin-template";

export interface CanvasCreationRequest {
  target: WorkbenchDocumentTarget;
  intent: CanvasCreationIntent;
  mode: "click" | "drop";
  position?: { x: number; y: number };
}

export function requestCanvasCreation(request: CanvasCreationRequest): void {
  window.dispatchEvent(new CustomEvent<CanvasCreationRequest>(CANVAS_CREATION_EVENT, { detail: request }));
}

export function documentTargetMatches(
  left: WorkbenchDocumentTarget,
  right: WorkbenchDocumentTarget,
): boolean {
  return left.tabId === right.tabId
    && left.projectId === right.projectId
    && left.documentEpoch === right.documentEpoch;
}

function isNodeKind(value: unknown): value is NodeKind {
  return typeof value === "string" && Object.hasOwn(NODE_SPECS, value);
}

export function serializeCanvasCreationDragPayload(intent: CanvasCreationIntent): string {
  return JSON.stringify(intent);
}

export function parseCanvasCreationDragPayload(value: string): CanvasCreationIntent | undefined {
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || typeof raw.type !== "string") return undefined;
    if (raw.type === "node" && isNodeKind(raw.kind)) {
      return {
        type: "node",
        kind: raw.kind,
        ...(raw.preset && typeof raw.preset === "object" && !Array.isArray(raw.preset)
          ? { preset: raw.preset as Record<string, unknown> }
          : {}),
      };
    }
    if (raw.type === "asset-picker" || raw.type === "drawing-board") {
      return { type: raw.type };
    }
    if (raw.type === "workflow-template" && typeof raw.templateId === "string" && raw.templateId.trim()) {
      return { type: "workflow-template", templateId: raw.templateId };
    }
    if (raw.type === "color-palette" && Array.isArray(raw.swatches)) {
      return { type: "color-palette", swatches: raw.swatches as never };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

interface CanvasRect { left: number; top: number; right: number; bottom: number }

function overlapsWithGap(
  position: { x: number; y: number },
  size: { width: number; height: number },
  rect: CanvasRect,
  gap: number,
): boolean {
  return !(
    position.x + size.width + gap <= rect.left
    || position.x >= rect.right + gap
    || position.y + size.height + gap <= rect.top
    || position.y >= rect.bottom + gap
  );
}

export function findNearestVisibleNodePosition(options: {
  viewport: CanvasRect;
  preferred: { x: number; y: number };
  nodeSize: { width: number; height: number };
  occupied: readonly CanvasRect[];
  gap?: number;
  preservePreferred?: boolean;
}): { x: number; y: number } {
  if (options.preservePreferred) return { ...options.preferred };
  const gap = options.gap ?? 24;
  const clamp = (candidate: { x: number; y: number }) => ({
    x: Math.min(Math.max(candidate.x, options.viewport.left), options.viewport.right - options.nodeSize.width),
    y: Math.min(Math.max(candidate.y, options.viewport.top), options.viewport.bottom - options.nodeSize.height),
  });
  const preferred = clamp({
    x: options.preferred.x - options.nodeSize.width / 2,
    y: options.preferred.y - options.nodeSize.height / 2,
  });
  const clear = (candidate: { x: number; y: number }) => (
    options.occupied.every((rect) => !overlapsWithGap(candidate, options.nodeSize, rect, gap))
  );
  if (clear(preferred)) return preferred;
  const stepX = options.nodeSize.width + gap;
  const stepY = options.nodeSize.height + gap;
  for (let ring = 1; ring <= 12; ring += 1) {
    const candidates = [
      { x: preferred.x + stepX * ring, y: preferred.y },
      { x: preferred.x, y: preferred.y + stepY * ring },
      { x: preferred.x - stepX * ring, y: preferred.y },
      { x: preferred.x, y: preferred.y - stepY * ring },
      { x: preferred.x + stepX * ring, y: preferred.y + stepY * ring },
      { x: preferred.x - stepX * ring, y: preferred.y + stepY * ring },
      { x: preferred.x + stepX * ring, y: preferred.y - stepY * ring },
      { x: preferred.x - stepX * ring, y: preferred.y - stepY * ring },
    ];
    for (const candidate of candidates) {
      const bounded = clamp(candidate);
      if (clear(bounded)) return bounded;
    }
  }
  return preferred;
}

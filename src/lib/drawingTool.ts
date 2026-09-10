import type { WorkbenchDocumentTarget } from "@/types/workbench";

export const OPEN_DRAWING_TOOL_EVENT = "garment:open-drawing-tool";

export interface OpenDrawingToolRequest {
  target: WorkbenchDocumentTarget;
  position: { x: number; y: number };
}

export function openDrawingTool(request: OpenDrawingToolRequest): void {
  window.dispatchEvent(
    new CustomEvent<OpenDrawingToolRequest>(OPEN_DRAWING_TOOL_EVENT, {
      detail: request,
    }),
  );
}

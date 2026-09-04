import type { WorkbenchDocumentTarget } from "@/types/workbench";

export const OPEN_COLOR_TOOL_EVENT = "garment:open-color-tool";

export interface OpenColorToolRequest {
  target: WorkbenchDocumentTarget;
}

export function openColorTool(target: WorkbenchDocumentTarget): void {
  window.dispatchEvent(new CustomEvent<OpenColorToolRequest>(OPEN_COLOR_TOOL_EVENT, {
    detail: { target },
  }));
}

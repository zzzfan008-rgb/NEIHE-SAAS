import type { Asset, ColorSwatch, NodeKind, WorkflowInputRole } from "./workflow";

/** Five stable discovery groups. UI open/hover state is deliberately not persisted. */
export type ToolGroupId = "add" | "apparel" | "try-on" | "video" | "create";

export type ToolIconName = string;

export type CanvasCreationIntent =
  | { type: "node"; kind: NodeKind; preset?: Record<string, unknown> }
  | { type: "asset-picker" }
  | { type: "workflow-template"; templateId: string }
  | { type: "drawing-board" }
  | { type: "color-palette"; swatches: ColorSwatch[] };

export interface ToolItem {
  id: string;
  name: string;
  icon: ToolIconName;
  description: string;
  availability: "available" | "unavailable";
  disabledReason?: string;
  creationIntent?: CanvasCreationIntent;
  capabilityGate?: {
    domain: "video";
    capabilityId: string;
    approvalState: "blocked" | "approved";
  };
}

export interface ToolGroup {
  id: ToolGroupId;
  label: string;
  icon: ToolIconName;
  items: readonly ToolItem[];
}

export interface WorkbenchUiState {
  hoveredToolGroupId: ToolGroupId | null;
  openToolGroupId: ToolGroupId | null;
  pinnedToolGroupId: ToolGroupId | null;
  rightDockOpen: boolean;
  conversationDockOpen: boolean;
  resultsFlyoutOpen: boolean;
}

/** Immutable identity captured before any delayed or asynchronous command starts. */
export interface WorkbenchDocumentTarget {
  tabId: string;
  projectId: string;
  documentEpoch: number;
}

export interface ConnectionDraft {
  target: WorkbenchDocumentTarget;
  sourceNodeId: string;
  targetNodeId: string;
  sourceHandle: string | null;
  proposedTargetHandle: WorkflowInputRole | null;
}

export type DocumentTargetCommand =
  | { type: "create"; target: WorkbenchDocumentTarget; intent: CanvasCreationIntent; position?: { x: number; y: number } }
  | { type: "add-asset"; target: WorkbenchDocumentTarget; asset: Pick<Asset, "name" | "image">; position: { x: number; y: number } }
  | { type: "confirm-connection"; draft: ConnectionDraft; targetHandle: WorkflowInputRole }
  | { type: "commit-drawing"; target: WorkbenchDocumentTarget; nodeId: string; contentRef: string; previewImageRef: string };

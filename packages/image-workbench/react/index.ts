import "@xyflow/react/dist/style.css";
import "../src/index.css";
import { TiAngelNode } from "../src/components/nodes/TiAngelNode";
import { ImageInputNode } from "../src/components/nodes/ImageInputNode";
import { BackgroundExtractNode } from "../src/components/nodes/BackgroundExtractNode";
import { ResultNode } from "../src/components/nodes/ResultNode";
import { useFlowStore } from "../src/store/flowStore";

export { TiAngelNode, ImageInputNode, BackgroundExtractNode, ResultNode };
export { ConversationPanel } from "../src/components/conversation/ConversationPanel";
export { PoseEditorDialog } from "../src/components/pose/PoseEditorDialog";
export { WorkbenchRuntime, WorkbenchResults, WorkbenchRecoveryNotice, useWorkbenchRuntime } from "./WorkbenchRuntime";
export { WorkbenchSession } from "./WorkbenchSession";
export { AuthProvider, useAuth } from "../src/auth/AuthContext";
export * from "../src/store/flowStore";
export * from "../src/store/imageConversationStore";
export * from "../src/lib/overlayEvents";
export * from "../src/lib/documentSnapshot";
export * from "../src/lib/imageConversationClient";
export type * from "../src/types/workflow";
export type * from "../src/types/imageConversation";

export const imageWorkbenchNodeTypes = {
  "ti-angle": TiAngelNode,
  "image-input": ImageInputNode,
  "background-extract": BackgroundExtractNode,
  result: ResultNode,
};

/** Pose identity is part of the canonical document, not just a different component label. */
export function addPoseReferenceNode(position: { x: number; y: number }) {
  return useFlowStore.getState().addNode("image-input", position, { poseReference: true });
}

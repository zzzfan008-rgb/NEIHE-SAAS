import type { DragEvent } from "react";
import {
  selectActiveDocumentTarget,
  selectActiveNodes,
  selectResultImages,
  useFlowStore,
  type DocumentTarget,
  type FlowState,
} from "@/store/flowStore";
import { documentTargetsMatch, sourceResultIdFromReference, type ImageConversationSourceSelection } from "@/lib/imageConversationInputs";

export const CANVAS_IMAGE_DRAG_TYPE = "application/x-garment-canvas-image";

/** 画布图片可作为拖拽来源的引用形式；长按手势与原生拖放共用同一判定。 */
export function isSupportedCanvasImageRef(ref: string): boolean {
  return ref.startsWith("/api/files/") || ref.startsWith("asset/") || ref.startsWith("generation-output/");
}

export function startCanvasImageDrag(event: DragEvent<HTMLElement>, nodeId: string, imageRef: string): void {
  if (!isSupportedCanvasImageRef(imageRef)) {
    event.preventDefault();
    return;
  }
  const target = selectActiveDocumentTarget(useFlowStore.getState());
  event.dataTransfer.setData(CANVAS_IMAGE_DRAG_TYPE, JSON.stringify({ target, nodeId, imageRef }));
  event.dataTransfer.effectAllowed = "copy";
}

export function isCanvasImageDrag(types: readonly string[]): boolean {
  return Array.from(types).includes(CANVAS_IMAGE_DRAG_TYPE);
}

export function resolveCanvasImageDrop(
  data: string,
  target: DocumentTarget,
  state: FlowState,
): ImageConversationSourceSelection | null {
  try {
    const payload: unknown = JSON.parse(data);
    if (!payload || typeof payload !== "object") return null;
    const { target: sourceTarget, nodeId, imageRef } = payload as Record<string, unknown>;
    if (
      !sourceTarget || typeof sourceTarget !== "object" ||
      typeof nodeId !== "string" || typeof imageRef !== "string" ||
      !isSupportedCanvasImageRef(imageRef) ||
      !documentTargetsMatch(sourceTarget as DocumentTarget, target) ||
      !documentTargetsMatch(target, selectActiveDocumentTarget(state))
    ) return null;
    const node = selectActiveNodes(state).find((candidate) => candidate.id === nodeId);
    if (!node) return null;
    const nodeData = node.data as Record<string, unknown>;
    const refs = [
      nodeData.imageUrl,
      ...(Array.isArray(nodeData.images) ? nodeData.images : []),
      ...(Array.isArray(nodeData.outputImages) ? nodeData.outputImages : []),
      ...(node.type === "result" ? selectResultImages(state, nodeId) : []),
    ];
    if (!refs.includes(imageRef)) return null;
    const stableRef = nodeData.imageUrl === imageRef &&
      typeof nodeData.imageConversationSourceRef === "string" &&
      isSupportedCanvasImageRef(nodeData.imageConversationSourceRef)
      ? nodeData.imageConversationSourceRef
      : imageRef;
    return {
      sourceRef: stableRef,
      previewRef: imageRef,
      label: String(nodeData.label || "画布图片"),
      sourceResultId: sourceResultIdFromReference(stableRef),
    };
  } catch {
    return null;
  }
}

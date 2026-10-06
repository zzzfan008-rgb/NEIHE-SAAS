import type { PointerEvent as ReactPointerEvent } from "react";
import { isSupportedCanvasImageRef } from "@/lib/imageConversationDrag";
import { selectActiveDocumentTarget, useFlowStore } from "@/store/flowStore";
import { CANVAS_IMAGE_DROPZONE_ATTRIBUTE, useCanvasImageDragStore } from "@/store/canvasImageDragStore";

/**
 * 画布图片拖拽手势：右键长按（默认 350ms、位移不超过容差）后进入拖拽，左键保持给节点移动。
 * 原生 HTML5 拖放只支持主键，因此这里用指针事件实现，并与原生拖放共用同一份 payload。
 */
export const CANVAS_IMAGE_LONG_PRESS_MS = 350;
export const CANVAS_IMAGE_PRESS_TOLERANCE_PX = 8;
/** 落在有效落点后派发给对话面板的事件；payload 与原生拖放格式一致。 */
export const CANVAS_IMAGE_DROP_EVENT = "garment:canvas-image-drop";
/** 结束拖拽后短暂继续抑制右键菜单，覆盖在 mouseup 才弹菜单的平台。 */
const CONTEXT_MENU_SUPPRESSION_TAIL_MS = 500;

export interface CanvasImageDropDetail {
  payload: string;
}

interface PendingPress {
  payload: string;
  preview: string;
  startX: number;
  startY: number;
  timer: number;
}

let pending: PendingPress | null = null;
let listenersAttached = false;
let detachTimer = 0;
let suppressContextMenuUntil = 0;

function dropzoneUnderPointer(x: number, y: number): Element | null {
  if (typeof document === "undefined") return null;
  return document.elementFromPoint(x, y)?.closest(`[${CANVAS_IMAGE_DROPZONE_ATTRIBUTE}="enabled"]`) ?? null;
}

/** 构造与原生拖放一致的 payload；不支持的引用返回 null。 */
export function canvasImageDragPayload(nodeId: string, imageRef: string): string | null {
  if (!isSupportedCanvasImageRef(imageRef)) return null;
  return JSON.stringify({ target: selectActiveDocumentTarget(useFlowStore.getState()), nodeId, imageRef });
}

function handlePointerMove(event: PointerEvent): void {
  const press = pending;
  if (!press) return;
  if (useCanvasImageDragStore.getState().drag) {
    useCanvasImageDragStore.getState().move(event.clientX, event.clientY, Boolean(dropzoneUnderPointer(event.clientX, event.clientY)));
    return;
  }
  if (Math.hypot(event.clientX - press.startX, event.clientY - press.startY) > CANVAS_IMAGE_PRESS_TOLERANCE_PX) {
    cancelCanvasImagePress();
  }
}

function handlePointerUp(event: PointerEvent): void {
  const press = pending;
  if (!press) return;
  const drag = useCanvasImageDragStore.getState().drag;
  if (!drag) {
    cancelCanvasImagePress();
    return;
  }
  const dropped = Boolean(dropzoneUnderPointer(event.clientX, event.clientY));
  const { payload } = drag;
  window.clearTimeout(press.timer);
  pending = null;
  useCanvasImageDragStore.getState().end();
  suppressContextMenuUntil = performance.now() + CONTEXT_MENU_SUPPRESSION_TAIL_MS;
  scheduleListenerDetach();
  if (dropped) {
    window.dispatchEvent(new CustomEvent<CanvasImageDropDetail>(CANVAS_IMAGE_DROP_EVENT, { detail: { payload } }));
  }
}

function handlePointerCancel(): void {
  cancelCanvasImagePress();
}

function handleKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape") cancelCanvasImagePress();
}

function handleWindowBlur(): void {
  cancelCanvasImagePress();
}

function handleContextMenu(event: MouseEvent): void {
  if (pending || useCanvasImageDragStore.getState().drag || performance.now() < suppressContextMenuUntil) {
    event.preventDefault();
  }
}

/** 延迟卸载监听器，覆盖在 mouseup 才弹菜单的平台；新的按压会取消这次卸载。 */
function scheduleListenerDetach(): void {
  window.clearTimeout(detachTimer);
  detachTimer = window.setTimeout(detachListeners, CONTEXT_MENU_SUPPRESSION_TAIL_MS + 50);
}

function attachListeners(): void {
  if (listenersAttached) return;
  window.clearTimeout(detachTimer);
  detachTimer = 0;
  listenersAttached = true;
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp);
  window.addEventListener("pointercancel", handlePointerCancel);
  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("contextmenu", handleContextMenu);
  window.addEventListener("blur", handleWindowBlur);
}

function detachListeners(): void {
  if (!listenersAttached) return;
  window.clearTimeout(detachTimer);
  detachTimer = 0;
  listenersAttached = false;
  window.removeEventListener("pointermove", handlePointerMove);
  window.removeEventListener("pointerup", handlePointerUp);
  window.removeEventListener("pointercancel", handlePointerCancel);
  window.removeEventListener("keydown", handleKeyDown);
  window.removeEventListener("contextmenu", handleContextMenu);
  window.removeEventListener("blur", handleWindowBlur);
}

/** 取消进行中的长按或拖拽（位移超限、Esc、窗口失焦、指针取消）。 */
export function cancelCanvasImagePress(): void {
  const press = pending;
  pending = null;
  if (press) window.clearTimeout(press.timer);
  if (useCanvasImageDragStore.getState().drag) useCanvasImageDragStore.getState().end();
  detachListeners();
}

/** 图片元素的右键按下入口：长按达到阈值后开始拖拽，否则按普通右键处理。 */
export function beginCanvasImagePress(event: ReactPointerEvent<HTMLElement>, nodeId?: string, imageRef?: string): void {
  if (event.button !== 2 || !nodeId || !imageRef) return;
  const payload = canvasImageDragPayload(nodeId, imageRef);
  if (!payload) return;
  cancelCanvasImagePress();
  attachListeners();
  pending = {
    payload,
    preview: imageRef,
    startX: event.clientX,
    startY: event.clientY,
    timer: window.setTimeout(() => {
      const press = pending;
      if (!press) return;
      useCanvasImageDragStore.getState().begin(press.payload, press.preview, press.startX, press.startY);
    }, CANVAS_IMAGE_LONG_PRESS_MS),
  };
}

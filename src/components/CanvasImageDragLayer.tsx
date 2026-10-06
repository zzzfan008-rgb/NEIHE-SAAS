import { thumbnailImageUrl } from "@/lib/images";
import { useCanvasImageDragStore } from "@/store/canvasImageDragStore";

/**
 * 右键长按拖动画布图片时的跟随光标浮层：40×40 缩略图，偏移光标避免遮挡指针，且不接收指针事件。
 */
export function CanvasImageDragLayer() {
  const drag = useCanvasImageDragStore((state) => state.drag);
  if (!drag) return null;
  return (
    <div
      aria-hidden="true"
      data-canvas-image-drag-layer="true"
      className="pointer-events-none fixed z-[70] rounded-md border border-[var(--gc-accent)] bg-[var(--gc-panel)] p-0.5 shadow-xl"
      style={{ left: drag.x + 12, top: drag.y + 12 }}
    >
      <img src={thumbnailImageUrl(drag.preview)} alt="" className="h-10 w-10 rounded object-cover" />
    </div>
  );
}

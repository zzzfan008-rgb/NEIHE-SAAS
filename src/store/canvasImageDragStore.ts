import { create } from "zustand";

/** 画布图片拖拽的落点契约：只有带此属性且值为 enabled 的元素接受画布图片。 */
export const CANVAS_IMAGE_DROPZONE_ATTRIBUTE = "data-canvas-image-dropzone";

export interface CanvasImageDragState {
  /** 进行中的画布图片拖拽（跟随光标的浮层 + 落点高亮）；null 表示无拖拽。 */
  drag: {
    payload: string;
    preview: string;
    x: number;
    y: number;
    overDropzone: boolean;
  } | null;
  begin: (payload: string, preview: string, x: number, y: number) => void;
  move: (x: number, y: number, overDropzone: boolean) => void;
  end: () => void;
}

export const useCanvasImageDragStore = create<CanvasImageDragState>((set) => ({
  drag: null,
  begin: (payload, preview, x, y) => set({ drag: { payload, preview, x, y, overDropzone: false } }),
  move: (x, y, overDropzone) =>
    set((state) => (state.drag ? { drag: { ...state.drag, x, y, overDropzone } } : {})),
  end: () => set({ drag: null }),
}));

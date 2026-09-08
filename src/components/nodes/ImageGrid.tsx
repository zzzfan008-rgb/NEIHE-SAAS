import type { ReactNode } from "react";
import { EyeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFlowStore } from "@/store/flowStore";
import { thumbnailImageUrl } from "@/lib/images";

interface ImageGridProps {
  images?: string[] | null;
  empty?: string;
  /** 每张图下方渲染的操作区（如「存为素材」按钮） */
  renderAction?: (url: string, index: number) => ReactNode;
  selectedIndex?: number;
  onSelect?: (url: string, index: number) => void;
}

/** 生成结果缩略图网格（单击弹出全局查看器，滚轮缩放） */
export function ImageGrid({ images, empty = "暂无生成结果", renderAction, selectedIndex, onSelect }: ImageGridProps) {
  const openViewer = useFlowStore((s) => s.openViewer);
  const safeImages = Array.isArray(images)
    ? images.filter((image): image is string => typeof image === "string" && image.length > 0)
    : [];

  if (safeImages.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[#2a2a2a] py-4 text-center text-[10px] text-neutral-600">
        {empty}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-1.5">
      {safeImages.map((url, i) => (
        <div
          key={`${url}-${i}`}
          className={`nodrag group relative overflow-hidden rounded-md border bg-[var(--gc-control)] ${onSelect && selectedIndex === i ? "border-[var(--gc-accent)] ring-1 ring-[var(--gc-accent)]/50" : "border-[var(--gc-border)]"}`}
        >
          <Button
            type="button"
            variant="ghost"
            aria-label={onSelect ? `选择生成结果 ${i + 1}` : `查看生成结果 ${i + 1}`}
            aria-pressed={onSelect ? selectedIndex === i : undefined}
            onClick={() => onSelect ? onSelect(url, i) : openViewer({ url, title: `生成结果 ${i + 1}` })}
            className="block h-auto w-full rounded-none p-0"
          >
            <img
              src={thumbnailImageUrl(url)}
              alt={`生成结果 ${i + 1}`}
              loading="lazy"
              decoding="async"
              className="aspect-square w-full object-cover transition-transform group-hover:scale-105"
            />
          </Button>
          {onSelect && (
            <Button
              type="button"
              variant="secondary"
              size="icon-xs"
              title="查看大图"
              aria-label={`查看生成结果 ${i + 1}`}
              onClick={() => openViewer({ url, title: `生成结果 ${i + 1}` })}
              className="absolute right-1 top-1 opacity-0 shadow-md transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            >
              <EyeIcon aria-hidden="true" />
            </Button>
          )}
          {renderAction?.(url, i)}
        </div>
      ))}
    </div>
  );
}

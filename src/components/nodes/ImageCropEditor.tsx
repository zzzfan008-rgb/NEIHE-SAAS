import { useRef, useState } from "react";
import { CheckIcon, Loader2Icon, XIcon } from "lucide-react";
import { useViewport } from "@xyflow/react";
import { Button } from "@/components/ui/button";
import { RectangleCropSurface, type ImageCropRect } from "@/components/RectangleCropSurface";

export default function ImageCropEditor({ source, onSave, onClose }: {
  source: string;
  onSave: (file: File) => Promise<void>;
  onClose: () => void;
}) {
  const [crop, setCrop] = useState<ImageCropRect | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [error, setError] = useState("");
  const { zoom } = useViewport();
  const save = async () => {
    const image = imageRef.current;
    if (!crop || !image || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const x = Math.floor(crop.x * image.naturalWidth);
      const y = Math.floor(crop.y * image.naturalHeight);
      const width = Math.max(1, Math.min(image.naturalWidth - x, Math.round(crop.width * image.naturalWidth)));
      const height = Math.max(1, Math.min(image.naturalHeight - y, Math.round(crop.height * image.naturalHeight)));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("浏览器暂不支持裁切，请重试");
      // Canvas reads original pixels; the editor's CSS grayscale is preview-only.
      context.drawImage(image, x, y, width, height, 0, 0, width, height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("裁切导出失败，请重试")), "image/png"));
      await onSave(new File([blob], "裁切图片.png", { type: "image/png" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "裁切保存失败，请重试");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return <>
    <RectangleCropSurface
      source={source} alt="已上传图片" crop={crop} onCropChange={setCrop}
      disabled={busy} autoFocus className="h-full w-full" imageClassName="h-full w-full object-contain"
      controlScale={1 / zoom} onConfirm={() => void save()} onCancel={onClose}
      onImageLoad={(image) => {
        if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) {
          setError("图片尺寸过大，无法裁切");
          return;
        }
        imageRef.current = image;
      }}
      onImageError={() => setError("图片加载失败，请取消后重试")}
      actions={<div className="flex h-8 w-[72px] items-center justify-center gap-1 rounded-lg border border-(--gc-border) bg-(--gc-panel) shadow-lg">
        <Button type="button" size="icon-xs" variant="ghost" aria-label="取消裁切" title="取消裁切（Esc）" className="text-destructive" onClick={onClose}><XIcon /></Button>
        <Button type="button" size="icon-xs" variant="ghost" aria-label="确认裁切" title="确认裁切（Enter）" disabled={!crop || busy || !imageRef.current} className="text-(--gc-accent)" onClick={() => void save()}>{busy ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <CheckIcon />}</Button>
      </div>}
    />
    {error && <p role="alert" className="absolute inset-x-1 top-1 z-30 rounded bg-(--gc-panel) p-1 text-xs text-destructive">{error}</p>}
  </>;
}

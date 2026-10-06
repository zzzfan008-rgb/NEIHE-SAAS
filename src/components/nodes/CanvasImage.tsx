import { useEffect, useState, type ImgHTMLAttributes } from "react";
import { thumbnailImageUrl } from "@/lib/images";

/**
 * 画布内图片：默认加载服务端衍生缩略图以节省解码与内存；缩略图不可用时回退原图。
 * 交互用途（查看器、裁切、蒙版、拖拽出图、AI 执行）仍使用原图 URL，不经过本组件。
 */
export function CanvasImage({
  source,
  onError,
  ...rest
}: { source: string } & ImgHTMLAttributes<HTMLImageElement>) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source]);
  const thumbnail = thumbnailImageUrl(source);
  return (
    <img
      {...rest}
      src={failed ? source : thumbnail}
      onError={(event) => {
        if (!failed && thumbnail !== source) {
          setFailed(true);
          return;
        }
        onError?.(event);
      }}
    />
  );
}

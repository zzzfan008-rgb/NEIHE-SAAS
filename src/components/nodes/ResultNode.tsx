import { useEffect, useRef, useState } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { useFlowStore, selectResultImages } from "@/store/flowStore";
import { useResultExport } from "@/store/resultExportStore";
import type { ResultNodeData } from "@/types/workflow";
import { imageExtensionFromReference, type ImageFileExtension } from "@/lib/imageFormat";
import { NodeFrame, inputClass } from "./NodeFrame";
import { ImageGrid } from "./ImageGrid";
import { useCoalescedTextEdit } from "@/hooks/useCoalescedTextEdit";
import { MediaNodeActionToolbar } from "./NodeActionToolbar";

function downloadImage(url: string, index: number, extension?: ImageFileExtension) {
  const a = document.createElement("a");
  a.href = url;
  a.download = `garment-result-${index + 1}${extension ? `.${extension}` : ""}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function ResultSaveControls({ images }: { images: string[] }) {
  const store = useResultExport(
    useShallow((s) => ({
      supported: s.supported,
      handle: s.handle,
      directoryName: s.directoryName,
      autoSave: s.autoSave,
      permission: s.permission,
      chooseDirectory: s.chooseDirectory,
      clearDirectory: s.clearDirectory,
      setAutoSave: s.setAutoSave,
      saveAll: s.saveAll,
    })),
  );
  const { supported, handle, directoryName, autoSave, permission, chooseDirectory, clearDirectory, setAutoSave, saveAll } = store;
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const savedRefs = useRef<Set<string>>(new Set());
  const savedDirectory = useRef<FileSystemDirectoryHandle | null>(handle);

  useEffect(() => {
    if (savedDirectory.current === handle) return;
    savedDirectory.current = handle;
    savedRefs.current.clear();
  }, [handle]);

  // 自动保存：新结果图写盘（需已授权；未授权时不弹窗，提示改用手动按钮授权）
  useEffect(() => {
    if (!supported || !autoSave || !directoryName) return;
    if (permission !== "granted") {
      setStatus("自动保存已开启，点击“保存全部到文件夹”授权后生效");
      return;
    }
    const pending = images.filter((ref) => !savedRefs.current.has(ref));
    if (pending.length === 0) return;
    let cancelled = false;
    void (async () => {
      const result = await saveAll(pending, { prompt: false });
      if (cancelled) return;
      result.savedImages.forEach((ref) => savedRefs.current.add(ref));
      setStatus(
        result.errors.length ? `自动保存 ${result.saved} 张，${result.errors.length} 张失败` : `已自动保存 ${result.saved} 张`,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [images, autoSave, supported, directoryName, permission, saveAll]);

  if (!supported) {
    return <p className="text-[9px] text-neutral-600">当前浏览器不支持保存到文件夹，已回退为逐张下载。</p>;
  }

  const onChoose = async () => {
    try {
      await chooseDirectory();
      setStatus(null);
    } catch {
      // 用户取消选择，忽略
    }
  };

  const onSaveAll = async () => {
    if (images.length === 0) return;
    setBusy(true);
    setStatus("保存中…");
    const result = await saveAll(images, { prompt: true });
    result.savedImages.forEach((ref) => savedRefs.current.add(ref));
    setBusy(false);
    setStatus(
      result.saved === 0 && result.errors.length
        ? `保存失败：${result.errors[0]}`
        : `已保存 ${result.saved} 张到「${directoryName}」${result.errors.length ? `，${result.errors.length} 张失败` : ""}`,
    );
  };

  return (
    <div className="space-y-1.5 rounded-md border border-[#262626] p-2">
      <div className="flex items-center gap-1.5 text-[10px] text-neutral-400">
        <span className="text-neutral-500">保存到:</span>
        <span className="truncate text-gold">{directoryName ?? "未设置"}</span>
        <button
          type="button"
          onClick={() => void onChoose()}
          className="nodrag ml-auto shrink-0 rounded-sm border border-[#333] px-1.5 py-0.5 hover:border-gold hover:text-gold"
        >
          选择文件夹
        </button>
        {directoryName && (
          <button
            type="button"
            onClick={() => void clearDirectory()}
            className="nodrag shrink-0 rounded-sm border border-[#333] px-1.5 py-0.5 hover:border-gold hover:text-gold"
          >
            清除
          </button>
        )}
      </div>
      <label className="flex items-center gap-1.5 text-[10px] text-neutral-400">
        <input type="checkbox" className="nodrag" checked={autoSave} onChange={(e) => setAutoSave(e.target.checked)} />
        自动保存新结果图
      </label>
      <button
        type="button"
        disabled={busy || !directoryName || images.length === 0}
        onClick={() => void onSaveAll()}
        className="nodrag w-full rounded-md bg-gold py-1 text-[10px] font-medium text-ink disabled:opacity-40"
      >
        保存全部到文件夹
      </button>
      {status && <p className="text-[9px] text-neutral-500">{status}</p>}
    </div>
  );
}

export function ResultNode({ id, data, selected }: NodeProps<Node<ResultNodeData>>) {
  const images = useFlowStore(useShallow((s) => selectResultImages(s, id)));
  const videos = images.filter((ref) => /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(ref) || ref.startsWith("data:video/"));
  const stillImages = images.filter((ref) => !videos.includes(ref));
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  useEffect(() => {
    if (selectedImageIndex >= stillImages.length) setSelectedImageIndex(Math.max(0, stillImages.length - 1));
  }, [selectedImageIndex, stillImages.length]);
  const noteEdit = useCoalescedTextEdit(
    { kind: "node-data", nodeId: id, field: "note" },
    { multiline: true },
  );

  return (
    <>
      <Handle id="references" type="target" position={Position.Left} title="媒体输入" />
      <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected} toolbar={<MediaNodeActionToolbar nodeId={id} imageActions={videos.length === 0} hasImage={stillImages.length > 0} sourceHandle={`image:${selectedImageIndex}`} />}>
        <ImageGrid images={stillImages} empty={videos.length ? "" : "连接上游节点后自动汇总媒体"} selectedIndex={selectedImageIndex} onSelect={(_, index) => setSelectedImageIndex(index)} />
        {videos.map((video) => <video key={video} src={video} controls preload="metadata" className="nodrag max-h-52 w-full rounded-md bg-black" />)}
        {stillImages.length > 0 && (
          <>
            <ResultSaveControls images={stillImages} />
            <div className="grid grid-cols-2 gap-1.5">
              {images.map((url, i) => {
                const extension = imageExtensionFromReference(url);
                return (
                  <button
                    key={`${url}-${i}`}
                    type="button"
                    onClick={() => downloadImage(url, i, extension)}
                    className="nodrag rounded-md border border-[#262626] py-1 text-[10px] text-neutral-400 hover:border-gold hover:text-gold"
                  >
                    {extension ? `下载 ${extension.toUpperCase()} ${i + 1}` : `下载图片 ${i + 1}`}
                  </button>
                );
              })}
            </div>
          </>
        )}
        {videos.map((video, index) => <a key={`download-${video}`} href={video} download={`garment-video-${index + 1}.mp4`} className="nodrag block rounded-md border border-[#262626] py-1 text-center text-[10px] text-neutral-400 hover:border-gold hover:text-gold">下载视频 {index + 1}</a>)}
        <label className="block space-y-1">
          <span className="text-[10px] text-neutral-500">备注</span>
          <textarea
            value={data.note ?? ""}
            {...noteEdit.bind}
            rows={2}
            placeholder="记录这一版结果的说明…"
            className={`${inputClass} resize-none`}
          />
        </label>
      </NodeFrame>
      {stillImages.map((_, index) => (
        <Handle
          key={`image:${index}`}
          id={`image:${index}`}
          type="source"
          position={Position.Right}
          title={`生成结果 ${index + 1}`}
          style={{ top: `${((index + 1) / (stillImages.length + 1)) * 100}%` }}
        />
      ))}
    </>
  );
}

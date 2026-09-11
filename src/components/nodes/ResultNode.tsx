import { useEffect, useRef, useState } from "react";
import { Position, type NodeProps, type Node } from "@xyflow/react";
import { NodeHandle as Handle } from "./NodeHandle";
import { useShallow } from "zustand/react/shallow";
import { useFlowStore, selectResultImages, selectActiveCompareIds, selectActiveDocumentTarget } from "@/store/flowStore";
import { useResultExport } from "@/store/resultExportStore";
import type { ResultNodeData } from "@/types/workflow";
import { imageExtensionFromReference, type ImageFileExtension } from "@/lib/imageFormat";
import { NodeFrame } from "./NodeFrame";
import { MediaNodeActionToolbar } from "./NodeActionToolbar";
import { CircleIcon, Columns2Icon, DownloadIcon, EyeIcon, MoreHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { OPEN_COMPARE_EVENT } from "@/lib/overlayEvents";
import { ResultNoteControl } from "./ResultNoteControl";

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
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="icon-xs" className="gc-result-more nodrag nopan" aria-label="结果保存选项" />}>
        <MoreHorizontalIcon aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent side="right" className="nodrag nopan nowheel w-72 space-y-3 p-3" aria-label="结果保存选项">
      <div className="space-y-1">
        {images.map((url, index) => <Button key={`${url}-${index}`} variant="ghost" size="sm" className="w-full justify-start" onClick={() => downloadImage(url, index, imageExtensionFromReference(url))}>
          <DownloadIcon aria-hidden="true" />下载图片 {index + 1}
        </Button>)}
      </div>
      {!supported ? <p className="text-xs text-[var(--gc-text-muted)]">当前浏览器不支持保存到文件夹，可使用逐张下载。</p> : <>
      <div className="flex items-center gap-1.5 text-[10px] text-neutral-400">
        <span className="text-neutral-500">保存到:</span>
        <span className="truncate text-gold">{directoryName ?? "未设置"}</span>
        <Button variant="outline" size="xs"
          type="button"
          onClick={() => void onChoose()}
          className="nodrag ml-auto shrink-0 rounded-sm border border-[#333] px-1.5 py-0.5 hover:border-gold hover:text-gold"
        >
          选择文件夹
        </Button>
        {directoryName && (
          <Button variant="outline" size="xs"
            type="button"
            onClick={() => void clearDirectory()}
            className="nodrag shrink-0 rounded-sm border border-[#333] px-1.5 py-0.5 hover:border-gold hover:text-gold"
          >
            清除
          </Button>
        )}
      </div>
      <label className="flex items-center gap-1.5 text-[10px] text-neutral-400">
        <Switch aria-label="自动保存新结果图" className="nodrag" checked={autoSave} onCheckedChange={setAutoSave} />
        自动保存新结果图
      </label>
      <Button size="sm"
        type="button"
        disabled={busy || !directoryName || images.length === 0}
        onClick={() => void onSaveAll()}
        className="nodrag w-full rounded-md bg-gold py-1 text-[10px] font-medium text-ink disabled:opacity-40"
      >
        保存全部到文件夹
      </Button>
      </>}
      {status && <p role="status" className="text-xs text-[var(--gc-text-muted)]">{status}</p>}
      </PopoverContent>
    </Popover>
  );
}

function ResultCompareControl({ image }: { image?: string }) {
  const records = useFlowStore(useShallow((s) => s.recentResults.filter((r) => r.status === "success" && r.image && !/\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(r.image) && !r.image.startsWith("data:video/"))));
  const compareIds = useFlowStore(selectActiveCompareIds);
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={(next) => {
    setOpen(next);
    const record = records.find((r) => r.image === image);
    if (next && record && !compareIds.includes(record.id) && compareIds.length < 4) useFlowStore.getState().toggleCompareId(record.id);
  }}>
    <PopoverTrigger render={<Button variant="outline" className="gc-result-action" disabled={!image} />}><Columns2Icon aria-hidden="true" />对比</PopoverTrigger>
    <PopoverContent className="nodrag nopan nowheel w-72 space-y-3 p-3" aria-label="选择对比结果">
      <p className="text-xs">选择 2–4 张生成结果</p>
      {records.length === 0 && <p className="text-xs text-[var(--gc-text-muted)]">暂无可对比的生成记录</p>}
      <div className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto">
        {records.map((r) => <Button key={r.id} variant="outline" className="h-auto flex-col p-1" aria-label={`对比 ${r.nodeLabel}`} aria-pressed={compareIds.includes(r.id)} disabled={!compareIds.includes(r.id) && compareIds.length >= 4} onClick={() => useFlowStore.getState().toggleCompareId(r.id)}>
          <img src={r.image} alt="" className="h-20 w-full object-contain" />
          <span className="max-w-full truncate text-xs">{compareIds.includes(r.id) ? "已选 · " : ""}{r.nodeLabel}</span>
        </Button>)}
      </div>
      <Button className="w-full" disabled={compareIds.length < 2} onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent(OPEN_COMPARE_EVENT)); }}>对比 {compareIds.length} 张</Button>
    </PopoverContent>
  </Popover>;
}

export function ResultNode({ id, data, selected }: NodeProps<Node<ResultNodeData>>) {
  const images = useFlowStore(useShallow((s) => selectResultImages(s, id)));
  const videos = images.filter((ref) => /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(ref) || ref.startsWith("data:video/"));
  const stillImages = images.filter((ref) => !videos.includes(ref));
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  useEffect(() => {
    if (selectedImageIndex >= stillImages.length) setSelectedImageIndex(Math.max(0, stillImages.length - 1));
  }, [selectedImageIndex, stillImages.length]);
  const target = useFlowStore(useShallow(selectActiveDocumentTarget));
  const selectedImage = stillImages[Math.min(selectedImageIndex, stillImages.length - 1)];
  const viewImage = () => { if (selectedImage) useFlowStore.getState().openViewer({ url: selectedImage, title: data.label }); };

  return (
    <div className="gc-result-node">
      <Handle id="references" type="target" position={Position.Left} title="媒体输入" />
      <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected} toolbar={<MediaNodeActionToolbar nodeId={id} imageActions={videos.length === 0} hasImage={stillImages.length > 0} sourceHandle={`image:${selectedImageIndex}`} />}>
        <CircleIcon aria-hidden="true" className="gc-result-status" />
        <ResultSaveControls images={stillImages} />
        {selectedImage ? <Button variant="ghost" aria-label="查看生成结果大图" className="gc-result-image nodrag nopan" onClick={viewImage}>
          <img src={selectedImage} alt={data.label} decoding="async" />
        </Button> : videos.length === 0 && <div className="gc-result-empty">连接上游节点后自动汇总媒体</div>}
        {stillImages.length > 1 && <div className="nodrag nopan nowheel flex gap-1 overflow-x-auto" aria-label="结果图片选择">
          {stillImages.map((url, index) => <Button key={`${url}-${index}`} variant="outline" aria-label={`选择生成结果 ${index + 1}`} aria-pressed={selectedImageIndex === index} className="gc-result-thumbnail" onClick={() => setSelectedImageIndex(index)}><img src={url} alt="" /></Button>)}
        </div>}
        {videos.map((video) => <video key={video} src={video} controls preload="metadata" className="nodrag max-h-52 w-full rounded-md bg-black" />)}
        {videos.map((video, index) => <Button key={`download-${video}`} variant="outline" className="gc-result-action w-full" render={<a href={video} download={`garment-video-${index + 1}.mp4`} />}>下载视频 {index + 1}</Button>)}
        <div className="gc-result-footer nodrag nopan">
          <Button variant="outline" className="gc-result-action" disabled={!selectedImage} onClick={viewImage}><EyeIcon aria-hidden="true" />查看</Button>
          <ResultCompareControl key={`${target.tabId}:${target.documentEpoch}`} image={selectedImage} />
          <Button variant="outline" className="gc-result-action" disabled={!selectedImage} onClick={() => selectedImage && downloadImage(selectedImage, selectedImageIndex, imageExtensionFromReference(selectedImage))}><DownloadIcon aria-hidden="true" />下载</Button>
          <ResultNoteControl key={`${target.tabId}:${target.projectId}:${target.documentEpoch}:${id}`} nodeId={id} target={target} />
        </div>
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
    </div>
  );
}

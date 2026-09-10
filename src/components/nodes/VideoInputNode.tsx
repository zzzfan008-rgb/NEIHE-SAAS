import { useCallback, useEffect, useRef, useState } from "react";
import { LinkIcon } from "lucide-react";
import { Position, type Node, type NodeProps } from "@xyflow/react";
import { NodeHandle as Handle } from "./NodeHandle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { selectActiveDocumentTarget, useFlowStore } from "@/store/flowStore";
import type { VideoInputNodeData } from "@/types/workflow";
import { MediaNodeActionToolbar } from "./NodeActionToolbar";
import { NodeFrame } from "./NodeFrame";

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function VideoInputNode({ id, data, selected }: NodeProps<Node<VideoInputNodeData>>) {
  const updateNodeDataInTab = useFlowStore((state) => state.updateNodeDataInTab);
  const requestRef = useRef(0);
  const [uploading, setUploading] = useState(false);
  const [referenceDraft, setReferenceDraft] = useState(data.videoUrl ?? "");
  useEffect(() => setReferenceDraft(data.videoUrl ?? ""), [data.videoUrl]);

  const applyReference = useCallback(() => {
    const value = referenceDraft.trim();
    const target = selectActiveDocumentTarget(useFlowStore.getState());
    if (!/^https:\/\//i.test(value) && !/^asset:\/\/[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
      updateNodeDataInTab(target, id, { status: "error", error: "请输入 HTTPS 或 asset:// 视频引用" });
      return;
    }
    updateNodeDataInTab(target, id, {
      videoUrl: value,
      mimeType: value.startsWith("asset://") ? undefined : data.mimeType,
      status: "success",
      error: undefined,
    });
  }, [data.mimeType, id, referenceDraft, updateNodeDataInTab]);
  const handleFile = useCallback(async (file?: File) => {
    if (!file || !["video/mp4", "video/webm", "video/quicktime"].includes(file.type)) return;
    const requestId = ++requestRef.current;
    const target = selectActiveDocumentTarget(useFlowStore.getState());
    setUploading(true);
    try {
      const response = await fetch("/api/files/video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl: await readAsDataUrl(file) }),
      });
      const payload = await response.json().catch(() => ({})) as { url?: string; mimeType?: VideoInputNodeData["mimeType"]; error?: string };
      if (!response.ok || !payload.url) throw new Error(payload.error || "视频上传失败");
      if (requestId === requestRef.current) updateNodeDataInTab(target, id, { videoUrl: payload.url, mimeType: payload.mimeType, status: "success", error: undefined });
    } catch (error) {
      if (requestId === requestRef.current) updateNodeDataInTab(target, id, { status: "error", error: error instanceof Error ? error.message : "视频上传失败" });
    } finally {
      if (requestId === requestRef.current) setUploading(false);
    }
  }, [id, updateNodeDataInTab]);

  return (
    <>
      <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected} toolbar={<MediaNodeActionToolbar nodeId={id} imageActions={false} />}>
        {data.videoUrl && !data.videoUrl.startsWith("asset://") ? <video src={data.videoUrl} controls preload="metadata" className="nodrag max-h-44 w-full rounded-md bg-black" /> : data.videoUrl ? (
          <div className="rounded-md border border-[var(--gc-node-border)] bg-[var(--gc-node-inner)] px-2 py-2 text-[10px] text-[var(--gc-node-text)]">
            API易视频素材
          </div>
        ) : (
          <label className="nodrag nopan relative flex min-h-28 cursor-pointer items-center justify-center rounded-md border border-dashed border-[var(--gc-node-border)] bg-[var(--gc-node-inner)] px-4 text-center text-[10px] leading-relaxed text-[var(--gc-node-muted)] hover:border-[var(--gc-node-accent)]">
            <input type="file" accept="video/mp4,video/webm,video/quicktime,.mov" className="absolute inset-0 cursor-pointer opacity-0" onChange={(event) => { void handleFile(event.target.files?.[0]); event.target.value = ""; }} />
            {uploading ? "视频上传中…" : "点击上传 MP4 / WebM / MOV\n单文件最大 32MB"}
          </label>
        )}
        <div className="flex gap-1">
          <Input
            value={referenceDraft}
            onChange={(event) => setReferenceDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                applyReference();
              }
            }}
            aria-label="视频公网地址或素材 ID"
            placeholder="https://… 或 asset://…"
            className="nodrag h-7 min-w-0 border-[var(--gc-node-border)] bg-[var(--gc-node-inner)] px-2 text-[10px] text-[var(--gc-node-text)]"
          />
          <Button type="button" variant="outline" size="icon-sm" aria-label="应用视频引用" onClick={applyReference} className="nodrag border-[var(--gc-node-border)] text-[var(--gc-node-text)]">
            <LinkIcon />
          </Button>
        </div>
      </NodeFrame>
      <Handle id="video" type="source" position={Position.Right} title="视频输出" />
    </>
  );
}

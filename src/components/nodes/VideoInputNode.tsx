import { useCallback, useRef, useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
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
        {data.videoUrl ? <video src={data.videoUrl} controls preload="metadata" className="nodrag max-h-44 w-full rounded-md bg-black" /> : (
          <label className="nodrag nopan relative flex min-h-28 cursor-pointer items-center justify-center rounded-md border border-dashed border-[var(--gc-node-border)] bg-[var(--gc-node-inner)] px-4 text-center text-[10px] leading-relaxed text-[var(--gc-node-muted)] hover:border-[var(--gc-node-accent)]">
            <input type="file" accept="video/mp4,video/webm,video/quicktime,.mov" className="absolute inset-0 cursor-pointer opacity-0" onChange={(event) => { void handleFile(event.target.files?.[0]); event.target.value = ""; }} />
            {uploading ? "视频上传中…" : "点击上传 MP4 / WebM / MOV\n单文件最大 32MB"}
          </label>
        )}
      </NodeFrame>
      <Handle id="video" type="source" position={Position.Right} title="视频输出" />
    </>
  );
}

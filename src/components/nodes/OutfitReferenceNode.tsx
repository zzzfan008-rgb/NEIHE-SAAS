import { useRef, useState } from "react";
import { Position, type NodeProps, type Node } from "@xyflow/react";
import { UploadIcon, StarIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NodeHandle } from "./NodeHandle";
import { NodeFrame } from "./NodeFrame";
import { selectActiveDocumentTarget, selectActiveNodes, selectActiveReadOnly, useFlowStore } from "@/store/flowStore";
import { stylingDocument } from "@/store/stylingRuntime";
import { stylingReferenceLimit } from "@/lib/styling";
import { isNodeRunActive, type OutfitReferenceNodeData } from "@/types/workflow";
import { useShallow } from "zustand/react/shallow";

export function OutfitReferenceNode({ id, data, selected }: NodeProps<Node<OutfitReferenceNodeData>>) {
  const target = useFlowStore(useShallow(selectActiveDocumentTarget));
  const readOnly = useFlowStore(selectActiveReadOnly);
  const nodes = useFlowStore(selectActiveNodes);
  const edges = useFlowStore((state) => state.tabs.find((tab) => tab.id === state.activeTabId)!.edges);
  const connected = nodes.filter((node) => node.data.kind === "ai-styling" && edges.some((edge) => edge.source === id && edge.target === node.id));
  const limit = Math.min(8, ...connected.map((node) => node.data.kind === "ai-styling" ? stylingReferenceLimit(node.data.modelId, node.data.batchSize) : 8));
  const active = connected.some((node) => isNodeRunActive(node.data.status));
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  const picker = useRef<HTMLInputElement>(null);
  const update = useFlowStore((state) => state.updateNodeDataInTab);
  const disabled = readOnly || active || uploading;
  const upload = async (files: File[]) => {
    if (busy.current || disabled || !files.length) return;
    if (files.length + data.images.length > limit) { setError(`当前模型最多支持 ${limit} 张参考图`); return; }
    busy.current = true;
    setUploading(true); setError(undefined);
    const initialImages = JSON.stringify(data.images);
    const saved: string[] = [];
    try {
      for (const file of files) {
        const image = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("图片读取失败"));
          reader.readAsDataURL(file);
        });
        const response = await fetch("/api/assets", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name.replace(/\.[^.]+$/, "").slice(0, 180) || "服饰参考图", category: "upload", scope: "private", image, sourceNote: "来自 AI 搭配上传节点" }) });
        const body = await response.json();
        if (!response.ok || body.normalized !== true || typeof body.url !== "string" || !body.url.startsWith("/api/files/")) throw new Error(body.error || "图片标准化失败");
        saved.push(body.url);
      }
    } catch (error) { setError(error instanceof Error ? error.message : "上传失败"); }
    finally {
      const current = stylingDocument(target)?.nodes.find((node) => node.id === id);
      if (saved.length && current?.data.kind === "outfit-reference" && JSON.stringify(current.data.images) === initialImages) {
        const images = [...current.data.images, ...saved];
        update(target, id, { images, mainImage: current.data.mainImage ?? images[0] });
      }
      busy.current = false; setUploading(false);
    }
  };
  return <div className="gc-outfit-reference" style={{ width: 280 }}>
    <NodeFrame nodeId={id} title={data.label} status={data.status} selected={selected}>
      {data.mainImage ? <img src={data.mainImage} alt="服饰主参考图" className="max-h-64 w-full rounded-md object-contain" /> :
        <p className="py-8 text-center text-xs text-[var(--gc-text-muted)]">上传服饰或模特穿搭图</p>}
      <div className="nodrag nopan grid grid-cols-2 gap-2" aria-label="服饰参考图列表">
        {data.images.map((image, index) => <div key={image} className="space-y-1 rounded-md border border-[var(--gc-border)] p-1">
          <img src={image} alt={`参考图 ${index + 1}`} className="h-20 w-full object-contain" />
          <div className="flex gap-1">
            <Button size="xs" className="gc-styling-control" variant={image === data.mainImage ? "secondary" : "outline"} aria-pressed={image === data.mainImage} disabled={disabled}
              onClick={() => update(target, id, { mainImage: image })} aria-label={`将参考图 ${index + 1} 设为主图`}><StarIcon aria-hidden="true" />{image === data.mainImage ? "主图" : "设为主图"}</Button>
            <Button size="icon-xs" className="gc-styling-control" variant="ghost" disabled={disabled} aria-label={`移除参考图 ${index + 1}`} onClick={() => {
              const images = data.images.filter((ref) => ref !== image);
              update(target, id, { images, mainImage: data.mainImage === image ? images[0] ?? null : data.mainImage });
            }}><XIcon aria-hidden="true" /></Button>
          </div>
        </div>)}
      </div>
      <input ref={picker} type="file" accept="image/*" multiple disabled={disabled} className="sr-only" aria-label="上传服饰参考图"
        onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void upload(files); }} />
      <Button variant="outline" className="gc-styling-control nodrag nopan w-full" disabled={disabled} onClick={() => picker.current?.click()}><UploadIcon aria-hidden="true" />{uploading ? "上传中…" : "上传参考图"}</Button>
      <p className="text-[10px] text-[var(--gc-text-muted)]">{data.images.length} / {limit} 张 · 主图确定人物与背景，其余图片仅补充服饰细节</p>
      {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
    </NodeFrame>
    <NodeHandle id="image" type="source" position={Position.Right} title="服饰参考图" />
  </div>;
}

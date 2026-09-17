import { useRef, useState } from "react";
import { Position, type Node, type NodeProps } from "@xyflow/react";
import { UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFlowStore, selectActiveDocumentTarget, selectActiveReadOnly } from "@/store/flowStore";
import { isNodeRunActive, type CharacterBoardNodeData } from "@/types/workflow";
import { uploadCharacterBoardSource } from "@/lib/characterBoardUpload";
import { NodeHandle } from "./NodeHandle";
import { NodeFrame, RunButton, Developing } from "./NodeFrame";
import { ImageGrid } from "./ImageGrid";

export function CharacterBoardNode({ id, data, selected }: NodeProps<Node<CharacterBoardNodeData>>) {
  const readOnly = useFlowStore(selectActiveReadOnly);
  const runNode = useFlowStore((state) => state.runNode);
  const picker = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();
  const running = isNodeRunActive(data.status);
  const disabled = readOnly || running || uploading;
  const upload = async (file?: File) => {
    if (!file || disabled || busy.current) return;
    const target = selectActiveDocumentTarget(useFlowStore.getState());
    busy.current = true; setUploading(true); setError(undefined);
    try {
      const image = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("图片读取失败"));
        reader.readAsDataURL(file);
      });
      await uploadCharacterBoardSource(target, id, image, file.name);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "上传失败"); }
    finally { busy.current = false; setUploading(false); }
  };
  return <>
    <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected} missingInput={!data.sourceImage}>
      {data.sourceImage
        ? <img src={data.sourceImage} alt="人物板原始模特图" className="max-h-32 w-full rounded-md object-contain" />
        : <p className="py-4 text-center text-xs text-[var(--gc-node-muted)]">上传一张清晰模特图</p>}
      <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={disabled} className="sr-only" aria-label="上传人物板模特图"
        onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void upload(file); }} />
      <Button variant="outline" className="nodrag nopan w-full border-[var(--gc-node-border)] bg-[var(--gc-node-main)] text-[var(--gc-node-text)] hover:bg-[var(--gc-node-inner-hover)] hover:text-[var(--gc-node-text)]" disabled={disabled} onClick={() => picker.current?.click()}>
        <UploadIcon aria-hidden="true" />{uploading ? "上传中…" : data.sourceImage ? "替换模特图" : "上传模特图"}
      </Button>
      <p className="text-[10px] leading-relaxed text-[var(--gc-node-muted)]">正面全身 · 背面全身 · 侧面全身 · 面部特写，统一人物身份与表情。</p>
      {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
      <RunButton status={data.status} label="生成人物板" disabled={disabled || !data.sourceImage} onClick={() => void runNode(id)} />
      {running && <Developing />}
      <div className="[&_img]:max-h-48 [&_img]:object-contain">
        <ImageGrid images={data.outputImages} empty="生成后可连线传递人物板" renderAction={(url) =>
          <Button variant="outline" size="sm" className="nodrag nopan w-full border-[var(--gc-node-border)] bg-[var(--gc-node-main)] text-[var(--gc-node-text)] hover:bg-[var(--gc-node-inner-hover)] hover:text-[var(--gc-node-text)]" render={<a href={url} download="人物板.png" />}>下载人物板</Button>} />
      </div>
    </NodeFrame>
    <NodeHandle id="image" type="source" position={Position.Right} title="人物板图像" />
  </>;
}

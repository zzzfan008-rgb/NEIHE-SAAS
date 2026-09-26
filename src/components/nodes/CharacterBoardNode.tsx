import { useRef, useState } from "react";
import { Position, type Node, type NodeProps } from "@xyflow/react";
import { UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useFlowStore, selectActiveDocumentTarget, selectActiveReadOnly } from "@/store/flowStore";
import { isNodeRunActive, type CharacterBoardNodeData } from "@/types/workflow";
import { imageModelLabel } from "@/types/imageModels";
import { uploadCharacterBoardSource } from "@/lib/characterBoardUpload";
import { NodeHandle } from "./NodeHandle";
import { NodeFrame, RunButton, Developing } from "./NodeFrame";
import { ImageGrid } from "./ImageGrid";

const CHARACTER_BOARD_MODEL_IDS = ["gpt-image-2.5-flare", "gemini-3.1-flash-image"] as const;

export function CharacterBoardNode({ id, data, selected }: NodeProps<Node<CharacterBoardNodeData>>) {
  const readOnly = useFlowStore(selectActiveReadOnly);
  const runNode = useFlowStore((state) => state.runNode);
  const updateNodeData = useFlowStore((state) => state.updateNodeData);
  const picker = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();
  const running = isNodeRunActive(data.status);
  const disabled = readOnly || running || uploading;
  const boardLayout = data.boardLayout ?? "2x2";
  const setBoardLayout = (next: "2x2" | "1x3") => {
    if (disabled || next === boardLayout) return;
    updateNodeData(id, { boardLayout: next, error: undefined });
  };
  const modelId = data.modelId ?? "gpt-image-2.5-flare";
  const imageSize = data.outputSize ?? "2K";
  const gemini = modelId.startsWith("gemini-");
  const sizeOptions = gemini ? ["1K", "2K", "4K"] : ["2K", "4K"];
  const setModelId = (next: "gpt-image-2.5-flare" | "gemini-3.1-flash-image") => {
    if (disabled || next === modelId) return;
    const nextImageSize = imageSize === "1K" && !next.startsWith("gemini-") ? "2K" : imageSize;
    updateNodeData(id, { modelId: next, outputSize: nextImageSize, error: undefined });
  };
  const setImageSize = (next: "1K" | "2K" | "4K") => {
    if (disabled || next === imageSize) return;
    updateNodeData(id, { outputSize: next, error: undefined });
  };
  const layoutHint = boardLayout === "1x3"
    ? "正面全身 · 侧面全身 · 背面全身三视图，统一人物身份与表情。"
    : "正面全身 · 背面全身 · 侧面全身 · 面部特写，统一人物身份与表情。";
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
      <p className="text-[10px] leading-relaxed text-[var(--gc-node-muted)]">{layoutHint}</p>
      <div className="min-w-0 space-y-1">
        <span className="text-[10px] text-[var(--gc-text-muted)]">图像模型</span>
        <Select value={modelId} disabled={disabled} onValueChange={(next) => { if (next === "gpt-image-2.5-flare" || next === "gemini-3.1-flash-image") setModelId(next); }}>
          <SelectTrigger aria-label="图像模型" className="nodrag nopan h-8 w-full min-w-0 text-xs"><SelectValue>{imageModelLabel(modelId)}</SelectValue></SelectTrigger>
          <SelectContent>
            {CHARACTER_BOARD_MODEL_IDS.map((id) => <SelectItem key={id} value={id}>{imageModelLabel(id)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-2">
        <div className="min-w-0 space-y-1">
          <span className="text-[10px] text-[var(--gc-text-muted)]">画板规格</span>
          <Select value={boardLayout} disabled={disabled} onValueChange={(next) => { if (next) setBoardLayout(next as "2x2" | "1x3"); }}>
            <SelectTrigger aria-label="画板规格" className="nodrag nopan h-8 w-full min-w-0 text-xs"><SelectValue>{boardLayout === "1x3" ? "1×3 三视图" : "2×2 四视图"}</SelectValue></SelectTrigger>
            <SelectContent>
              <SelectItem value="2x2">2×2 四视图</SelectItem>
              <SelectItem value="1x3">1×3 三视图</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-0 space-y-1">
          <span className="text-[10px] text-[var(--gc-text-muted)]">输出尺寸</span>
          <Select value={imageSize} disabled={disabled} onValueChange={(next) => { if (next === "1K" || next === "2K" || next === "4K") setImageSize(next); }}>
            <SelectTrigger aria-label="输出尺寸" className="nodrag nopan h-8 w-full min-w-0 text-xs"><SelectValue>{imageSize}</SelectValue></SelectTrigger>
            <SelectContent>
              {sizeOptions.map((size) => <SelectItem key={size} value={size}>{size}{size === "2K" ? "（默认）" : ""}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
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

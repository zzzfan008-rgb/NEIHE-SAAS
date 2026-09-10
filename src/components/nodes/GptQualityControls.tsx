import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getImageModelContract, type ImageModelId, type ImageModelOptions } from "@/types/imageModels";
import { selectActiveReadOnly, useFlowStore } from "@/store/flowStore";

export function GptQualityControls({ nodeId, modelId, modelOptions, disabled = false }: {
  nodeId: string; modelId: ImageModelId; modelOptions?: ImageModelOptions; disabled?: boolean;
}) {
  const readOnly = useFlowStore(selectActiveReadOnly);
  const update = useFlowStore((state) => state.updateNodeData);
  const qualities = getImageModelContract(modelId).qualities;
  if (!qualities) return null;
  return <div className="space-y-1">
    <span className="text-[10px] text-[var(--gc-text-muted)]">图片质量</span>
    <Select value={modelOptions?.quality ?? "medium"} disabled={disabled || readOnly}
      onValueChange={(quality) => { if (quality) update(nodeId, { modelOptions: { ...modelOptions, quality } }); }}>
      <SelectTrigger aria-label="图片质量" className="nodrag nopan w-full text-xs"><SelectValue /></SelectTrigger>
      <SelectContent>{qualities.map((quality) => <SelectItem key={quality} value={quality}>{quality}</SelectItem>)}</SelectContent>
    </Select>
    {modelId.startsWith("gpt-image-2.5-") && <p className="text-[9px] text-[var(--gc-text-muted)]">文生图 Flare · 图片编辑 Sunburst；xhigh / max 费用更高、等待更久。</p>}
  </div>;
}

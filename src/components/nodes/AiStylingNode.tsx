import { useEffect } from "react";
import { Position, type NodeProps, type Node } from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { ShirtIcon, FootprintsIcon, ShoppingBagIcon, GemIcon, HardHatIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { NodeHandle } from "./NodeHandle";
import { NodeFrame, RunButton } from "./NodeFrame";
import { ModelControls } from "./ModelControls";
import { useCoalescedTextEdit } from "@/hooks/useCoalescedTextEdit";
import { selectActiveDocument, selectActiveDocumentTarget, useFlowStore } from "@/store/flowStore";
import { recognizeOutfit, stylingInput, stylingRuntimeKey, useStylingRuntime, validStylingAnalysis } from "@/store/stylingRuntime";
import { STYLING_EXTRAS, STYLING_PRESERVE_LABELS, stylingBlockReason } from "@/lib/styling";
import { isNodeRunActive, type AiStylingNodeData } from "@/types/workflow";
import type { StylingPreserve } from "@/types/styling";

const ICONS = { outerwear: ShirtIcon, shoes: FootprintsIcon, bag: ShoppingBagIcon, accessories: GemIcon, hat: HardHatIcon };
const CATEGORY_LABELS: Record<StylingPreserve, string> = {
  upper: "上装",
  lower: "下装",
  "one-piece": "连体服饰",
  whole: "整套服装",
};
export function AiStylingNode({ id, data, selected }: NodeProps<Node<AiStylingNodeData>>) {
  const target = useFlowStore(useShallow(selectActiveDocumentTarget));
  const document = useFlowStore(selectActiveDocument);
  const progress = useFlowStore((state) => state.recentResults.find((record) => record.projectId === target.projectId && record.nodeId === id)?.executionMeta?.styling) as { completed?: number; total?: number } | undefined;
  const input = stylingInput(document, id);
  const runtimeKey = stylingRuntimeKey(target, id);
  const runtime = useStylingRuntime((state) => state.analyses[runtimeKey]);
  const update = useFlowStore((state) => state.updateNodeDataInTab);
  const runAccepted = useFlowStore((state) => state.recentResults.some((record) => (
    record.projectId === target.projectId && record.nodeId === id && Boolean(record.runId) && isNodeRunActive(record.status)
  )));
  const promptEdit = useCoalescedTextEdit({ kind: "node-data", nodeId: id, field: "prompt" }, { multiline: true });
  const active = isNodeRunActive(data.status);
  const disabled = document.readOnly || active;
  const promptDisabled = document.readOnly || (data.status === "queued" && !runAccepted);
  const analysis = validStylingAnalysis(target, id);
  const protectedOuterwear = analysis?.result && ((data.preserve === "whole" && analysis.result.existingExtras.outerwear) || (data.preserve === "upper" && analysis.result.upperIsOuterwear));
  const reason = stylingBlockReason(data, input.images, Boolean(analysis), Boolean(protectedOuterwear));
  useEffect(() => {
    if (data.analysisId && !runtime?.record && !runtime?.loading && !runtime?.error) void recognizeOutfit(target, id, true);
  }, [data.analysisId, id, runtime?.record, runtime?.loading, runtime?.error, target]);
  return <div className="gc-ai-styling" style={{ width: 320 }}>
    <NodeHandle id="references" type="target" position={Position.Left} title="服饰参考图" />
    <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected} missingInput={Boolean(reason)}>
      <Button variant="outline" className="gc-styling-control nodrag nopan w-full" disabled={disabled || runtime?.loading || !input.images.length}
        onClick={() => void recognizeOutfit(target, id, Boolean(runtime?.record && ["pending", "running", "outcome_unknown"].includes(runtime.record.status)))}>
        {runtime?.loading ? "正在识别服饰…" : "识别服饰"}
      </Button>
      <p role="status" className="text-xs text-[var(--gc-text-muted)]">
        {runtime?.error ?? (analysis?.result?.description || (runtime?.record?.result?.ambiguous ? "服饰不明确，请更换或裁剪主图后重新识别" : runtime?.record?.result?.categories.length === 0 ? "未识别到有效服饰，请更换或裁剪主图后重新识别" : "上传完成后点击识别服饰"))}
      </p>
      {analysis?.result && (
        <p className="text-xs text-[var(--gc-text-muted)]">
          识别类别：{analysis.result.categories.map((category) => CATEGORY_LABELS[category]).join("、")}
        </p>
      )}
      <label className="block space-y-1"><span className="text-xs">保留对象</span>
        <Select value={data.preserve ?? ""} disabled={disabled || !analysis} onValueChange={(value) => { if (value) update(target, id, { preserve: value as StylingPreserve }); }}>
          <SelectTrigger aria-label="保留对象" className="nodrag nopan w-full"><SelectValue placeholder="请选择要保留的服饰">{data.preserve ? STYLING_PRESERVE_LABELS[data.preserve] : "请选择要保留的服饰"}</SelectValue></SelectTrigger>
          <SelectContent>{Object.entries(STYLING_PRESERVE_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
        </Select>
      </label>
      <div role="group" aria-label="搭配单品" className="nodrag nopan grid grid-cols-2 gap-2">
        {STYLING_EXTRAS.map(({ id: extra, label }) => { const Icon = ICONS[extra]; const locked=extra === "outerwear" && protectedOuterwear === true; const enabled=data.extras[extra] && !locked; return <Button key={extra} className="gc-styling-control" variant={enabled ? "secondary" : "outline"}
          disabled={disabled || locked} aria-pressed={enabled} aria-label={label}
          onClick={() => update(target, id, { extras: { ...data.extras, [extra]: !data.extras[extra] } })}><Icon aria-hidden="true" />{label}<span aria-hidden="true">{locked ? "保护" : enabled ? "开" : "关"}</span></Button>; })}
      </div>
      <p className="text-[10px] text-[var(--gc-text-muted)]">关闭：保留原有单品、不新增。开启：允许搭配或替换。{protectedOuterwear ? "原外套属于受保护服饰，不替换。" : ""}</p>
      <label className="block space-y-1"><span className="text-xs">补充要求（可选）</span>
        <Textarea value={data.prompt} disabled={promptDisabled} {...promptEdit.bind} rows={3} placeholder="例如：秋季通勤，搭配简洁利落；可指定场景" className="nodrag nopan nowheel resize-none" />
      </label>
      <label className="block space-y-1"><span className="text-xs">生成数量</span>
        <Select value={String(data.batchSize)} disabled={disabled} onValueChange={(value) => { if (value) update(target, id, { batchSize: Number(value) }); }}>
          <SelectTrigger aria-label="搭配生成数量" className="nodrag nopan w-full"><SelectValue>{data.batchSize} 套</SelectValue></SelectTrigger>
          <SelectContent>{[1, 2, 4].map((count) => <SelectItem key={count} value={String(count)}>{count} 套</SelectItem>)}</SelectContent>
        </Select>
      </label>
      <ModelControls nodeId={id} modelId={data.modelId} modelOptions={data.modelOptions} preferredAspectRatio={data.aspectRatio} disabled={disabled} />
      {reason && <p className="text-xs text-[var(--gc-text-muted)]">{reason}</p>}
      <RunButton status={data.status} disabled={disabled || Boolean(reason) || runtime?.loading} onClick={() => void useFlowStore.getState().runNode(id)} label="生成搭配" />
      {active && <p role="status" className="text-xs">正在生成搭配，已完成 {progress?.completed ?? 0} / {progress?.total ?? data.batchSize} 套</p>}
    </NodeFrame>
    <NodeHandle id="image" type="source" position={Position.Right} title="搭配结果" />
  </div>;
}

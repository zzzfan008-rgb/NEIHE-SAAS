import {
  selectActiveEdges,
  selectActiveNodes,
  selectActivePrimarySelectedNodeId,
  selectActiveReadOnly,
  selectActiveSelectedResultId,
  useFlowStore,
  type ConnectedNodeDirection,
  type RecentResult,
} from "@/store/flowStore";
import {
  NODE_SPECS,
  isNodeRunActive,
  type NodeKind,
} from "@/types/workflow";
import { RunButton, STATUS_TEXT } from "../nodes/NodeFrame";
import { SceneStabilizeControls } from "../nodes/SceneStabilizeControls";
import { ModelControls } from "../nodes/ModelControls";
import { thumbnailImageUrl } from "@/lib/images";
import { cn } from "@/lib/utils";
import { useCoalescedTextEdit } from "@/hooks/useCoalescedTextEdit";
import {
  imageModelAspectRatioPatch,
  isImageModelId,
  type GenerationImageModelId,
  type ImageModelOptions,
} from "@/types/imageModels";
import { requestCanvasLanding } from "@/lib/canvasLanding";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { TryOnQualityControls } from "./TryOnQualityControls";

const UPSTREAM_SUGGESTIONS: Record<NodeKind, NodeKind[]> = {
  "character-board": [],
  "outfit-reference": [],
  "ai-styling": ["outfit-reference"],
  "image-input": [],
  "background-extract": ["image-input", "drawing-board"],
  "text-input": [],
  "ti-angle": [],
  "drawing-board": [],
  "color-palette": [],
  "stage-approval": ["virtual-try-on"],
  "video-input": [],
  "audio-input": [],
  "video-generate": ["video-input", "audio-input", "image-input", "text-input"],
  "sketch-optimize": ["image-input", "drawing-board"],
  "sketch-to-render": ["image-input", "sketch-optimize"],
  "ai-modify": ["image-input", "sketch-to-render"],
  "fabric-recolor": ["image-input", "sketch-to-render"],
  upscale: ["sketch-to-render", "ai-modify"],
  "print-extract": ["image-input", "ai-modify"],
  "print-mutate": ["image-input", "print-extract"],
  "virtual-try-on": ["image-input"],
  "mask-redraw": ["image-input", "ai-modify"],
  result: ["sketch-to-render", "ai-modify", "upscale"],
};

const DOWNSTREAM_SUGGESTIONS: Record<NodeKind, NodeKind[]> = {
  "character-board": ["virtual-try-on", "ai-modify", "result"],
  "outfit-reference": ["ai-styling"],
  "ai-styling": ["result"],
  "image-input": ["sketch-to-render", "ai-modify", "virtual-try-on", "print-extract", "background-extract"],
  "background-extract": ["sketch-to-render", "ai-modify", "fabric-recolor", "upscale", "print-extract", "print-mutate", "virtual-try-on", "mask-redraw", "result"],
  "text-input": [],
  "ti-angle": [],
  "drawing-board": ["sketch-to-render", "ai-modify", "virtual-try-on", "print-extract", "background-extract"],
  "color-palette": ["fabric-recolor"],
  "stage-approval": ["virtual-try-on"],
  "video-input": ["video-generate"],
  "audio-input": ["video-generate"],
  "video-generate": ["result"],
  "sketch-to-render": ["ai-modify", "fabric-recolor", "upscale", "result"],
  "sketch-optimize": ["sketch-to-render", "result"],
  "ai-modify": ["fabric-recolor", "upscale", "result"],
  "fabric-recolor": ["upscale", "result"],
  upscale: ["result"],
  "print-extract": ["print-mutate", "result"],
  "print-mutate": ["result"],
  "virtual-try-on": ["upscale", "result"],
  "mask-redraw": ["result"],
  result: [],
};

const panelInputClass = cn(
  "h-8 w-full rounded-md border-[var(--gc-border)] bg-[var(--gc-control)] px-2 text-xs text-[var(--gc-text)] placeholder:text-[var(--gc-text-muted)]",
  "focus-visible:border-[var(--gc-accent)] focus-visible:ring-2 focus-visible:ring-[var(--gc-accent)]/50",
);

function QuickConnect({ nodeId, kind }: { nodeId: string; kind: NodeKind }) {
  const edges = useFlowStore(selectActiveEdges);
  const readOnly = useFlowStore(selectActiveReadOnly);
  const addConnectedNode = useFlowStore((state) => state.addConnectedNode);
  const upstreamFull = edges.filter((edge) => edge.target === nodeId).length >= NODE_SPECS[kind].inputs;

  const add = (nextKind: NodeKind, direction: ConnectedNodeDirection) => {
    const addedId = addConnectedNode(nodeId, nextKind, direction);
    if (!addedId) return;
    requestCanvasLanding({
      tabId: useFlowStore.getState().activeTabId,
      nodeId: addedId,
      fitView: false,
      activateFilePicker: nextKind === "image-input" || nextKind === "background-extract",
      selectText: nextKind !== "image-input" && nextKind !== "result",
    });
  };

  const groups = [
    { label: "快速添加上游", direction: "upstream" as const, kinds: UPSTREAM_SUGGESTIONS[kind], disabled: upstreamFull },
    { label: "快速添加下游", direction: "downstream" as const, kinds: DOWNSTREAM_SUGGESTIONS[kind], disabled: false },
  ].filter((group) => group.kinds.length > 0);
  if (groups.length === 0) return null;

  return (
    <section aria-label="快捷建图" className="space-y-2 border-t border-[var(--gc-border)] pt-3">
      <p className="text-[10px] font-medium text-[var(--gc-text-muted)]">快捷建图</p>
      {groups.map((group) => (
          <div key={group.direction} className="space-y-1">
          <div className="flex items-center justify-between text-[10px] text-[var(--gc-text-muted)]">
            <span>{group.label}</span>
            {group.disabled && <span>输入已满</span>}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {group.kinds.map((nextKind) => (
              <Button
                key={nextKind}
                type="button"
                disabled={readOnly || group.disabled}
                onClick={() => add(nextKind, group.direction)}
                variant="outline"
                size="xs"
                className="h-auto min-h-7 border-[var(--gc-border)] bg-[var(--gc-control)] px-2 py-1 text-[10px] leading-tight text-[var(--gc-text-muted)] hover:border-[var(--gc-accent)] hover:bg-[var(--gc-panel-hover)] hover:text-[var(--gc-accent)] focus-visible:ring-2 focus-visible:ring-[var(--gc-accent)]/50"
              >
                {group.direction === "upstream" ? "← " : "+ "}{NODE_SPECS[nextKind].title}
              </Button>
            ))}
          </div>
        </div>
      ))}
      <p className="text-[10px] leading-relaxed text-[var(--gc-text-muted)]">新增节点与连线属于同一次撤销操作。</p>
    </section>
  );
}

function PropertyEditor({ nodeId }: { nodeId: string }) {
  const nodes = useFlowStore(selectActiveNodes);
  const edges = useFlowStore(selectActiveEdges);
  const node = nodes.find((candidate) => candidate.id === nodeId);
  const updateNodeData = useFlowStore((s) => s.updateNodeData);
  const runNode = useFlowStore((s) => s.runNode);
  const onConnect = useFlowStore((s) => s.onConnect);
  const onEdgesChange = useFlowStore((s) => s.onEdgesChange);
  const readOnly = useFlowStore(selectActiveReadOnly);
  const labelEdit = useCoalescedTextEdit({ kind: "node-data", nodeId, field: "label" });
  const promptEdit = useCoalescedTextEdit(
    { kind: "node-data", nodeId, field: "prompt" },
    { multiline: true },
  );
  const noteEdit = useCoalescedTextEdit(
    { kind: "node-data", nodeId, field: "note" },
    { multiline: true },
  );
  const materialEdit = useCoalescedTextEdit(
    { kind: "node-data", nodeId, field: "materialSpec" },
    { multiline: true },
  );
  const constructionEdit = useCoalescedTextEdit(
    { kind: "node-data", nodeId, field: "constructionSpec" },
    { multiline: true },
  );
  if (!node) return null;
  const d = node.data;
  const spec = NODE_SPECS[d.kind];
  const selectedModelId: GenerationImageModelId | undefined =
    "modelId" in d && isImageModelId(d.modelId) && d.modelId !== "gpt-image-2" && d.modelId !== "gemini-3-pro-image-preview" ? d.modelId : undefined;
  const selectedModelOptions = "modelOptions" in d && typeof d.modelOptions === "object" && d.modelOptions !== null
    ? d.modelOptions as ImageModelOptions
    : undefined;
  const paletteEdge = d.kind === "fabric-recolor"
    ? edges.find((edge) => edge.target === nodeId && edge.targetHandle === "palette")
    : undefined;
  const paletteSource = paletteEdge ? nodes.find((candidate) => candidate.id === paletteEdge.source) : undefined;
  const accessoryCandidates = d.kind === "mask-redraw" && d.repairFocus === "accessories"
    ? nodes.filter((candidate) => candidate.data.kind === "image-input" && candidate.data.autoConnectTargets?.some((target) => (
        target.targetNodeId === nodeId && target.targetHandle === "references"
      )))
    : [];
  const selectedAccessoryEdges = d.kind === "mask-redraw" && d.repairFocus === "accessories"
    ? edges.filter((edge) => edge.target === nodeId && edge.targetHandle === "references")
    : [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--gc-text)]">{spec.title}</span>
        <span className="text-[10px] text-[var(--gc-text-muted)]">{STATUS_TEXT[d.status]}</span>
      </div>

      <label className="block space-y-1">
        <span className="text-[10px] text-[var(--gc-text-muted)]">节点名称</span>
        <Input
          value={d.label}
          {...labelEdit.bind}
          className={panelInputClass}
        />
      </label>

      {d.kind === "drawing-board" && (
        <section className="space-y-2 rounded-lg border border-[var(--gc-border)] p-2">
          <p className="text-[10px] text-[var(--gc-text-muted)]">画板属性</p>
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-[10px] text-[var(--gc-text-muted)]">宽度
              <Input type="number" min={256} max={4096} disabled={Boolean(d.contentRef)} value={d.width}
                onChange={(event) => updateNodeData(nodeId, { width: Math.max(256, Math.min(4096, Number(event.target.value) || 256)) })}
                className={panelInputClass} />
            </label>
            <label className="space-y-1 text-[10px] text-[var(--gc-text-muted)]">高度
              <Input type="number" min={256} max={4096} disabled={Boolean(d.contentRef)} value={d.height}
                onChange={(event) => updateNodeData(nodeId, { height: Math.max(256, Math.min(4096, Number(event.target.value) || 256)) })}
                className={panelInputClass} />
            </label>
          </div>
          <label className="flex items-center justify-between text-[10px] text-[var(--gc-text-muted)]">背景颜色
            <Input aria-label="背景颜色" type="color" disabled={Boolean(d.contentRef)} value={d.background}
              onChange={(event) => updateNodeData(nodeId, { background: event.target.value.toUpperCase() })}
              className="h-8 w-10 cursor-pointer rounded-md border-[var(--gc-border)] bg-[var(--gc-control)] p-1 focus-visible:border-[var(--gc-accent)] focus-visible:ring-2 focus-visible:ring-[var(--gc-accent)]/50" />
          </label>
          <p className="text-[10px] leading-relaxed text-[var(--gc-text-muted)]">{d.contentRef ? "已保存版本；尺寸与背景请在画板编辑器中调整。" : "未保存画板不会输出图片，也不能连接下游。"}</p>
        </section>
      )}

      {d.kind === "color-palette" && (
        <section className="space-y-2 rounded-lg border border-[var(--gc-border)] p-2">
          <p className="text-[10px] text-[var(--gc-text-muted)]">色板颜色（{d.swatches.length}/32）</p>
          <div className="grid grid-cols-2 gap-1">{d.swatches.map((swatch) => (
            <span key={swatch.id} title={`${swatch.pantone?.libraryKey ?? ""} ${swatch.pantone?.code ?? swatch.value}`.trim()}
              className="flex min-w-0 items-center gap-1 rounded-md border border-[var(--gc-border)] p-1 text-[8px]">
              <span className="h-5 w-5 shrink-0 rounded border border-white/15" style={{ backgroundColor: swatch.value }} />
              <span className="truncate">{swatch.pantone?.code ?? swatch.value}</span>
            </span>
          ))}</div>
          <p className="text-[10px] leading-relaxed text-[var(--gc-text-muted)]">色板是独立节点；需要另一组颜色时，请从左侧色彩工具新建色板。</p>
        </section>
      )}

      {d.kind === "mask-redraw" && d.repairFocus !== "custom" && (
        <section className="space-y-3 border-t border-[var(--gc-border)] pt-3" aria-label="局部精修设置">
          <label className="flex items-center justify-between gap-3">
            <span>
              <span className="block text-[10px] font-medium text-[var(--gc-text)]">参与精修</span>
              <span className="block text-[9px] text-[var(--gc-text-muted)]">跳过时不生成、不计费</span>
            </span>
            <Switch
              checked={d.executionMode === "repair"}
              disabled={readOnly || isNodeRunActive(d.status)}
              aria-label={`${d.label}参与精修`}
              onCheckedChange={(checked) => updateNodeData(nodeId, checked
                ? { executionMode: "repair", status: "idle", error: undefined }
                : {
                    executionMode: "bypass",
                    status: "idle",
                    error: undefined,
                    mask: undefined,
                    maskSourceRef: undefined,
                    outputImages: [],
                  })}
            />
          </label>

          {d.repairFocus === "accessories" && (
            <fieldset className="space-y-2">
              <legend className="text-[10px] text-[var(--gc-text-muted)]">
                配饰细节参考（{selectedAccessoryEdges.length}/6）
              </legend>
              {accessoryCandidates.map((candidate) => {
                const selectedEdge = selectedAccessoryEdges.find((edge) => edge.source === candidate.id);
                const hasImage = candidate.data.kind === "image-input" && Boolean(candidate.data.imageUrl);
                return (
                  <label key={candidate.id} className="flex min-h-8 items-center justify-between gap-3 rounded-md border border-[var(--gc-border)] bg-[var(--gc-control)] px-2.5 py-1.5">
                    <span className="min-w-0 truncate text-[10px] text-[var(--gc-text)]">{candidate.data.label}</span>
                    <Switch
                      checked={Boolean(selectedEdge)}
                      disabled={readOnly || !hasImage || (!selectedEdge && selectedAccessoryEdges.length >= 6)}
                      aria-label={`选择配饰参考：${candidate.data.label}`}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          onConnect({
                            source: candidate.id,
                            sourceHandle: "image",
                            target: nodeId,
                            targetHandle: "references",
                          });
                        } else if (selectedEdge) {
                          onEdgesChange([{ id: selectedEdge.id, type: "remove" }]);
                        }
                      }}
                    />
                  </label>
                );
              })}
              <p className="text-[9px] leading-4 text-[var(--gc-text-muted)]">上传时自动选择有空位的参考；已满时先关闭一项再选择其它配饰。</p>
            </fieldset>
          )}
        </section>
      )}

      {d.kind === "fabric-recolor" && (
        <section className="space-y-2 rounded-lg border border-[var(--gc-border)] p-2">
          <p className="text-[10px] text-[var(--gc-text-muted)]">替换模式</p>
          <div className="grid grid-cols-3 gap-1">
            {([['fabric', '仅面料'], ['color', '仅配色'], ['combined', '面料+配色']] as const).map(([operationMode, label]) => (
              <Button key={operationMode} type="button" size="sm" variant={d.operationMode === operationMode ? "default" : "outline"}
                disabled={isNodeRunActive(d.status)} onClick={() => updateNodeData(nodeId, { operationMode, error: undefined })}
                className="h-auto min-h-8 px-1 text-[9px]">{label}</Button>
            ))}
          </div>
          <p className="text-[10px] leading-relaxed text-[var(--gc-text-muted)]">
            {paletteSource?.data.kind === "color-palette"
              ? `已连接色板“${paletteSource.data.label}”，其 ${paletteSource.data.swatches.length} 个颜色覆盖节点内临时颜色。`
              : "未连接色板；使用节点内选择的临时颜色。"}
          </p>
        </section>
      )}

      {(d.kind === "sketch-to-render" || d.kind === "ai-modify" || d.kind === "fabric-recolor" || (d.kind === "virtual-try-on" && d.workflowStage !== "scene-stabilize")) && (
        <label className="block space-y-1">
          <span className="text-[10px] text-[var(--gc-text-muted)]">提示词</span>
          <Textarea
            value={d.prompt}
            {...promptEdit.bind}
            rows={12}
            className={cn(panelInputClass, "h-auto min-h-40 resize-none py-2 leading-5")}
          />
          <span className="text-[10px] leading-relaxed text-[var(--gc-text-muted)]">
            {d.kind === "virtual-try-on"
              ? d.workflowStage === "standard"
                ? "图 1=最终模特基准，图 2=主穿搭，图 3–14=服装/鞋包/工艺细节；补充要求不得重写图片编号"
                : "只描述最终效果，不要重定义参考图角色或图片编号"
              : "可连接最多 8 张参考图，按连线顺序传入"}
          </span>
        </label>
      )}

      {(d.kind === "sketch-to-render" || d.kind === "ai-modify") && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <span id={`aspect-ratio-label-${nodeId}`} className="block text-[10px] text-[var(--gc-text-muted)]">画幅比例</span>
            <Select
              value={d.aspectRatio}
              onValueChange={(value) => {
                if (!value) return;
                updateNodeData(
                  nodeId,
                  imageModelAspectRatioPatch(selectedModelId, selectedModelOptions, value),
                );
              }}
            >
              <SelectTrigger aria-labelledby={`aspect-ratio-label-${nodeId}`} className={panelInputClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start" className="border border-[var(--gc-border)] bg-[var(--gc-panel)] text-[var(--gc-text)] ring-0">
              {["1:1", "3:4", "4:3", "9:16", "16:9"].map((r) => (
                <SelectItem key={r} value={r} className="min-h-8 text-xs">
                  {r}
                </SelectItem>
              ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <span id={`batch-size-label-${nodeId}`} className="block text-[10px] text-[var(--gc-text-muted)]">生成数量</span>
            <Select
              value={String(d.batchSize)}
              onValueChange={(value) => {
                if (!value) return;
                updateNodeData(nodeId, { batchSize: Number(value) as 1 | 2 | 4 | 8 });
              }}
            >
              <SelectTrigger aria-labelledby={`batch-size-label-${nodeId}`} className={panelInputClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start" className="border border-[var(--gc-border)] bg-[var(--gc-panel)] text-[var(--gc-text)] ring-0">
              {[1, 2, 4, 8].map((n) => (
                <SelectItem key={n} value={String(n)} className="min-h-8 text-xs">
                  {n} 张
                </SelectItem>
              ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {d.kind === "result" && (
        <label className="block space-y-1">
          <span className="text-[10px] text-[var(--gc-text-muted)]">备注</span>
          <Textarea
            value={d.note ?? ""}
            {...noteEdit.bind}
            rows={3}
            className={cn(panelInputClass, "h-auto min-h-20 resize-none py-2 leading-5")}
          />
        </label>
      )}

      {d.kind === "virtual-try-on" && (
        <div className="space-y-3 border-t border-[var(--gc-border)] pt-3">
          {d.workflowStage === "scene-stabilize" && <SceneStabilizeControls nodeId={nodeId} data={d} />}
          {d.workflowStage === "garment-refine" && (
            <p className="text-[10px] leading-relaxed text-[var(--gc-text-muted)]">
              第二轮使用固定服装精修引擎 · 中等质量
            </p>
          )}
          {d.workflowStage !== "scene-stabilize" && <fieldset className="space-y-1">
            <legend className="text-[10px] text-[var(--gc-text-muted)]">输出档位</legend>
            <div className="flex gap-2">
              {(["2K", "4K"] as const).map((imageSize) => (
                <Button
                  key={imageSize}
                  type="button"
                  size="sm"
                  variant={d.imageSize === imageSize ? "default" : "outline"}
                  aria-pressed={d.imageSize === imageSize}
                  disabled={isNodeRunActive(d.status)}
                  onClick={() => updateNodeData(nodeId, {
                    imageSize,
                    modelOptions: d.modelId === "gemini-3.1-flash-image"
                      ? { ...d.modelOptions, imageSize }
                      : d.workflowStage === "garment-refine" ? { quality: "medium" } : {},
                    error: undefined,
                  })}
                  className="h-8 flex-1 text-[10px]"
                >
                  {imageSize}
                </Button>
              ))}
            </div>
          </fieldset>}
          <TryOnQualityControls
            nodeId={nodeId}
            data={d}
            disabled={isNodeRunActive(d.status)}
            onChange={(patch) => updateNodeData(nodeId, patch)}
          />
          {d.workflowStage === "garment-refine" && (
            <div className="space-y-3 border-t border-[var(--gc-border)] pt-3">
              <fieldset className="space-y-1">
                <legend className="text-[10px] text-[var(--gc-text-muted)]">服装品类（选填）</legend>
                <div className="grid grid-cols-2 gap-2">
                  {([[undefined, "自动判断"], [
                    "knit", "针织",
                  ], ["woven", "梭织"], ["other", "其他"]] as const).map(([garmentCategory, label]) => (
                    <Button
                      key={garmentCategory ?? "auto"}
                      type="button"
                      size="sm"
                      variant={d.garmentCategory === garmentCategory ? "default" : "outline"}
                      aria-pressed={d.garmentCategory === garmentCategory}
                      disabled={isNodeRunActive(d.status)}
                      onClick={() => updateNodeData(nodeId, { garmentCategory, error: undefined })}
                      className="h-8 flex-1 text-[10px]"
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </fieldset>
              <label className="block space-y-1">
                <span className="text-[10px] text-[var(--gc-text-muted)]">材料/面料规格（选填）</span>
                <Textarea
                  value={d.materialSpec ?? ""}
                  {...materialEdit.bind}
                  rows={4}
                  placeholder={d.garmentCategory === "knit"
                    ? "纤维成分、纱线粗细、厚度、手感"
                    : "留空时根据主穿搭和面料参考图判断"}
                  className={cn(panelInputClass, "h-auto min-h-24 resize-none py-2 leading-5")}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[10px] text-[var(--gc-text-muted)]">结构/制作工艺（选填）</span>
                <Textarea
                  value={d.constructionSpec ?? ""}
                  {...constructionEdit.bind}
                  rows={4}
                  placeholder={d.garmentCategory === "knit"
                    ? "机号、针织组织、密度、罗纹、绞花或收针方式"
                    : "留空时根据主穿搭和局部结构参考判断"}
                  className={cn(panelInputClass, "h-auto min-h-24 resize-none py-2 leading-5")}
                />
              </label>
            </div>
          )}
        </div>
      )}

      {spec.providerId && d.kind !== "mask-redraw" && d.kind !== "virtual-try-on" && selectedModelId && (
        <ModelControls
          nodeId={nodeId}
          modelId={selectedModelId}
          modelOptions={selectedModelOptions}
          preferredAspectRatio={"aspectRatio" in d && typeof d.aspectRatio === "string" ? d.aspectRatio : undefined}
          disabled={isNodeRunActive(d.status)}
        />
      )}

      {spec.providerId && !(d.kind === "mask-redraw" && d.executionMode === "bypass") && (
        <RunButton
          status={d.status}
          onClick={() => void runNode(nodeId)}
          label="运行此节点"
        />
      )}

      <QuickConnect nodeId={nodeId} kind={d.kind} />
    </div>
  );
}

/** 「最近生成」条目对应的运行记录详情 */
function ResultRecordDetail({ resultId }: { resultId: string }) {
  const record = useFlowStore((s) => s.recentResults.find((r) => r.id === resultId));
  if (!record) return null;
  const time = new Date(record.startedAt).toLocaleTimeString("zh-CN", { hour12: false });
  const duration = (((record.finishedAt ?? Date.now()) - record.startedAt) / 1000).toFixed(1);
  const statusText: Record<RecentResult["status"], string> = {
    queued: "排队中",
    running: "生成中",
    retry_wait: "等待重试",
    cancel_requested: "取消请求中",
    success: "成功",
    error: "失败",
    outcome_unknown: "结果未知",
    cancelled: "已取消",
  };
  const statusColor: Record<RecentResult["status"], string> = {
    queued: "text-yellow-400",
    running: "text-blue-400",
    retry_wait: "text-amber-400",
    cancel_requested: "text-orange-400",
    success: "text-emerald-400",
    error: "text-red-400",
    outcome_unknown: "text-orange-500",
    cancelled: "text-neutral-500",
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--gc-text)]">{record.nodeLabel}</span>
        <span
          className={`text-[10px] ${statusColor[record.status]}`}
        >
          {statusText[record.status]}
        </span>
      </div>

      {record.image && (record.kind === "video-generate" || /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(record.image) ? (
        <video src={record.image} controls playsInline preload="metadata" aria-label={`播放 ${record.nodeLabel}`} className="w-full rounded-md border border-[var(--gc-border)] bg-black" />
      ) : (
        <img
          src={record.thumbnail ?? thumbnailImageUrl(record.image)}
          loading="lazy"
          decoding="async"
          alt={record.nodeLabel}
          className="w-full rounded-md border border-[var(--gc-border)] object-cover"
        />
      ))}

      <dl className="space-y-1.5 text-[10px]">
        <div className="flex justify-between">
          <dt className="text-[var(--gc-text-muted)]">节点类型</dt>
          <dd className="text-[var(--gc-text)]">{record.kind === "image-conversation" ? "对话修改" : NODE_SPECS[record.kind].title}</dd>
        </div>
        {record.projectName && (
          <div className="flex justify-between gap-3">
            <dt className="text-[var(--gc-text-muted)]">项目</dt>
            <dd className="truncate text-[var(--gc-text)]" title={record.projectName}>
              {record.projectName}
            </dd>
          </div>
        )}
        {record.model && (
          <div className="flex justify-between">
            <dt className="text-[var(--gc-text-muted)]">模型</dt>
            <dd className="font-mono text-[var(--gc-text)]">{record.model}</dd>
          </div>
        )}
        {record.providerOutputSize && (
          <div className="flex justify-between">
            <dt className="text-[var(--gc-text-muted)]">上游实际尺寸</dt>
            <dd className="font-mono text-[var(--gc-text)]">{record.providerOutputSize}</dd>
          </div>
        )}
        <div className="flex justify-between">
          <dt className="text-[var(--gc-text-muted)]">时间</dt>
          <dd className="text-[var(--gc-text)]">
            {time} · {record.finishedAt ? "耗时" : "已等待"} {duration}s
          </dd>
        </div>
      </dl>

      {record.prompt && (
        <div className="space-y-1">
          <span className="text-[10px] text-[var(--gc-text-muted)]">提示词</span>
          <p className="rounded-md border border-[var(--gc-border)] bg-[var(--gc-control)] px-2 py-1.5 text-[10px] leading-relaxed text-[var(--gc-text)]">
            {record.prompt}
          </p>
        </div>
      )}

      {record.error && (
        <div className="space-y-1">
          <span className="text-[10px] text-red-400/80">错误信息</span>
          <p className="rounded-md border border-red-900/50 bg-red-950/20 px-2 py-1.5 text-[10px] leading-relaxed text-red-300/90">
            {record.error}
          </p>
        </div>
      )}
    </div>
  );
}

interface InspectorPanelProps {
  className?: string;
  view?: "auto" | "properties" | "result";
}

export function InspectorPanel({ className, view = "auto" }: InspectorPanelProps) {
  const selectedNodeId = useFlowStore(selectActivePrimarySelectedNodeId);
  const selectedResultId = useFlowStore(selectActiveSelectedResultId);
  const showResult = view === "result" || (view === "auto" && Boolean(selectedResultId));

  return (
    <aside
      className={cn(
        "gc-panel flex w-64 shrink-0 flex-col border-l border-[var(--gc-border)] bg-[var(--gc-panel)]",
        className,
      )}
    >
      <div className="border-b border-[var(--gc-border)] px-3 py-2.5 text-[10px] font-medium uppercase tracking-widest text-[var(--gc-text-muted)]">
        {showResult ? "生成记录" : "属性"}
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {showResult ? (
          selectedResultId ? (
            <ResultRecordDetail resultId={selectedResultId} />
          ) : (
            <p className="py-4 text-center text-[10px] leading-relaxed text-[var(--gc-text-muted)]">
              选择上方结果查看完整运行记录
            </p>
          )
        ) : selectedNodeId ? (
          <PropertyEditor nodeId={selectedNodeId} />
        ) : (
          <p className="py-4 text-center text-[10px] leading-relaxed text-[var(--gc-text-muted)]">
            点击画布节点查看属性
          </p>
        )}
      </div>
    </aside>
  );
}

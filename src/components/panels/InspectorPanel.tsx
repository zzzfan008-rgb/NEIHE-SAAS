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
import { inputClass, RunButton, STATUS_TEXT } from "../nodes/NodeFrame";
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

const UPSTREAM_SUGGESTIONS: Record<NodeKind, NodeKind[]> = {
  "image-input": [],
  "sketch-to-render": ["image-input"],
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
  "image-input": ["sketch-to-render", "ai-modify", "virtual-try-on", "print-extract"],
  "sketch-to-render": ["ai-modify", "fabric-recolor", "upscale", "result"],
  "ai-modify": ["fabric-recolor", "upscale", "result"],
  "fabric-recolor": ["upscale", "result"],
  upscale: ["result"],
  "print-extract": ["print-mutate", "result"],
  "print-mutate": ["result"],
  "virtual-try-on": ["upscale", "result"],
  "mask-redraw": ["result"],
  result: [],
};

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
      activateFilePicker: nextKind === "image-input",
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
          <div className="flex items-center justify-between text-[9px] text-neutral-600">
            <span>{group.label}</span>
            {group.disabled && <span>输入已满</span>}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {group.kinds.map((nextKind) => (
              <button
                key={nextKind}
                type="button"
                disabled={readOnly || group.disabled}
                onClick={() => add(nextKind, group.direction)}
                className="rounded-md border border-[var(--gc-border)] bg-[var(--gc-panel-soft)] px-2 py-1 text-[9px] text-[var(--gc-text-muted)] transition-colors hover:border-[var(--gc-accent)] hover:text-[var(--gc-accent)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {group.direction === "upstream" ? "← " : "+ "}{NODE_SPECS[nextKind].title}
              </button>
            ))}
          </div>
        </div>
      ))}
      <p className="text-[9px] leading-relaxed text-neutral-600">新增节点与连线属于同一次撤销操作。</p>
    </section>
  );
}

function PropertyEditor({ nodeId }: { nodeId: string }) {
  const node = useFlowStore((state) =>
    selectActiveNodes(state).find((candidate) => candidate.id === nodeId),
  );
  const updateNodeData = useFlowStore((s) => s.updateNodeData);
  const runNode = useFlowStore((s) => s.runNode);
  const labelEdit = useCoalescedTextEdit({ kind: "node-data", nodeId, field: "label" });
  const promptEdit = useCoalescedTextEdit(
    { kind: "node-data", nodeId, field: "prompt" },
    { multiline: true },
  );
  const noteEdit = useCoalescedTextEdit(
    { kind: "node-data", nodeId, field: "note" },
    { multiline: true },
  );
  if (!node) return null;
  const d = node.data;
  const spec = NODE_SPECS[d.kind];
  const selectedModelId: GenerationImageModelId | undefined =
    "modelId" in d && isImageModelId(d.modelId) && d.modelId !== "gpt-image-2" ? d.modelId : undefined;
  const selectedModelOptions = "modelOptions" in d && typeof d.modelOptions === "object" && d.modelOptions !== null
    ? d.modelOptions as ImageModelOptions
    : undefined;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-neutral-200">{spec.title}</span>
        <span className="text-[10px] text-neutral-500">{STATUS_TEXT[d.status]}</span>
      </div>

      <label className="block space-y-1">
        <span className="text-[10px] text-neutral-500">节点名称</span>
        <input
          value={d.label}
          {...labelEdit.bind}
          className={inputClass}
        />
      </label>

      {(d.kind === "sketch-to-render" || d.kind === "ai-modify" || d.kind === "fabric-recolor" || d.kind === "virtual-try-on") && (
        <label className="block space-y-1">
          <span className="text-[10px] text-neutral-500">提示词</span>
          <textarea
            value={d.prompt}
            {...promptEdit.bind}
            rows={12}
            className={`${inputClass} resize-none`}
          />
          <span className="text-[9px] text-neutral-600">
            {d.kind === "virtual-try-on"
              ? "图 1=最终模特基准，图 2=主穿搭，图 3–14=服装/鞋包/工艺细节；补充要求不得重写图片编号"
              : "可连接最多 8 张参考图，按连线顺序传入"}
          </span>
        </label>
      )}

      {(d.kind === "sketch-to-render" || d.kind === "ai-modify") && (
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1">
            <span className="text-[10px] text-neutral-500">画幅比例</span>
            <select
              value={d.aspectRatio}
              onChange={(e) => updateNodeData(
                nodeId,
                imageModelAspectRatioPatch(selectedModelId, selectedModelOptions, e.target.value),
              )}
              className={inputClass}
            >
              {["1:1", "3:4", "4:3", "9:16", "16:9"].map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] text-neutral-500">生成数量</span>
            <select
              value={d.batchSize}
              onChange={(e) =>
                updateNodeData(nodeId, { batchSize: Number(e.target.value) as 1 | 2 | 4 | 8 })
              }
              className={inputClass}
            >
              {[1, 2, 4, 8].map((n) => (
                <option key={n} value={n}>
                  {n} 张
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {d.kind === "result" && (
        <label className="block space-y-1">
          <span className="text-[10px] text-neutral-500">备注</span>
          <textarea
            value={d.note ?? ""}
            {...noteEdit.bind}
            rows={3}
            className={`${inputClass} resize-none`}
          />
        </label>
      )}

      {d.kind === "virtual-try-on" && (
        <div className="space-y-3 border-t border-[var(--gc-border)] pt-3">
          <fieldset className="space-y-1">
            <legend className="text-[10px] text-neutral-500">图片模型</legend>
            <div className="flex gap-2">
              {([
                ["gpt-image-2", "GPT Image 2"],
                ["gemini-3.1-flash-image-preview", "Gemini 3.1 Flash"],
              ] as const).map(([modelId, label]) => (
                <Button
                  key={modelId}
                  type="button"
                  size="sm"
                  variant={d.modelId === modelId ? "default" : "outline"}
                  aria-pressed={d.modelId === modelId}
                  disabled={isNodeRunActive(d.status)}
                  onClick={() => updateNodeData(nodeId, {
                    modelId,
                    modelOptions: modelId === "gemini-3.1-flash-image-preview"
                      ? { aspectRatio: "1:1", imageSize: d.imageSize }
                      : {},
                    error: undefined,
                  })}
                  className="h-auto min-h-8 flex-1 whitespace-normal px-2 py-1 text-[10px] leading-tight"
                >
                  {label}
                </Button>
              ))}
            </div>
          </fieldset>
          <fieldset className="space-y-1">
            <legend className="text-[10px] text-neutral-500">输出档位</legend>
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
                    modelOptions: d.modelId === "gemini-3.1-flash-image-preview"
                      ? { ...d.modelOptions, imageSize }
                      : {},
                    error: undefined,
                  })}
                  className="h-8 flex-1 text-[10px]"
                >
                  {imageSize}
                </Button>
              ))}
            </div>
          </fieldset>
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

      {spec.providerId && (
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
        <span className="text-xs font-medium text-neutral-200">{record.nodeLabel}</span>
        <span
          className={`text-[10px] ${statusColor[record.status]}`}
        >
          {statusText[record.status]}
        </span>
      </div>

      {record.image && (
        <img
          src={record.thumbnail ?? thumbnailImageUrl(record.image)}
          loading="lazy"
          decoding="async"
          alt={record.nodeLabel}
          className="w-full rounded-md border border-[#262626] object-cover"
        />
      )}

      <dl className="space-y-1.5 text-[10px]">
        <div className="flex justify-between">
          <dt className="text-neutral-500">节点类型</dt>
          <dd className="text-neutral-300">{NODE_SPECS[record.kind].title}</dd>
        </div>
        {record.projectName && (
          <div className="flex justify-between gap-3">
            <dt className="text-neutral-500">项目</dt>
            <dd className="truncate text-neutral-300" title={record.projectName}>
              {record.projectName}
            </dd>
          </div>
        )}
        {record.model && (
          <div className="flex justify-between">
            <dt className="text-neutral-500">模型</dt>
            <dd className="font-mono text-neutral-300">{record.model}</dd>
          </div>
        )}
        {record.providerOutputSize && (
          <div className="flex justify-between">
            <dt className="text-neutral-500">上游实际尺寸</dt>
            <dd className="font-mono text-neutral-300">{record.providerOutputSize}</dd>
          </div>
        )}
        <div className="flex justify-between">
          <dt className="text-neutral-500">时间</dt>
          <dd className="text-neutral-300">
            {time} · {record.finishedAt ? "耗时" : "已等待"} {duration}s
          </dd>
        </div>
      </dl>

      {record.prompt && (
        <div className="space-y-1">
          <span className="text-[10px] text-neutral-500">提示词</span>
          <p className="rounded-md border border-[#262626] bg-[#0f0f0f] px-2 py-1.5 text-[10px] leading-relaxed text-neutral-400">
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
        "gc-panel flex w-64 shrink-0 flex-col border-l border-[#262626] bg-[#141414]",
        className,
      )}
    >
      <div className="border-b border-[#262626] px-3 py-2.5 text-[10px] font-medium uppercase tracking-widest text-neutral-500">
        {showResult ? "生成记录" : "属性"}
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {showResult ? (
          selectedResultId ? (
            <ResultRecordDetail resultId={selectedResultId} />
          ) : (
            <p className="py-4 text-center text-[10px] text-neutral-600">
              选择上方结果查看完整运行记录
            </p>
          )
        ) : selectedNodeId ? (
          <PropertyEditor nodeId={selectedNodeId} />
        ) : (
          <p className="py-4 text-center text-[10px] text-neutral-600">
            点击画布节点查看属性
          </p>
        )}
      </div>
    </aside>
  );
}

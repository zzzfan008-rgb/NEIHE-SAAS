import { useState } from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  Clock3Icon,
  ImageIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { ImageConversationSourceSelection } from "@/lib/imageConversationInputs";
import type { DocumentTarget } from "@/store/flowStore";
import { ConversationResultActions } from "./ConversationResultActions";
import type {
  ImageConversationIntentView,
  ImageConversationOutputView,
  ImageConversationRoundView,
  ImageConversationView,
} from "@/types/imageConversation";
import { imageModelLabel, isImageModelId } from "@/types/imageModels";

interface ConversationHistoryProps {
  conversation: ImageConversationView | null;
  target: DocumentTarget;
  onView: (imageRef: string) => void;
  onContinue: (selection: ImageConversationSourceSelection) => void;
  onAddReference: (selection: ImageConversationSourceSelection) => void;
  onRetry: (intent: ImageConversationIntentView) => void;
  onReconcile: (roundId: string) => void;
  reconcilingRoundId: string | null;
}

export function ConversationHistory({
  conversation,
  target,
  onView,
  onContinue,
  onAddReference,
  onRetry,
  onReconcile,
  reconcilingRoundId,
}: ConversationHistoryProps) {
  if (!conversation || conversation.rounds.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-8 text-center">
        <div className="max-w-xs space-y-2">
          <p className="text-sm font-medium text-[var(--gc-text)]">还没有修改轮次</p>
          <p className="text-xs leading-5 text-[var(--gc-text-muted)]">
            选择底图并输入要求后，这里会按轮次保留指令、输入快照、状态和结果。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3" role="region" aria-label="对话修改历史">
      {conversation.rounds.map((round) => (
        <RoundCard
          key={round.id}
          round={round}
          conversation={conversation}
          sourcePreviews={conversation.sourcePreviews ?? {}}
          outputs={conversation.outputs.filter((output) => output.roundId === round.id)}
          target={target}
          onView={onView}
          onContinue={onContinue}
          onAddReference={onAddReference}
          onRetry={onRetry}
          onReconcile={onReconcile}
          reconcilingRoundId={reconcilingRoundId}
        />
      ))}
    </div>
  );
}

function RoundCard({
  round,
  conversation,
  sourcePreviews,
  outputs,
  target,
  onView,
  onContinue,
  onAddReference,
  onRetry,
  onReconcile,
  reconcilingRoundId,
}: {
  round: ImageConversationRoundView;
  conversation: ImageConversationView;
  sourcePreviews: Record<string, string>;
  outputs: ImageConversationOutputView[];
  target: DocumentTarget;
  onView: (imageRef: string) => void;
  onContinue: (selection: ImageConversationSourceSelection) => void;
  onAddReference: (selection: ImageConversationSourceSelection) => void;
  onRetry: (intent: ImageConversationIntentView) => void;
  onReconcile: (roundId: string) => void;
  reconcilingRoundId: string | null;
}) {
  return (
    <Card size="sm" className="gap-2 rounded-lg border border-[var(--gc-border)] bg-[var(--gc-control)] p-3 text-[var(--gc-text)] ring-0">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--gc-text-muted)]">
            第 {round.ordinal} 轮 · {modeLabel(round.mode)}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-[var(--gc-text)]">{round.prompt}</p>
        </div>
        <StatusPill status={round.status} />
      </div>

      <RoundInputSnapshot
        round={round}
        conversation={conversation}
        sourcePreviews={sourcePreviews}
      />

      <RoundParameters parameters={round.parameters} />

      {round.clarification && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs leading-5 text-amber-200">
          <p className="font-medium">需要补充说明</p>
          <p>{round.clarification.question}</p>
        </div>
      )}

      <div className="space-y-2">
        {round.intents.map((intent) => (
          <IntentRow
            key={intent.id}
            intent={intent}
            outputs={outputs.filter((output) => output.intentId === intent.id)}
            target={target}
            onView={onView}
            onContinue={onContinue}
            onAddReference={onAddReference}
            onRetry={onRetry}
            onReconcile={onReconcile}
            reconcilingRoundId={reconcilingRoundId}
          />
        ))}
      </div>
    </Card>
  );
}

function RoundInputSnapshot({
  round,
  conversation,
  sourcePreviews,
}: {
  round: ImageConversationRoundView;
  conversation: ImageConversationView;
  sourcePreviews: Record<string, string>;
}) {
  const sourceOutput = round.sourceResultId
    ? conversation.outputs.find((output) => (
        output.generationOutputId === round.sourceResultId || output.id === round.sourceResultId
      ))
    : undefined;
  const sourceRound = sourceOutput
    ? conversation.rounds.find((candidate) => candidate.id === sourceOutput.roundId)
    : undefined;
  const inputs = [...round.inputManifest].sort((left, right) => left.ordinal - right.ordinal);

  if (inputs.length === 0 && !round.maskRef && !sourceRound && !round.sourceResultId) return null;

  return (
    <div
      className="space-y-2 rounded-md border border-[var(--gc-border)] bg-[var(--gc-panel)] px-2.5 py-2"
      data-testid="conversation-input-snapshot"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--gc-text-muted)]">输入快照</p>
        {sourceRound ? (
          <span className="text-[10px] text-[var(--gc-accent)]">基于第 {sourceRound.ordinal} 轮结果</span>
        ) : round.sourceResultId ? (
          <span className="text-[10px] text-[var(--gc-accent)]">基于已生成结果继续修改</span>
        ) : null}
      </div>

      {inputs.length > 0 && (
        <div className="grid grid-cols-4 gap-1.5">
          {inputs.map((input) => (
            <SnapshotImage
              key={`${input.sourceRef}-${input.ordinal}`}
              previewRef={previewForSource(input.sourceRef, sourcePreviews, conversation.outputs)}
              label={input.role === "base" ? "底图" : `参考图 ${input.ordinal}`}
              fallback={sourceRefLabel(input.sourceRef)}
            />
          ))}
        </div>
      )}

      {round.maskRef && (
        <div className="flex items-center gap-2 border-t border-[var(--gc-border)] pt-2">
          <SnapshotImage
            previewRef={previewForSource(round.maskRef, sourcePreviews, conversation.outputs)}
            label="蒙版"
            fallback={sourceRefLabel(round.maskRef)}
            compact
          />
          <span className="text-[10px] text-[var(--gc-text-muted)]">本轮使用的蒙版</span>
        </div>
      )}
    </div>
  );
}

function SnapshotImage({
  previewRef,
  label,
  fallback,
  compact = false,
}: {
  previewRef: string | undefined;
  label: string;
  fallback: string;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "flex items-center gap-2" : "min-w-0"}>
      <div className={compact ? "size-10 shrink-0" : "overflow-hidden rounded border border-[var(--gc-border)] bg-[var(--gc-control)]"}>
        {previewRef ? (
          <img src={previewRef} alt={label} className="aspect-square size-full object-cover" />
        ) : (
          <div className="flex aspect-square size-full items-center justify-center p-1 text-[9px] text-[var(--gc-text-muted)]" title={fallback}>
            <ImageIcon aria-hidden="true" className="size-4" />
          </div>
        )}
      </div>
      {!compact && <p className="mt-1 truncate text-[9px] text-[var(--gc-text-muted)]" title={fallback}>{label}</p>}
    </div>
  );
}

function RoundParameters({ parameters }: { parameters: Record<string, unknown> }) {
  const modelId = typeof parameters.modelId === "string" ? parameters.modelId : "";
  const quality = typeof parameters.quality === "string" ? parameters.quality : "未记录";
  const outputCount = typeof parameters.outputCount === "number" ? String(parameters.outputCount) : "未记录";
  const size = typeof parameters.size === "string" ? parameters.size : "未记录";
  const aspectRatio = typeof parameters.aspectRatio === "string" ? parameters.aspectRatio : "未记录";
  const aspectRatioMode = parameters.aspectRatioMode === "follow" ? `跟随底图（${aspectRatio}）` : aspectRatio;

  return (
    <Collapsible defaultOpen={false} data-testid="conversation-round-parameters">
      <CollapsibleTrigger className="h-7 rounded-md px-1.5 text-[10px]">
        <span className="flex items-center gap-1.5"><SlidersHorizontalIcon aria-hidden="true" className="size-3" />本轮参数</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 transition-transform group-data-panel-open/collapsible-trigger:rotate-180 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-[var(--gc-border)] px-1 pt-2 text-[10px]">
          <ParameterItem label="图片模型" value={isImageModelId(modelId) ? imageModelLabel(modelId) : modelId || "未记录"} />
          <ParameterItem label="画质" value={quality} />
          <ParameterItem label="输出数量" value={outputCount} />
          <ParameterItem label="分辨率" value={size} />
          <ParameterItem label="画幅" value={aspectRatioMode} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ParameterItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className="text-[var(--gc-text-muted)]">{label}</span>
      <span className="ml-1 break-words text-[var(--gc-text)]">{value}</span>
    </div>
  );
}

function previewForSource(
  sourceRef: string,
  sourcePreviews: Record<string, string>,
  outputs: ImageConversationOutputView[],
): string | undefined {
  return sourcePreviews[sourceRef]
    ?? (sourceRef.startsWith("/api/files/") || sourceRef.startsWith("data:image/") ? sourceRef : undefined)
    ?? outputs.find((output) => (
      output.generationOutputId && sourceRef === `generation-output/${output.generationOutputId}`
    ))?.imageRef
    ?? undefined;
}

function sourceRefLabel(sourceRef: string): string {
  const lastSegment = sourceRef.split("/").at(-1);
  return lastSegment || sourceRef;
}

function IntentRow({
  intent,
  outputs,
  target,
  onView,
  onContinue,
  onAddReference,
  onRetry,
  onReconcile,
  reconcilingRoundId,
}: {
  intent: ImageConversationIntentView;
  outputs: ImageConversationOutputView[];
  target: DocumentTarget;
  onView: (imageRef: string) => void;
  onContinue: (selection: ImageConversationSourceSelection) => void;
  onAddReference: (selection: ImageConversationSourceSelection) => void;
  onRetry: (intent: ImageConversationIntentView) => void;
  onReconcile: (roundId: string) => void;
  reconcilingRoundId: string | null;
}) {
  const canRetry = intent.status === "failed";
  const [retryOpen, setRetryOpen] = useState(false);
  return (
    <div className="rounded-md border border-[var(--gc-border)] bg-[var(--gc-panel)] p-2.5">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--gc-accent)]/15 text-[10px] font-semibold text-[var(--gc-accent)]">
          {intent.ordinal}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--gc-text)]">{intent.label}</p>
            <StatusPill status={intent.status} />
          </div>
          <p className="mt-1 text-[11px] leading-4 text-[var(--gc-text-muted)]">{intent.instruction}</p>
        </div>
      </div>

      {outputs.length > 0 && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          {outputs.map((output) => (
            <OutputCard
              key={output.id}
              output={output}
              target={target}
              onView={onView}
              onContinue={onContinue}
              onAddReference={onAddReference}
              onReconcile={onReconcile}
              reconcilingRoundId={reconcilingRoundId}
            />
          ))}
        </div>
      )}

      {canRetry && (
        <>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="mt-2 w-full justify-center text-amber-300 hover:text-amber-200"
            onClick={() => setRetryOpen(true)}
          >
            <RotateCcwIcon aria-hidden="true" />重试此方案
          </Button>
          <AlertDialog open={retryOpen} onOpenChange={setRetryOpen}>
            <AlertDialogContent overlayClassName="z-[90]" className="z-[91]">
              <AlertDialogHeader>
                <AlertDialogTitle>确认重试此方案？</AlertDialogTitle>
                <AlertDialogDescription>
                  只会重新执行“{intent.label}”这一项，已成功的结果不会重跑；本次重试可能产生额外费用。结果待确认的方案不能直接重试，需先核对。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction onClick={() => onRetry(intent)}>确认重试</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  );
}

function OutputCard({
  output,
  target,
  onView,
  onContinue,
  onAddReference,
  onReconcile,
  reconcilingRoundId,
}: {
  output: ImageConversationOutputView;
  target: DocumentTarget;
  onView: (imageRef: string) => void;
  onContinue: (selection: ImageConversationSourceSelection) => void;
  onAddReference: (selection: ImageConversationSourceSelection) => void;
  onReconcile: (roundId: string) => void;
  reconcilingRoundId: string | null;
}) {
  if (output.status === "unknown") {
    return (
      <div className="col-span-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-2 text-[11px] text-amber-200">
        <p>结果待确认：不会自动重发，请先完成结果核对。</p>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="mt-1 px-0 text-amber-200 hover:text-amber-100"
          disabled={reconcilingRoundId === output.roundId}
          onClick={() => onReconcile(output.roundId)}
        >
          {reconcilingRoundId === output.roundId ? "核对中…" : "核对结果"}
        </Button>
      </div>
    );
  }
  if (output.status === "failed" || !output.imageRef) {
    return (
      <div className="col-span-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-2 text-[11px] text-red-200">
        该方案生成失败{output.error ? `：${output.error}` : ""}
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-[var(--gc-border)] bg-[var(--gc-control)]">
      <img src={output.imageRef} alt="对话修改结果" className="aspect-square w-full object-cover" />
      <ConversationResultActions
        output={output}
        target={target}
        onView={onView}
        onContinue={onContinue}
        onAddReference={onAddReference}
      />
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone = status === "succeeded" || status === "ready"
    ? "text-emerald-300"
    : status === "failed" || status === "rejected"
      ? "text-red-300"
      : status === "unknown" || status === "outcome_unknown"
        ? "text-amber-300"
        : "text-[var(--gc-text-muted)]";
  const Icon = status === "succeeded" || status === "ready"
    ? CheckCircle2Icon
    : status === "failed" || status === "rejected"
      ? AlertCircleIcon
      : Clock3Icon;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 text-[10px] ${tone}`}>
      <Icon aria-hidden="true" className="size-3" />{statusLabel(status)}
    </span>
  );
}

function modeLabel(mode: ImageConversationRoundView["mode"]): string {
  return mode === "single" ? "单图修改" : mode === "fusion" ? "多图融合" : "局部重绘";
}

function statusLabel(status: string): string {
  switch (status) {
    case "succeeded":
    case "ready": return "已完成";
    case "queued": return "排队中";
    case "running": return "生成中";
    case "partial": return "部分完成";
    case "failed": return "失败";
    case "rejected": return "已拒绝";
    case "unknown":
    case "outcome_unknown": return "结果待确认";
    case "clarification_required": return "待补充";
    default: return "草稿";
  }
}

import { ChevronDownIcon, ChevronUpIcon, ImagePlusIcon, SendIcon, SlidersHorizontalIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type {
  ImageConversationMode,
  ImageConversationModeDraft,
  ImageConversationParameters,
} from "@/types/imageConversation";
import {
  closestImageConversationAspectRatio,
  getImageConversationModelCapabilities,
  getImageConversationModelsForMode,
  IMAGE_CONVERSATION_ASPECT_RATIOS,
} from "@/lib/imageConversationRules";
import { DEFAULT_IMAGE_CONVERSATION_PARAMETERS } from "@/store/imageConversationStore";
import { imageModelLabel } from "@/types/imageModels";

interface ConversationComposerProps {
  mode: ImageConversationMode;
  draft: ImageConversationModeDraft;
  sourcePreviews: Record<string, string>;
  clarification?: {
    question: string;
    answer: string;
    onAnswerChange: (answer: string) => void;
  };
  disabled: boolean;
  canSend: boolean;
  sending: boolean;
  onDraftChange: (patch: Partial<ImageConversationModeDraft>) => void;
  onRemoveInput: (ordinal: number) => void;
  onMoveInput: (ordinal: number, direction: "up" | "down") => void;
  onReorderInputs: (fromIndex: number, toIndex: number) => void;
  onAddInput: () => void;
  onUpload: () => void;
  onBaseAspectRatioChange: (aspectRatio: string) => void;
  onEditMask: () => void;
  onSubmit: () => void;
}

export function ConversationComposer({
  mode,
  draft,
  sourcePreviews,
  clarification,
  disabled,
  canSend,
  sending,
  onDraftChange,
  onRemoveInput,
  onMoveInput,
  onReorderInputs,
  onAddInput,
  onUpload,
  onBaseAspectRatioChange,
  onEditMask,
  onSubmit,
}: ConversationComposerProps) {
  const baseImage = useRef<HTMLImageElement>(null);
  const dragIndex = useRef<number | null>(null);
  const parameters = draft.parameters ?? DEFAULT_IMAGE_CONVERSATION_PARAMETERS;
  const capabilities = getImageConversationModelCapabilities(parameters.modelId);
  const availableModels = getImageConversationModelsForMode(mode);
  const inputDisabled = disabled || Boolean(clarification);
  const updateParameters = (patch: Partial<ImageConversationParameters>) => {
    onDraftChange({ parameters: { ...parameters, ...patch } });
  };

  return (
    <div className="shrink-0 border-t border-[var(--gc-border)] bg-[var(--gc-panel)] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--gc-text-muted)]">
          {mode === "single" ? "底图" : mode === "fusion" ? "有序输入" : "底图与蒙版"}
        </p>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="xs" onClick={onUpload} disabled={inputDisabled}>
            <UploadIcon aria-hidden="true" />上传
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={onAddInput} disabled={inputDisabled}>
            <ImagePlusIcon aria-hidden="true" />添加
          </Button>
        </div>
      </div>

      <div className="mb-2 flex max-h-24 min-h-10 gap-2 overflow-x-auto rounded-lg border border-[var(--gc-border)] bg-[var(--gc-control)] p-2">
        {draft.inputs.length === 0 ? (
          <p className="self-center text-[11px] text-[var(--gc-text-muted)]">尚未选择图片；发送前需要一张底图。</p>
        ) : (
          draft.inputs.map((input, index) => (
            <div
              key={`${input.sourceRef}-${input.ordinal}`}
              className="group relative flex w-16 shrink-0 flex-col gap-1"
              draggable={mode === "fusion" && !inputDisabled}
              onDragStart={(event) => {
                if (mode !== "fusion" || inputDisabled) return;
                dragIndex.current = index;
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => {
                if (mode !== "fusion" || dragIndex.current === null) return;
                event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (mode !== "fusion" || dragIndex.current === null || dragIndex.current === index) {
                  dragIndex.current = null;
                  return;
                }
                const from = dragIndex.current;
                dragIndex.current = null;
                onReorderInputs(from, index);
              }}
              onDragEnd={() => { dragIndex.current = null; }}
            >
              <div className="relative overflow-hidden rounded-md border border-[var(--gc-border)] bg-[var(--gc-panel)]">
                <img
                  ref={index === 0 ? baseImage : undefined}
                  src={sourcePreviews[input.sourceRef] ?? input.sourceRef}
                  alt={`${input.role === "base" ? "底图" : "参考图"} ${index + 1}`}
                  className="aspect-square w-full object-cover"
                  onLoad={(event) => {
                    if (index !== 0) return;
                    onBaseAspectRatioChange(
                      closestImageConversationAspectRatio(
                        event.currentTarget.naturalWidth,
                        event.currentTarget.naturalHeight,
                      ),
                    );
                  }}
                />
                <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[9px] text-white">图 {index + 1}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`移除第 ${index + 1} 张图片`}
                  className="absolute right-0.5 top-0.5 bg-black/60 text-white hover:bg-black/80 hover:text-white"
                  onClick={() => onRemoveInput(input.ordinal)}
                  disabled={inputDisabled}
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </div>
              {mode === "fusion" && (
                <div className="flex justify-center gap-0.5">
                  <Button type="button" variant="ghost" size="icon-xs" aria-label={`第 ${index + 1} 张图片上移`} onClick={() => onMoveInput(input.ordinal, "up")} disabled={inputDisabled || index === 0}>
                    <ChevronUpIcon aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-xs" aria-label={`第 ${index + 1} 张图片下移`} onClick={() => onMoveInput(input.ordinal, "down")} disabled={inputDisabled || index === draft.inputs.length - 1}>
                    <ChevronDownIcon aria-hidden="true" />
                  </Button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {mode === "mask" && (
        <div className="mb-2 flex items-center justify-between rounded-md border border-dashed border-[var(--gc-border)] px-2.5 py-2 text-[11px] text-[var(--gc-text-muted)]">
          <span>{draft.maskSourceRef ? "蒙版已绑定当前底图" : "请在底图上绘制蒙版"}</span>
          <Button type="button" variant="outline" size="xs" disabled={inputDisabled || draft.inputs.length === 0} onClick={onEditMask}>
            {draft.maskSourceRef ? "重新绘制" : "绘制蒙版"}
          </Button>
        </div>
      )}

      <Collapsible className="mb-2" defaultOpen={false}>
        <CollapsibleTrigger>
          <span className="flex items-center gap-1.5"><SlidersHorizontalIcon aria-hidden="true" className="size-3.5" />参数</span>
          <ChevronDownIcon aria-hidden="true" className="size-3.5 transition-transform group-data-panel-open/collapsible-trigger:rotate-180 motion-reduce:transition-none" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="grid grid-cols-2 gap-2 border-t border-[var(--gc-border)] px-1 pt-2">
            <label className="min-w-0 space-y-1">
              <span className="block text-[10px] text-[var(--gc-text-muted)]">图片模型</span>
              <Select value={parameters.modelId} disabled={inputDisabled} onValueChange={(value) => value && updateParameters({ modelId: value })}>
                <SelectTrigger aria-label="图片模型" className="w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent positionerClassName="z-[90]">
                  {availableModels.map((modelId) => (
                    <SelectItem key={modelId} value={modelId}>{imageModelLabel(modelId)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="min-w-0 space-y-1">
              <span className="block text-[10px] text-[var(--gc-text-muted)]">画质</span>
              <Select value={parameters.quality} disabled={inputDisabled} onValueChange={(value) => value && updateParameters({ quality: value })}>
                <SelectTrigger aria-label="图片画质" className="w-full text-xs"><SelectValue /></SelectTrigger>
                <SelectContent positionerClassName="z-[90]">
                  {(capabilities?.qualities ?? [parameters.quality]).map((quality) => (
                    <SelectItem key={quality} value={quality}>{qualityLabel(quality)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {mode !== "mask" && (
              <>
                <label className="min-w-0 space-y-1">
                  <span className="block text-[10px] text-[var(--gc-text-muted)]">画幅</span>
                  <Select
                    value={parameters.aspectRatioMode === "fixed" ? parameters.aspectRatio ?? "1:1" : "follow"}
                    disabled={inputDisabled}
                    onValueChange={(value) => {
                      if (!value) return;
                      updateParameters(value === "follow"
                        ? { aspectRatioMode: "follow", aspectRatio: baseImage.current?.naturalWidth
                            ? closestImageConversationAspectRatio(baseImage.current.naturalWidth, baseImage.current.naturalHeight)
                            : "1:1" }
                        : { aspectRatio: value, aspectRatioMode: "fixed" });
                    }}
                  >
                    <SelectTrigger aria-label="输出画幅" className="w-full text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent positionerClassName="z-[90]">
                      <SelectItem value="follow">跟随底图（{parameters.aspectRatio ?? "1:1"}）</SelectItem>
                      {(capabilities?.aspectRatios ?? [...IMAGE_CONVERSATION_ASPECT_RATIOS]).map((aspectRatio) => (
                        <SelectItem key={aspectRatio} value={aspectRatio}>{aspectRatio}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <label className="min-w-0 space-y-1">
                  <span className="block text-[10px] text-[var(--gc-text-muted)]">分辨率</span>
                  <Select value={parameters.size ?? "2K"} disabled={inputDisabled} onValueChange={(value) => value && updateParameters({ size: value })}>
                    <SelectTrigger aria-label="输出分辨率" className="w-full text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent positionerClassName="z-[90]">
                      {(capabilities?.sizes ?? [parameters.size ?? "2K"]).map((size) => (
                        <SelectItem key={size} value={size}>{size}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              </>
            )}
            {mode === "mask" && (
              <div className="col-span-2 flex items-center justify-between rounded-md border border-[var(--gc-border)] px-2 py-1.5 text-[10px] text-[var(--gc-text-muted)]">
                <span>画幅</span>
                <span>跟随底图（{parameters.aspectRatio ?? "1:1"}）</span>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {clarification && (
        <div className="mb-2 space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5" role="group" aria-label="补充说明">
          <div className="text-xs leading-5 text-amber-200">
            <p className="font-medium">需要补充说明</p>
            <p>{clarification.question}</p>
          </div>
          <Textarea
            value={clarification.answer}
            disabled={disabled}
            aria-label="澄清补充回答"
            placeholder="回答后提交本轮"
            rows={2}
            className="min-h-14 resize-none bg-[var(--gc-control)] text-xs leading-5"
            onChange={(event) => clarification.onAnswerChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
              event.preventDefault();
              if (canSend && !sending) onSubmit();
            }}
          />
        </div>
      )}
      <Textarea
        value={draft.prompt}
        disabled={disabled || Boolean(clarification)}
        aria-label="对话修改指令"
        placeholder="描述要怎么修改；Enter 换行，⌘/Ctrl + Enter 发送"
        rows={3}
        className="min-h-20 resize-none bg-[var(--gc-control)] text-xs leading-5"
        onChange={(event) => onDraftChange({ prompt: event.target.value })}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
          event.preventDefault();
          if (canSend && !sending) onSubmit();
        }}
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="min-w-0 text-[10px] leading-4 text-[var(--gc-text-muted)]">
          {sending ? "本轮生成中；可以编辑下一轮草稿，但当前对话暂不能再次发送。" : clarification ? "回答澄清后提交本轮 · ⌘/Ctrl + Enter 发送" : "Enter 换行 · ⌘/Ctrl + Enter 发送"}
        </p>
        <Button type="button" size="sm" className="shrink-0" disabled={disabled || !canSend || sending} onClick={onSubmit}>
          <SendIcon aria-hidden="true" />{sending ? "发送中…" : clarification ? "提交补充" : "发送"}
        </Button>
      </div>
    </div>
  );
}

function qualityLabel(value: string): string {
  return {
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "超高",
    max: "最高",
  }[value] ?? value;
}

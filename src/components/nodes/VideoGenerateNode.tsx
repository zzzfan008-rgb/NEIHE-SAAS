import { MinusIcon, PlusIcon } from "lucide-react";
import { Position, type Node, type NodeProps } from "@xyflow/react";
import { NodeHandle as Handle } from "./NodeHandle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  SEEDANCE_MODEL_CAPABILITIES,
  SEEDANCE_RATIOS,
  SEEDANCE_RESOLUTIONS,
  SEEDANCE_VIDEO_MODELS,
  normalizedSeedanceSettings,
  seedanceModeRequiresAdaptive,
  seedanceModeSupported,
} from "@/lib/seedance";
import { inputPortSpecs } from "@/lib/workflowPorts";
import { useFlowStore } from "@/store/flowStore";
import {
  isNodeRunActive,
  type SeedanceOutputFormat,
  type SeedanceVideoModelId,
  type VideoAspectRatio,
  type VideoGenerateNodeData,
  type VideoGenerationMode,
  type VideoResolution,
} from "@/types/workflow";
import { Developing, NodeFrame, RunButton } from "./NodeFrame";

const MODES: ReadonlyArray<{ value: VideoGenerationMode; label: string }> = [
  { value: "text-to-video", label: "文生视频" },
  { value: "first-frame-to-video", label: "首帧生视频" },
  { value: "keyframes-to-video", label: "首尾帧生视频" },
  { value: "multimodal-reference", label: "多模态参考" },
  { value: "video-edit", label: "视频编辑" },
  { value: "video-extend", label: "视频延长" },
];

export function VideoGenerateNode({ id, data, selected }: NodeProps<Node<VideoGenerateNodeData>>) {
  const runNode = useFlowStore((state) => state.runNode);
  const updateNodeData = useFlowStore((state) => state.updateNodeData);
  const updateVideoNodeSettings = useFlowStore((state) => state.updateVideoNodeSettings);
  const capability = SEEDANCE_MODEL_CAPABILITIES[data.videoModel];
  const ratioLocked = seedanceModeRequiresAdaptive(data.videoModel, data.mode);
  const durationLocked = data.mode === "video-edit";
  const ports = inputPortSpecs(data);

  const updateSettings = (patch: Partial<{
    model: SeedanceVideoModelId;
    mode: VideoGenerationMode;
    resolution: VideoResolution;
    ratio: VideoAspectRatio;
    duration: number;
    outputFormat: SeedanceOutputFormat;
  }>) => {
    const next = normalizedSeedanceSettings({
      model: patch.model ?? data.videoModel,
      mode: patch.mode ?? data.mode,
      resolution: patch.resolution ?? data.resolution,
      ratio: patch.ratio ?? data.aspectRatio,
      duration: patch.duration ?? data.seconds,
      outputFormat: patch.outputFormat ?? data.outputFormat,
    });
    updateVideoNodeSettings(id, {
      videoModel: next.model,
      mode: next.mode,
      resolution: next.resolution,
      aspectRatio: next.ratio,
      seconds: next.duration,
      outputFormat: next.outputFormat,
      outputImages: [],
    });
  };

  const changeSeconds = (delta: number) => {
    const current = data.seconds === -1 ? 4 : data.seconds;
    updateSettings({ duration: Math.min(capability.maxDuration, Math.max(4, current + delta)) });
  };

  return (
    <>
      {ports.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type="target"
          position={Position.Left}
          title={port.label}
          style={{ top: `${((index + 1) / (ports.length + 1)) * 100}%` }}
        />
      ))}
      <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected} executable>
        <label className="block space-y-1">
          <span className="text-[9px] text-[var(--gc-node-muted)]">模型</span>
          <Select value={data.videoModel} onValueChange={(value) => updateSettings({ model: value as SeedanceVideoModelId })}>
            <SelectTrigger size="sm" aria-label="Seedance 模型" className="nodrag w-full border-[var(--gc-node-border)] bg-[var(--gc-node-inner)] text-[10px] text-[var(--gc-node-text)]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start" className="border border-[var(--gc-border)] bg-[var(--gc-panel)] text-[var(--gc-text)]">
              {SEEDANCE_VIDEO_MODELS.map((model) => (
                <SelectItem key={model} value={model} className="min-h-8 text-xs">
                  {SEEDANCE_MODEL_CAPABILITIES[model].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="block space-y-1">
          <span className="text-[9px] text-[var(--gc-node-muted)]">生成方式</span>
          <Select value={data.mode} onValueChange={(value) => updateSettings({ mode: value as VideoGenerationMode })}>
            <SelectTrigger size="sm" aria-label="视频生成方式" className="nodrag w-full border-[var(--gc-node-border)] bg-[var(--gc-node-inner)] text-[10px] text-[var(--gc-node-text)]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start" className="border border-[var(--gc-border)] bg-[var(--gc-panel)] text-[var(--gc-text)]">
              {MODES.map((mode) => (
                <SelectItem
                  key={mode.value}
                  value={mode.value}
                  disabled={!seedanceModeSupported(data.videoModel, mode.value)}
                  className="min-h-8 text-xs"
                >
                  {mode.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="block space-y-1">
          <span className="text-[10px] text-[var(--gc-node-muted)]">镜头提示词（必填）</span>
          <Textarea
            value={data.prompt}
            rows={3}
            onChange={(event) => updateNodeData(id, { prompt: event.target.value })}
            className="nodrag min-h-20 resize-none border-[var(--gc-node-border)] bg-[var(--gc-node-inner)] px-2 py-1.5 text-xs text-[var(--gc-node-text)] focus-visible:border-[var(--gc-node-accent)] focus-visible:ring-[var(--gc-node-accent)]/40"
            placeholder={data.mode === "video-edit" ? "修改 @视频1 中的…" : data.mode === "video-extend" ? "向后延长 @视频1…" : "镜头、动作、材质动态与声音…"}
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="block text-[9px] text-[var(--gc-node-muted)]">画幅比例</span>
            <Select
              value={ratioLocked ? "adaptive" : data.aspectRatio}
              disabled={ratioLocked}
              onValueChange={(value) => updateSettings({ ratio: value as VideoAspectRatio })}
            >
              <SelectTrigger size="sm" aria-label="视频画幅比例" className="nodrag w-full border-[var(--gc-node-border)] bg-[var(--gc-node-inner)] text-[10px] text-[var(--gc-node-text)]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start" className="border border-[var(--gc-border)] bg-[var(--gc-panel)] text-[var(--gc-text)]">
                {SEEDANCE_RATIOS.map((ratio) => <SelectItem key={ratio} value={ratio} className="min-h-8 text-xs">{ratio}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
          <div className="space-y-1">
            <span className="block text-[9px] text-[var(--gc-node-muted)]">时长</span>
            <div className="flex h-7 items-center">
              <Button type="button" variant="outline" size="icon-xs" aria-label="减少一秒" disabled={durationLocked || data.seconds === -1 || data.seconds <= 4} onClick={() => changeSeconds(-1)} className="nodrag rounded-r-none border-[var(--gc-node-border)] text-[var(--gc-node-text)]"><MinusIcon /></Button>
              <Input readOnly aria-label="视频时长（秒）" value={data.seconds === -1 ? "智能" : `${data.seconds} 秒`} className="nodrag h-6 min-w-0 rounded-none border-x-0 border-[var(--gc-node-border)] bg-[var(--gc-node-inner)] px-1 text-center text-[10px] text-[var(--gc-node-text)] shadow-none" />
              <Button type="button" variant="outline" size="icon-xs" aria-label="增加一秒" disabled={durationLocked || data.seconds >= capability.maxDuration} onClick={() => changeSeconds(1)} className="nodrag rounded-l-none border-[var(--gc-node-border)] text-[var(--gc-node-text)]"><PlusIcon /></Button>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between rounded-md border border-[var(--gc-node-border)] bg-[var(--gc-node-inner)] px-2 py-1.5">
          <label htmlFor={`video-smart-duration-${id}`} className="text-[10px] text-[var(--gc-node-text)]">智能时长</label>
          <Switch
            id={`video-smart-duration-${id}`}
            checked={data.seconds === -1}
            disabled={durationLocked}
            onCheckedChange={(checked) => updateSettings({ duration: checked ? -1 : 5 })}
            className="nodrag"
          />
        </div>

        <div role="group" aria-label="视频分辨率" className="grid grid-cols-3 gap-1">
          {SEEDANCE_RESOLUTIONS.map((resolution) => (
            <Button
              key={resolution}
              type="button"
              variant="outline"
              size="xs"
              disabled={resolution === "1080p" && !capability.supports1080p}
              aria-pressed={data.resolution === resolution}
              onClick={() => updateSettings({ resolution })}
              className={`nodrag rounded-md border-[var(--gc-node-border)] text-[9px] ${data.resolution === resolution ? "border-[var(--gc-node-accent)] bg-[var(--gc-node-accent)] text-[var(--gc-primary-foreground)] hover:bg-[var(--gc-node-accent)]/80" : "bg-[var(--gc-node-inner)] text-[var(--gc-node-muted)]"}`}
            >
              {resolution}
            </Button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="flex items-center justify-between rounded-md border border-[var(--gc-node-border)] bg-[var(--gc-node-inner)] px-2 py-1.5">
            <label htmlFor={`video-audio-${id}`} className="text-[10px] text-[var(--gc-node-text)]">同步音频</label>
            <Switch id={`video-audio-${id}`} checked={data.generateAudio} onCheckedChange={(checked) => updateNodeData(id, { generateAudio: checked })} className="nodrag" />
          </div>
          <Select
            value={data.outputFormat}
            disabled={!capability.supportsMov}
            onValueChange={(value) => updateSettings({ outputFormat: value as SeedanceOutputFormat })}
          >
            <SelectTrigger size="sm" aria-label="视频输出格式" className="nodrag w-full border-[var(--gc-node-border)] bg-[var(--gc-node-inner)] text-[10px] text-[var(--gc-node-text)]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start" className="border border-[var(--gc-border)] bg-[var(--gc-panel)] text-[var(--gc-text)]">
              <SelectItem value="mp4" className="min-h-8 text-xs">MP4</SelectItem>
              <SelectItem value="mov" className="min-h-8 text-xs">MOV</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {data.mode === "multimodal-reference" && (
          <p className="text-[8px] leading-snug text-[var(--gc-node-muted)]">
            上限：{capability.maxImages} 图 / {capability.maxVideos} 视频 / {capability.maxAudios} 音频
          </p>
        )}
        <p className="text-[8px] leading-snug text-amber-600">
          {data.seconds === -1 ? "智能时长按实际输出计费；" : ""}生成会调用 API易并产生对应费用。
        </p>
        <RunButton status={data.status} onClick={() => void runNode(id)} label="生成视频" />
        {isNodeRunActive(data.status) && <Developing />}
        {data.outputImages.map((video) => <video key={video} src={video} controls preload="metadata" className="nodrag max-h-44 w-full rounded-md bg-black" />)}
      </NodeFrame>
      <Handle id="video" type="source" position={Position.Right} title="视频输出" />
    </>
  );
}

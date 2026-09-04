import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { inputPortSpecs } from "@/lib/workflowPorts";
import { useFlowStore } from "@/store/flowStore";
import { isNodeRunActive, type VideoGenerateNodeData } from "@/types/workflow";
import { Developing, inputClass, NodeFrame, RunButton } from "./NodeFrame";

export function VideoGenerateNode({ id, data, selected }: NodeProps<Node<VideoGenerateNodeData>>) {
  const runNode = useFlowStore((state) => state.runNode);
  const updateNodeData = useFlowStore((state) => state.updateNodeData);
  const lockedFrames = data.mode === "keyframes-to-video" || data.mode === "multi-image-video";
  const ports = inputPortSpecs(data);
  const setResolution = (resolution: VideoGenerateNodeData["resolution"]) => updateNodeData(id, {
    resolution,
    ...(resolution === "720p" ? {} : { seconds: 8 }),
  });

  return (
    <>
      {ports.map((port, index) => <Handle key={port.id} id={port.id} type="target" position={Position.Left} title={port.label} style={{ top: `${((index + 1) / (ports.length + 1)) * 100}%` }} />)}
      <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected} executable>
        <p className="text-[9px] leading-relaxed text-[var(--gc-node-muted)]">
          {data.mode === "text-to-video" ? "文字生成服装短片" : data.mode === "keyframes-to-video" ? "首帧与尾帧之间生成连续过渡" : data.mode === "multi-image-video" ? "按参考图一与参考图二建立视觉连续性" : "提取源视频首帧后生成全新镜头；不会逐帧复刻原视频"}
        </p>
        <label className="block space-y-1">
          <span className="text-[10px] text-[var(--gc-node-muted)]">镜头提示词（必填）</span>
          <textarea value={data.prompt} rows={3} onChange={(event) => updateNodeData(id, { prompt: event.target.value })} className={`${inputClass} resize-none`} placeholder="镜头运动、人物动作、布料动态、声音氛围…" />
        </label>
        <div className="grid grid-cols-2 gap-1">
          {(["16:9", "9:16"] as const).map((ratio) => <button key={ratio} type="button" onClick={() => updateNodeData(id, { aspectRatio: ratio })} className={`nodrag rounded border py-1 text-[9px] ${data.aspectRatio === ratio ? "border-[var(--gc-node-accent)] bg-[var(--gc-node-accent)] text-white" : "border-[var(--gc-node-border)] text-[var(--gc-node-muted)]"}`}>{ratio === "16:9" ? "横屏 16:9" : "竖屏 9:16"}</button>)}
        </div>
        <div className="grid grid-cols-3 gap-1">
          {(["720p", "1080p", "4k"] as const).map((resolution) => <button key={resolution} type="button" disabled={lockedFrames && resolution !== "720p"} onClick={() => setResolution(resolution)} className={`nodrag rounded border py-1 text-[9px] disabled:opacity-35 ${data.resolution === resolution ? "border-[var(--gc-node-accent)] bg-[var(--gc-node-accent)] text-white" : "border-[var(--gc-node-border)] text-[var(--gc-node-muted)]"}`}>{resolution === "4k" ? "4K" : resolution}</button>)}
        </div>
        <div className="grid grid-cols-3 gap-1">
          {([4, 6, 8] as const).map((seconds) => <button key={seconds} type="button" disabled={lockedFrames || (data.resolution !== "720p" && seconds !== 8)} onClick={() => updateNodeData(id, { seconds })} className={`nodrag rounded border py-1 text-[9px] disabled:opacity-35 ${data.seconds === seconds ? "border-[var(--gc-node-accent)] bg-[var(--gc-node-accent)] text-white" : "border-[var(--gc-node-border)] text-[var(--gc-node-muted)]"}`}>{seconds} 秒</button>)}
        </div>
        <div className="grid grid-cols-2 gap-1">
          {(["fast", "standard"] as const).map((quality) => <button key={quality} type="button" onClick={() => updateNodeData(id, { quality })} className={`nodrag rounded border py-1 text-[9px] ${data.quality === quality ? "border-[var(--gc-node-accent)] bg-[var(--gc-node-accent)] text-white" : "border-[var(--gc-node-border)] text-[var(--gc-node-muted)]"}`}>{quality === "fast" ? "快速" : "质量优先"}</button>)}
        </div>
        {lockedFrames && <p className="text-[8px] text-amber-600">首尾帧通道固定 720p / 8 秒；两张参考图按连线角色排序。</p>}
        <p className="text-[8px] leading-snug text-amber-600">点击生成会调用 APIYI 视频接口并产生对应费用；模板打开和参数调整不会调用接口。</p>
        <RunButton status={data.status} onClick={() => void runNode(id)} label="生成视频" />
        {isNodeRunActive(data.status) && <Developing />}
        {data.outputImages.map((video) => <video key={video} src={video} controls preload="metadata" className="nodrag max-h-44 w-full rounded-md bg-black" />)}
      </NodeFrame>
      <Handle id="video" type="source" position={Position.Right} title="生成视频" />
    </>
  );
}

import { Position, type Node, type NodeProps } from "@xyflow/react";
import { NodeHandle as Handle } from "./NodeHandle";
import { SceneStabilizeControls } from "./SceneStabilizeControls";
import { GptQualityControls } from "./GptQualityControls";
import { useCoalescedTextEdit } from "@/hooks/useCoalescedTextEdit";
import { nodeOutputImages, selectActiveEdges, selectActiveNodes, useFlowStore } from "@/store/flowStore";
import { orderSceneReferences } from "@/lib/sceneReferenceOrder";
import { inputPortSpecs } from "@/lib/workflowPorts";
import { isNodeRunActive, type VirtualTryOnNodeData } from "@/types/workflow";
import { ImageGrid } from "./ImageGrid";
import { Developing, inputClass, NodeFrame, RunButton } from "./NodeFrame";

export const FASHION_ASPECT_RATIOS: ReadonlyArray<{
  value: VirtualTryOnNodeData["aspectRatio"];
  label: string;
  hint: string;
}> = [
  { value: "1:1", label: "方形", hint: "商品与社媒" },
  { value: "4:5", label: "竖版", hint: "电商主图" },
  { value: "3:4", label: "全身", hint: "服装常用" },
  { value: "2:3", label: "画册", hint: "时装大片" },
  { value: "9:16", label: "长竖", hint: "移动端" },
  { value: "16:9", label: "横版", hint: "场景展示" },
];

function RatioIcon({ ratio }: { ratio: string }) {
  const [width, height] = ratio.split(":").map(Number);
  const scale = 17 / Math.max(width, height);
  return <span aria-hidden="true" className="inline-block rounded-[2px] border border-current" style={{ width: Math.max(5, width * scale), height: Math.max(5, height * scale) }} />;
}

function StageHandles({ data }: { data: VirtualTryOnNodeData }) {
  if (data.workflowStage === "standard") {
    return <Handle id="references" type="target" position={Position.Left} title="参考图" />;
  }
  return (
    <>
    {data.workflowStage === "scene-stabilize" && (
      // Preserve typed edges at the general input after removing the pose row.
      <Handle id="pose" type="target" position={Position.Left}
        className="gc-global-image-input-handle" isConnectable={false}
        style={{ opacity: 0, pointerEvents: "none" }} aria-hidden="true" />
    )}
    <Handle
      className="gc-global-image-input-handle"
      type="target"
      position={Position.Left}
      aria-label="通用图片输入，连接后选择用途"
      title="通用图片输入（连接后选择用途）"
    />
    </>
  );
}

export function VirtualTryOnNode({ id, data, selected }: NodeProps<Node<VirtualTryOnNodeData>>) {
  const runNode = useFlowStore((state) => state.runNode);
  const updateNodeData = useFlowStore((state) => state.updateNodeData);
  const nodes = useFlowStore(selectActiveNodes);
  const edges = useFlowStore(selectActiveEdges);
  const promptEdit = useCoalescedTextEdit(
    { kind: "node-data", nodeId: id, field: "prompt" },
    { multiline: true },
  );
  const running = isNodeRunActive(data.status);
  const numberedReferences = data.workflowStage === "scene-stabilize"
    ? orderSceneReferences(edges.filter(edge => edge.target === id).flatMap(edge => {
      const source = nodes.find(node => node.id === edge.source);
      return source ? nodeOutputImages(source.data, edge.sourceHandle).map(image => ({
        image, role: edge.targetHandle ?? "", sourceId: source.id,
      })) : [];
    })).map((reference, index) => ({ ...reference, number: index + 1 })) : [];
  const roleRows = data.workflowStage === "standard" ? [] : inputPortSpecs(data)
    .filter(port => data.workflowStage !== "scene-stabilize" || port.id !== "pose").map((port) => {
    const connected = edges.filter((edge) => edge.target === id && edge.targetHandle === port.id);
    const sourceLabel = connected
      .map((edge) => nodes.find((node) => node.id === edge.source)?.data.label)
      .filter((label): label is string => Boolean(label));
    const numbers = numberedReferences.filter(reference => reference.role === port.id).map(reference => reference.number);
    const pending = connected.some(edge => {
      const source = nodes.find(node => node.id === edge.source);
      return !source || nodeOutputImages(source.data, edge.sourceHandle).length === 0;
    });
    return { port, connectedSource: sourceLabel, numbers, pending };
  });
  const missingRequiredRole = roleRows.some(({ port, connectedSource }) => (
    port.required && connectedSource.length === 0
  ));
  const missingRefineSpec = data.workflowStage === "garment-refine" && (
    !data.garmentCategory || !data.materialSpec?.trim() || !data.constructionSpec?.trim()
  );
  const staged = data.workflowStage !== "standard";

  return (
    <>
      <StageHandles data={data} />
      <NodeFrame
        nodeId={id}
        title={data.label}
        status={data.status}
        error={data.error}
        selected={selected}
        missingInput={staged && (missingRequiredRole || missingRefineSpec)}
        executable={staged && !missingRequiredRole && !missingRefineSpec}
        summary={staged ? (
          <p className="text-[9px] leading-snug text-[var(--gc-node-muted)]">
            {data.workflowStage === "scene-stabilize"
              ? "人物锁身份 · 场景锁环境 · 穿搭锁服装"
              : "锁定已确认基准，只精修服装结构、面料与工艺"}
          </p>
        ) : undefined}
      >
        {data.workflowStage !== "scene-stabilize" && <GptQualityControls nodeId={id} modelId={data.modelId} modelOptions={data.modelOptions} disabled={running} />}
        {data.workflowStage === "standard" ? (
          <StageHelp title="系统参考图角色" lines={[
            "首图锁定最终模特身份、姿势与背景",
            "第二图控制主穿搭轮廓、比例与层叠",
            "其余图片补充鞋包、材质与工艺细节",
          ]} />
        ) : null}

        {roleRows.length > 0 && (
          <div role="group" className="grid grid-cols-2 gap-1" aria-label="输入角色">
            {roleRows.map(({ port, connectedSource, numbers, pending }) => (
              <div
                key={port.id}
                data-port-row={port.id}
                className="flex min-w-0 items-center gap-1 rounded border border-[var(--gc-node-border)] px-1.5 py-1"
                title={connectedSource.join("、") || `${port.label}未连接`}
              >
                <Handle
                  className="gc-staged-role-handle nodrag"
                  data-connection-state={connectedSource.length ? "connected" : port.required ? "required" : "optional"}
                  type="target"
                  position={Position.Left}
                  id={port.id}
                  aria-label={connectedSource.length
                    ? `${port.label}，已连接 ${connectedSource.join("、")}`
                    : `${port.label}，${port.required ? "必填" : "可选"}，未连接`}
                  title={connectedSource.length
                    ? `${port.label}（已连接）`
                    : `${port.label}${port.required ? "（必填，未连接）" : "（可选，未连接）"}`}
                />
                <span className="min-w-0 flex-1 text-[8px] text-[var(--gc-node-muted)]">
                  <span className="block truncate">{port.label}</span>
                  {data.workflowStage === "scene-stabilize" && <span className="block break-words" data-reference-numbers={port.id}>
                    {numbers.map(number => `(参考图 ${number})`).join(" ")}
                    {pending ? " 待提供图片" : ""}
                  </span>}
                </span>
                {port.required && <span className="text-[7px] text-amber-600">必填</span>}
              </div>
            ))}
          </div>
        )}

        {data.workflowStage === "scene-stabilize" && <SceneStabilizeControls nodeId={id} data={data} />}

        {!staged && <label className="block space-y-1">
          <span className="text-[10px] text-neutral-500">补充要求（可选）</span>
          <textarea
            value={data.prompt}
            {...promptEdit.bind}
            rows={3}
            placeholder="只描述最终效果，不要重定义参考图角色或编号"
            className={`${inputClass} resize-none`}
          />
        </label>}

        {!staged && (
          <div className="space-y-1.5">
            <span className="text-[10px] text-[var(--gc-node-muted)]">画幅比例</span>
            <div className="grid grid-cols-3 gap-1">
              {FASHION_ASPECT_RATIOS.map((ratio) => (
                <button
                  key={ratio.value}
                  type="button"
                  title={ratio.hint}
                  onClick={() => updateNodeData(id, { aspectRatio: ratio.value })}
                  className={`nodrag flex min-h-10 flex-col items-center justify-center gap-0.5 rounded border px-1 text-[8px] ${data.aspectRatio === ratio.value ? "border-[var(--gc-node-accent)] bg-amber-50 text-[var(--gc-node-accent)]" : "border-[var(--gc-node-border)] text-[var(--gc-node-muted)] hover:border-[var(--gc-node-accent)]"}`}
                >
                  <RatioIcon ratio={ratio.value} />
                  <span>{ratio.value} · {ratio.label}</span>
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-1" aria-label="输出清晰度">
              {(["2K", "4K"] as const).map((size) => (
                <button key={size} type="button" onClick={() => updateNodeData(id, { imageSize: size })} className={`nodrag rounded border py-1 text-[9px] ${data.imageSize === size ? "border-[var(--gc-node-accent)] bg-[var(--gc-node-accent)] text-white" : "border-[var(--gc-node-border)] text-[var(--gc-node-muted)]"}`}>
                  {size}{size === "2K" ? "（默认）" : ""}
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="text-[8px] leading-snug text-amber-600">
          临时连接异常最多自动重试 2 次；参数错误不会重试。
        </p>

        {data.workflowStage === "garment-refine" && <div className="truncate rounded border border-[var(--gc-node-border)] bg-[var(--gc-node-inner)] px-2 py-1 text-[9px] text-[var(--gc-node-muted)]">
          {`第二轮固定引擎 · 中等质量 · ${data.imageSize}`}
          <span className="ml-1">（完整设置在右侧属性面板）</span>
        </div>}

        <RunButton
          status={data.status}
          onClick={() => void runNode(id)}
          label={data.workflowStage === "scene-stabilize" ? "生成第一轮基准" : data.workflowStage === "garment-refine" ? "生成服装精修" : "生成换装效果"}
        />
        {running && <Developing />}
        <ImageGrid images={data.outputImages} />
      </NodeFrame>
      <Handle
        className={staged ? "gc-staged-output-handle" : undefined}
        id="image"
        type="source"
        position={Position.Right}
        title="生成图片"
      />
    </>
  );
}

function StageHelp({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="space-y-1 rounded-md border border-[var(--gc-node-border)] bg-[var(--gc-node-inner)] p-2">
      <p className="text-[10px] text-[var(--gc-node-text)]">{title}</p>
      <ul className="list-disc space-y-0.5 pl-4 text-[9px] leading-relaxed text-[var(--gc-node-muted)]">
        {lines.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </div>
  );
}

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Position, type Node, type NodeProps } from "@xyflow/react";
import { ChevronDownIcon, CopyIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  selectActiveEdges,
  selectActiveNodeInputImages,
  selectActiveNodes,
  selectActiveReadOnly,
  useFlowStore,
} from "@/store/flowStore";
import { compileTiAngleText, describeTiAngleText, normalizeTiAngleConfig } from "@/lib/tiAngle";
import { isImageModelId, type ImageModelId } from "@/types/imageModels";
import type { TiAngleConfig, TiAngleNodeData } from "@/types/workflow";
import { NodeHandle as Handle } from "./NodeHandle";
import { NodeFrame } from "./NodeFrame";
import { TiAnglePreview } from "./TiAnglePreview";

function signedAngle(value: number): string {
  return `${value > 0 ? "+" : ""}${value}°`;
}

const ANGLE_PRESETS = [
  { label: "正面", azimuthDeg: 0 },
  { label: "左前方 +45°", azimuthDeg: 45 },
  { label: "右前方 -45°", azimuthDeg: -45 },
  { label: "左侧 +90°", azimuthDeg: 90 },
  { label: "右侧 -90°", azimuthDeg: -90 },
  { label: "背面 -180°", azimuthDeg: -180 },
] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function copyText(text: string): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Keep the read-only text visible so users can select it manually.
  }
  try {
    if (typeof document === "undefined") return;
    const fallback = document.createElement("textarea");
    fallback.value = text;
    fallback.setAttribute("readonly", "true");
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand("copy");
    fallback.remove();
  } catch {
    // Copy failures are intentionally silent; the text remains selectable.
  }
}

function AngleControl({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const [draftValue, setDraftValue] = useState(String(value));
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (!editing) {
      setDraftValue(String(value));
      setInvalid(false);
    }
  }, [editing, value]);

  const commit = (rawValue = draftValue) => {
    const parsed = Number(rawValue.trim());
    if (!rawValue.trim() || !Number.isFinite(parsed) || parsed < min || parsed > max) {
      setDraftValue(String(value));
      setInvalid(true);
      return;
    }
    const next = Math.round(parsed);
    setDraftValue(String(next));
    setInvalid(false);
    onChange(next);
  };

  const commitKeyboardStep = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const step = event.shiftKey ? 5 : 1;
    const next = event.key === "Home"
      ? min
      : event.key === "End"
        ? max
        : clamp(value + (event.key === "ArrowUp" ? step : -step), min, max);
    setDraftValue(String(next));
    setInvalid(false);
    onChange(next);
  };

  return (
    <label className="block space-y-0.5">
      <span className="flex items-center justify-between text-[9px] text-[var(--gc-node-muted)]">
        <span>{label}</span>
        <span className="flex items-center gap-1">
          <output className="font-mono tabular-nums text-[var(--gc-node-text)]">{signedAngle(value)}</output>
          <Input
            type="number"
            aria-label={`${label}数值`}
            min={min}
            max={max}
            step={1}
            value={draftValue}
            disabled={disabled}
            aria-invalid={invalid}
            onFocus={() => setEditing(true)}
            onChange={(event) => {
              setDraftValue(event.target.value);
              setInvalid(false);
            }}
            onKeyDown={commitKeyboardStep}
            onKeyUp={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
                event.currentTarget.blur();
              }
            }}
            onBlur={() => {
              commit();
              setEditing(false);
            }}
            className="h-6 w-14 rounded-md px-1 text-right text-[10px] font-mono"
          />
        </span>
      </span>
      <Slider
        aria-label={label}
        min={min}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        className="nodrag"
      />
    </label>
  );
}

export function TiAngelNode({ id, data, selected }: NodeProps<Node<TiAngleNodeData>>) {
  const updateNodeData = useFlowStore((state) => state.updateNodeData);
  const previewImage = useFlowStore((state) => selectActiveNodeInputImages(state, id)[0]);
  const edges = useFlowStore(selectActiveEdges);
  const nodes = useFlowStore(selectActiveNodes);
  const readOnly = useFlowStore(selectActiveReadOnly);
  const [outputOpen, setOutputOpen] = useState(false);
  const controlsDisabled = readOnly || !data.angle.enabled;

  const updateAngle = (patch: Partial<TiAngleConfig>) => {
    if (readOnly) return;
    updateNodeData(id, {
      angle: normalizeTiAngleConfig({ ...data.angle, ...patch }),
    });
  };

  const outputTargets = useMemo(() => {
    const destinations = edges
      .filter((edge) => edge.source === id && edge.sourceHandle === "text")
      .map((edge) => {
        const target = nodes.find((node) => node.id === edge.target);
        const modelId = target && "modelId" in target.data && isImageModelId(target.data.modelId)
          ? target.data.modelId
          : null;
        return {
          key: edge.id,
          nodeLabel: target?.data.label ?? edge.target,
          modelId,
        };
      });
    const targets = destinations.length > 0
      ? destinations
      : [{ key: "unbound", nodeLabel: "未连接第一阶段", modelId: null as ImageModelId | null }];
    return targets.map((target) => ({
      ...target,
      text: data.angle.enabled
        ? target.modelId
          ? compileTiAngleText(data.angle, target.modelId).text
          : describeTiAngleText(data.angle)
        : "已关闭，不会输出角度约束。",
    }));
  }, [data.angle, edges, id, nodes]);

  const outputId = `${id}-angle-output`;

  return (
    <>
      <Handle id="preview-image" type="target" position={Position.Left} title="示意参考图（仅显示）" />
      <NodeFrame
        nodeId={id}
        title={data.label}
        status={data.status}
        error={data.error}
        selected={selected}
        summary={<p className="text-[9px] leading-snug text-[var(--gc-node-muted)]">仅改变最终观察视角，不改变人物与服装输入</p>}
      >
        <TiAnglePreview
          image={previewImage}
          config={data.angle}
          disabled={controlsDisabled}
          onCommit={(next) => {
            if (!readOnly) updateNodeData(id, { angle: normalizeTiAngleConfig(next) });
          }}
        />
        <div className="space-y-2 rounded-lg border border-[var(--gc-node-border)] bg-[var(--gc-node-inner)] p-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-[10px] font-medium text-[var(--gc-node-text)]">输出视角约束</p>
              <p className="text-[9px] text-[var(--gc-node-muted)]">连接第一轮场景定版后适配目标模型</p>
            </div>
            <Switch
              checked={data.angle.enabled}
              onCheckedChange={(enabled) => updateAngle({ enabled })}
              disabled={readOnly}
              aria-label="启用 3D 视角"
              className="nodrag"
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <p className="text-[9px] text-[var(--gc-node-muted)]">常用视角</p>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={controlsDisabled}
                onClick={() => updateAngle({ azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 })}
                className="nodrag h-6 gap-1 px-1.5 text-[9px]"
              >
                <RotateCcwIcon aria-hidden="true" className="size-3" />
                重置视角
              </Button>
            </div>
            <div className="grid grid-cols-3 gap-1">
              {ANGLE_PRESETS.map((preset) => (
                <Button
                  key={preset.label}
                  type="button"
                  variant={data.angle.azimuthDeg === preset.azimuthDeg && data.angle.elevationDeg === 0 && data.angle.rollDeg === 0 ? "secondary" : "outline"}
                  size="xs"
                  disabled={controlsDisabled}
                  onClick={() => updateAngle({ azimuthDeg: preset.azimuthDeg, elevationDeg: 0, rollDeg: 0 })}
                  className="nodrag h-6 px-1 text-[9px]"
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>
          <AngleControl label="环绕角" value={data.angle.azimuthDeg} min={-180} max={180} disabled={controlsDisabled} onChange={(azimuthDeg) => updateAngle({ azimuthDeg })} />
          <AngleControl label="俯仰角" value={data.angle.elevationDeg} min={-45} max={60} disabled={controlsDisabled} onChange={(elevationDeg) => updateAngle({ elevationDeg })} />
          <AngleControl label="画面倾斜" value={data.angle.rollDeg} min={-30} max={30} disabled={controlsDisabled} onChange={(rollDeg) => updateAngle({ rollDeg })} />
        </div>
        <Collapsible
          open={outputOpen}
          onOpenChange={setOutputOpen}
          className="rounded-md border border-[var(--gc-node-border)] bg-[var(--gc-node-inner)]"
        >
          <CollapsibleTrigger
            aria-expanded={outputOpen}
            aria-controls={outputId}
            className="nodrag flex h-8 w-full items-center justify-between px-2 text-[10px] text-[var(--gc-node-muted)] hover:bg-[var(--gc-panel-hover)] hover:text-[var(--gc-node-text)]"
          >
            <span>查看输出文本</span>
            <ChevronDownIcon aria-hidden="true" className={`size-3 transition-transform ${outputOpen ? "rotate-180" : ""}`} />
          </CollapsibleTrigger>
          <CollapsibleContent id={outputId} className="space-y-2 border-t border-[var(--gc-node-border)] px-2 py-2">
            {outputTargets.map((target) => (
              <section key={target.key} className="space-y-1.5 rounded-md bg-[var(--gc-node-main)]/45 p-1.5">
                <div className="text-[9px] text-[var(--gc-node-muted)]">
                  <p>接收节点：{target.nodeLabel}</p>
                  <p>模型：{target.modelId ?? "未绑定模型"}</p>
                </div>
                <p className="select-text whitespace-pre-wrap text-[9px] leading-relaxed text-[var(--gc-node-text)]">{target.text}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={!data.angle.enabled}
                  onClick={() => void copyText(target.text)}
                  className="nodrag h-6 gap-1 text-[9px]"
                >
                  <CopyIcon aria-hidden="true" className="size-3" />
                  复制视角文本
                </Button>
              </section>
            ))}
          </CollapsibleContent>
        </Collapsible>
      </NodeFrame>
      <Handle id="text" type="source" position={Position.Right} title="视角文本" />
    </>
  );
}

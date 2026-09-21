import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { Position, type Node, type NodeProps } from "@xyflow/react";
import { ChevronDownIcon, CopyIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  selectActiveEdges,
  selectActiveNodeInputImages,
  selectActiveNodes,
  selectActiveReadOnly,
  useFlowStore,
} from "@/store/flowStore";
import {
  TI_ANGLE_APERTURES,
  TI_ANGLE_CAMERA_MODELS,
  TI_ANGLE_FOCAL_LENGTHS,
  TI_ANGLE_ISO_VALUES,
  TI_ANGLE_SHUTTER_SPEEDS,
  compileTiAngleText,
  describeTiAngleCameraParameters,
  describeTiAngleText,
  normalizeTiAngleConfig,
} from "@/lib/tiAngle";
import { isImageModelId, type ImageModelId } from "@/types/imageModels";
import type {
  TiAngleAperture,
  TiAngleCameraModel,
  TiAngleCameraParameters,
  TiAngleConfig,
  TiAngleFocalLengthMm,
  TiAngleIso,
  TiAngleNodeData,
  TiAngleShutterSpeed,
} from "@/types/workflow";
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

const UNSPECIFIED_CAMERA_PARAMETER = "__unspecified__";

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

function TiAngleSection({
  id,
  title,
  summary,
  open,
  onOpenChange,
  children,
}: {
  id: string;
  title: string;
  summary: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="rounded-md border border-[var(--gc-node-border)] bg-[var(--gc-node-inner)]"
    >
      <CollapsibleTrigger
        aria-expanded={open}
        aria-controls={id}
        className="nodrag flex min-h-10 w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--gc-panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gc-focus)]"
      >
        <span className="min-w-0">
          <span className="block text-[10px] font-medium text-[var(--gc-node-text)]">{title}</span>
          <span className="block truncate text-[9px] text-[var(--gc-node-muted)]">{summary}</span>
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className={`size-3 shrink-0 text-[var(--gc-node-muted)] transition-transform ${open ? "rotate-180" : ""}`}
        />
      </CollapsibleTrigger>
      <CollapsibleContent id={id} className="border-t border-[var(--gc-node-border)] px-2 py-2">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function CameraParameterSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled: boolean;
  onChange: (value: string | undefined) => void;
}) {
  const selectedLabel = value === undefined
    ? "不指定"
    : options.find((option) => option.value === value)?.label ?? value;

  return (
    <label className="block min-w-0 space-y-1">
      <span className="block text-[9px] text-[var(--gc-node-muted)]">{label}</span>
      <Select
        value={value ?? UNSPECIFIED_CAMERA_PARAMETER}
        disabled={disabled}
        onValueChange={(next) => onChange(!next || next === UNSPECIFIED_CAMERA_PARAMETER ? undefined : next)}
      >
        <SelectTrigger
          size="sm"
          aria-label={label}
          className="nodrag nopan w-full min-w-0 border-[var(--gc-node-border)] bg-[var(--gc-node-main)] px-2 text-[9px] text-[var(--gc-node-text)]"
        >
          <SelectValue>{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent
          align="start"
          className="border border-[var(--gc-border)] bg-[var(--gc-panel)] text-[var(--gc-text)]"
        >
          <SelectItem value={UNSPECIFIED_CAMERA_PARAMETER} className="min-h-7 text-[10px]">不指定</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} className="min-h-7 text-[10px]">
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

export function TiAngelNode({ id, data, selected }: NodeProps<Node<TiAngleNodeData>>) {
  const updateNodeData = useFlowStore((state) => state.updateNodeData);
  const previewImage = useFlowStore((state) => selectActiveNodeInputImages(state, id)[0]);
  const edges = useFlowStore(selectActiveEdges);
  const nodes = useFlowStore(selectActiveNodes);
  const readOnly = useFlowStore(selectActiveReadOnly);
  const [angleOpen, setAngleOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);
  const controlsDisabled = readOnly || !data.angle.enabled;

  const updateAngle = (patch: Partial<TiAngleConfig>) => {
    if (readOnly) return;
    updateNodeData(id, {
      angle: normalizeTiAngleConfig({ ...data.angle, ...patch }),
    });
  };

  const updateCamera = (patch: Partial<TiAngleCameraParameters>) => {
    const next: TiAngleCameraParameters = { ...(data.angle.camera ?? {}), ...patch };
    if (next.cameraModel === undefined) delete next.cameraModel;
    if (next.focalLengthMm === undefined) delete next.focalLengthMm;
    if (next.iso === undefined) delete next.iso;
    if (next.shutterSpeed === undefined) delete next.shutterSpeed;
    if (next.aperture === undefined) delete next.aperture;
    updateAngle({ camera: Object.keys(next).length > 0 ? next : undefined });
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
        : "已关闭，不会输出视角与相机约束。",
    }));
  }, [data.angle, edges, id, nodes]);

  const angleSectionId = `${id}-angle-constraints`;
  const cameraSectionId = `${id}-camera-parameters`;
  const outputId = `${id}-angle-output`;
  const angleSummary = data.angle.enabled
    ? `${signedAngle(data.angle.azimuthDeg)} · ${signedAngle(data.angle.elevationDeg)} · ${signedAngle(data.angle.rollDeg)}`
    : "已关闭";
  const cameraSummary = describeTiAngleCameraParameters(data.angle.camera) || "未设置";

  return (
    <>
      <Handle id="preview-image" type="target" position={Position.Left} title="示意参考图（仅显示）" />
      <NodeFrame
        nodeId={id}
        title={data.label}
        status={data.status}
        error={data.error}
        selected={selected}
        summary={<p className="text-[9px] leading-snug text-[var(--gc-node-muted)]">控制最终观察视角与成像参数，不改变人物与服装输入</p>}
      >
        <TiAnglePreview
          image={previewImage}
          config={data.angle}
          disabled={controlsDisabled}
          onCommit={(next) => {
            if (!readOnly) updateNodeData(id, { angle: normalizeTiAngleConfig(next) });
          }}
        />
        <TiAngleSection
          id={angleSectionId}
          title="输出视角约束"
          summary={angleSummary}
          open={angleOpen}
          onOpenChange={setAngleOpen}
        >
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[9px] leading-snug text-[var(--gc-node-muted)]">连接第一轮场景定版后适配目标模型</p>
              <Switch
                checked={data.angle.enabled}
                onCheckedChange={(enabled) => updateAngle({ enabled })}
                disabled={readOnly}
                aria-label="启用 3D 视角"
                className="nodrag shrink-0"
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
                {ANGLE_PRESETS.map((preset) => {
                  const active = data.angle.azimuthDeg === preset.azimuthDeg && data.angle.elevationDeg === 0 && data.angle.rollDeg === 0;
                  return (
                    <Button
                      key={preset.label}
                      type="button"
                      variant="outline"
                      size="xs"
                      aria-pressed={active}
                      disabled={controlsDisabled}
                      onClick={() => updateAngle({ azimuthDeg: preset.azimuthDeg, elevationDeg: 0, rollDeg: 0 })}
                      className={active
                        ? "nodrag h-6 border-[#b98d45] bg-[#b98d45] px-1 text-[9px] text-[#181818] hover:border-[#c99a4d] hover:bg-[#c99a4d] hover:text-[#181818] focus-visible:ring-[#b98d45]"
                        : "nodrag h-6 border-[#b98d45] bg-[#181818] px-1 text-[9px] text-[#b98d45] hover:border-[#c99a4d] hover:bg-[#24211d] hover:text-[#c99a4d] focus-visible:ring-[#b98d45]"}
                    >
                      {preset.label}
                    </Button>
                  );
                })}
              </div>
            </div>
            <AngleControl label="环绕角" value={data.angle.azimuthDeg} min={-180} max={180} disabled={controlsDisabled} onChange={(azimuthDeg) => updateAngle({ azimuthDeg })} />
            <AngleControl label="俯仰角" value={data.angle.elevationDeg} min={-45} max={60} disabled={controlsDisabled} onChange={(elevationDeg) => updateAngle({ elevationDeg })} />
            <AngleControl label="画面倾斜" value={data.angle.rollDeg} min={-30} max={30} disabled={controlsDisabled} onChange={(rollDeg) => updateAngle({ rollDeg })} />
          </div>
        </TiAngleSection>
        <TiAngleSection
          id={cameraSectionId}
          title="相机参数"
          summary={cameraSummary}
          open={cameraOpen}
          onOpenChange={setCameraOpen}
        >
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-1.5">
              <div className="col-span-2">
                <CameraParameterSelect
                  label="品牌相机"
                  value={data.angle.camera?.cameraModel}
                  options={TI_ANGLE_CAMERA_MODELS}
                  disabled={controlsDisabled}
                  onChange={(cameraModel) => updateCamera({ cameraModel: cameraModel as TiAngleCameraModel | undefined })}
                />
              </div>
              <CameraParameterSelect
                label="焦距"
                value={data.angle.camera?.focalLengthMm?.toString()}
                options={TI_ANGLE_FOCAL_LENGTHS.map((value) => ({ value: String(value), label: `${value} mm` }))}
                disabled={controlsDisabled}
                onChange={(value) => updateCamera({ focalLengthMm: value ? Number(value) as TiAngleFocalLengthMm : undefined })}
              />
              <CameraParameterSelect
                label="ISO"
                value={data.angle.camera?.iso?.toString()}
                options={TI_ANGLE_ISO_VALUES.map((value) => ({ value: String(value), label: `ISO ${value}` }))}
                disabled={controlsDisabled}
                onChange={(value) => updateCamera({ iso: value ? Number(value) as TiAngleIso : undefined })}
              />
              <CameraParameterSelect
                label="快门速度"
                value={data.angle.camera?.shutterSpeed}
                options={TI_ANGLE_SHUTTER_SPEEDS.map((value) => ({ value, label: `${value} s` }))}
                disabled={controlsDisabled}
                onChange={(shutterSpeed) => updateCamera({ shutterSpeed: shutterSpeed as TiAngleShutterSpeed | undefined })}
              />
              <CameraParameterSelect
                label="光圈大小"
                value={data.angle.camera?.aperture}
                options={TI_ANGLE_APERTURES.map((value) => ({ value, label: value }))}
                disabled={controlsDisabled}
                onChange={(aperture) => updateCamera({ aperture: aperture as TiAngleAperture | undefined })}
              />
            </div>
            <p className="text-[9px] leading-snug text-[var(--gc-node-muted)]">用于控制镜头透视、景深、运动与曝光表现</p>
          </div>
        </TiAngleSection>
        <TiAngleSection
          id={outputId}
          title="查看输出文本"
          summary="按下游模型适配，点击展开查看"
          open={outputOpen}
          onOpenChange={setOutputOpen}
        >
          <div className="space-y-2">
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
                  复制约束文本
                </Button>
              </section>
            ))}
          </div>
        </TiAngleSection>
      </NodeFrame>
      <Handle id="text" type="source" position={Position.Right} title="视角与相机文本" />
    </>
  );
}

import { useFlowStore } from "@/store/flowStore";
import { inputClass } from "./NodeFrame";
import { GptQualityControls } from "./GptQualityControls";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DEFAULT_GENERATION_MODEL_ID,
  GENERATION_IMAGE_MODEL_IDS,
  defaultImageModelOptions,
  getImageModelContract,
  imageModelLabel,
  normalizeImageModelOptions,
  type GenerationImageModelId,
  type ImageModelOptions,
} from "@/types/imageModels";

interface ModelControlsProps {
  nodeId: string;
  modelId?: GenerationImageModelId;
  modelOptions?: ImageModelOptions;
  preferredAspectRatio?: string;
  disabled?: boolean;
}

export function ModelControls({
  nodeId,
  modelId = DEFAULT_GENERATION_MODEL_ID,
  modelOptions,
  preferredAspectRatio = "1:1",
  disabled = false,
}: ModelControlsProps) {
  const updateNodeData = useFlowStore((state) => state.updateNodeData);
  const options = normalizeImageModelOptions(modelId, modelOptions, preferredAspectRatio);
  const updateOptions = (patch: Partial<ImageModelOptions>) => {
    updateNodeData(nodeId, { modelOptions: { ...options, ...patch }, error: undefined });
  };

  return (
    <div className="space-y-2 border-t border-[#262626] pt-2">
      <label className="block space-y-1">
        <span className="text-[10px] text-neutral-500">图片模型</span>
        <Select
          value={modelId}
          disabled={disabled}
          onValueChange={(value) => {
            if (!value) return;
            const next = value as GenerationImageModelId;
            updateNodeData(nodeId, {
              modelId: next,
              modelOptions: defaultImageModelOptions(next, preferredAspectRatio),
              error: undefined,
            });
          }}
        >
          <SelectTrigger aria-label="图片模型" className="nodrag nopan w-full text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
          {GENERATION_IMAGE_MODEL_IDS.map((id) => (
            <SelectItem key={id} value={id}>{imageModelLabel(id)}</SelectItem>
          ))}
          </SelectContent>
        </Select>
      </label>

      {modelId === "gpt-image-2-vip" && (
        <SelectOption
          label="输出尺寸"
          value={options.size ?? "auto"}
          values={getImageModelContract(modelId).sizes ?? []}
          disabled={disabled}
          onChange={(value) => updateOptions({ size: value })}
        />
      )}
      {modelId.startsWith("gpt-image-2.5-") && <>
        <SelectOption label="输出尺寸" value={options.size ?? "2048x2048"}
          values={["1024x1024", "1536x1024", "1024x1536", "2048x2048", "2048x1152", "1152x2048", "3840x2160", "2160x3840", ...(options.size ? [options.size] : [])].filter((v, i, a) => a.indexOf(v) === i)}
          disabled={disabled} onChange={(size) => updateOptions({ size })} />
        <GptQualityControls nodeId={nodeId} modelId={modelId} modelOptions={options} disabled={disabled} />
      </>}

      {modelId === "gemini-3.1-flash-image" && (
        <div className="grid grid-cols-2 gap-2">
          <SelectOption
            label="原生比例"
            value={options.aspectRatio ?? "1:1"}
            values={getImageModelContract(modelId).aspectRatios ?? []}
            disabled={disabled}
            onChange={(value) => updateOptions({ aspectRatio: value })}
          />
          <SelectOption
            label="原生尺寸"
            value={options.imageSize ?? "2K"}
            values={getImageModelContract(modelId).imageSizes ?? []}
            disabled={disabled}
            onChange={(value) => updateOptions({ imageSize: value })}
          />
        </div>
      )}

      {modelId === "flux-2-pro" && (
        <div className="grid grid-cols-2 gap-2">
          <NumberOption
            label="宽度" value={options.width ?? 2048} disabled={disabled}
            onChange={(value) => updateOptions({ width: value })}
          />
          <NumberOption
            label="高度" value={options.height ?? 2048} disabled={disabled}
            onChange={(value) => updateOptions({ height: value })}
          />
          <div className="col-span-2">
            <SelectOption
              label="输出格式"
              value={options.outputFormat ?? "png"}
              values={getImageModelContract(modelId).outputFormats ?? []}
              disabled={disabled}
              onChange={(value) => updateOptions({ outputFormat: value as "jpeg" | "png" })}
            />
          </div>
        </div>
      )}

      {modelId === "seedream-5-0-260128" && (
        <SelectOption
          label="原生尺寸"
          value={options.size ?? "2K"}
          values={getImageModelContract(modelId).sizes ?? []}
          disabled={disabled}
          onChange={(value) => updateOptions({ size: value })}
        />
      )}

      {modelId === "grok-imagine-image" && (
        <div className="grid grid-cols-2 gap-2">
          <SelectOption
            label="原生比例"
            value={options.aspectRatio ?? "1:1"}
            values={getImageModelContract(modelId).aspectRatios ?? []}
            disabled={disabled}
            onChange={(value) => updateOptions({ aspectRatio: value })}
          />
          <SelectOption
            label="分辨率"
            value={options.resolution ?? "2k"}
            values={getImageModelContract(modelId).resolutions ?? []}
            disabled={disabled}
            onChange={(value) => updateOptions({ resolution: value })}
          />
        </div>
      )}
    </div>
  );
}

function SelectOption({
  label, value, values, disabled, onChange,
}: {
  label: string; value: string; values: string[]; disabled: boolean; onChange: (value: string) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] text-neutral-500">{label}</span>
      <Select value={value} disabled={disabled} onValueChange={(next) => { if (next) onChange(next); }}>
        <SelectTrigger aria-label={label} className="nodrag nopan w-full text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>{values.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
      </Select>
    </label>
  );
}

function NumberOption({
  label, value, disabled, onChange,
}: {
  label: string; value: number; disabled: boolean; onChange: (value: number) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] text-neutral-500">{label}</span>
      <input
        type="number" min={64} step={16} value={value} disabled={disabled}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isInteger(next) && next >= 64 && next % 16 === 0) onChange(next);
        }}
        className={inputClass}
      />
    </label>
  );
}

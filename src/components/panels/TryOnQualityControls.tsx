import { useCallback, useEffect, useId, useState } from "react";
import { SaveIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { BUILT_IN_TRY_ON_STYLE_PRESETS, type TryOnQualityMode } from "@/lib/tryOnStylePresets";
import { thumbnailImageUrl } from "@/lib/images";
import { selectActiveDocumentTarget, useFlowStore } from "@/store/flowStore";
import type { Asset, VirtualTryOnNodeData } from "@/types/workflow";

interface StylePreset {
  id: string;
  name: string;
  description: string;
  prompt: string;
  referenceImage?: string;
  thumbnail?: string;
  builtIn: boolean;
}

const initialPresets: StylePreset[] = BUILT_IN_TRY_ON_STYLE_PRESETS.map((preset) => ({
  ...preset,
  referenceImage: preset.referenceAsset,
  builtIn: true,
}));

const qualityModes: Array<{ id: TryOnQualityMode; label: string; detail: string }> = [
  { id: "fast", label: "快速", detail: "每阶段 1 张" },
  { id: "balanced", label: "均衡", detail: "每阶段 2 张择优" },
  { id: "best", label: "最佳", detail: "第一阶段 3 张，第二阶段 2 张择优" },
];

export function TryOnQualityControls({
  nodeId,
  data,
  disabled,
  onChange,
}: {
  nodeId: string;
  data: VirtualTryOnNodeData;
  disabled: boolean;
  onChange: (patch: Partial<VirtualTryOnNodeData>) => void;
}) {
  const updateNodeDataInTab = useFlowStore((state) => state.updateNodeDataInTab);
  const [presets, setPresets] = useState(initialPresets);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState(data.stylePrompt ?? "");
  const [referenceImage, setReferenceImage] = useState(data.styleReferenceImage ?? "none");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const styleLabelId = useId();
  const referenceLabelId = useId();

  const loadPresets = useCallback(async () => {
    try {
      const response = await fetch("/api/try-on-style-presets", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as StylePreset[];
      if (Array.isArray(body)) setPresets(body);
    } catch {
      setPresets(initialPresets);
    }
  }, []);

  useEffect(() => { void loadPresets(); }, [loadPresets]);

  const openSaveDialog = async () => {
    setName("");
    setPrompt(data.stylePrompt ?? presets.find((preset) => preset.id === data.stylePresetId)?.prompt ?? "");
    setReferenceImage(data.styleReferenceImage ?? "none");
    setError(null);
    setDialogOpen(true);
    try {
      const response = await fetch("/api/assets?category=reference&limit=100", { cache: "no-store" });
      if (response.ok) setAssets(await response.json() as Asset[]);
    } catch {
      setAssets([]);
    }
  };

  const selectPreset = (id: string | null) => {
    if (!id) return;
    const preset = presets.find((candidate) => candidate.id === id);
    if (!preset) return;
    onChange({
      stylePresetId: preset.id,
      stylePresetName: preset.name,
      stylePrompt: preset.prompt,
      styleReferenceImage: preset.builtIn ? undefined : preset.referenceImage,
      error: undefined,
    });
  };

  const savePreset = async () => {
    const target = selectActiveDocumentTarget(useFlowStore.getState());
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/try-on-style-presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          prompt: prompt.trim(),
          ...(referenceImage !== "none" ? { referenceImage } : {}),
        }),
      });
      const body = await response.json() as { id?: string; error?: string };
      if (!response.ok || !body.id) throw new Error(body.error ?? `HTTP ${response.status}`);
      await loadPresets();
      updateNodeDataInTab(target, nodeId, {
        stylePresetId: body.id,
        stylePresetName: name.trim(),
        stylePrompt: prompt.trim(),
        styleReferenceImage: referenceImage === "none" ? undefined : referenceImage,
        error: undefined,
      });
      setDialogOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const selectedPreset = presets.find((preset) => preset.id === data.stylePresetId);
  const selectedReferenceName = referenceImage === "none"
    ? "不使用参考图"
    : assets.find((asset) => asset.image === referenceImage)?.name ?? "已选参考图";

  return (
    <section className="space-y-3 border-t border-[var(--gc-border)] pt-3">
      {data.workflowStage === "scene-stabilize" && (
        <div className="space-y-1">
          <span id={styleLabelId} className="text-[10px] text-[var(--gc-text-muted)]">风格预设</span>
          <div className="flex gap-1.5">
            <Select value={data.stylePresetId} onValueChange={selectPreset} disabled={disabled}>
              <SelectTrigger aria-labelledby={styleLabelId} className="h-8 min-w-0 flex-1 border-[var(--gc-border)] bg-[var(--gc-control)] text-xs text-[var(--gc-text)]">
                <SelectValue>{selectedPreset?.name ?? "选择风格"}</SelectValue>
              </SelectTrigger>
              <SelectContent align="start" className="border border-[var(--gc-border)] bg-[var(--gc-panel)] text-[var(--gc-text)] ring-0">
                {presets.map((preset) => (
                  <SelectItem key={preset.id} value={preset.id} className="min-h-8 text-xs">{preset.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="button" variant="outline" size="icon-sm" aria-label="保存为我的风格预设" disabled={disabled} onClick={() => void openSaveDialog()}>
              <SaveIcon aria-hidden="true" />
            </Button>
            {selectedPreset && !selectedPreset.builtIn && (
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="删除当前风格预设"
                disabled={disabled}
                onClick={async () => {
                  const target = selectActiveDocumentTarget(useFlowStore.getState());
                  const response = await fetch(`/api/try-on-style-presets/${encodeURIComponent(selectedPreset.id)}`, { method: "DELETE" });
                  if (response.ok) {
                    await loadPresets();
                    const faithful = initialPresets.find((preset) => preset.id === "faithful")!;
                    updateNodeDataInTab(target, nodeId, {
                      stylePresetId: faithful.id,
                      stylePresetName: faithful.name,
                      stylePrompt: faithful.prompt,
                      styleReferenceImage: undefined,
                      error: undefined,
                    });
                  }
                }}
              >
                <Trash2Icon aria-hidden="true" />
              </Button>
            )}
          </div>
          <p className="text-[10px] leading-4 text-[var(--gc-text-muted)]">{selectedPreset?.description}</p>
        </div>
      )}

      <fieldset className="space-y-1">
        <legend className="text-[10px] text-[var(--gc-text-muted)]">采样档位</legend>
        <div className="grid grid-cols-3 gap-1">
          {qualityModes.map((mode) => (
            <Button
              key={mode.id}
              type="button"
              size="sm"
              variant={data.qualityMode === mode.id ? "default" : "outline"}
              aria-pressed={data.qualityMode === mode.id}
              title={mode.detail}
              disabled={disabled}
              onClick={() => onChange({ qualityMode: mode.id, error: undefined })}
              className="h-8 px-1 text-[10px]"
            >
              {mode.label}
            </Button>
          ))}
        </div>
      </fieldset>

      <label className="flex items-center justify-between gap-3 text-[10px] text-[var(--gc-text)]">
        <span>提示词增强</span>
        <Switch checked={data.promptEnhancement} disabled={disabled} onCheckedChange={(checked) => onChange({ promptEnhancement: checked, error: undefined })} aria-label="提示词增强" />
      </label>
      <label className="flex items-center justify-between gap-3 text-[10px] text-[var(--gc-text)]">
        <span>审核失败安全降级一次</span>
        <Switch checked={data.safetyFallback} disabled={disabled} onCheckedChange={(checked) => onChange({ safetyFallback: checked, error: undefined })} aria-label="审核失败安全降级一次" />
      </label>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent showCloseButton={false} className="w-[min(520px,calc(100vw-3rem))] max-w-none rounded-lg border border-[var(--gc-border)] bg-[var(--gc-panel)] p-0 text-[var(--gc-text)] ring-0">
          <header className="border-b border-[var(--gc-border)] px-4 py-3">
            <DialogTitle className="text-sm font-medium">保存风格预设</DialogTitle>
            <DialogDescription className="mt-1 text-[10px] text-[var(--gc-text-muted)]">风格只控制光线、镜头、色调与媒介，不覆盖人物和商品。</DialogDescription>
          </header>
          <div className="space-y-3 p-4">
            <label className="block space-y-1 text-[10px] text-[var(--gc-text-muted)]">名称
              <Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} className="h-8 border-[var(--gc-border)] bg-[var(--gc-control)] text-xs text-[var(--gc-text)]" />
            </label>
            <label className="block space-y-1 text-[10px] text-[var(--gc-text-muted)]">提示词片段
              <Textarea value={prompt} maxLength={2000} rows={5} onChange={(event) => setPrompt(event.target.value)} className="resize-none border-[var(--gc-border)] bg-[var(--gc-control)] text-xs leading-5 text-[var(--gc-text)]" />
            </label>
            <div className="space-y-1">
              <span id={referenceLabelId} className="text-[10px] text-[var(--gc-text-muted)]">固定参考图（可选）</span>
              <Select value={referenceImage} onValueChange={(value) => value && setReferenceImage(value)}>
                <SelectTrigger aria-labelledby={referenceLabelId} className="h-8 w-full border-[var(--gc-border)] bg-[var(--gc-control)] text-xs text-[var(--gc-text)]"><SelectValue>{selectedReferenceName}</SelectValue></SelectTrigger>
                <SelectContent align="start" className="border border-[var(--gc-border)] bg-[var(--gc-panel)] text-[var(--gc-text)] ring-0">
                  <SelectItem value="none">不使用参考图</SelectItem>
                  {assets.map((asset) => <SelectItem key={asset.id} value={asset.image}>{asset.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {referenceImage !== "none" && <img src={thumbnailImageUrl(referenceImage)} alt="风格参考预览" className="mt-2 aspect-[3/2] w-full rounded-md border border-[var(--gc-border)] object-cover" />}
            </div>
            {error && <p role="alert" className="text-[10px] text-red-400">{error}</p>}
          </div>
          <footer className="flex justify-end gap-2 border-t border-[var(--gc-border)] px-4 py-3">
            <DialogClose render={<Button type="button" variant="outline" size="sm" disabled={saving} />}>取消</DialogClose>
            <Button type="button" size="sm" disabled={saving || !name.trim() || !prompt.trim()} onClick={() => void savePreset()}>{saving ? "保存中" : "保存"}</Button>
          </footer>
        </DialogContent>
      </Dialog>
    </section>
  );
}

import { useEffect, useMemo, useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { MaterialAnalysisModel } from "@/types/materialAnalysis";

type EditableModel = Omit<MaterialAnalysisModel, "revision">;

export interface MaterialModelEditorState {
  dirty: boolean;
  busy: boolean;
  outcomeUnknown: boolean;
}
async function loadModels() {
  const response = await fetch("/api/material-analyses/models", {
    credentials: "same-origin",
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    revision?: number;
    models?: MaterialAnalysisModel[];
  };
  if (
    !response.ok ||
    !Array.isArray(body.models) ||
    typeof body.revision !== "number"
  ) {
    throw new Error(
      typeof body.error === "string" ? body.error : "无法读取材质分析模型",
    );
  }
  return { revision: body.revision, models: body.models };
}

export function MaterialModelSettings({
  onStateChange,
}: {
  onStateChange?: (state: MaterialModelEditorState) => void;
} = {}) {
  const [revision, setRevision] = useState(0);
  const [models, setModels] = useState<EditableModel[]>([]);
  const [savedSignature, setSavedSignature] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const signature = JSON.stringify(models);
  const dirty = signature !== savedSignature;

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await loadModels();
      const editable = data.models.map(
        ({ revision: _revision, ...model }) => model,
      );
      setRevision(data.revision);
      setModels(editable);
      setSavedSignature(JSON.stringify(editable));
      setOutcomeUnknown(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    onStateChange?.({ dirty, busy, outcomeUnknown });
  }, [busy, dirty, outcomeUnknown, onStateChange]);
  useEffect(
    () => () =>
      onStateChange?.({ dirty: false, busy: false, outcomeUnknown: false }),
    [onStateChange],
  );

  const locked = busy || outcomeUnknown;
  const defaultId = models.find((model) => model.isDefault)?.id ?? "";
  const valid = useMemo(
    () =>
      models.length > 0 &&
      models.length <= 16 &&
      models.every(
        (model) =>
          /^[A-Za-z0-9._-]{1,120}$/.test(model.id) &&
          model.label.trim() &&
          model.label.length <= 120,
      ) &&
      models.filter((model) => model.enabled && model.isDefault).length === 1,
    [models],
  );

  const save = async () => {
    if (!dirty || !valid || busy || outcomeUnknown) return;
    setBusy(true);
    setError(null);
    let mayHaveSucceeded = true;
    try {
      const response = await fetch("/api/material-analyses/models", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: revision, models }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: unknown;
        revision?: number;
        models?: MaterialAnalysisModel[];
      };
      if (
        !response.ok ||
        !Array.isArray(body.models) ||
        typeof body.revision !== "number"
      ) {
        if (!response.ok && response.status < 500) mayHaveSucceeded = false;
        throw new Error(
          typeof body.error === "string"
            ? body.error
            : `HTTP ${response.status}`,
        );
      }
      const editable = body.models.map(
        ({ revision: _revision, ...model }) => model,
      );
      setRevision(body.revision);
      setModels(editable);
      setSavedSignature(JSON.stringify(editable));
      setOutcomeUnknown(false);
    } catch (failure) {
      if (mayHaveSucceeded) setOutcomeUnknown(true);
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="space-y-3 rounded-md border border-(--gc-border) p-3"
      aria-label="材质分析模型配置"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">材质分析模型</h3>
          <p className="text-xs text-(--gc-text-muted)">
            仅已启用模型会出现在上传分析流程；网关密钥不会返回浏览器。
          </p>
        </div>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={locked || models.length >= 16}
          onClick={() =>
            setModels((current) => [
              ...current,
              {
                id: "",
                label: "",
                protocol: "gemini-generate-content",
                enabled: true,
                isDefault: false,
              },
            ])
          }
        >
          <PlusIcon aria-hidden="true" className="size-3" />
          添加
        </Button>
      </div>
      <div className="space-y-2">
        {models.map((model, index) => (
          <div
            key={`${index}-${model.id}`}
            className="grid grid-cols-[minmax(10rem,1fr)_minmax(10rem,1fr)_auto_auto] items-center gap-2"
          >
            <Input
              aria-label={`模型 ID ${index + 1}`}
              value={model.id}
              disabled={locked}
              onChange={(event) =>
                setModels((current) =>
                  current.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, id: event.target.value }
                      : item,
                  ),
                )
              }
            />
            <Input
              aria-label={`模型名称 ${index + 1}`}
              value={model.label}
              disabled={locked}
              onChange={(event) =>
                setModels((current) =>
                  current.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, label: event.target.value }
                      : item,
                  ),
                )
              }
            />
            <label className="flex items-center gap-1 text-xs">
              启用
              <Switch
                aria-label={`启用 ${model.label || index + 1}`}
                checked={model.enabled}
                disabled={locked || model.isDefault}
                onCheckedChange={(checked) =>
                  setModels((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, enabled: checked }
                        : item,
                    ),
                  )
                }
              />
            </label>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={`删除模型 ${model.label || index + 1}`}
              disabled={locked || models.length === 1 || model.isDefault}
              onClick={() =>
                setModels((current) =>
                  current.filter((_, itemIndex) => itemIndex !== index),
                )
              }
            >
              <Trash2Icon aria-hidden="true" className="size-3" />
            </Button>
          </div>
        ))}
      </div>
      <div className="flex items-end justify-between gap-3">
        <label className="min-w-64 text-xs">
          默认模型
          <Select
            value={defaultId}
            disabled={locked}
            onValueChange={(id) =>
              setModels((current) =>
                current.map((model) => ({
                  ...model,
                  isDefault: model.id === id,
                  enabled: model.id === id ? true : model.enabled,
                })),
              )
            }
          >
            <SelectTrigger aria-label="默认材质分析模型">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[90]">
              {models
                .filter((model) => model.id)
                .map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.label || model.id}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </label>
        <div className="flex gap-2">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => void refresh()}
          >
            刷新
          </Button>
          <Button
            type="button"
            size="xs"
            disabled={!dirty || !valid || locked}
            onClick={() => void save()}
          >
            {busy ? "保存中…" : "保存模型配置"}
          </Button>
        </div>
      </div>
      {dirty && (
        <p role="status" className="text-xs text-amber-600">
          模型配置尚未保存。
        </p>
      )}
      {outcomeUnknown && (
        <p role="alert" className="text-xs text-amber-600">
          模型配置保存结果可能未知。请刷新核对服务端配置后再编辑或关闭。
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

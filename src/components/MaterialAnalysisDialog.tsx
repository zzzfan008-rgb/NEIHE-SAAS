import { useEffect, useMemo, useRef, useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Input } from "@/components/ui/input";
import { boundImageCrop, RectangleCropSurface } from "@/components/RectangleCropSurface";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  MaterialAnalysisCalibration,
  MaterialAnalysisModel,
  MaterialAnalysisRecord,
  MaterialCropRect,
} from "@/types/materialAnalysis";

const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
const INITIAL_CROP: MaterialCropRect = {
  x: 0.1,
  y: 0.1,
  width: 0.8,
  height: 0.8,
};

class MaterialRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MaterialRequestError";
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (!response.ok)
    throw new MaterialRequestError(
      response.status,
      typeof body.error === "string" ? body.error : `HTTP ${response.status}`,
    );
  return body as T;
}

function normalizeCrop(
  crop: MaterialCropRect,
  field: keyof MaterialCropRect,
  value: number,
  minWidth: number,
  minHeight: number,
) {
  return boundImageCrop({ ...crop, [field]: value }, minWidth, minHeight);
}

export function MaterialAnalysisDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [imageData, setImageData] = useState<string | null>(null);
  const [crop, setCrop] = useState(INITIAL_CROP);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [record, setRecord] = useState<MaterialAnalysisRecord | null>(null);
  const [recordCrop, setRecordCrop] = useState<string | null>(null);
  const [models, setModels] = useState<MaterialAnalysisModel[]>([]);
  const [modelId, setModelId] = useState("");
  const [calibration, setCalibration] = useState<MaterialAnalysisCalibration>({
    name: "",
    materialDescription: "",
    colors: [],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDiscard, setPendingDiscard] = useState<
    { kind: "close" } | { kind: "file"; file: File } | null
  >(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const calibrationDirtyRef = useRef(false);
  const seededSuggestionRef = useRef<string | null>(null);
  const [retryUnknownOpen, setRetryUnknownOpen] = useState(false);
  const [unknownOperation, setUnknownOperation] = useState<
    "analysis" | "save" | null
  >(null);
  const cropSignature = JSON.stringify(crop);
  const cropChanged = Boolean(record && recordCrop !== cropSignature);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void requestJson<{ models: MaterialAnalysisModel[] }>(
      "/api/material-analyses/models",
    )
      .then((value) => {
        if (!active) return;
        setModels(value.models);
        setModelId(
          value.models.find((model) => model.isDefault)?.id ??
            value.models[0]?.id ??
            "",
        );
      })
      .catch((failure) => {
        if (active)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      });
    return () => {
      active = false;
    };
  }, [open]);

  useEffect(() => {
    if (!record?.suggestion) return;
    const suggestionKey = `${record.id}:${record.revision}`;
    if (seededSuggestionRef.current === suggestionKey) return;
    seededSuggestionRef.current = suggestionKey;
    if (calibrationDirtyRef.current) return;
    setCalibration((current) => ({
      name: current.name,
      materialDescription: record.suggestion?.materialDescription || "无法确定",
      colors: record.suggestion?.colors.map((color) => ({ ...color })) ?? [],
    }));
  }, [record?.id, record?.revision, record?.suggestion]);

  const reset = () => {
    calibrationDirtyRef.current = false;
    seededSuggestionRef.current = null;
    setRetryUnknownOpen(false);
    setUnknownOperation(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setImageData(null);
    setCrop(INITIAL_CROP);
    setImageSize({ width: 0, height: 0 });
    setRecord(null);
    setRecordCrop(null);
    setCalibration({ name: "", materialDescription: "", colors: [] });
    setError(null);
    setBusy(false);
    setPendingDiscard(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const loadFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      if (preview) URL.revokeObjectURL(preview);
      setPreview(URL.createObjectURL(file));
      setImageData(reader.result);
      setRecord(null);
      setRecordCrop(null);
      setCalibration({
        name: file.name.replace(/\.[^.]+$/, ""),
        materialDescription: "",
        colors: [],
      });
    };
    reader.onerror = () => setError("无法读取图片");
    reader.readAsDataURL(file);
  };

  const hasUnsavedDraft = Boolean(imageData && record?.status !== "saved");
  const chooseFile = (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (!file.type.startsWith("image/") || file.size > MAX_IMAGE_BYTES) {
      setError("请选择不超过 7 MiB 的 PNG、JPEG、WebP 或 GIF 图片");
      return;
    }
    if (hasUnsavedDraft) {
      setPendingDiscard({ kind: "file", file });
      return;
    }
    reset();
    loadFile(file);
  };

  const deleteDraft = async () => {
    if (!record || record.status === "saved") return;
    const response = await fetch(
      `/api/material-analyses/${encodeURIComponent(record.id)}`,
      {
        method: "DELETE",
        credentials: "same-origin",
      },
    );
    if (!response.ok && response.status !== 404) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: unknown;
      };
      throw new Error(
        typeof body.error === "string" ? body.error : `HTTP ${response.status}`,
      );
    }
  };

  const discardDraft = async () => {
    if (!pendingDiscard || busy) return;
    const action = pendingDiscard;
    setBusy(true);
    setError(null);
    try {
      await deleteDraft();
      reset();
      if (action.kind === "close") onOpenChange(false);
      else loadFile(action.file);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
      setPendingDiscard(null);
    }
  };

  const refreshRecord = async () => {
    if (!record) return;
    setBusy(true);
    setError(null);
    try {
      const refreshed = await requestJson<MaterialAnalysisRecord>(
        `/api/material-analyses/${encodeURIComponent(record.id)}`,
      );
      setRecord(refreshed);
      setUnknownOperation(
        refreshed.status === "outcome_unknown" ? "analysis" : null,
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const analyze = async () => {
    if (
      !imageData ||
      !modelId ||
      busy ||
      record?.status === "analyzing" ||
      record?.status === "outcome_unknown"
    )
      return;
    setBusy(true);
    setError(null);
    setUnknownOperation(null);
    let submittedDraft: MaterialAnalysisRecord | null = null;
    let analysisRequested = false;
    try {
      await deleteDraft();
      const draft = await requestJson<MaterialAnalysisRecord>(
        "/api/material-analyses",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: imageData, crop }),
        },
      );
      submittedDraft = draft;
      setRecord(draft);
      setRecordCrop(cropSignature);
      analysisRequested = true;
      const analyzed = await requestJson<MaterialAnalysisRecord>(
        `/api/material-analyses/${encodeURIComponent(draft.id)}/analyze`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision: draft.revision, modelId }),
        },
      );
      setRecord(analyzed);
    } catch (failure) {
      if (submittedDraft && analysisRequested) {
        setRecord({
          ...submittedDraft,
          status: "outcome_unknown",
          error: "分析请求结果未知，请刷新记录确认",
        });
        setUnknownOperation("analysis");
      }
      setError(
        `${failure instanceof Error ? failure.message : String(failure)}。若请求中断，分析结果可能未知，请刷新记录确认。`,
      );
    } finally {
      setBusy(false);
    }
  };
  const retryUnknownAnalysis = async () => {
    if (
      !record ||
      record.status !== "outcome_unknown" ||
      unknownOperation === "save" ||
      !modelId ||
      busy
    )
      return;
    setRetryUnknownOpen(false);
    setBusy(true);
    setError(null);
    try {
      const analyzed = await requestJson<MaterialAnalysisRecord>(
        `/api/material-analyses/${encodeURIComponent(record.id)}/analyze`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision: record.revision, modelId }),
        },
      );
      setRecord(analyzed);
      setUnknownOperation(null);
    } catch (failure) {
      setError(
        `${failure instanceof Error ? failure.message : String(failure)}。重试请求结果仍可能未知，请刷新记录确认。`,
      );
      setRecord((current) =>
        current ? { ...current, status: "outcome_unknown" } : current,
      );
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!record || record.status !== "analyzed" || cropChanged || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = await requestJson<{
        assetId: string;
        analysis: MaterialAnalysisRecord;
      }>(`/api/material-analyses/${encodeURIComponent(record.id)}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: record.revision,
          calibration,
        }),
      });
      setRecord(body.analysis);
      onSaved();
      setUnknownOperation(null);
    } catch (failure) {
      setError(
        `${failure instanceof Error ? failure.message : String(failure)}。若请求中断，入库结果可能未知，请刷新记录确认。`,
      );
      if (!(failure instanceof MaterialRequestError) || failure.status >= 500) {
        setRecord((current) =>
          current
            ? {
                ...current,
                status: "outcome_unknown",
                error: "入库请求结果未知，请刷新记录确认",
              }
            : current,
        );
        setUnknownOperation("save");
      }
    } finally {
      setBusy(false);
    }
  };

  const canSave = useMemo(
    () =>
      record?.status === "analyzed" &&
      !cropChanged &&
      calibration.name.trim() &&
      calibration.materialDescription.trim() &&
      calibration.colors.length > 0 &&
      calibration.colors.every((color) => /^#[0-9A-Fa-f]{6}$/.test(color.hex)),
    [record?.status, cropChanged, calibration],
  );

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) {
            onOpenChange(true);
            return;
          }
          if (busy) return;
          if (hasUnsavedDraft) {
            setPendingDiscard({ kind: "close" });
            return;
          }
          reset();
          onOpenChange(false);
        }}
      >
        <DialogContent
          showCloseButton={false}
          overlayClassName="z-[70] bg-black/65"
          className="z-[71] flex max-h-[88vh] w-[min(1040px,calc(100vw-3rem))] max-w-none flex-col overflow-hidden p-0 sm:max-w-none"
        >
          <header className="flex items-center justify-between border-b border-(--gc-border) px-5 py-3">
            <div>
              <DialogTitle>上传并分析面料</DialogTitle>
              <DialogDescription>
                先裁切目标面料，再由模型分析并人工校准后保存共享素材。
              </DialogDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={busy}
              onClick={() => {
                if (hasUnsavedDraft) setPendingDiscard({ kind: "close" });
                else {
                  reset();
                  onOpenChange(false);
                }
              }}
            >
              关闭
            </Button>
          </header>
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)] overflow-hidden">
            <section
              className="min-h-0 overflow-auto border-r border-(--gc-border) p-4"
              aria-label="面料裁切"
            >
              <div className="mb-3 flex items-center gap-2">
                <Input
                  ref={inputRef}
                  aria-label="选择面料图片"
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.currentTarget.value = "";
                    chooseFile(file);
                  }}
                />
              </div>
              {preview ? (
                <RectangleCropSurface
                  key={preview}
                  source={preview}
                  alt="待分析面料"
                  crop={crop}
                  onCropChange={setCrop}
                  minimumPixels={16}
                  disabled={busy || record?.status === "saved" || record?.status === "analyzing" || record?.status === "outcome_unknown"}
                  className="mx-auto w-fit max-w-full"
                  imageClassName="max-h-[46vh] max-w-full object-contain"
                  onImageLoad={(image) => {
                    setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
                    if (image.naturalWidth < 16 || image.naturalHeight < 16) setError("面料图片至少需要 16×16 像素");
                    else setCrop((current) => boundImageCrop(current, 16 / image.naturalWidth, 16 / image.naturalHeight));
                  }}
                  onImageError={() => setError("图片加载失败，请重新选择")}
                />
              ) : (
                <p className="rounded-md border border-dashed border-(--gc-border) p-10 text-center text-sm text-(--gc-text-muted)">
                  选择图片后设置裁切区域
                </p>
              )}
              {preview && <p className="mt-3 text-xs text-(--gc-text-muted)">鼠标左键拖动框选；拖动选区移动，拖动边角调整。框内为原色。</p>}
              <div className="mt-3 grid grid-cols-2 gap-3">
                {(["x", "y", "width", "height"] as const).map((field) => (
                  <label key={field} className="text-xs">
                    {
                      {
                        x: "左边界",
                        y: "上边界",
                        width: "宽度",
                        height: "高度",
                      }[field]
                    }{" "}
                    {Math.round(crop[field] * 100)}%
                    <Input
                      aria-label={`裁切${field}`}
                      type="number"
                      min={field === "x" || field === "y" ? 0 : 16 / Math.max(16, field === "width" ? imageSize.width : imageSize.height)}
                      max="1"
                      step="0.01"
                      value={crop[field]}
                      disabled={!preview || !imageSize.width || busy || record?.status === "saved" || record?.status === "analyzing" || record?.status === "outcome_unknown"}
                      onChange={(event) => {
                        const value = event.target.valueAsNumber;
                        if (!Number.isFinite(value)) return;
                        setCrop((current) =>
                          normalizeCrop(
                            current,
                            field,
                            value,
                            16 / imageSize.width,
                            16 / imageSize.height,
                          ),
                        );
                      }}
                    />
                  </label>
                ))}
              </div>
              {/* Reserve the notice height so a new crop cannot recenter the dialog mid-drag. */}
              <p role="status" className="mt-2 min-h-4 text-xs text-amber-600">
                {cropChanged ? "裁切已改变，请重新分析后再入库。" : ""}
              </p>
            </section>
            <section
              className="min-h-0 overflow-auto p-4"
              aria-label="模型分析与人工校准"
            >
              <div className="flex items-end gap-2">
                <label className="min-w-0 flex-1 text-xs">
                  分析模型
                  <Select
                    value={modelId}
                    disabled={busy || models.length === 0}
                    onValueChange={(value) => value && setModelId(value)}
                  >
                    <SelectTrigger aria-label="分析模型">
                      <SelectValue placeholder="没有已启用模型" />
                    </SelectTrigger>
                    <SelectContent className="z-[90]">
                      {models.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <Button
                  type="button"
                  disabled={
                    !imageData ||
                    imageSize.width < 16 || imageSize.height < 16 ||
                    !modelId ||
                    busy ||
                    record?.status === "saved" ||
                    record?.status === "analyzing" ||
                    record?.status === "outcome_unknown"
                  }
                  onClick={() => void analyze()}
                >
                  {busy ? "处理中…" : record ? "重新分析" : "开始分析"}
                </Button>
              </div>
              {record && (
                <div className="mt-2 flex items-center justify-between gap-2 text-xs text-(--gc-text-muted)">
                  <span>状态：{record.status}</span>
                  <div className="flex gap-1">
                    {record.status === "outcome_unknown" &&
                      unknownOperation !== "save" && (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={busy || !modelId}
                          onClick={() => setRetryUnknownOpen(true)}
                        >
                          确认重试分析
                        </Button>
                      )}
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void refreshRecord()}
                    >
                      刷新记录
                    </Button>
                  </div>
                </div>
              )}
              {record?.suggestion && (
                <div className="mt-3 rounded-md border border-(--gc-border) p-3 text-xs">
                  <p>{record.suggestion.materialDescription}</p>
                  {record.suggestion.observedAttributes.length > 0 && (
                    <p className="mt-1 text-(--gc-text-muted)">
                      可见：{record.suggestion.observedAttributes.join("、")}
                    </p>
                  )}
                  {record.suggestion.uncertainAttributes.length > 0 && (
                    <p className="mt-1 text-amber-600">
                      待确认：{record.suggestion.uncertainAttributes.join("、")}
                    </p>
                  )}
                </div>
              )}
              <div className="mt-4 space-y-3">
                <label className="block text-xs">
                  素材名称
                  <Input
                    aria-label="素材名称"
                    value={calibration.name}
                    disabled={busy || record?.status === "saved"}
                    onChange={(event) =>
                      setCalibration((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="block text-xs">
                  材质描述
                  <Input
                    aria-label="材质描述"
                    placeholder="无法确定时可填写“无法确定”"
                    value={calibration.materialDescription}
                    disabled={busy || record?.status === "saved"}
                    onChange={(event) => {
                      calibrationDirtyRef.current = true;
                      setCalibration((current) => ({
                        ...current,
                        materialDescription: event.target.value,
                      }));
                    }}
                  />
                </label>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs">校准颜色（至少一项）</span>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={
                        busy ||
                        record?.status === "saved" ||
                        calibration.colors.length >= 12
                      }
                      onClick={() => {
                        calibrationDirtyRef.current = true;
                        setCalibration((current) => ({
                          ...current,
                          colors: [...current.colors, { hex: "#808080" }],
                        }));
                      }}
                    >
                      <PlusIcon aria-hidden="true" className="size-3" />
                      添加颜色
                    </Button>
                  </div>
                  {calibration.colors.map((color, index) => (
                    <div
                      key={`${index}-${color.pantone?.catalogId ?? "hex"}`}
                      className="flex items-center gap-2"
                    >
                      <Input
                        aria-label={`颜色 ${index + 1}`}
                        value={color.hex}
                        disabled={busy || record?.status === "saved"}
                        onChange={(event) => {
                          calibrationDirtyRef.current = true;
                          setCalibration((current) => ({
                            ...current,
                            colors: current.colors.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, hex: event.target.value }
                                : item,
                            ),
                          }));
                        }}
                      />
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`删除颜色 ${index + 1}`}
                        disabled={busy || record?.status === "saved"}
                        onClick={() => {
                          calibrationDirtyRef.current = true;
                          setCalibration((current) => ({
                            ...current,
                            colors: current.colors.filter(
                              (_, itemIndex) => itemIndex !== index,
                            ),
                          }));
                        }}
                      >
                        <Trash2Icon aria-hidden="true" className="size-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
              {error && (
                <p
                  role="alert"
                  className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
                >
                  {error}
                </p>
              )}
            </section>
          </div>
          <footer className="flex items-center justify-between border-t border-(--gc-border) px-5 py-3">
            <p className="text-xs text-(--gc-text-muted)">
              保存后将共享给团队；原始上传图仍保持私有。
            </p>
            <Button
              type="button"
              disabled={!canSave || busy || record?.status === "saved"}
              onClick={() => void save()}
            >
              {record?.status === "saved" ? "已保存到面料库" : "保存为共享面料"}
            </Button>
          </footer>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={retryUnknownOpen}
        onOpenChange={(next) => {
          if (!busy) setRetryUnknownOpen(next);
        }}
      >
        <AlertDialogContent overlayClassName="z-[90]" className="z-[91]">
          <AlertDialogHeader>
            <AlertDialogTitle>确认重新发起材质分析？</AlertDialogTitle>
            <AlertDialogDescription>
              上一次请求结果未知，重新发起可能产生第二次调用和费用。请仅在确认需要重试时继续。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void retryUnknownAnalysis();
              }}
            >
              确认重试
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={pendingDiscard !== null}
        onOpenChange={(next) => {
          if (!next && !busy) setPendingDiscard(null);
        }}
      >
        <AlertDialogContent overlayClassName="z-[90]" className="z-[91]">
          <AlertDialogHeader>
            <AlertDialogTitle>放弃尚未入库的面料分析？</AlertDialogTitle>
            <AlertDialogDescription>
              放弃后会删除服务端草稿、原图和裁片，无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>继续编辑</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void discardDraft();
              }}
            >
              {busy ? "正在删除…" : "放弃并删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

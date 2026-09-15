import { useEffect, useMemo, useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
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
import type { MaterialAnalysisColor } from "@/types/materialAnalysis";
import type { Asset } from "@/types/workflow";

async function updateMaterial(
  asset: Asset,
  name: string,
  materialDescription: string,
  colors: MaterialAnalysisColor[],
) {
  const response = await fetch(`/api/assets/${encodeURIComponent(asset.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      material: { name, materialDescription, colors },
    }),
  });
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (!response.ok)
    throw new Error(
      typeof body.error === "string" ? body.error : `HTTP ${response.status}`,
    );
}

function materialDraftSignature(
  name: string,
  description: string,
  colors: MaterialAnalysisColor[],
) {
  return JSON.stringify({ name, description, colors });
}

export function MaterialAssetDetailsDialog({
  asset,
  onOpenChange,
  onUpdated,
}: {
  asset: Asset | null;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [colors, setColors] = useState<MaterialAnalysisColor[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialSignature, setInitialSignature] = useState("");
  const [discardOpen, setDiscardOpen] = useState(false);

  useEffect(() => {
    if (!asset) return;
    const initialColors =
      asset.material?.colors.map((color) => ({
        ...color,
        ...(color.pantone ? { pantone: { ...color.pantone } } : {}),
      })) ?? [];
    const initialDescription = asset.material?.materialDescription ?? "";
    setName(asset.name);
    setDescription(initialDescription);
    setColors(initialColors);
    setInitialSignature(
      materialDraftSignature(asset.name, initialDescription, initialColors),
    );
    setDiscardOpen(false);
    setError(null);
  }, [asset]);

  const valid = useMemo(
    () =>
      Boolean(
        asset?.canManage &&
          name.trim() &&
          description.trim() &&
          colors.length > 0 &&
          colors.every((color) => /^#[0-9A-Fa-f]{6}$/.test(color.hex)),
      ),
    [asset?.canManage, name, description, colors],
  );

  const dirty = Boolean(
    asset?.canManage &&
      initialSignature &&
      materialDraftSignature(name, description, colors) !== initialSignature,
  );
  const requestClose = () => {
    if (busy) return;
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    onOpenChange(false);
  };

  const save = async () => {
    if (!asset || !valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await updateMaterial(
        asset,
        name.trim(),
        description.trim(),
        colors.map((color) => ({
          ...color,
          hex: color.hex.toUpperCase() as `#${string}`,
          ...(color.name?.trim() ? { name: color.name.trim() } : {}),
        })),
      );
      onUpdated();
      onOpenChange(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog
        open={Boolean(asset)}
        onOpenChange={(open) => {
          if (!open) requestClose();
        }}
      >
        <DialogContent className="flex max-h-[90vh] w-[min(42rem,calc(100vw-2rem))] max-w-none flex-col overflow-hidden sm:max-w-none">
          <DialogHeader>
            <DialogTitle>面料校准信息</DialogTitle>
            <DialogDescription>
              查看材质与配色；只有素材创建者或管理员可编辑共享面料。
            </DialogDescription>
          </DialogHeader>
          {asset && (
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
              <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-4">
                <img
                  src={asset.thumbnail ?? asset.image}
                  alt={asset.name}
                  className="aspect-square w-32 rounded-lg border border-[var(--gc-border)] object-cover"
                />
                <div className="min-w-0 space-y-3">
                  <label className="block space-y-1 text-xs">
                    素材名称
                    <Input
                      aria-label="面料素材名称"
                      value={name}
                      disabled={!asset.canManage || busy}
                      maxLength={200}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                  <label className="block space-y-1 text-xs">
                    材质描述
                    <textarea
                      aria-label="面料材质描述"
                      value={description}
                      disabled={!asset.canManage || busy}
                      maxLength={1000}
                      onChange={(event) => setDescription(event.target.value)}
                      className="min-h-20 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    />
                  </label>
                </div>
              </div>
              {!asset.material && (
                <p className="rounded-md border border-dashed border-[var(--gc-border)] p-3 text-xs text-[var(--gc-text-muted)]">
                  {asset.canManage
                    ? "该历史面料暂无分析校准信息，可人工补录。"
                    : "该历史面料暂无分析校准信息。"}
                </p>
              )}
              <section className="space-y-2" aria-label="面料校准颜色">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-medium">校准颜色</h3>
                  {asset.canManage && (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={busy || colors.length >= 12}
                      onClick={() =>
                        setColors((current) => [...current, { hex: "#808080" }])
                      }
                    >
                      <PlusIcon />
                      添加颜色
                    </Button>
                  )}
                </div>
                {colors.length === 0 ? (
                  <p className="rounded-md border border-dashed border-[var(--gc-border)] p-3 text-xs text-[var(--gc-text-muted)]">
                    暂无校准颜色。
                  </p>
                ) : (
                  colors.map((color, index) => (
                    <div
                      key={color.pantone?.catalogId ?? index}
                      className="grid grid-cols-[2.5rem_minmax(0,1fr)_minmax(0,1fr)_2rem] items-center gap-2"
                    >
                      <span
                        className="size-8 rounded border border-[var(--gc-border)]"
                        style={{ backgroundColor: color.hex }}
                        aria-hidden="true"
                      />
                      <Input
                        aria-label={`面料颜色 ${index + 1}`}
                        value={color.hex}
                        disabled={
                          !asset.canManage || busy || Boolean(color.pantone)
                        }
                        onChange={(event) =>
                          setColors((current) =>
                            current.map((entry, position) =>
                              position === index
                                ? {
                                    ...entry,
                                    hex: event.target.value as `#${string}`,
                                  }
                                : entry,
                            ),
                          )
                        }
                      />
                      <div className="min-w-0 text-[11px] text-[var(--gc-text-muted)]">
                        {color.pantone ? (
                          <>
                            <p className="truncate">{color.pantone.code}</p>
                            <p className="truncate">
                              {color.pantone.libraryKey}
                            </p>
                          </>
                        ) : (
                          <Input
                            aria-label={`颜色名称 ${index + 1}`}
                            value={color.name ?? ""}
                            placeholder="可选名称"
                            disabled={!asset.canManage || busy}
                            onChange={(event) =>
                              setColors((current) =>
                                current.map((entry, position) =>
                                  position === index
                                    ? { ...entry, name: event.target.value }
                                    : entry,
                                ),
                              )
                            }
                          />
                        )}
                      </div>
                      {asset.canManage && !color.pantone ? (
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`删除颜色 ${index + 1}`}
                          disabled={busy}
                          onClick={() =>
                            setColors((current) =>
                              current.filter(
                                (_, position) => position !== index,
                              ),
                            )
                          }
                        >
                          <Trash2Icon />
                        </Button>
                      ) : (
                        <span />
                      )}
                    </div>
                  ))
                )}
              </section>
              {asset.material && (
                <p className="text-[10px] text-[var(--gc-text-muted)]">
                  最后确认：
                  {new Date(asset.material.confirmedAt).toLocaleString()}
                </p>
              )}
              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={requestClose}
            >
              关闭
            </Button>
            {asset?.canManage && (
              <Button
                type="button"
                disabled={!valid || busy}
                onClick={() => void save()}
              >
                {busy ? "保存中…" : "保存校准信息"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent overlayClassName="z-[90]" className="z-[91]">
          <AlertDialogHeader>
            <AlertDialogTitle>放弃未保存的面料校准修改？</AlertDialogTitle>
            <AlertDialogDescription>
              关闭将丢弃名称、材质描述和颜色修改。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>继续编辑</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => onOpenChange(false)}
            >
              放弃修改
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

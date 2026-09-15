import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ColorRequestError } from "@/lib/colorManagementClient";
import { useColorManagementRequest } from "./ColorManagementSession";
import type { ColorBrand, ColorSeries } from "@/types/brandColors";

export type ColorMetadataTarget =
  | { kind: "brands"; item: ColorBrand | null }
  | { kind: "series"; item: ColorSeries | null; brandId: string };

export interface ColorMetadataEditorState {
  dirty: boolean;
  busy: boolean;
  outcomeUnknown: boolean;
}

export function ColorMetadataDialog({
  target,
  onClose,
  onRefresh,
  onSaved,
  onStateChange,
}: {
  target: ColorMetadataTarget;
  onClose: () => void;
  onRefresh: () => void;
  onSaved: (item: ColorBrand | ColorSeries) => void;
  onStateChange?: (state: ColorMetadataEditorState) => void;
}) {
  const colorRequest = useColorManagementRequest();
  const initialName = target.item?.name ?? "";
  const original = target.kind === "series" ? target.item : null;
  const initialYear = original?.year?.toString() ?? "";
  const initialSeason = original?.season ?? "";
  const [name, setName] = useState(initialName);
  const [year, setYear] = useState(initialYear);
  const [season, setSeason] = useState(initialSeason);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const label = target.kind === "brands" ? "品牌" : "系列";
  const dirty = useMemo(
    () =>
      name !== initialName || year !== initialYear || season !== initialSeason,
    [initialName, initialSeason, initialYear, name, season, year],
  );

  useEffect(() => {
    onStateChange?.({ dirty, busy, outcomeUnknown });
  }, [busy, dirty, onStateChange, outcomeUnknown]);
  useEffect(
    () => () =>
      onStateChange?.({ dirty: false, busy: false, outcomeUnknown: false }),
    [onStateChange],
  );

  const requestClose = () => {
    if (busy) return;
    if (dirty || outcomeUnknown) {
      setDiscardOpen(true);
      return;
    }
    onClose();
  };

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) requestClose();
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="z-80 bg-(--gc-panel) text-(--gc-text)"
          overlayClassName="z-80"
        >
          <DialogTitle>
            {target.item ? "编辑" : "新建"}
            {label}
          </DialogTitle>
          <DialogDescription>
            保存后对所有用户立即可见；未标注的年份和季节请留空。
          </DialogDescription>
          <form
            className="mt-4 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || conflict || outcomeUnknown) return;
              setBusy(true);
              setError(null);
              setConflict(false);
              const body = {
                name: name.trim(),
                ...(target.item ? { revision: target.item.revision } : {}),
                ...(target.kind === "series"
                  ? {
                      ...(target.item ? {} : { brandId: target.brandId }),
                      year: year === "" ? null : Number(year),
                      season: season.trim() || null,
                    }
                  : {}),
              };
              void colorRequest<ColorBrand | ColorSeries>(
                `/${target.kind}${target.item ? `/${target.item.id}` : ""}`,
                target.item ? "PATCH" : "POST",
                body,
              )
                .then(onSaved)
                .catch((reason: unknown) => {
                  const unknown =
                    reason instanceof ColorRequestError &&
                    reason.outcomeUnknown;
                  setOutcomeUnknown(unknown);
                  setError(
                    unknown
                      ? "保存结果可能未知。请关闭并刷新目录核对服务器记录，确认不存在后再重试。"
                      : reason instanceof Error
                        ? reason.message
                        : "保存失败",
                  );
                  setConflict(
                    reason instanceof ColorRequestError &&
                      reason.status === 409,
                  );
                })
                .finally(() => setBusy(false));
            }}
          >
            <label className="block text-xs">
              {label}名称
              <Input
                required
                maxLength={120}
                value={name}
                disabled={busy || conflict || outcomeUnknown}
                onChange={(event) => setName(event.target.value)}
                className="mt-1"
              />
            </label>
            {target.kind === "series" && (
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs">
                  年份
                  <Input
                    type="number"
                    min={1900}
                    max={2200}
                    value={year}
                    disabled={busy || conflict || outcomeUnknown}
                    onChange={(event) => setYear(event.target.value)}
                  />
                </label>
                <label className="text-xs">
                  季节
                  <Input
                    maxLength={80}
                    value={season}
                    disabled={busy || conflict || outcomeUnknown}
                    onChange={(event) => setSeason(event.target.value)}
                  />
                </label>
              </div>
            )}
            {error && (
              <p role="alert" className="text-xs text-red-400">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              {(conflict || outcomeUnknown) && (
                <Button
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={onRefresh}
                >
                  关闭并刷新目录
                </Button>
              )}
              <Button
                variant="outline"
                type="button"
                disabled={busy}
                onClick={requestClose}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={busy || conflict || outcomeUnknown}
              >
                {busy ? "保存中…" : "保存"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent
          overlayClassName="z-90"
          className="z-90 bg-(--gc-panel) text-(--gc-text)"
        >
          <AlertDialogTitle>放弃未保存的{label}修改？</AlertDialogTitle>
          <AlertDialogDescription>
            关闭将丢弃当前表单内容。
            {outcomeUnknown && (
              <span className="mt-2 block">
                上一次保存结果可能未知；离开后请刷新目录核对，避免重复创建。
              </span>
            )}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>继续编辑</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onClose}>
              放弃修改
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

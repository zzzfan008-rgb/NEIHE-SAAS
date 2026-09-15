import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  useColorManagementRequest,
  useColorManagementQuery as useColorQuery,
} from "./ColorManagementSession";
import type { BrandColorMember, ColorGroup } from "@/types/brandColors";
import {
  ColorCatalogPicker,
  type CatalogSelection,
} from "./ColorCatalogPicker";

type GroupDetail = ColorGroup & { members: BrandColorMember[] };
type DraftMember = BrandColorMember & { ratioText: string };
const DECIMAL_RATIO = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function parseRatio(text: string) {
  const value = text.trim();
  if (!value) return null;
  if (!DECIMAL_RATIO.test(value)) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1
    ? number
    : undefined;
}

function editorSyncLabel(dirty: boolean, outcomeUnknown: boolean) {
  if (outcomeUnknown) return "等待核对服务器状态";
  return dirty ? "有未保存修改" : "已与服务器同步";
}

function draftSignature(name: string, members: readonly DraftMember[]) {
  return JSON.stringify({
    name,
    members: members.map(({ catalogId, releaseId, ratioText }) => ({
      catalogId,
      releaseId,
      ratioText,
    })),
  });
}

function moveMember(
  members: readonly DraftMember[],
  index: number,
  direction: -1 | 1,
) {
  const target = index + direction;
  if (target < 0 || target >= members.length) return [...members];
  const reordered = [...members];
  [reordered[index], reordered[target]] = [
    reordered[target]!,
    reordered[index]!,
  ];
  return reordered;
}
export function ColorGroupEditor({
  group,
  brandId,
  seriesId,
  onSaved,
  onBusyChange,
  onDirtyChange,
  onOutcomeUnknownChange,
  onRefreshDirectory,
}: {
  group: ColorGroup | null;
  brandId: string;
  seriesId: string | null;
  onSaved: (group: ColorGroup) => void;
  onBusyChange: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  onOutcomeUnknownChange: (outcomeUnknown: boolean) => void;
  onRefreshDirectory: () => void;
}) {
  const [reloadRevision, setReloadRevision] = useState(0);
  const loaded = useColorQuery<GroupDetail>(
    group ? `/groups/${group.id}` : null,
    reloadRevision,
  );
  if (group && !loaded.data)
    return (
      <div className="flex items-center gap-2">
        <p role={loaded.error ? "alert" : "status"}>
          {loaded.error ?? "读取色组…"}
        </p>
        {loaded.error && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => setReloadRevision((value) => value + 1)}
          >
            重试色组
          </Button>
        )}
      </div>
    );
  return (
    <GroupForm
      key={
        group
          ? `${group.id}:${loaded.data?.revision ?? group.revision}:${reloadRevision}`
          : "new"
      }
      original={loaded.data}
      brandId={brandId}
      seriesId={seriesId}
      onSaved={onSaved}
      onBusyChange={onBusyChange}
      onDirtyChange={onDirtyChange}
      onOutcomeUnknownChange={onOutcomeUnknownChange}
      onReload={
        group
          ? () => setReloadRevision((value) => value + 1)
          : onRefreshDirectory
      }
    />
  );
}
function GroupForm({
  original,
  brandId,
  seriesId,
  onSaved,
  onBusyChange,
  onDirtyChange,
  onOutcomeUnknownChange,
  onReload,
}: {
  original: GroupDetail | null;
  brandId: string;
  seriesId: string | null;
  onSaved: (group: ColorGroup) => void;
  onBusyChange: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  onOutcomeUnknownChange: (outcomeUnknown: boolean) => void;
  onReload: () => void;
}) {
  const colorRequest = useColorManagementRequest();
  const initialMembers: DraftMember[] = (original?.members ?? []).map((member) => ({
    ...member,
    ratioText: member.ratio?.toString() ?? "",
  }));
  const [name, setName] = useState(original?.name ?? "");
  const [members, setMembers] = useState<DraftMember[]>(initialMembers);
  const [memberOffset, setMemberOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const submittingRef = useRef(false);
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [reloadOpen, setReloadOpen] = useState(false);
  const dirty =
    draftSignature(name, members) !==
    draftSignature(original?.name ?? "", initialMembers);
  const selectedCatalogIds = new Set(
    members.map((member) => member.catalogId),
  );
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(
    () => onOutcomeUnknownChange(outcomeUnknown),
    [onOutcomeUnknownChange, outcomeUnknown],
  );
  useEffect(
    () => () => onOutcomeUnknownChange(false),
    [onOutcomeUnknownChange],
  );
  const clearError = () => {
    if (outcomeUnknown) return;
    setError(null);
    setErrorStatus(null);
  };
  const addColor = (selection: CatalogSelection) => {
    clearError();
    setMembers((current) =>
      current.some((member) => member.catalogId === selection.catalogId)
        ? current
        : [
            ...current,
            {
              ...selection,
              ratio: null,
              ratioText: "",
              originalHex: null,
            },
          ],
    );
  };
  const reorder = (index: number, direction: -1 | 1) => {
    clearError();
    setMembers((current) => moveMember(current, index, direction));
    const target = index + direction;
    setMemberOffset(Math.floor(target / 25) * 25);
  };
  return (
    <>
    <form
      className="flex min-h-0 flex-1 flex-col gap-3"
      aria-label="主题色组编辑"
      onSubmit={(event) => {
        event.preventDefault();
        if (submittingRef.current || outcomeUnknown) return;
        const ratios = members.map((member) => parseRatio(member.ratioText));
        if (ratios.some((ratio) => ratio === undefined)) {
          setError("参考比例须为 0–1 的数值或空值，不会自动补齐。");
          setErrorStatus(null);
          return;
        }
        const references = members.map((member, index) => ({
          catalogId: member.catalogId,
          releaseId: member.releaseId,
          ratio: ratios[index] as number | null,
        }));
        submittingRef.current = true;
        setBusy(true);
        onBusyChange(true);
        clearError();
        void colorRequest<ColorGroup>(
          original ? `/groups/${original.id}` : "/groups",
          original ? "PUT" : "POST",
          {
            name,
            members: references,
            seriesId: original ? original.seriesId : seriesId,
            ...(original ? { revision: original.revision } : { brandId }),
          },
        )
          .then((saved) => {
            setOutcomeUnknown(false);
            onSaved(saved);
          })
          .catch((reason: unknown) => {
            const message = reason instanceof Error ? reason.message : "保存失败";
            const unknown =
              reason instanceof ColorRequestError && reason.outcomeUnknown;
            setOutcomeUnknown(unknown);
            setError(
              unknown
                ? `保存结果可能未知：${message}。请先核对服务器状态。`
                : message,
            );
            setErrorStatus(
              reason instanceof ColorRequestError ? (reason.status ?? null) : null,
            );
          })
          .finally(() => {
            submittingRef.current = false;
            setBusy(false);
            onBusyChange(false);
          });
      }}
    >
      <label className="text-xs">
        主题色组名称
        <Input
          required
          maxLength={120}
          value={name}
          disabled={busy}
          onChange={(event) => {
            clearError();
            setName(event.target.value);
          }}
          className="mt-1"
        />
      </label>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-4">
        <ColorCatalogPicker
          disabled={busy}
          selectedCatalogIds={selectedCatalogIds}
          maxReached={members.length >= 5000}
          onSelect={addColor}
        />
        <section
          className="flex min-h-0 min-w-0 flex-col gap-2"
          aria-label="已选色组颜色"
        >
          <p>{members.length} 色 · 参考比例留空不会补齐</p>
          <ol className="min-h-0 flex-1 space-y-2 overflow-auto">
            {members
              .slice(memberOffset, memberOffset + 25)
              .map((member, visibleIndex) => {
                const index = memberOffset + visibleIndex;
                return (
              <li
                key={member.catalogId}
                className="flex flex-wrap items-center gap-2 border-b border-(--gc-border) pb-2"
              >
                <span
                  aria-hidden="true"
                  className="size-5 shrink-0 rounded border border-(--gc-border)"
                  style={{ backgroundColor: member.hex }}
                />
                <span className="min-w-0 flex-1 break-all">
                  {member.code}
                  <span className="block text-(--gc-text-muted)">
                    {member.libraryKey} · {member.hex}
                  </span>
                </span>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={busy || index === 0}
                  aria-label={`上移 ${member.code} ${member.libraryKey}`}
                  onClick={() => reorder(index, -1)}
                >
                  上移
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={busy || index === members.length - 1}
                  aria-label={`下移 ${member.code} ${member.libraryKey}`}
                  onClick={() => reorder(index, 1)}
                >
                  下移
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`移除 ${member.code} ${member.libraryKey}`}
                  onClick={() => {
                    clearError();
                    setMembers((current) =>
                      current.filter((m) => m.catalogId !== member.catalogId),
                    );
                    setMemberOffset(0);
                  }}
                >
                  移除
                </Button>
                <label className="flex w-full items-center gap-2">
                  参考比例（0–1）
                  <Input
                    className="h-7 w-24"
                    inputMode="decimal"
                    aria-label={`${member.code} 参考比例`}
                    value={member.ratioText}
                    disabled={busy}
                    onChange={(event) => {
                      clearError();
                      setMembers((current) =>
                        current.map((currentMember) =>
                          currentMember.catalogId === member.catalogId
                            ? { ...currentMember, ratioText: event.target.value }
                            : currentMember,
                        ),
                      );
                    }}
                  />
                </label>
                </li>
                );
              })}
          </ol>
          <div className="flex justify-between gap-2">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={!memberOffset || busy}
              onClick={() => setMemberOffset(Math.max(0, memberOffset - 25))}
            >
              上一页已选
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={memberOffset + 25 >= members.length || busy}
              onClick={() => setMemberOffset(memberOffset + 25)}
            >
              下一页已选
            </Button>
          </div>
        </section>
      </div>
      {error && (
        <div className="flex items-center gap-2">
          <p role="alert" className="min-w-0 flex-1 text-red-400">
            {error}
          </p>
          {((errorStatus === 409 && original) || outcomeUnknown) && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => setReloadOpen(true)}
            >
              {original ? "重新加载服务器版本" : "刷新目录并核对"}
            </Button>
          )}
        </div>
      )}
      <footer className="flex items-center justify-between gap-3 border-t border-(--gc-border) pt-3">
        <p className="text-(--gc-text-muted)">
          保存后所有用户可见。色组可超过 8 色；画布选色仍限 8 色。
          <span className="block" aria-live="polite">
            {editorSyncLabel(dirty, outcomeUnknown)}
          </span>
        </p>
        <Button type="submit" disabled={busy || !dirty || outcomeUnknown}>
          {busy ? "保存中…" : "保存色组"}
        </Button>
      </footer>
    </form>
      <AlertDialog open={reloadOpen} onOpenChange={setReloadOpen}>
        <AlertDialogContent
          overlayClassName="z-80"
          className="z-80 bg-(--gc-panel) text-(--gc-text)"
        >
          <AlertDialogTitle>
            {original
              ? "放弃本地草稿并重新加载？"
              : "放弃本地草稿并刷新目录？"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {outcomeUnknown
              ? "上一次保存可能已经到达服务器。继续会丢弃本地草稿；请在刷新后核对目录，避免重复创建。"
              : "服务器中的色组版本已变化。重新加载会丢弃当前名称、顺序和比例修改。"}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>继续编辑</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setReloadOpen(false);
                onReload();
              }}
            >
              {original ? "放弃草稿并重新加载" : "放弃草稿并刷新目录"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

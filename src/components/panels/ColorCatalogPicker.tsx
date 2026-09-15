import { useEffect, useState } from "react";
import { CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  CatalogColorSummary,
  CatalogLibrariesPage,
  CatalogPage,
  CatalogReleaseState,
} from "@/types/colorManagement";
import { useColorManagementQuery as useColorQuery } from "./ColorManagementSession";
import {
  PANTONE_TCX_LIBRARY_KEY,
  pantoneLibraryGuidance,
  pantoneLibraryLabel,
} from "@/lib/pantoneLibraries";

const PAGE_SIZE = 25;
const ALL_LIBRARIES = "__all__";

const HUES = [
  ["__all_hues__", "全部色相"], ["red", "红"], ["orange", "橙"], ["yellow", "黄"],
  ["green", "绿"], ["cyan", "青"], ["blue", "蓝"], ["purple", "紫"],
  ["pink", "粉"], ["neutral", "中性色"],
] as const;
export interface CatalogSelection {
  catalogId: string;
  releaseId: string;
  libraryKey: string;
  code: string;
  hex: `#${string}`;
}

export interface ColorCatalogPickerProps {
  libraryKey?: string;
  defaultLibraryKey?: string;
  releaseId?: string;
  disabled?: boolean;
  selectedCatalogIds?: ReadonlySet<string>;
  maxReached?: boolean;
  queryHook?: typeof useColorQuery;
  presentation?: "list" | "swatch-card";
  onSelect: (selection: CatalogSelection) => void;
}

function catalogPath(
  releaseId: string,
  libraryKey: string | undefined,
  query: string,
  hue: string,
  offset: number,
) {
  const parameters = new URLSearchParams({
    releaseId,
    status: "ready",
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (libraryKey) parameters.set("libraryKey", libraryKey);
  if (query) parameters.set("q", query);
  if (hue !== "__all_hues__") parameters.set("hue", hue);
  return `/catalog?${parameters.toString()}`;
}

function selectable(color: CatalogColorSummary, releaseId: string | null) {
  return color.status === "ready" && color.hex !== null && releaseId !== null;
}

export function ColorCatalogPicker({
  libraryKey,
  defaultLibraryKey = ALL_LIBRARIES,
  releaseId,
  disabled = false,
  selectedCatalogIds,
  maxReached = false,
  queryHook,
  presentation = "list",
  onSelect,
}: ColorCatalogPickerProps) {
  const usePickerQuery = queryHook ?? useColorQuery;
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [selectedLibrary, setSelectedLibrary] = useState(defaultLibraryKey);
  const [hue, setHue] = useState("__all_hues__");
  const [offset, setOffset] = useState(0);
  const [snapshotRevision, setSnapshotRevision] = useState(0);
  const [dataRevision, setDataRevision] = useState(0);
  const [previewedCatalogId, setPreviewedCatalogId] = useState<string>();
  const fixedRelease = releaseId !== undefined;
  const state = usePickerQuery<CatalogReleaseState>(
    fixedRelease ? null : "/catalog/state",
    snapshotRevision,
  );
  const snapshotResolved = fixedRelease || state.data !== null;
  const snapshotReleaseId = releaseId ?? state.data?.releaseId ?? null;
  const activeLibrary =
    libraryKey ??
    (selectedLibrary === ALL_LIBRARIES ? undefined : selectedLibrary);
  const encodedRelease = snapshotReleaseId
    ? encodeURIComponent(snapshotReleaseId)
    : null;
  const libraries = usePickerQuery<CatalogLibrariesPage>(
    snapshotResolved && encodedRelease && !libraryKey
      ? `/catalog/libraries?releaseId=${encodedRelease}`
      : null,
    dataRevision,
  );
  const catalog = usePickerQuery<CatalogPage>(
    snapshotResolved && snapshotReleaseId
      ? catalogPath(snapshotReleaseId, activeLibrary, query, hue, offset)
      : null,
    dataRevision,
  );

  useEffect(() => {
    setOffset(0);
    setSnapshotRevision((value) => value + 1);
  }, [libraryKey, releaseId]);

  const restartSnapshot = () => {
    setOffset(0);
    setSnapshotRevision((value) => value + 1);
  };
  const applySearch = () => {
    setQuery(search.trim());
    restartSnapshot();
  };
  const librariesMismatch =
    libraries.data !== null && libraries.data.releaseId !== snapshotReleaseId;
  const catalogMismatch =
    catalog.data !== null && catalog.data.releaseId !== snapshotReleaseId;
  const snapshotMismatch = librariesMismatch || catalogMismatch;
  const error =
    state.error ??
    libraries.error ??
    catalog.error ??
    (snapshotMismatch ? "主库响应版本不一致，请重试。" : null);
  const retry = () => {
    if (snapshotMismatch) {
      if (!fixedRelease) restartSnapshot();
      setDataRevision((value) => value + 1);
      return;
    }
    if (state.error) {
      restartSnapshot();
      return;
    }
    setDataRevision((value) => value + 1);
  };
  const loading =
    !error &&
    (!snapshotResolved ||
      (snapshotReleaseId !== null &&
        (!catalog.data || (!libraryKey && !libraries.data))));
  const guidance = pantoneLibraryGuidance(activeLibrary);
  const librarySummary = !error && !loading
    ? libraries.data?.libraries.find((library) => library.libraryKey === activeLibrary)
    : undefined;
  const availableColors = catalog.data?.colors.filter((color) =>
    selectable(color, snapshotReleaseId)
  ) ?? [];
  const previewColor = availableColors.find((color) => color.id === previewedCatalogId)
    ?? availableColors[0];

  const selectColor = (color: CatalogColorSummary) => {
    if (!selectable(color, snapshotReleaseId) || !snapshotReleaseId || !color.hex) return;
    setPreviewedCatalogId(color.id);
    onSelect({
      catalogId: color.id,
      releaseId: snapshotReleaseId,
      libraryKey: color.libraryKey,
      code: color.code,
      hex: color.hex,
    });
  };

  const colorResults = !snapshotMismatch && catalog.data?.colors.map((color) => {
    const canSelect = selectable(color, snapshotReleaseId);
    const selected = selectedCatalogIds?.has(color.id) ?? false;
    const unavailable = disabled || (!selected && maxReached) || !canSelect;
    const label = `${selected ? "移除" : "选择"} ${color.code} ${color.libraryKey} ${color.hex ?? "不可转换"}`;

    if (presentation === "swatch-card") {
      return (
        <li key={color.id} className="min-w-0 space-y-1">
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button
                  type="button"
                  variant="outline"
                  aria-label={label}
                  aria-pressed={selected}
                  aria-disabled={unavailable}
                  className="relative aspect-square h-auto w-full min-w-0 overflow-hidden rounded-lg border p-0 transition-[border-color,box-shadow,filter,transform] hover:brightness-110 focus-visible:ring-2 focus-visible:ring-(--gc-accent) aria-disabled:cursor-not-allowed aria-pressed:border-(--gc-accent) aria-pressed:ring-2 aria-pressed:ring-(--gc-accent)/45"
                  disabled={disabled}
                  style={{ backgroundColor: color.hex ?? "transparent" }}
                  onPointerEnter={() => setPreviewedCatalogId(color.id)}
                  onFocus={() => setPreviewedCatalogId(color.id)}
                  onClick={() => {
                    if (!unavailable) selectColor(color);
                  }}
                >
                  {selected && (
                    <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-(--gc-panel) text-(--gc-accent) shadow-sm" aria-hidden="true">
                      <CheckIcon className="size-2.5" strokeWidth={2.5} />
                    </span>
                  )}
                </Button>
              )}
            />
            <TooltipContent side="top" className="font-mono">
              {color.hex ?? "不可转换"}
            </TooltipContent>
          </Tooltip>
          <span className="line-clamp-2 min-h-6 break-words text-center text-[10px] font-medium leading-3 text-(--gc-text-muted)">
            {color.code}
          </span>
        </li>
      );
    }

    return (
      <li key={color.id}>
        <Button
          type="button"
          variant="outline"
          className="h-auto w-full justify-start py-2 text-xs"
          disabled={unavailable}
          aria-pressed={selected}
          onClick={() => selectColor(color)}
        >
          <span
            aria-hidden="true"
            className="size-5 shrink-0 rounded border border-(--gc-border)"
            style={{ backgroundColor: color.hex ?? "transparent" }}
          />
          <span className="min-w-0 text-left">
            <span className="block break-all">{color.code}</span>
            <span className="block break-all text-(--gc-text-muted)">
              {color.libraryKey} · {color.hex ?? "不可转换"}
            </span>
          </span>
        </Button>
      </li>
    );
  });

  const pagination = (
    <div className="flex shrink-0 justify-between gap-2">
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={!offset || disabled || loading}
        onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
      >
        上一页色号
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={catalog.data?.nextOffset == null || disabled || loading}
        onClick={() => setOffset(catalog.data!.nextOffset!)}
      >
        下一页色号
      </Button>
    </div>
  );

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
      aria-label="色库选色"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(8rem,0.6fr)_minmax(7rem,0.45fr)_auto] gap-2">
        <Input
          aria-label="搜索 Pantone 色号或来源名称"
          value={search}
          disabled={disabled}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              applySearch();
            }
          }}
        />
        <Select
          value={libraryKey ?? selectedLibrary}
          disabled={disabled || libraryKey !== undefined || loading}
          onValueChange={(value) => {
            if (!value || libraryKey !== undefined) return;
            setSelectedLibrary(value);
            restartSnapshot();
          }}
        >
          <SelectTrigger aria-label="色库系列" className="min-w-0 text-xs">
            <SelectValue>{activeLibrary ? pantoneLibraryLabel(activeLibrary) : "全部色库"}</SelectValue>
          </SelectTrigger>
          <SelectContent
            positionerClassName="z-[90]"
            className="z-[90] border-(--gc-border) bg-(--gc-panel) text-(--gc-text)"
          >
            {!libraryKey && (
              <SelectItem value={ALL_LIBRARIES}>全部色库</SelectItem>
            )}
            {(libraryKey
              ? [{ libraryKey, ready: 0, total: 0 }]
              : (libraries.data?.libraries ??
                (activeLibrary
                  ? [{ libraryKey: activeLibrary, ready: 0, total: 0 }]
                  : []))
            ).map((library) => (
              <SelectItem key={library.libraryKey} value={library.libraryKey}>
                {pantoneLibraryLabel(library.libraryKey)}
                {libraryKey ? "" : ` · ${library.ready}/${library.total}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={hue}
          disabled={disabled || loading}
          onValueChange={(value) => {
            if (!value) return;
            setHue(value);
            restartSnapshot();
          }}
>
          <SelectTrigger aria-label="色相筛选" className="min-w-0 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent positionerClassName="z-[90]" className="z-[90] border-(--gc-border) bg-(--gc-panel)">
            {HUES.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || loading}
          onClick={applySearch}
        >
          搜索
        </Button>
      </div>
      {guidance && (
        <p aria-label="色库用途说明" aria-live="polite" className="shrink-0 text-xs leading-relaxed text-(--gc-text-muted)">
          {guidance.label}：{guidance.usage}
          {activeLibrary === PANTONE_TCX_LIBRARY_KEY && librarySummary && (
            <span>
              {librarySummary.total > 0 && librarySummary.ready === librarySummary.total
                ? `这批已导入 ${librarySummary.total.toLocaleString("en-US")} 色，均无冲突。`
                : `这批已导入 ${librarySummary.total.toLocaleString("en-US")} 色，其中 ${librarySummary.ready.toLocaleString("en-US")} 色可选。`}
            </span>
          )}
          {activeLibrary === PANTONE_TCX_LIBRARY_KEY && "建议作为默认库。"}
        </p>
      )}

      {error && (
        <div className="space-y-1">
          <p role="alert" className="text-red-400">
            {error}
          </p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={retry}
          >
            重试主库
          </Button>
        </div>
      )}
      {loading && <p role="status">读取主库…</p>}
      {!error && snapshotResolved && snapshotReleaseId === null && (
        <p>主库尚未初始化，请联系运维。此处不能上传主库。</p>
      )}
      {!error &&
        catalog.data?.releaseId &&
        catalog.data.colors.length === 0 && <p>未找到可用色号。</p>}
      {catalog.data?.activeReleaseId &&
        catalog.data.releaseId !== catalog.data.activeReleaseId && (
          <p className="text-(--gc-text-muted)">
            活动主库已更新；当前结果仍固定在打开时的版本。
          </p>
        )}

      {presentation === "swatch-card" ? (
        <TooltipProvider delay={180}>
          <div
            className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.85fr)_minmax(14rem,0.85fr)] gap-4 overflow-hidden"
            aria-label="潘通双栏选色"
          >
            <div className="flex min-h-0 min-w-0 flex-col gap-2" aria-label="潘通颜色网格">
              <ul
                className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(4rem,1fr))] content-start gap-2 overflow-auto pr-1"
                aria-label="色号搜索结果"
              >
                {colorResults}
              </ul>
              {pagination}
            </div>
            <aside className="min-h-0 min-w-0 overflow-hidden pr-1" aria-label="潘通色卡预览">
              {previewColor?.hex ? (
                <Card className="h-full max-h-full gap-0 overflow-hidden border border-(--gc-border) bg-(--gc-panel) py-0 ring-0">
                  <div
                    className="min-h-32 flex-1 border-b border-(--gc-border)"
                    style={{ backgroundColor: previewColor.hex }}
                    aria-hidden="true"
                  />
                  <CardContent className="shrink-0 space-y-3 px-4 py-4">
                    <div className="space-y-1">
                      <p className="text-[10px] font-semibold tracking-[0.22em] text-(--gc-text-muted)">PANTONE</p>
                      <p className="break-words text-xl font-semibold leading-tight text-(--gc-text)">{previewColor.code}</p>
                    </div>
                    <dl className="space-y-2 text-xs">
                      <div className="space-y-1">
                        <dt className="text-(--gc-text-muted)">色库</dt>
                        <dd className="break-words font-medium text-(--gc-text)">{pantoneLibraryLabel(previewColor.libraryKey)}</dd>
                      </div>
                      <div className="space-y-1">
                        <dt className="text-(--gc-text-muted)">HEX</dt>
                        <dd className="font-mono font-semibold text-(--gc-text)">{previewColor.hex}</dd>
                      </div>
                    </dl>
                    {selectedCatalogIds?.has(previewColor.id) && (
                      <p className="inline-flex rounded-full border border-(--gc-accent)/45 bg-(--gc-accent)/10 px-2 py-1 text-[10px] font-medium text-(--gc-accent)">
                        已选择
                      </p>
                    )}
                  </CardContent>
                </Card>
              ) : (
                <Card className="h-full min-h-64 items-center justify-center border border-dashed border-(--gc-border) bg-(--gc-panel) px-6 text-center text-xs text-(--gc-text-muted) ring-0">
                  选择或悬停左侧颜色以查看色卡
                </Card>
              )}
            </aside>
          </div>
        </TooltipProvider>
      ) : (
        <>
          <ul
            className="min-h-0 flex-1 space-y-1 overflow-auto"
            aria-label="色号搜索结果"
          >
            {colorResults}
          </ul>
          {pagination}
        </>
      )}
    </section>
  );
}

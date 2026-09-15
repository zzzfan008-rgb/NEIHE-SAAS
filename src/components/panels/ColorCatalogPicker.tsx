import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

      <ul
        className="min-h-0 flex-1 space-y-1 overflow-auto"
        aria-label="色号搜索结果"
      >
        {!snapshotMismatch &&
          catalog.data?.colors.map((color) => {
            const canSelect = selectable(color, snapshotReleaseId);
            return (
              <li key={color.id}>
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto w-full justify-start py-2 text-xs"
                  disabled={
                    disabled ||
                    maxReached ||
                    !canSelect ||
                    selectedCatalogIds?.has(color.id)
                  }
                  onClick={() => {
                    if (!canSelect || !snapshotReleaseId || !color.hex) return;
                    onSelect({
                      catalogId: color.id,
                      releaseId: snapshotReleaseId,
                      libraryKey: color.libraryKey,
                      code: color.code,
                      hex: color.hex,
                    });
                  }}
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
          })}
      </ul>
      <div className="flex justify-between gap-2">
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
    </section>
  );
}

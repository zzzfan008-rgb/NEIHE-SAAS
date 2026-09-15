import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ColorCatalogPicker,
  type CatalogSelection,
} from "@/components/panels/ColorCatalogPicker";
import { useColorQuery } from "@/lib/colorManagementClient";
import { PANTONE_TCX_LIBRARY_KEY } from "@/lib/pantoneLibraries";
import type {
  BrandColorMember,
  ColorBrand,
  ColorGroup,
  ColorSeries,
} from "@/types/brandColors";

interface Page<T> {
  items: T[];
  nextOffset: number | null;
}

type GroupDetail = ColorGroup & { members: BrandColorMember[] };
const usePublicColorQuery = <T,>(path: string | null, revision = 0) =>
  useColorQuery<T>(path, revision, "color-tool");

export interface ColorSystemBrowserProps {
  selectedCatalogIds: ReadonlySet<string>;
  remaining: number;
  onSelect: (selection: CatalogSelection, source: "pantone" | "brand") => void;
}

function BrandGroups({
  kind,
  selectedCatalogIds,
  remaining,
  onSelect,
}: ColorSystemBrowserProps & { kind: ColorBrand["kind"] }) {
  const brands = usePublicColorQuery<Page<ColorBrand>>(
    "/brands?limit=100&offset=0",
  );
  const visibleBrands = useMemo(
    () => brands.data?.items.filter((brand) => brand.kind === kind) ?? [],
    [brands.data, kind],
  );
  const [brandId, setBrandId] = useState("");
  const [seriesId, setSeriesId] = useState("__all_series__");
  const [groupId, setGroupId] = useState("");
  const [groupOffset, setGroupOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (visibleBrands.some((brand) => brand.id === brandId)) return;
    setBrandId(visibleBrands[0]?.id ?? "");
  }, [brandId, visibleBrands]);
  useEffect(() => {
    setSeriesId("__all_series__");
    setGroupId("");
    setGroupOffset(0);
    setError(undefined);
  }, [brandId]);
  useEffect(() => {
    setGroupId("");
    setGroupOffset(0);
    setError(undefined);
  }, [seriesId]);

  const series = usePublicColorQuery<Page<ColorSeries>>(
    brandId
      ? `/series?brandId=${encodeURIComponent(brandId)}&limit=100&offset=0`
      : null,
    revision,
  );
  const groups = usePublicColorQuery<Page<ColorGroup>>(
    brandId
      ? `/groups?brandId=${encodeURIComponent(brandId)}${seriesId === "__all_series__" ? "" : `&seriesId=${encodeURIComponent(seriesId)}`}&limit=25&offset=${groupOffset}`
      : null,
    revision,
  );
  const group = usePublicColorQuery<GroupDetail>(
    groupId ? `/groups/${encodeURIComponent(groupId)}` : null,
    revision,
  );

  const addMember = (member: BrandColorMember) => {
    if (selectedCatalogIds.has(member.catalogId)) return;
    if (remaining <= 0) {
      setError("面料配色最多选择 8 个颜色");
      return;
    }
    setError(undefined);
    onSelect(
      {
        catalogId: member.catalogId,
        releaseId: member.releaseId,
        libraryKey: member.libraryKey,
        code: member.code,
        hex: member.hex,
      },
      "brand",
    );
  };
  const addGroup = () => {
    const available = (group.data?.members ?? []).filter(
      (member) => !selectedCatalogIds.has(member.catalogId),
    );
    if (available.length > remaining) {
      setError(
        `该主题有 ${available.length} 个未选颜色，当前仅剩 ${remaining} 个名额；请单独选择。`,
      );
      return;
    }
    setError(undefined);
    available.forEach((member) => addMember(member));
  };

  if (brands.error) {
    return (
      <p role="alert" className="text-xs text-red-400">
        {brands.error}
      </p>
    );
  }
  if (!brands.data)
    return (
      <p role="status" className="text-xs">
        读取品牌色系…
      </p>
    );
  if (visibleBrands.length === 0) {
    return (
      <p className="text-xs text-(--gc-text-muted)">暂未配置可用品牌色系。</p>
    );
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(11rem,0.7fr)_minmax(0,1.5fr)] gap-3">
      <div className="flex min-h-0 flex-col gap-2">
        {visibleBrands.length > 1 && (
          <Select
            value={brandId}
            onValueChange={(value) => {
              if (value) setBrandId(value);
            }}
          >
            <SelectTrigger aria-label="参考品牌" className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent positionerClassName="z-[90]" className="z-[90]">
              {visibleBrands.map((brand) => (
                <SelectItem key={brand.id} value={brand.id}>
                  {brand.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {(series.data?.items.length ?? 0) > 0 && (
          <Select
            value={seriesId}
            onValueChange={(value) => {
              if (value) setSeriesId(value);
            }}
          >
            <SelectTrigger aria-label="系列与季节" className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent positionerClassName="z-[90]" className="z-[90]">
              <SelectItem value="__all_series__">全部系列</SelectItem>
              {series.data!.items.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {[item.year, item.season, item.name]
                    .filter(Boolean)
                    .join(" · ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div
          className="min-h-0 flex-1 space-y-1 overflow-auto"
          aria-label="主题色组"
        >
          {groups.error && (
            <div className="space-y-1">
              <p role="alert" className="text-xs text-red-400">
                {groups.error}
              </p>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => setRevision((value) => value + 1)}
              >
                重试色组
              </Button>
            </div>
          )}
          {groups.data?.items.map((item) => (
            <Button
              key={item.id}
              type="button"
              variant={groupId === item.id ? "secondary" : "ghost"}
              className="h-auto w-full justify-start py-2 text-left text-xs"
              onClick={() => {
                setGroupId(item.id);
                setError(undefined);
              }}
            >
              {item.name}
            </Button>
          ))}
          {groups.data?.items.length === 0 && (
            <p className="text-xs text-(--gc-text-muted)">暂无主题色组。</p>
          )}
        </div>
        <div className="flex justify-between">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={groupOffset === 0}
            onClick={() => setGroupOffset(Math.max(0, groupOffset - 25))}
          >
            上一页
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={groups.data?.nextOffset == null}
            onClick={() => setGroupOffset(groups.data!.nextOffset!)}
          >
            下一页
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-col gap-2 rounded-md border border-(--gc-border) p-2">
        {!groupId && (
          <p className="text-xs text-(--gc-text-muted)">
            选择一个主题色组查看颜色。
          </p>
        )}
        {group.error && (
          <p role="alert" className="text-xs text-red-400">
            {group.error}
          </p>
        )}
        {group.data && (
          <>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h4 className="truncate text-xs font-medium">
                  {group.data.name}
                </h4>
                <p className="text-[10px] text-(--gc-text-muted)">
                  {group.data.members.length} 色
                </p>
              </div>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={group.data.members.length === 0}
                onClick={addGroup}
              >
                整组加入
              </Button>
            </div>
            <ul
              className="min-h-0 flex-1 space-y-1 overflow-auto"
              aria-label={`${group.data.name} 色组颜色`}
            >
              {group.data.members.map((member) => {
                const selected = selectedCatalogIds.has(member.catalogId);
                return (
                  <li key={member.catalogId}>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={selected || (remaining <= 0 && !selected)}
                      aria-pressed={selected}
                      className="h-auto w-full justify-start gap-2 py-2 text-xs"
                      onClick={() => addMember(member)}
                    >
                      <span
                        aria-hidden="true"
                        className="size-6 shrink-0 rounded border border-(--gc-border)"
                        style={{ backgroundColor: member.hex }}
                      />
                      <span className="min-w-0 text-left">
                        <span className="block break-all">{member.code}</span>
                        <span className="block break-all text-[10px] text-(--gc-text-muted)">
                          {member.libraryKey} · {member.hex}
                          {member.ratio === null
                            ? ""
                            : ` · ${(member.ratio * 100).toFixed(2)}%`}
                        </span>
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {error && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export function ColorSystemBrowser(props: ColorSystemBrowserProps) {
  return (
    <Tabs defaultValue="catalog" className="flex min-h-[20rem] flex-1 flex-col">
      <TabsList className="grid h-9 w-full grid-cols-3 bg-(--gc-control)">
        <TabsTrigger value="catalog" className="text-xs">
          全系列
        </TabsTrigger>
        <TabsTrigger value="neihe" className="text-xs">
          NEIHE Color
        </TabsTrigger>
        <TabsTrigger value="reference" className="text-xs">
          参考品牌
        </TabsTrigger>
      </TabsList>
      <TabsContent value="catalog" className="flex min-h-0 flex-1 pt-2">
        <ColorCatalogPicker
          queryHook={usePublicColorQuery}
          defaultLibraryKey={PANTONE_TCX_LIBRARY_KEY}
          presentation="swatch-card"
          selectedCatalogIds={props.selectedCatalogIds}
          maxReached={props.remaining <= 0}
          onSelect={(selection) => props.onSelect(selection, "pantone")}
        />
      </TabsContent>
      <TabsContent value="neihe" className="flex min-h-0 flex-1 pt-2">
        <BrandGroups {...props} kind="neihe" />
      </TabsContent>
      <TabsContent value="reference" className="flex min-h-0 flex-1 pt-2">
        <BrandGroups {...props} kind="reference" />
      </TabsContent>
    </Tabs>
  );
}

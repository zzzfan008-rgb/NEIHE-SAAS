import { useCallback, useEffect, useRef, useState } from "react";
import {
  useFlowStore,
} from "@/store/flowStore";
import { Button } from "@/components/ui/button";
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ASSET_CATEGORIES, isEditableAssetCategory, type EditableAssetCategory } from "@/lib/assetCategories";
import type { Asset } from "@/types/workflow";
import { thumbnailImageUrl } from "@/lib/images";
import type { AssetPickerRequest } from "@/lib/overlayEvents";
import { EyeIcon, InfoIcon, Trash2Icon } from "lucide-react";
import { MaterialAnalysisDialog } from "@/components/MaterialAnalysisDialog";
import { MaterialAssetDetailsDialog } from "@/components/MaterialAssetDetailsDialog";

const CATEGORY_TABS = [
  ["all", "全部"],
  ...ASSET_CATEGORIES,
] as const;

type CategoryFilter = (typeof CATEGORY_TABS)[number][0];

const PAGE_SIZE = 20;
type AssetSortValue = "name:asc" | "name:desc" | "createdAt:asc" | "createdAt:desc";
const ASSET_SORT_OPTIONS: ReadonlyArray<{ value: AssetSortValue; label: string }> = [
  { value: "name:asc", label: "名称正序" },
  { value: "name:desc", label: "名称倒序" },
  { value: "createdAt:asc", label: "时间正序" },
  { value: "createdAt:desc", label: "时间倒序" },
];

/** 素材库选择浮层：按分类筛选 + 名称搜索，选中后写回目标图片上传节点 */
export function AssetPickerOverlay({
  request,
  onRequestChange,
}: {
  request: AssetPickerRequest;
  onRequestChange: (request: AssetPickerRequest | null) => void;
}) {
  const assignImageInputInTab = useFlowStore((s) => s.assignImageInputInTab);
  const viewer = useFlowStore((s) => s.viewer);
  const openViewer = useFlowStore((s) => s.openViewer);
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortValue, setSortValue] = useState<AssetSortValue>("createdAt:desc");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assetToDelete, setAssetToDelete] = useState<Asset | null>(null);
  const [deletingAssetId, setDeletingAssetId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  const [pickingAssetId, setPickingAssetId] = useState<string | null>(null);
  const [savingCategoryId, setSavingCategoryId] = useState<string | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [materialAsset, setMaterialAsset] = useState<Asset | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const requestGeneration = useRef(0);
  const previewButtons = useRef(new Map<string, HTMLButtonElement>());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const assetScrollRef = useRef<HTMLDivElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async (offset: number) => {
    if (offset > 0) {
      if (loadingMoreRef.current) return;
      loadingMoreRef.current = true;
    } else {
      loadingMoreRef.current = false;
    }
    const generation = offset === 0 ? requestGeneration.current + 1 : requestGeneration.current;
    if (offset === 0) {
      requestGeneration.current = generation;
      setAssets([]);
      setHasMore(false);
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      const [sortBy, sortOrder] = sortValue.split(":") as ["name" | "createdAt", "asc" | "desc"];
      params.set("sortBy", sortBy);
      params.set("sortOrder", sortOrder);
      if (category !== "all") params.set("category", category);
      if (debouncedSearch) params.set("search", debouncedSearch);
      const res = await fetch(`/api/assets?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const page = (await res.json()) as Asset[];
      if (!Array.isArray(page)) throw new Error("素材数据格式无效");
      if (generation !== requestGeneration.current) return;
      setAssets((current) => {
        if (offset === 0) return page;
        const ids = new Set(current.map((asset) => asset.id));
        return [...current, ...page.filter((asset) => !ids.has(asset.id))];
      });
      setHasMore(page.length === PAGE_SIZE);
    } catch (err) {
      if (generation !== requestGeneration.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (offset > 0) loadingMoreRef.current = false;
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [category, debouncedSearch, sortValue]);

  // 打开、切换分类或搜索词变化时都从第一页重新拉取
  useEffect(() => {
    void load(0);
    return () => { requestGeneration.current += 1; };
  }, [request, load, refreshKey]);

  const refreshAssets = () => {
    requestGeneration.current += 1;
    setRefreshKey((value) => value + 1);
  };

  useEffect(() => {
    const root = assetScrollRef.current;
    const sentinel = loadMoreSentinelRef.current;
    if (!root || !sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || loading || !hasMore || loadingMoreRef.current) return;
        void load(assets.length);
      },
      { root, rootMargin: "160px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [assets.length, hasMore, load, loading]);

  useEffect(() => {
    if (!previewAssetId || viewer) return;
    const frame = requestAnimationFrame(() => {
      previewButtons.current.get(previewAssetId)?.focus();
      setPreviewAssetId(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [previewAssetId, viewer]);

  const pick = async (asset: Asset) => {
    if (request.mode === "browse") {
      viewAsset(asset, `card:${asset.id}`);
      return;
    }
    if (request.mode === "conversation") {
      setPickingAssetId(asset.id);
      setError(null);
      try {
        const response = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/references`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: request.target.projectId }),
        });
        const body = await response.json().catch(() => null) as { error?: unknown } | null;
        if (!response.ok) {
          throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`);
        }
        request.onSelect({
          sourceRef: `asset/${asset.id}`,
          previewRef: asset.image,
          label: asset.name,
        });
        onRequestChange(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPickingAssetId(null);
      }
      return;
    }
    assignImageInputInTab(request.target, request.nodeId, asset.image);
    onRequestChange(null);
  };

  const viewAsset = (asset: Asset, focusKey = asset.id) => {
    setPreviewAssetId(focusKey);
    openViewer({ url: asset.image, title: asset.name, meta: "资产库", assetCategory: asset.category });
  };

  const deleteAsset = async () => {
    if (!assetToDelete) return;
    setDeletingAssetId(assetToDelete.id);
    setDeleteError(null);
    try {
      const response = await fetch(`/api/assets/${encodeURIComponent(assetToDelete.id)}`, {
        method: "DELETE",
      });
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      if (!response.ok) {
        throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`);
      }
      // Deletion shifts server offsets; discard pending pages and rebuild the list.
      refreshAssets();
      setAssetToDelete(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingAssetId(null);
    }
  };

  const changeCategory = async (asset: Asset, nextCategory: EditableAssetCategory) => {
    if (savingCategoryId || nextCategory === asset.category) return;
    setSavingCategoryId(asset.id);
    setCategoryError(null);
    try {
      const response = await fetch(`/api/assets/${encodeURIComponent(asset.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: nextCategory }),
      });
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      if (!response.ok) {
        throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`);
      }
      searchInputRef.current?.focus();
      refreshAssets();
    } catch (err) {
      setCategoryError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingCategoryId(null);
    }
  };

  return (
    <>
      <Dialog
        open={!viewer && !analysisOpen && !materialAsset}
        onOpenChange={(open) => {
          if (!open && !viewer && !analysisOpen && !materialAsset) onRequestChange(null);
        }}
      >
        <DialogContent
          showCloseButton={false}
          overlayClassName="z-50 bg-[color-mix(in_srgb,var(--gc-shell)_82%,transparent)] backdrop-blur-xs"
          className="z-[51] flex max-h-[80vh] w-[min(680px,calc(100vw-3rem))] max-w-none flex-col gap-0 overflow-hidden rounded-lg border border-[var(--gc-border)] bg-[var(--gc-panel)] p-0 text-[var(--gc-text)] ring-0 sm:max-w-none"
        >
          <div className="flex items-center justify-between border-b border-[var(--gc-border)] px-4 py-3">
            <div>
              <DialogTitle className="text-xs font-medium tracking-widest text-[var(--gc-text)]">
                {request.mode === "browse"
                  ? "资产库"
                  : request.mode === "conversation"
                    ? request.purpose === "new-base" ? "开始新修改：选择底图" : request.purpose === "base" ? "选择对话底图" : "添加对话参考图"
                    : "从素材库选择"}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {request.mode === "browse"
                  ? "已保存的图片素材"
                  : request.mode === "conversation"
                    ? request.purpose === "new-base" ? "选择素材后会创建独立图片对话" : "选择素材后会关联到当前项目，并作为对话修改输入"
                    : "选择当前图片节点的素材"}
              </DialogDescription>
            </div>
            <DialogClose render={<Button type="button" variant="outline" size="xs" />}>
              关闭
            </DialogClose>
          </div>

          <Tabs value={category} onValueChange={(value) => setCategory(value as CategoryFilter)} className="min-h-0 flex-1 gap-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--gc-border)] px-4 py-2.5">
              <TabsList aria-label="素材分类" className="bg-[var(--gc-control)]">
              {CATEGORY_TABS.map(([key, label]) => (
                <TabsTrigger
                  key={key}
                  value={key}
                  className="text-xs text-[var(--gc-text-muted)] data-active:bg-[var(--gc-panel)] data-active:text-[var(--gc-text)]"
                >
                  {label}
                </TabsTrigger>
              ))}
              </TabsList>
            {request.mode === "browse" && (
              <Button type="button" size="xs" onClick={() => { setCategory("fabric"); setAnalysisOpen(true); }}>
                上传并分析
              </Button>
            )}
            <Select value={sortValue} onValueChange={(value) => setSortValue(value as AssetSortValue)}>
              <SelectTrigger size="sm" aria-label="素材排序" className="w-28 border-[var(--gc-border)] bg-[var(--gc-control)] text-[10px] text-[var(--gc-text)]">
                <SelectValue>{ASSET_SORT_OPTIONS.find((option) => option.value === sortValue)?.label}</SelectValue>
              </SelectTrigger>
              <SelectContent positionerClassName="z-[70]" className="z-[70] border-[var(--gc-border)] bg-[var(--gc-panel)] text-[var(--gc-text)]">
                {ASSET_SORT_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <label className="ml-auto w-44">
              <span className="sr-only">搜索素材名称</span>
              <Input
                ref={searchInputRef}
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索素材名称"
                className="h-7 rounded-md bg-[var(--gc-control)] text-xs"
              />
            </label>
          </div>

          <TabsContent value={category} className="min-h-0 flex-1 overflow-hidden p-0">
            <div ref={assetScrollRef} data-asset-scroll-container className="h-full overflow-y-auto p-4">
            {categoryError && <p role="alert" className="mb-2 text-xs text-[var(--gc-text)]">分类保存失败：{categoryError}</p>}
            {error && (
              <div className="py-6 text-center">
                <p className="text-[10px] text-[var(--gc-text-muted)]">素材服务暂不可用（{error}）</p>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => void load(0)}
                  className="mt-2"
                >
                  重试
                </Button>
              </div>
            )}
            {!error && loading && assets.length === 0 && (
              <p className="py-6 text-center text-[10px] text-[var(--gc-text-muted)]">加载中…</p>
            )}
            {!error && !loading && assets.length === 0 && (
              <p className="py-6 text-center text-[10px] text-[var(--gc-text-muted)]">
                {debouncedSearch ? "没有匹配的素材" : "暂无素材"}
              </p>
            )}
            {assets.length > 0 && (
              <div className="grid grid-cols-4 gap-2.5">
                {assets.map((asset) => (
                  <div
                    key={asset.id}
                    data-asset-card-id={asset.id}
                    className="group relative overflow-hidden rounded-md border border-[var(--gc-border)] bg-[var(--gc-control)] transition-colors hover:border-[var(--gc-accent)] focus-within:border-[var(--gc-accent)]"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => void pick(asset)}
                      disabled={pickingAssetId !== null}
                      ref={(element) => {
                        if (request.mode !== "browse") return;
                        if (element) previewButtons.current.set(`card:${asset.id}`, element);
                        else previewButtons.current.delete(`card:${asset.id}`);
                      }}
                      title={asset.name}
                      className="h-auto w-full flex-col items-stretch gap-0 rounded-none p-0 text-left hover:bg-transparent focus-visible:ring-2 focus-visible:ring-[var(--gc-accent)]"
                    >
                      <img
                        src={asset.thumbnail ?? thumbnailImageUrl(asset.image)}
                        alt={asset.name}
                        loading="lazy"
                        decoding="async"
                        className="aspect-square w-full bg-[var(--gc-control)] object-cover"
                      />
                      <span className="truncate px-1.5 py-1 text-[10px] font-normal text-[var(--gc-text)]">
                        {asset.name}
                      </span>
                    </Button>
                    <div className="absolute right-1.5 top-1.5 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      {asset.category === "fabric" && (
                        <Button type="button" variant="secondary" size="icon-xs"
                          aria-label={`查看面料校准信息 ${asset.name}`} title="面料校准信息"
                          onClick={() => setMaterialAsset(asset)}
                          className="border border-[var(--gc-border)] bg-[var(--gc-panel)]/95 text-[var(--gc-text)] shadow-sm hover:bg-[var(--gc-panel-hover)]">
                          <InfoIcon />
                        </Button>
                      )}
                      <Button
                        ref={(element) => {
                          if (element) previewButtons.current.set(asset.id, element);
                          else previewButtons.current.delete(asset.id);
                        }}
                        type="button"
                        variant="secondary"
                        size="icon-xs"
                        aria-label={`查看图片 ${asset.name}`}
                        title="查看图片"
                        onClick={() => viewAsset(asset)}
                        className="border border-[var(--gc-border)] bg-[var(--gc-panel)]/95 text-[var(--gc-text)] shadow-sm hover:bg-[var(--gc-panel-hover)]"
                      >
                        <EyeIcon />
                      </Button>
                      {asset.canManage && (
                        <Button
                          type="button"
                          variant="destructive"
                          size="icon-xs"
                          aria-label={`删除素材 ${asset.name}`}
                          title="删除素材"
                          onClick={() => {
                            setDeleteError(null);
                            setAssetToDelete(asset);
                          }}
                          className="border border-[var(--gc-border)] bg-[var(--gc-panel)]/95 text-destructive shadow-sm hover:bg-[var(--gc-panel-hover)]"
                        >
                          <Trash2Icon />
                        </Button>
                      )}
                    </div>
                    {asset.canManage ? (
                      <Select
                        value={asset.category}
                        disabled={Boolean(savingCategoryId)}
                        onValueChange={(value) => {
                          if (isEditableAssetCategory(value)) void changeCategory(asset, value);
                        }}
                      >
                        <SelectTrigger size="sm" aria-label={`分类 ${asset.name}`} className="m-1 w-[calc(100%-0.5rem)] border-[var(--gc-border)] bg-[var(--gc-panel)] text-[10px] text-[var(--gc-text)]">
                          <SelectValue>{ASSET_CATEGORIES.find(([key]) => key === asset.category)?.[1] ?? "未分类"}</SelectValue>
                        </SelectTrigger>
                        <SelectContent positionerClassName="z-[70]" className="z-[70] border-[var(--gc-border)] bg-[var(--gc-panel)] text-[var(--gc-text)]">
                          {ASSET_CATEGORIES.map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    ) : (
                      <p className="px-2 pb-2 text-[10px] text-[var(--gc-text-muted)]">{ASSET_CATEGORIES.find(([key]) => key === asset.category)?.[1] ?? "未分类"}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
            {hasMore && (
              <div
                ref={loadMoreSentinelRef}
                data-asset-load-sentinel
                aria-live="polite"
                className="flex min-h-8 items-center justify-center text-[10px] text-[var(--gc-text-muted)]"
              >
                {loading ? "加载中…" : "继续向下滚动加载更多素材"}
              </div>
            )}
            {!hasMore && assets.length > 0 && !loading && (
              <p aria-live="polite" className="py-3 text-center text-[10px] text-[var(--gc-text-muted)]">已加载全部素材</p>
            )}
            </div>
          </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      <MaterialAnalysisDialog
        open={analysisOpen}
        onOpenChange={setAnalysisOpen}
        onSaved={() => { setCategory("fabric"); refreshAssets(); }}
      />

      <MaterialAssetDetailsDialog
        asset={materialAsset}
        onOpenChange={(open) => { if (!open) setMaterialAsset(null); }}
        onUpdated={refreshAssets}
      />

      <AlertDialog
        open={assetToDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deletingAssetId) {
            setAssetToDelete(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent
          finalFocus={searchInputRef}
          overlayClassName="z-[60] bg-[color-mix(in_srgb,var(--gc-shell)_82%,transparent)] backdrop-blur-xs"
          className="z-[61] border border-[var(--gc-border)] bg-[var(--gc-panel)] text-[var(--gc-text)] ring-0"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>删除素材</AlertDialogTitle>
            <AlertDialogDescription className="text-[var(--gc-text-muted)]">
              “{assetToDelete?.name}”将移入回收状态并在 15 天后清理。正在被项目使用的素材不能删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {deleteError}
            </p>
          )}
          <AlertDialogFooter className="border-[var(--gc-border)] bg-[var(--gc-control)]/50">
            <AlertDialogCancel disabled={Boolean(deletingAssetId)}>取消</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              disabled={Boolean(deletingAssetId)}
              onClick={() => void deleteAsset()}
            >
              {deletingAssetId ? "删除中…" : "确认删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useFlowStore,
} from "@/store/flowStore";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Asset } from "@/types/workflow";
import { thumbnailImageUrl } from "@/lib/images";
import type { AssetPickerRequest } from "@/lib/overlayEvents";

const CATEGORY_TABS = [
  ["all", "全部"],
  ["print", "印花"],
  ["fabric", "面料"],
  ["reference", "参考"],
] as const;

type CategoryFilter = (typeof CATEGORY_TABS)[number][0];

const PAGE_SIZE = 20;

/** 素材库选择浮层：按分类筛选 + 名称搜索，选中后写回目标图片上传节点 */
export function AssetPickerOverlay({
  request,
  onRequestChange,
}: {
  request: AssetPickerRequest;
  onRequestChange: (request: AssetPickerRequest | null) => void;
}) {
  const assignImageInputInTab = useFlowStore((s) => s.assignImageInputInTab);
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async (offset: number) => {
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
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [category, debouncedSearch]);

  // 打开、切换分类或搜索词变化时都从第一页重新拉取
  useEffect(() => {
    void load(0);
  }, [request, load]);

  const pick = (asset: Asset) => {
    assignImageInputInTab(request.target, request.nodeId, asset.image);
    onRequestChange(null);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onRequestChange(null); }}>
      <DialogContent
        showCloseButton={false}
        overlayClassName="z-50 bg-[color-mix(in_srgb,var(--gc-shell)_82%,transparent)] backdrop-blur-xs"
        className="z-[51] flex max-h-[80vh] w-[min(680px,calc(100vw-3rem))] max-w-none flex-col gap-0 overflow-hidden rounded-lg border border-[var(--gc-border)] bg-[var(--gc-panel)] p-0 text-[var(--gc-text)] ring-0"
      >
        <div className="flex items-center justify-between border-b border-[var(--gc-border)] px-4 py-3">
          <div>
            <DialogTitle className="text-xs font-medium tracking-widest text-[var(--gc-text)]">从素材库选择</DialogTitle>
            <DialogDescription className="mt-1 text-[10px] text-[var(--gc-text-muted)]">
              按分类筛选素材，选择后写入当前图片节点
            </DialogDescription>
          </div>
          <DialogClose render={<Button type="button" variant="outline" size="xs" />}>
            关闭
          </DialogClose>
        </div>

        <div className="flex items-center gap-2 border-b border-[var(--gc-border)] px-4 py-2.5">
          <div className="flex gap-1">
            {CATEGORY_TABS.map(([key, label]) => (
              <Button
                key={key}
                type="button"
                variant={category === key ? "default" : "outline"}
                size="xs"
                aria-pressed={category === key}
                onClick={() => setCategory(key)}
                className="text-[10px]"
              >
                {label}
              </Button>
            ))}
          </div>
          <label className="ml-auto w-44">
            <span className="sr-only">搜索素材名称</span>
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索素材名称"
              className="h-7 rounded-md bg-[var(--gc-control)] text-xs"
            />
          </label>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
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
              {debouncedSearch ? "没有匹配的素材" : "暂无素材，可在印花提取节点中「存为素材」"}
            </p>
          )}
          {assets.length > 0 && (
            <div className="grid grid-cols-4 gap-2.5">
              {assets.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => pick(asset)}
                  title={asset.name}
                  className="overflow-hidden rounded-md border border-[var(--gc-border)] bg-[var(--gc-control)] text-left transition-colors hover:border-[var(--gc-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gc-accent)]"
                >
                  <img
                    src={asset.thumbnail ?? thumbnailImageUrl(asset.image)}
                    alt={asset.name}
                    loading="lazy"
                    decoding="async"
                    className="aspect-square w-full bg-[var(--gc-control)] object-cover"
                  />
                  <div className="truncate px-1.5 py-1 text-[10px] text-[var(--gc-text)]">{asset.name}</div>
                </button>
              ))}
            </div>
          )}
          {hasMore && (
            <Button
              type="button"
              variant="outline"
              onClick={() => void load(assets.length)}
              disabled={loading}
              className="mt-2.5 w-full border-dashed text-[10px]"
            >
              {loading ? "加载中…" : "加载更多素材"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

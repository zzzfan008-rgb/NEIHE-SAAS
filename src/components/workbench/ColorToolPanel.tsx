import { useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { StarIcon } from "lucide-react";
import { ColorSystemBrowser } from "@/components/workbench/ColorSystemBrowser";
import type { CatalogSelection } from "@/components/panels/ColorCatalogPicker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { requestCanvasCreation } from "@/lib/canvasCreation";
import { OPEN_COLOR_TOOL_EVENT, type OpenColorToolRequest } from "@/lib/colorTool";
import { normalizeColorSwatches, parseColorValue } from "@/lib/colorPalette";
import { COLOR_CATEGORIES } from "@/lib/colors";
import { useCustomColors } from "@/store/customColors";
import type { ColorSwatch } from "@/types/workflow";
import type { WorkbenchDocumentTarget } from "@/types/workbench";

type EyeDropperConstructor = new () => { open: (options: { signal: AbortSignal }) => Promise<{ sRGBHex: string }> };

const MAX_COLORS = 8;
const MY_FAVORITES_CATEGORY_ID = "my-favorites";

const PANTONE_CATEGORY_ID = "pantone";

type SelectedColor = Omit<ColorSwatch, "id">;
const selectedColorKey = (color: SelectedColor) =>
  color.pantone ? `pantone:${color.pantone.catalogId}` : `hex:${color.value}`;
export function ColorToolPanel() {
  const [target, setTarget] = useState<WorkbenchDocumentTarget>();
  const [selected, setSelected] = useState<SelectedColor[]>([]);
  const [manual, setManual] = useState("");
  const [categoryId, setCategoryId] = useState(COLOR_CATEGORIES[0].id);
  const [error, setError] = useState<string>();
  const nativePicker = useRef<HTMLInputElement>(null);
  const activePicker = useRef<AbortController | null>(null);
  const myFavoritesTab = useRef<HTMLButtonElement>(null);
  const favoriteControlRefs = useRef(new Map<string, HTMLButtonElement>());
  const directPickingSupported = typeof window !== "undefined"
    && typeof (window as typeof window & { EyeDropper?: EyeDropperConstructor }).EyeDropper === "function";
  const {
    colors, recent, favorites, pantoneFavorites, favoritesSyncing, favoritesSyncError,
    add, rememberRecent, refreshFavorites, toggleFavorite, togglePantoneFavorite,
  } = useCustomColors();

  useEffect(() => () => {
    activePicker.current?.abort();
    activePicker.current = null;
  }, [target]);

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<OpenColorToolRequest>).detail;
      if (!detail?.target) return;
      void refreshFavorites();
      setTarget(detail.target);
      setSelected([]);
      setManual("");
      setCategoryId(COLOR_CATEGORIES[0].id);
      setError(undefined);
    };
    window.addEventListener(OPEN_COLOR_TOOL_EVENT, listener);
    return () => window.removeEventListener(OPEN_COLOR_TOOL_EVENT, listener);
  }, [refreshFavorites]);

  const selectedKeys = useMemo(
    () => new Set(selected.map(selectedColorKey)),
    [selected],
  );
  const selectedCatalogIds = useMemo(
    () => new Set(selected.flatMap((entry) => entry.pantone ? [entry.pantone.catalogId] : [])),
    [selected],
  );
  const toggleSelected = (candidate: SelectedColor) => {
    const key = selectedColorKey(candidate);
    if (!selectedKeys.has(key) && selected.length >= MAX_COLORS) {
      setError(`面料配色最多选择 ${MAX_COLORS} 个颜色`);
      return;
    }
    setError(undefined);
    if (!candidate.pantone) rememberRecent(candidate.value);
    setSelected((current) => current.some((entry) => selectedColorKey(entry) === key)
      ? current.filter((entry) => selectedColorKey(entry) !== key)
      : current.length >= MAX_COLORS ? current : [...current, candidate]);
  };
  const toggle = (raw: string, source: ColorSwatch["source"]) => {
    try {
      toggleSelected({ value: parseColorValue(raw), source });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "颜色格式无效");
    }
  };
  const selectCatalog = (selection: CatalogSelection, source: "pantone" | "brand") => {
    toggleSelected({
      value: selection.hex,
      name: selection.code,
      source,
      pantone: {
        catalogId: selection.catalogId,
        releaseId: selection.releaseId,
        libraryKey: selection.libraryKey,
        code: selection.code,
      },
    });
  };
  const addManual = () => {
    try {
      const value = parseColorValue(manual);
      add(value);
      toggle(value, "custom");
      setManual("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "颜色格式无效");
    }
  };
  const pick = async () => {
    setError(undefined);
    const EyeDropper = (window as typeof window & { EyeDropper?: EyeDropperConstructor }).EyeDropper;
    if (typeof EyeDropper !== "function") {
      const input = nativePicker.current;
      if (!input) return;
      // Native color pickers remain available on LAN HTTP. Their own eyedropper
      // is browser-owned; do not request screen capture or weaken browser security.
      setManual(input.value);
      try {
        if (typeof input.showPicker === "function") input.showPicker();
        else input.click();
      } catch (failure) {
        console.warn("[color-tool] native picker failed", { name: failure instanceof Error ? failure.name : "UnknownError" });
        setError("无法打开系统颜色选择器，请重试或输入颜色值");
      }
      return;
    }
    if (activePicker.current) return;
    const controller = new AbortController();
    activePicker.current = controller;
    try {
      const result = await new EyeDropper().open({ signal: controller.signal });
      if (controller.signal.aborted || activePicker.current !== controller) return;
      toggle(result.sRGBHex, "eyedropper");
    } catch (failure) {
      if (controller.signal.aborted || (failure instanceof Error && failure.name === "AbortError")) return;
      console.warn("[color-tool] screen picker failed", { name: failure instanceof Error ? failure.name : "UnknownError", secureContext: window.isSecureContext });
      setError("屏幕取色失败，请重试或使用颜色值输入");
    } finally {
      if (activePicker.current === controller) activePicker.current = null;
    }
  };
  const createPalette = () => {
    if (!target) return;
    try {
      const swatches = normalizeColorSwatches(selected.map((entry) => ({
        ...entry,
        id: `color-${nanoid(8)}`,
      })));
      requestCanvasCreation({ target, intent: { type: "color-palette", swatches }, mode: "click" });
      setTarget(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法创建色板");
    }
  };

  const toggleFavoriteFromControl = (
    value: string, source: ColorSwatch["source"], values: readonly string[], index: number,
  ) => {
    const removingFromFavorites = source === "favorite" && favorites.includes(value);
    if (removingFromFavorites) {
      const nextValue = values[index + 1] ?? values[index - 1];
      const nextControl = nextValue ? favoriteControlRefs.current.get(`favorite:${nextValue}`) : undefined;
      // 先移走焦点再卸载按钮，避免 Dialog 的删除后焦点恢复覆盖后续输入。
      (nextControl ?? myFavoritesTab.current)?.focus();
    }
    void toggleFavorite(value);
  };

  const removePantoneFavorite = (index: number) => {
    const next = pantoneFavorites[index + 1] ?? pantoneFavorites[index - 1];
    const nextControl = next
      ? favoriteControlRefs.current.get(`pantone:${next.catalogId}`)
      : undefined;
    (nextControl ?? myFavoritesTab.current)?.focus();
    const favorite = pantoneFavorites[index];
    if (favorite) void togglePantoneFavorite(favorite);
  };
  const section = (
    title: string,
    values: readonly string[],
    source: ColorSwatch["source"],
    favoriteControls = false,
    emptyMessage?: string,
  ) => (
    <section className="space-y-2">
      <h3 className="text-xs font-medium text-[var(--gc-text)]">{title}</h3>
      {values.length > 0 ? (
        <div className="grid grid-cols-8 gap-1.5">
          {values.map((value, index) => {
            const favorite = favorites.includes(value);
            const rgb = Number.parseInt(value.slice(1), 16);
            const brightness = ((rgb >> 16) * 299 + ((rgb >> 8) & 255) * 587 + (rgb & 255) * 114) / 1000;
            return (
              <div key={`${source}:${value}`}
                className={`gc-color-swatch relative h-10 overflow-hidden rounded-md border ${selectedKeys.has(`hex:${value}`) ? "border-[var(--gc-accent)] ring-2 ring-[var(--gc-accent)]/40" : "border-white/15"}`}>
                <Button type="button" variant="ghost" aria-label={`${selectedKeys.has(`hex:${value}`) ? "移除" : "选择"} ${value}`}
                  aria-pressed={selectedKeys.has(`hex:${value}`)} onClick={() => toggle(value, source)}
                  className="gc-color-swatch-select block h-full w-full min-w-0 rounded-none border-0 p-0 transition-[filter] hover:brightness-110 focus-visible:ring-inset focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--gc-accent)]"
                  style={{ backgroundColor: value }} />
                {favoriteControls && (
                  <Button ref={(button) => {
                    const key = `${source}:${value}`;
                    if (button) favoriteControlRefs.current.set(key, button);
                    else favoriteControlRefs.current.delete(key);
                  }} type="button" size="icon-xs" variant="ghost"
                    aria-label={`${favorites.includes(value) ? "取消收藏" : "收藏"} ${value}`}
                    aria-pressed={favorite}
                    onClick={() => toggleFavoriteFromControl(value, source, values, index)}
                    style={{ color: brightness > 180 ? "#52565c" : "#fff8eb" }}
                    className="gc-color-swatch-favorite absolute right-0.5 top-0.5 z-10 items-start justify-end border-0 p-0.5 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--gc-accent)]">
                    <StarIcon aria-hidden="true" className="size-2.5" strokeWidth={1.75} fill={favorite ? "var(--gc-accent)" : "none"} />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      ) : emptyMessage ? (
        <p className="rounded-md border border-dashed border-[var(--gc-border)] px-3 py-4 text-center text-xs text-[var(--gc-text-muted)]">
          {emptyMessage}
        </p>
      ) : null}
    </section>
  );

  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => { if (!open) setTarget(undefined); }}>
      <DialogContent className="flex max-h-[92vh] w-[min(64rem,calc(100vw-2rem))] max-w-none flex-col overflow-hidden sm:max-w-none">
        <DialogHeader>
          <DialogTitle>色彩工具</DialogTitle>
          <DialogDescription>选择 1–8 个颜色。Pantone 色号保留主库身份；确认后新建色板节点，可连接到面料替换节点。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-0.5">
          <Tabs value={categoryId} onValueChange={setCategoryId}>
            <TabsList className="grid h-9 w-full grid-cols-5 bg-[var(--gc-control)]">
              {COLOR_CATEGORIES.map((category) => (
                <TabsTrigger key={category.id} value={category.id} className="text-xs">
                  {category.label}
                </TabsTrigger>
              ))}
              <TabsTrigger value={PANTONE_CATEGORY_ID} className="text-xs">Pantone</TabsTrigger>
              <TabsTrigger ref={myFavoritesTab} value={MY_FAVORITES_CATEGORY_ID} className="text-xs">我的收藏</TabsTrigger>
            </TabsList>
            {COLOR_CATEGORIES.map((category) => (
              <TabsContent key={category.id} value={category.id} className="pt-2">
                {section(category.label, category.swatches.map((swatch) => swatch.hex), "quick", true)}
              </TabsContent>
            ))}
            <TabsContent value={PANTONE_CATEGORY_ID} className="flex min-h-[24rem] pt-2">
              <ColorSystemBrowser
                selectedCatalogIds={selectedCatalogIds}
                remaining={MAX_COLORS - selected.length}
                onSelect={selectCatalog}
              />
            </TabsContent>
            <TabsContent value={MY_FAVORITES_CATEGORY_ID} className="space-y-3 pt-2">
              {section(
                "普通颜色收藏", favorites, "favorite", true,
                favoritesSyncing && pantoneFavorites.length === 0 ? "正在同步收藏…" : "还没有普通颜色收藏",
              )}
              {pantoneFavorites.length > 0 && (
                <section className="space-y-2">
                  <h3 className="text-xs font-medium">Pantone 收藏</h3>
                  <div className="grid grid-cols-2 gap-2">
                    {pantoneFavorites.map((favorite, index) => {
                      const candidate: SelectedColor = {
                        value: favorite.hex, name: favorite.code, source: "pantone",
                        pantone: {
                          catalogId: favorite.catalogId, releaseId: favorite.releaseId,
                          libraryKey: favorite.libraryKey, code: favorite.code,
                        },
                      };
                      const selectedFavorite = selectedKeys.has(selectedColorKey(candidate));
                      return (
                        <div key={favorite.catalogId} className="flex min-w-0 items-center gap-1 rounded-md border border-(--gc-border) p-1">
                          <Button type="button" variant="ghost" aria-pressed={selectedFavorite}
                            className="h-auto min-w-0 flex-1 justify-start gap-2 px-2 py-1.5 text-xs"
                            onClick={() => toggleSelected(candidate)}>
                            <span aria-hidden="true" className="size-6 shrink-0 rounded border border-(--gc-border)" style={{ backgroundColor: favorite.hex }} />
                            <span className="min-w-0 text-left"><span className="block break-all">{favorite.code}</span><span className="block break-all text-[10px] text-(--gc-text-muted)">{favorite.libraryKey} · {favorite.hex}</span></span>
                          </Button>
                          <Button ref={(button) => {
                            const key = `pantone:${favorite.catalogId}`;
                            if (button) favoriteControlRefs.current.set(key, button);
                            else favoriteControlRefs.current.delete(key);
                          }} type="button" size="icon-xs" variant="ghost"
                            aria-label={`取消收藏 ${favorite.code}`}
                            onClick={() => removePantoneFavorite(index)}>
                            <StarIcon aria-hidden="true" className="size-3" fill="var(--gc-accent)" />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}
            </TabsContent>
          </Tabs>
          {section("我的颜色", colors, "custom", true)}
          {section("最近使用", recent, "recent", true)}
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-[var(--gc-text)]">颜色值与取色</h3>
            <div className="flex gap-2">
              <input aria-label="颜色值" value={manual} onChange={(event) => setManual(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addManual(); }}
                placeholder="#RGB、#RRGGBB、rgb() 或 hsl()" className="h-9 min-w-0 flex-1 rounded-md border border-[var(--gc-border)] bg-[var(--gc-control)] px-3 font-mono text-xs outline-none focus:border-[var(--gc-accent)]" />
              <Button type="button" variant="outline" onClick={addManual}>添加</Button>
              <Button type="button" variant="outline" onClick={() => void pick()}>屏幕取色</Button>
              <input ref={nativePicker} type="color" defaultValue="#000000" tabIndex={-1}
                aria-label="系统颜色选择器" className="sr-only"
                onChange={(event) => { setManual(event.target.value); setError(undefined); }} />
            </div>
            {!directPickingSupported && <p className="text-xs text-[var(--gc-text-muted)]">将打开系统颜色选择器；如面板提供吸管，可用它进行屏幕取色。选好颜色后点击“添加”。</p>}
          </section>
          {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
          {favoritesSyncError && <p role="alert" className="text-xs text-red-500">{favoritesSyncError}</p>}
        </div>
        <div className="space-y-2 border-t border-(--gc-border) pt-3">
          <div className="flex min-w-0 items-center gap-2">
            <strong className="shrink-0 text-xs">已选 {selected.length}/{MAX_COLORS}</strong>
            <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto" aria-label="已选颜色">
              {selected.map((entry) => (
                <Button key={selectedColorKey(entry)} type="button" size="xs" variant="outline"
                  className="h-auto shrink-0 gap-1 px-2 py-1 text-[10px]"
                  aria-label={`移除 ${entry.name ?? entry.value}`}
                  onClick={() => toggleSelected(entry)}>
                  <span className="size-3 rounded-sm border border-white/15" style={{ backgroundColor: entry.value }} />
                  {entry.name ?? entry.value}
                </Button>
              ))}
            </div>
            {selected.length > 0 && <Button type="button" size="xs" variant="ghost" onClick={() => setSelected([])}>清空</Button>}
          </div>
          <div className="flex flex-wrap gap-1">
            {selected.map((entry) => entry.pantone ? (
              <Button key={`favorite:${selectedColorKey(entry)}`} type="button" size="xs" variant="ghost"
                onClick={() => void togglePantoneFavorite({ ...entry.pantone!, hex: entry.value })}>
                {pantoneFavorites.some((favorite) => favorite.catalogId === entry.pantone!.catalogId) ? "取消收藏" : "收藏"} {entry.pantone.code}
              </Button>
            ) : (
              <Button key={`favorite:${selectedColorKey(entry)}`} type="button" size="xs" variant="ghost" onClick={() => void toggleFavorite(entry.value)}>
                {favorites.includes(entry.value) ? "取消收藏" : "收藏"} {entry.value}
              </Button>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setTarget(undefined)}>取消</Button>
            <Button type="button" disabled={selected.length === 0} onClick={createPalette}>创建新色板节点</Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

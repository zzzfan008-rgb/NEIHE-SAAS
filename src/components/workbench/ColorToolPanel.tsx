import { useEffect, useMemo, useState } from "react";
import { nanoid } from "nanoid";
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
import type { ColorSwatchSource } from "@/types/workflow";
import type { WorkbenchDocumentTarget } from "@/types/workbench";

type EyeDropperConstructor = new () => { open: () => Promise<{ sRGBHex: string }> };

const MAX_COLORS = 8;

export function ColorToolPanel() {
  const [target, setTarget] = useState<WorkbenchDocumentTarget>();
  const [selected, setSelected] = useState<Array<{ value: string; source: ColorSwatchSource }>>([]);
  const [manual, setManual] = useState("");
  const [categoryId, setCategoryId] = useState(COLOR_CATEGORIES[0].id);
  const [error, setError] = useState<string>();
  const { colors, recent, favorites, add, rememberRecent, toggleFavorite } = useCustomColors();

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<OpenColorToolRequest>).detail;
      if (!detail?.target) return;
      setTarget(detail.target);
      setSelected([]);
      setManual("");
      setCategoryId(COLOR_CATEGORIES[0].id);
      setError(undefined);
    };
    window.addEventListener(OPEN_COLOR_TOOL_EVENT, listener);
    return () => window.removeEventListener(OPEN_COLOR_TOOL_EVENT, listener);
  }, []);

  const selectedValues = useMemo(() => new Set(selected.map((entry) => entry.value)), [selected]);
  const toggle = (raw: string, source: ColorSwatchSource) => {
    try {
      const value = parseColorValue(raw);
      if (!selectedValues.has(value) && selectedValues.size >= MAX_COLORS) {
        setError(`面料配色最多选择 ${MAX_COLORS} 个颜色`);
        return;
      }
      setError(undefined);
      rememberRecent(value);
      setSelected((current) => current.some((entry) => entry.value === value)
        ? current.filter((entry) => entry.value !== value)
        : current.length >= MAX_COLORS ? current : [...current, { value, source }]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "颜色格式无效");
    }
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
    const EyeDropper = (window as typeof window & { EyeDropper?: EyeDropperConstructor }).EyeDropper;
    if (!EyeDropper) { setError("当前浏览器不支持屏幕取色，请使用色块或颜色值输入"); return; }
    try {
      const result = await new EyeDropper().open();
      toggle(result.sRGBHex, "eyedropper");
    } catch { /* user cancelled */ }
  };
  const createPalette = () => {
    if (!target) return;
    try {
      const swatches = normalizeColorSwatches(selected.map((entry) => ({
        id: `color-${nanoid(8)}`,
        value: entry.value,
        source: entry.source,
      })));
      requestCanvasCreation({ target, intent: { type: "color-palette", swatches }, mode: "click" });
      setTarget(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法创建色板");
    }
  };

  const section = (title: string, values: readonly string[], source: ColorSwatchSource) => values.length > 0 && (
    <section className="space-y-2">
      <h3 className="text-xs font-medium text-[var(--gc-text)]">{title}</h3>
      <div className="grid grid-cols-8 gap-1.5">
        {values.map((value) => (
          <button key={`${source}:${value}`} type="button" aria-label={`${selectedValues.has(value) ? "移除" : "选择"} ${value}`}
            aria-pressed={selectedValues.has(value)} onClick={() => toggle(value, source)}
            className={`h-8 rounded-md border transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gc-accent)] ${selectedValues.has(value) ? "border-[var(--gc-accent)] ring-2 ring-[var(--gc-accent)]/40" : "border-white/15"}`}
            style={{ backgroundColor: value }} />
        ))}
      </div>
    </section>
  );

  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => { if (!open) setTarget(undefined); }}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-auto">
        <DialogHeader>
          <DialogTitle>色彩工具</DialogTitle>
          <DialogDescription>选择 1–8 个颜色。确认后新建色板节点，可连接到面料替换节点的色板输入。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Tabs value={categoryId} onValueChange={setCategoryId}>
            <TabsList className="grid h-9 w-full grid-cols-3 bg-[var(--gc-control)]">
              {COLOR_CATEGORIES.map((category) => (
                <TabsTrigger key={category.id} value={category.id} className="text-xs">
                  {category.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {COLOR_CATEGORIES.map((category) => (
              <TabsContent key={category.id} value={category.id} className="pt-2">
                {section(category.label, category.swatches.map((swatch) => swatch.hex), "quick")}
              </TabsContent>
            ))}
          </Tabs>
          {section("我的颜色", colors, "custom")}
          {section("最近使用", recent, "recent")}
          {section("收藏", favorites, "favorite")}
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-[var(--gc-text)]">颜色值与取色</h3>
            <div className="flex gap-2">
              <input aria-label="颜色值" value={manual} onChange={(event) => setManual(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addManual(); }}
                placeholder="#RGB、#RRGGBB、rgb() 或 hsl()" className="h-9 min-w-0 flex-1 rounded-md border border-[var(--gc-border)] bg-[var(--gc-control)] px-3 font-mono text-xs outline-none focus:border-[var(--gc-accent)]" />
              <Button type="button" variant="outline" onClick={addManual}>添加</Button>
              <Button type="button" variant="outline" onClick={() => void pick()}>屏幕取色</Button>
            </div>
          </section>
          {selected.length > 0 && (
            <section className="space-y-2">
              <div className="flex items-center justify-between"><h3 className="text-xs font-medium">已选 {selected.length}/{MAX_COLORS}</h3><Button type="button" size="sm" variant="ghost" onClick={() => setSelected([])}>清空</Button></div>
              <div className="flex flex-wrap gap-2">{selected.map(({ value }) => (
                <button key={value} type="button" onClick={() => toggle(value, "quick")} className="flex items-center gap-1 rounded-md border border-[var(--gc-border)] px-2 py-1 font-mono text-[10px]">
                  <span className="h-3 w-3 rounded-sm border border-white/15" style={{ backgroundColor: value }} />{value}
                </button>
              ))}</div>
              <div className="flex flex-wrap gap-1">{selected.map(({ value }) => (
                <Button key={`favorite:${value}`} type="button" size="sm" variant="ghost" onClick={() => toggleFavorite(value)}>{favorites.includes(value) ? "取消收藏" : "收藏"} {value}</Button>
              ))}</div>
            </section>
          )}
          {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setTarget(undefined)}>取消</Button>
          <Button type="button" disabled={selected.length === 0} onClick={createPalette}>创建新色板节点</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

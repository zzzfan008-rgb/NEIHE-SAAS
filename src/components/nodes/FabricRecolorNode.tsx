import { useRef, useState } from "react";
import { Position, type NodeProps, type Node } from "@xyflow/react";
import { NodeHandle as Handle } from "./NodeHandle";
import {
  commitDocumentMutation,
  selectActiveDocument,
  selectActiveEdges,
  selectActiveNodes,
  useFlowStore,
} from "@/store/flowStore";
import { useCustomColors } from "@/store/customColors";
import { isNodeRunActive, type ColorPaletteNodeData, type FabricRecolorNodeData } from "@/types/workflow";
import { NodeFrame, RunButton, Developing } from "./NodeFrame";
import { ImageGrid } from "./ImageGrid";
import { ModelControls } from "./ModelControls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PipetteIcon } from "lucide-react";
import {
  COLOR_CATEGORIES,
  buildRecolorPrompt,
  isValidHex,
  nameOfColor,
  normalizeHex,
} from "@/lib/colors";

const MAX_COLORS = 8;
const CUSTOM_CATEGORY_ID = "custom";

export function FabricRecolorNode({
  id,
  data,
  selected,
}: NodeProps<Node<FabricRecolorNodeData>>) {
  const updateNodeData = useFlowStore((s) => s.updateNodeData);
  const runNode = useFlowStore((s) => s.runNode);
  const document = useFlowStore(selectActiveDocument);
  const hasFabricInput = useFlowStore((state) => {
    const inputs = selectActiveEdges(state).filter((edge) => edge.target === id);
    return inputs.some((edge) => edge.targetHandle === "fabric")
      || inputs.filter((edge) => edge.targetHandle === "references").length >= 2;
  });
  const paletteNode = useFlowStore((state): Node<ColorPaletteNodeData> | undefined => {
    const edge = selectActiveEdges(state).find((candidate) => candidate.target === id && candidate.targetHandle === "palette");
    const source = edge ? selectActiveNodes(state).find((candidate) => candidate.id === edge.source) : undefined;
    return source?.data.kind === "color-palette" ? source as Node<ColorPaletteNodeData> : undefined;
  });
  const running = isNodeRunActive(data.status);
  const runAccepted = useFlowStore((state) => state.recentResults.some((record) => (
    record.projectId === document.projectId && record.nodeId === id && Boolean(record.runId) && isNodeRunActive(record.status)
  )));
  const colorEditingDisabled = document.readOnly || (data.status === "queued" && !runAccepted);

  const localColors = data.colors ?? [];
  const colors = paletteNode ? paletteNode.data.swatches.map((swatch) => swatch.value) : localColors;
  const [hexInput, setHexInput] = useState("");
  const [categoryId, setCategoryId] = useState(COLOR_CATEGORIES[0].id);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [colorPickerError, setColorPickerError] = useState<string>();
  const colorPickerTriggerRef = useRef<HTMLButtonElement>(null);

  const customColors = useCustomColors((s) => s.colors);
  const addCustomColor = useCustomColors((s) => s.add);
  const removeCustomColor = useCustomColors((s) => s.remove);

  /** 页签 = 三个预置分类 + 自定义色 */
  const tabs = [
    ...COLOR_CATEGORIES.map((c) => ({ id: c.id, label: c.label })),
    { id: CUSTOM_CATEGORY_ID, label: "自定义色" },
  ];

  /** 当前页签展示的色块（自定义页签取用户保存的颜色，名即色值） */
  const activeSwatches =
    categoryId === CUSTOM_CATEGORY_ID
      ? customColors.map((hex) => ({ name: hex, hex }))
      : (COLOR_CATEGORIES.find((c) => c.id === categoryId) ?? COLOR_CATEGORIES[0]).swatches;

  const applyColors = (next: string[]) => {
    if (paletteNode) {
      if (next.length === 0) return;
      const existing = new Map(paletteNode.data.swatches.map((swatch) => [swatch.value.toLowerCase(), swatch]));
      const swatches: ColorPaletteNodeData["swatches"] = next.map((value) => (
        existing.get(value.toLowerCase()) ?? {
          id: `recolor-${value.slice(1).toLowerCase()}`,
          value: value as `#${string}`,
          name: nameOfColor(value),
          source: categoryId === CUSTOM_CATEGORY_ID ? "custom" : "quick",
        }
      ));
      commitDocumentMutation((tab) => ({
        nodes: tab.nodes.map((node) => {
          if (node.id === paletteNode.id && node.data.kind === "color-palette") {
            return { ...node, data: { ...node.data, swatches, error: undefined } };
          }
          if (node.id === id && node.data.kind === "fabric-recolor") {
            return { ...node, data: { ...node.data, error: undefined } };
          }
          return node;
        }),
      }));
      return;
    }
    updateNodeData(id, {
      colors: next,
      prompt: next.length > 0 ? buildRecolorPrompt(next) : "",
      error: undefined,
    });
  };

  const toggleColor = (hex: string) => {
    if (colorEditingDisabled) return;
    if (colors.includes(hex)) {
      applyColors(colors.filter((c) => c !== hex));
    } else if (colors.length < MAX_COLORS) {
      applyColors([...colors, hex]);
    }
  };

  const addCustomHex = (): boolean => {
    if (colorEditingDisabled) return false;
    if (!isValidHex(hexInput)) {
      setColorPickerError("请输入有效的 #RRGGBB 色值");
      return false;
    }
    const hex = normalizeHex(hexInput);
    if (!colors.includes(hex) && colors.length >= MAX_COLORS) {
      setColorPickerError(`最多选择 ${MAX_COLORS} 个颜色，请先移除一个颜色`);
      return false;
    }
    addCustomColor(hex); // 保存到自定义色分类（localStorage 持久化）
    if (!colors.includes(hex)) applyColors([...colors, hex]);
    setColorPickerError(undefined);
    setHexInput("");
    return true;
  };
  const closeColorPicker = (discardDraft = false) => {
    if (discardDraft) setHexInput("");
    setColorPickerError(undefined);
    setColorPickerOpen(false);
    requestAnimationFrame(() => colorPickerTriggerRef.current?.focus());
  };
  const confirmCustomHex = () => {
    if (addCustomHex()) closeColorPicker();
  };

  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        id="references"
        style={{ top: "38%" }}
        title="主服装图与面料参考图（按连线顺序）"
      />
      <Handle
        type="target"
        position={Position.Left}
        id="palette"
        style={{ top: "76%" }}
        title="目标色板输入"
      />
      <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected}>
        <div className="rounded-md border border-[#262626] bg-[#0f0f0f] px-2 py-1.5 text-[10px] leading-relaxed text-neutral-500">
          参考图输入口按顺序接收主服装图和目标面料图；色板是独立颜色数据，不计入参考图。
        </div>

        <div className="grid grid-cols-3 gap-1" role="group" aria-label="替换模式">
          {([['fabric', '仅面料'], ['color', '仅配色'], ['combined', '面料+配色']] as const).map(([operationMode, label]) => (
            <Button
              key={operationMode}
              type="button"
              variant={data.operationMode === operationMode ? "secondary" : "outline"}
              size="xs"
              disabled={running}
              aria-pressed={data.operationMode === operationMode}
              onClick={() => updateNodeData(id, { operationMode, error: undefined })}
              className="px-1 text-[9px]"
            >
              {label}
            </Button>
          ))}
        </div>

        {paletteNode && (
          <p className="rounded-md border border-gold/30 bg-gold/10 px-2 py-1 text-[9px] text-gold">
            已连接“{paletteNode.data.label}”：
            {colors.length > MAX_COLORS
              ? `色板超过 8 色，本节点仅按顺序使用前 8 个，后 ${colors.length - MAX_COLORS} 个不会生成；`
              : `使用其 ${colors.length} 个颜色；`}
            点击下方颜色会同步更新该色板。
          </p>
        )}

        {/* 已选配色（最多 8 色，点击移除） */}
        <div className="flex min-h-[22px] flex-wrap items-center gap-1 rounded-md border border-[#262626] bg-[#0f0f0f] px-1.5 py-1" aria-label="已选配色">
          {colors.length === 0 ? (
            <span className="text-[10px] text-neutral-600">已选配色（最多 8 色，每色出 1 张图）</span>
          ) : (
            colors.map((hex) => (
              <Button
                key={hex}
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => toggleColor(hex)}
                title={paletteNode && colors.length === 1 ? `${nameOfColor(hex)} ${hex} · 至少保留一个颜色` : `${nameOfColor(hex)} ${hex} · 点击移除`}
                disabled={colorEditingDisabled || Boolean(paletteNode && colors.length === 1)}
                aria-pressed="true"
                className="h-auto rounded-xs border border-[#333] bg-[#161616] px-1 py-0.5 text-[9px] font-normal text-neutral-300 hover:border-red-400/60 hover:bg-[#161616] focus-visible:border-gold focus-visible:ring-2 focus-visible:ring-gold/40"
              >
                <span
                  className="h-2.5 w-2.5 rounded-[2px]"
                  style={{ backgroundColor: hex }}
                />
                {nameOfColor(hex)}
              </Button>
            ))
          )}
        </div>

        {/* 色板常显：分类页签 + 色块网格 */}
        <div className="nodrag rounded-md border border-[#262626] bg-[#161616] p-1.5">
          <div className="mb-1.5 grid grid-cols-4 gap-1">
            {tabs.map((cat) => (
              <Button
                key={cat.id}
                type="button"
                variant={cat.id === categoryId ? "secondary" : "outline"}
                size="xs"
                onClick={() => setCategoryId(cat.id)}
                aria-pressed={cat.id === categoryId}
                className="px-1 text-[10px]"
              >
                {cat.label}
              </Button>
            ))}
          </div>

          <div className="grid max-h-[132px] grid-cols-6 gap-1 overflow-y-auto pr-0.5">
            {activeSwatches.length === 0 && categoryId === CUSTOM_CATEGORY_ID ? (
              <span className="col-span-6 py-2 text-center text-[10px] text-neutral-600">
                还没有自定义颜色，用下方取色器添加
              </span>
            ) : (
              activeSwatches.map((c) => {
                const active = colors.includes(c.hex);
                const cannotRemoveLastPaletteColor = Boolean(paletteNode && active && colors.length === 1);
                return (
                  <Button
                    key={c.hex}
                    type="button"
                    variant="ghost"
                    size="xs"
                    title={cannotRemoveLastPaletteColor ? `${c.name} ${c.hex} · 至少保留一个颜色` : `${c.name} ${c.hex}`}
                    onClick={() => toggleColor(c.hex)}
                    disabled={colorEditingDisabled || cannotRemoveLastPaletteColor}
                    onContextMenu={(e) => {
                      // 自定义色：右键从色板删除
                      if (categoryId === CUSTOM_CATEGORY_ID) {
                        e.preventDefault();
                        removeCustomColor(c.hex);
                      }
                    }}
                    aria-pressed={active}
                    className="h-auto min-w-0 flex-col gap-0.5 rounded-none p-0 font-normal hover:bg-transparent focus-visible:opacity-90"
                  >
                    <span
                      className={`h-5 w-full rounded-xs border transition-transform hover:scale-105 ${
                        active
                          ? "border-gold ring-1 ring-[#C9A66B]"
                          : "border-white/15"
                      }`}
                      style={{ backgroundColor: c.hex }}
                    />
                    <span
                      className={`w-full truncate text-center text-[8px] leading-tight ${
                        active ? "text-gold" : "text-neutral-500"
                      }`}
                    >
                      {c.name}
                    </span>
                  </Button>
                );
              })
            )}
          </div>

          {/* 自定义取色器只在自定义色页签内显示，确认后才写入节点并关闭。 */}
          {categoryId === CUSTOM_CATEGORY_ID && (
            <div className="mt-1.5 flex justify-end">
              <Popover
                open={colorPickerOpen}
                onOpenChange={(open) => {
                  if (open) {
                    setColorPickerError(undefined);
                    if (!isValidHex(hexInput)) setHexInput("#C9A66B");
                    setColorPickerOpen(true);
                  } else {
                    closeColorPicker(true);
                  }
                }}
              >
                <PopoverTrigger
                  render={(
                    <Button
                      ref={colorPickerTriggerRef}
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={colorEditingDisabled}
                      aria-label="打开自定义取色器"
                      className="h-7 border-[#333] text-[10px] text-neutral-300 hover:border-gold/60"
                    >
                      <PipetteIcon aria-hidden="true" />
                      自定义取色
                    </Button>
                  )}
                />
                <PopoverContent side="right" align="start" className="w-64 space-y-3 p-3">
                  <div>
                    <h4 className="text-xs font-medium text-[var(--gc-text)]">自定义取色</h4>
                    <p className="mt-1 text-[10px] text-[var(--gc-text-muted)]">选择颜色并确认后，颜色才会加入当前面料配色。</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      disabled={colorEditingDisabled}
                      value={isValidHex(hexInput) ? normalizeHex(hexInput) : "#C9A66B"}
                      onChange={(event) => setHexInput(event.target.value)}
                      aria-label="自定义取色"
                      className="h-9 w-11 cursor-pointer rounded-md border border-[var(--gc-border)] bg-transparent p-0"
                    />
                    <Input
                      type="text"
                      disabled={colorEditingDisabled}
                      value={hexInput}
                      onChange={(event) => setHexInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.nativeEvent.isComposing && !colorEditingDisabled) confirmCustomHex();
                      }}
                      aria-label="自定义颜色值"
                      placeholder="#RRGGBB"
                      className="h-9 flex-1 font-mono text-xs"
                    />
                  </div>
                  {colorPickerError && <p role="alert" className="text-[10px] text-[var(--gc-danger)]">{colorPickerError}</p>}
                  <div className="flex justify-end gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => closeColorPicker(true)}>取消</Button>
                    <Button type="button" size="sm" disabled={colorEditingDisabled || !isValidHex(hexInput)} onClick={confirmCustomHex}>确认</Button>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>

        <ModelControls nodeId={id} modelId={data.modelId} modelOptions={data.modelOptions} disabled={running} />
        <RunButton
          status={data.status}
          onClick={() => void runNode(id)}
          label={data.operationMode === "fabric" ? "替换面料" : data.operationMode === "color" ? "替换配色" : "替换面料与配色"}
          disabled={
            data.operationMode === "fabric" ? !hasFabricInput && !data.fabricImageUrl
              : data.operationMode === "color" ? colors.length === 0
                : colors.length === 0 || (!hasFabricInput && !data.fabricImageUrl)
          }
        />
        {running && <Developing />}
        <ImageGrid images={data.outputImages} />
      </NodeFrame>
      <Handle type="source" position={Position.Right} id="image" />
    </>
  );
}

import { useState } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { selectActiveEdges, selectActiveNodes, useFlowStore } from "@/store/flowStore";
import { useCustomColors } from "@/store/customColors";
import { isNodeRunActive, type ColorPaletteNodeData, type FabricRecolorNodeData } from "@/types/workflow";
import { NodeFrame, RunButton, Developing } from "./NodeFrame";
import { ImageGrid } from "./ImageGrid";
import { ModelControls } from "./ModelControls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

  const localColors = data.colors ?? [];
  const colors = paletteNode ? paletteNode.data.swatches.map((swatch) => swatch.value) : localColors;
  const [hexInput, setHexInput] = useState("");
  const [categoryId, setCategoryId] = useState(COLOR_CATEGORIES[0].id);

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
    updateNodeData(id, {
      colors: next,
      prompt: next.length > 0 ? buildRecolorPrompt(next) : "",
      error: undefined,
    });
  };

  const toggleColor = (hex: string) => {
    if (paletteNode) return;
    if (localColors.includes(hex)) {
      applyColors(localColors.filter((c) => c !== hex));
    } else if (localColors.length < MAX_COLORS) {
      applyColors([...localColors, hex]);
    }
  };

  const addCustomHex = () => {
    if (!isValidHex(hexInput)) return;
    const hex = normalizeHex(hexInput);
    addCustomColor(hex); // 保存到自定义色分类（localStorage 持久化）
    if (!paletteNode && !localColors.includes(hex) && localColors.length < MAX_COLORS) {
      applyColors([...localColors, hex]);
    }
    setHexInput("");
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
            已连接“{paletteNode.data.label}”：使用其 {colors.length} 个颜色；节点内临时颜色仅作断开后的备用。
          </p>
        )}

        {/* 已选配色（最多 3 色，点击移除） */}
        <div className="flex min-h-[22px] flex-wrap items-center gap-1 rounded-md border border-[#262626] bg-[#0f0f0f] px-1.5 py-1" aria-label="已选配色">
          {colors.length === 0 ? (
            <span className="text-[10px] text-neutral-600">已选配色（最多 8 色，每色出 1 张图）</span>
          ) : (
            colors.map((hex) => (
              <button
                key={hex}
                type="button"
                onClick={() => toggleColor(hex)}
                title={`${nameOfColor(hex)} ${hex} · 点击移除`}
                aria-pressed="true"
                className="flex items-center gap-1 rounded-xs border border-[#333] bg-[#161616] px-1 py-0.5 text-[9px] text-neutral-300 outline-hidden transition-colors hover:border-red-400/60 focus-visible:border-gold focus-visible:ring-2 focus-visible:ring-gold/40"
              >
                <span
                  className="h-2.5 w-2.5 rounded-[2px]"
                  style={{ backgroundColor: hex }}
                />
                {nameOfColor(hex)}
              </button>
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
                return (
                  <button
                    key={c.hex}
                    type="button"
                    title={`${c.name} ${c.hex}`}
                    onClick={() => toggleColor(c.hex)}
                    disabled={Boolean(paletteNode)}
                    onContextMenu={(e) => {
                      // 自定义色：右键从色板删除
                      if (categoryId === CUSTOM_CATEGORY_ID) {
                        e.preventDefault();
                        removeCustomColor(c.hex);
                      }
                    }}
                    aria-pressed={active}
                    className="flex flex-col items-center gap-0.5 outline-hidden transition-opacity focus-visible:opacity-90"
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
                  </button>
                );
              })
            )}
          </div>

          {/* 自定义色值输入（仅在自定义色页签内显示） */}
          {categoryId === CUSTOM_CATEGORY_ID && (
            <div className="mt-1.5 flex items-center gap-1">
              <input
                type="color"
                value={isValidHex(hexInput) ? normalizeHex(hexInput) : "#C9A66B"}
                onChange={(e) => setHexInput(e.target.value)}
                aria-label="自定义取色"
                className="h-6 w-7 cursor-pointer rounded-xs border border-[#333] bg-transparent p-0"
                title="自定义取色"
              />
              <Input
                type="text"
                value={hexInput}
                onChange={(e) => setHexInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addCustomHex()}
                placeholder="#RRGGBB"
                className="h-6 flex-1 rounded-xs border border-[#333] bg-[#0f0f0f] px-1.5 font-mono text-[10px] text-neutral-200 shadow-none placeholder:text-neutral-600 focus:border-gold/60 focus-visible:ring-0"
              />
              <Button
                type="button"
                onClick={addCustomHex}
                disabled={!isValidHex(hexInput)}
                variant="outline"
                size="xs"
                className="h-6 rounded-xs border border-[#333] px-2 text-[10px] text-neutral-300 hover:border-gold/60 disabled:opacity-40"
              >
                添加
              </Button>
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

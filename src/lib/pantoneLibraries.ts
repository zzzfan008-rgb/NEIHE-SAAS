export const PANTONE_TCX_LIBRARY_KEY = "pantone-f-h-cotton-tcx";

const PRINT_USAGE = "主要面向印刷，更适合吊牌、包装、宣传物料。";

const LIBRARY_GUIDANCE: Record<string, { label: string; usage: string }> = {
  [PANTONE_TCX_LIBRARY_KEY]: {
    label: "TCX（棉布色卡）",
    usage: "最适合服装面料选色、设计沟通和染厂对色。",
  },
  "pantone-f-h-paper-tpx": {
    label: "TPX（纸质色卡）",
    usage: "适合设计阶段参考；与面料实物存在差异，不宜替代布卡验色。",
  },
  "pantone-solid-coated": { label: "Solid Coated", usage: PRINT_USAGE },
  "pantone-solid-uncoated": { label: "Solid Uncoated", usage: PRINT_USAGE },
  "pantone-color-bridge-coated": { label: "Color Bridge Coated", usage: PRINT_USAGE },
  "pantone-color-bridge-uncoated": { label: "Color Bridge Uncoated", usage: PRINT_USAGE },
};

export function pantoneLibraryGuidance(libraryKey: string | undefined) {
  return libraryKey && Object.hasOwn(LIBRARY_GUIDANCE, libraryKey)
    ? LIBRARY_GUIDANCE[libraryKey]
    : undefined;
}

export function pantoneLibraryLabel(libraryKey: string): string {
  return pantoneLibraryGuidance(libraryKey)?.label ?? libraryKey;
}

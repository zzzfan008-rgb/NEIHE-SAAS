import type { ColorSwatch, ColorSwatchSource } from "../types/workflow";

export class ColorValueError extends Error {
  constructor(message = "颜色格式无效，请使用 #RGB、#RRGGBB、rgb() 或 hsl()") {
    super(message);
    this.name = "ColorValueError";
  }
}

const byteHex = (value: number) => Math.round(value).toString(16).padStart(2, "0").toUpperCase();
const assertByte = (value: number) => {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new ColorValueError("RGB 通道必须是 0–255 的整数");
  return value;
};

function hslToHex(hue: number, saturation: number, lightness: number): `#${string}` {
  if (![hue, saturation, lightness].every(Number.isFinite)) throw new ColorValueError();
  if (saturation < 0 || saturation > 100 || lightness < 0 || lightness > 100) {
    throw new ColorValueError("HSL 饱和度和亮度必须在 0–100% 之间");
  }
  const h = ((hue % 360) + 360) % 360;
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - chroma / 2;
  const [r, g, b] = h < 60 ? [chroma, x, 0]
    : h < 120 ? [x, chroma, 0]
      : h < 180 ? [0, chroma, x]
        : h < 240 ? [0, x, chroma]
          : h < 300 ? [x, 0, chroma]
            : [chroma, 0, x];
  return `#${byteHex((r + m) * 255)}${byteHex((g + m) * 255)}${byteHex((b + m) * 255)}`;
}

export function parseColorValue(input: string): `#${string}` {
  const value = input.trim();
  const shortHex = /^#([0-9a-f]{3})$/i.exec(value);
  if (shortHex) return `#${[...shortHex[1]].map((digit) => digit.repeat(2)).join("").toUpperCase()}`;
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return `#${hex[1].toUpperCase()}`;
  const rgb = /^rgb\(\s*([+-]?\d+)\s*,\s*([+-]?\d+)\s*,\s*([+-]?\d+)\s*\)$/i.exec(value);
  if (rgb) return `#${byteHex(assertByte(Number(rgb[1])))}${byteHex(assertByte(Number(rgb[2])))}${byteHex(assertByte(Number(rgb[3])))}`;
  const hsl = /^hsl\(\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*,\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))%\s*,\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))%\s*\)$/i.exec(value);
  if (hsl) return hslToHex(Number(hsl[1]), Number(hsl[2]), Number(hsl[3]));
  throw new ColorValueError();
}

export interface ColorSwatchInput {
  id?: string;
  value: string;
  name?: string;
  source: ColorSwatchSource;
}

export function normalizeColorSwatches(input: readonly ColorSwatchInput[]): ColorSwatch[] {
  const seen = new Set<string>();
  const output: ColorSwatch[] = [];
  input.forEach((candidate, index) => {
    const value = parseColorValue(candidate.value);
    if (seen.has(value)) return;
    seen.add(value);
    output.push({
      id: candidate.id?.trim() || `color-${value.slice(1).toLowerCase()}-${index + 1}`,
      value,
      source: candidate.source,
      ...(candidate.name?.trim() ? { name: candidate.name.trim() } : {}),
    });
  });
  if (output.length === 0) throw new ColorValueError("色板至少 1 个颜色");
  if (output.length > 32) throw new ColorValueError("色板最多 32 个颜色");
  return output;
}

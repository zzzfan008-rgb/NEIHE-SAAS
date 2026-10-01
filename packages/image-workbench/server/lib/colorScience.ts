import { parseColorValue } from "../../src/lib/colorPalette";
import type { SwatchColorSpace } from "../../src/types/colorCatalog";
import type { DisplayColor, LabD50 } from "../../src/types/colorImport";

// Matrices and white point: W3C CSS Color 4 sample conversions (Bradford adaptation).
// https://github.com/w3c/csswg-drafts/blob/main/css-color-4/conversions.js
const D50 = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];
const TO_D50 = [
  [1.0479297925449969, 0.022946870601609652, -0.05019226628920524],
  [0.02962780877005599, 0.9904344267538799, -0.017073799063418826],
  [-0.009243040646204504, 0.015055191490298152, 0.7518742814281371],
];
const TO_D65 = [
  [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
  [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
  [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
];
const TO_XYZ = [
  [506752 / 1228815, 87881 / 245763, 12673 / 70218],
  [87098 / 409605, 175762 / 245763, 12673 / 175545],
  [7918 / 409605, 87881 / 737289, 1001167 / 1053270],
];
const TO_RGB = [
  [12831 / 3959, -329 / 214, -1974 / 3959],
  [-851781 / 878810, 1648619 / 878810, 36519 / 878810],
  [705 / 12673, -2585 / 12673, 705 / 667],
];
const EPSILON = 216 / 24389;
const KAPPA = 24389 / 27;
const VERSION = "css4-bradford-d50-srgb-clipped-v1";
const multiply = (matrix: number[][], values: readonly number[]) =>
  matrix.map((row) =>
    row.reduce((sum, coefficient, i) => sum + coefficient * values[i], 0),
  );
const clamp = (value: number) => Math.min(1, Math.max(0, value));

function validateColor(
  space: SwatchColorSpace,
  values: readonly number[],
): void {
  const lengths = { RGB: 3, CMYK: 4, Gray: 1, Lab: 3 };
  const invalid = values.some((value, i) => {
    if (!Number.isFinite(value)) return true;
    if (space === "Lab")
      return i === 0 ? value < 0 || value > 100 : value < -128 || value > 127;
    return value < 0 || value > 1;
  });
  if (values.length !== lengths[space] || invalid) {
    throw new Error("颜色分量无效或超出范围");
  }
}

function rgbToLab(rgb: readonly number[]): LabD50 {
  const linear = rgb.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  const xyz = multiply(TO_D50, multiply(TO_XYZ, linear));
  const f = xyz
    .map((value, i) => value / D50[i])
    .map((value) =>
      value > EPSILON ? Math.cbrt(value) : (KAPPA * value + 16) / 116,
    );
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}

export function hexToLabD50(input: string): LabD50 {
  const hex = parseColorValue(input);
  return rgbToLab(
    [1, 3, 5].map(
      (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
    ),
  );
}

export function convertSwatchColor(
  space: SwatchColorSpace,
  values: readonly number[],
  labWhitePoint?: "D50",
): DisplayColor | null {
  validateColor(space, values);
  if (space === "CMYK" || (space === "Lab" && labWhitePoint !== "D50"))
    return null;
  let rgb: number[];
  let labD50: LabD50;
  let outOfGamut = false;
  if (space === "Lab") {
    labD50 = [values[0], values[1], values[2]];
    const fy = (values[0] + 16) / 116;
    const xyz = [fy + values[1] / 500, fy, fy - values[2] / 200].map((f, i) => {
      const cubed = f * f * f;
      const component = cubed > EPSILON ? cubed : (116 * f - 16) / KAPPA;
      return component * D50[i];
    });
    const linear = multiply(TO_RGB, multiply(TO_D65, xyz));
    outOfGamut = linear.some((value) => value < -1e-7 || value > 1 + 1e-7);
    rgb = linear
      .map(clamp)
      .map((value) =>
        value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055,
      );
  } else {
    rgb = space === "Gray" ? [values[0], values[0], values[0]] : [...values];
    labD50 = rgbToLab(rgb);
  }
  const hex = parseColorValue(
    `#${rgb
      .map((value) =>
        Math.round(clamp(value) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`,
  );
  return {
    hex,
    labD50,
    outOfGamut,
    conversionVersion: VERSION,
    assumption: space === "Lab" ? "declared-D50" : "untagged-sRGB",
  };
}

const radians = (degrees: number) => (degrees * Math.PI) / 180;
const cos = (degrees: number) => Math.cos(radians(degrees));
const sin = (degrees: number) => Math.sin(radians(degrees));
function hue(a: number, b: number): number {
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
}

/** CIEDE2000 with kL=kC=kH=1. Both inputs must use the same D50 reference white. */
export function deltaE2000(first: LabD50, second: LabD50): number {
  validateColor("Lab", first);
  validateColor("Lab", second);
  const [l1, a1, b1] = first;
  const [l2, a2, b2] = second;
  const averageChroma = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const power = averageChroma ** 7;
  const g = 0.5 * (1 - Math.sqrt(power / (power + 25 ** 7)));
  const ap1 = (1 + g) * a1;
  const ap2 = (1 + g) * a2;
  const cp1 = Math.hypot(ap1, b1);
  const cp2 = Math.hypot(ap2, b2);
  const h1 = hue(ap1, b1);
  const h2 = hue(ap2, b2);
  const dl = l2 - l1;
  const dc = cp2 - cp1;
  let dh = h2 - h1;
  if (cp1 * cp2 === 0) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(cp1 * cp2) * sin(dh / 2);
  let meanHue = h1 + h2;
  if (cp1 * cp2 !== 0) {
    if (Math.abs(h1 - h2) > 180) meanHue += meanHue < 360 ? 360 : -360;
    meanHue /= 2;
  }
  const meanL = (l1 + l2) / 2;
  const meanC = (cp1 + cp2) / 2;
  const t =
    1 -
    0.17 * cos(meanHue - 30) +
    0.24 * cos(2 * meanHue) +
    0.32 * cos(3 * meanHue + 6) -
    0.2 * cos(4 * meanHue - 63);
  const sl =
    1 + (0.015 * (meanL - 50) ** 2) / Math.sqrt(20 + (meanL - 50) ** 2);
  const sc = 1 + 0.045 * meanC;
  const sh = 1 + 0.015 * meanC * t;
  const rt =
    -2 *
    Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7)) *
    sin(60 * Math.exp(-(((meanHue - 275) / 25) ** 2)));
  return Math.sqrt(
    Math.max(
      0,
      (dl / sl) ** 2 +
        (dc / sc) ** 2 +
        (dH / sh) ** 2 +
        rt * (dc / sc) * (dH / sh),
    ),
  );
}

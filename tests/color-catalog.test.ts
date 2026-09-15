import assert from "node:assert/strict";
import {
  convertSwatchColor,
  deltaE2000,
  hexToLabD50,
} from "../server/lib/colorScience";
import {
  buildColorCatalog,
  normalizePantoneCode,
  recommendTcxColors,
} from "../server/lib/colorCatalog";
import { makeAse } from "./color-import-fixtures";

for (const [values, expected] of [
  [[50, 2.6772, -79.7751], 2.0425],
  [[50, 3.1571, -77.2803], 2.8615],
  [[50, 2.8361, -74.02], 3.4412],
  [[50, -1.3802, -84.2814], 1],
  [[50, -1.1848, -84.8006], 1],
  [[50, -0.9009, -85.5211], 1],
] as const) {
  assert.ok(
    Math.abs(deltaE2000(values, [50, 0, -82.7485]) - expected) < 0.0001,
  );
  assert.ok(
    Math.abs(deltaE2000([50, 0, -82.7485], values) - expected) < 0.0001,
  );
}
assert.equal(deltaE2000([50, 0, 0], [50, 0, 0]), 0);
assert.throws(() => deltaE2000([NaN, 0, 0], [0, 0, 0]));
for (const hex of [
  "#000000",
  "#FFFFFF",
  "#FF0000",
  "#00FF00",
  "#0000FF",
  "#ECDBA5",
]) {
  assert.equal(convertSwatchColor("Lab", hexToLabD50(hex), "D50")?.hex, hex);
}
assert.ok(Math.abs(hexToLabD50("#FF0000")[0] - 54.29) < 0.02);
assert.ok(Math.abs(hexToLabD50("#FF0000")[1] - 80.8) < 0.03);
assert.equal(
  convertSwatchColor("RGB", [236 / 255, 219 / 255, 165 / 255])?.hex,
  "#ECDBA5",
);
assert.equal(
  convertSwatchColor("Lab", [50, 0, 0]),
  null,
  "Unknown white point cannot produce a display color",
);
assert.equal(convertSwatchColor("CMYK", [0, 0, 0, 1]), null);
assert.equal(
  convertSwatchColor("Lab", [50, 120, -120], "D50")?.outOfGamut,
  true,
);
assert.throws(() => convertSwatchColor("RGB", [2, 0, 0]));
assert.equal(normalizePantoneCode(" PANTONE 13-1007.tcx "), "13-1007 TCX");
assert.equal(normalizePantoneCode("#ECDBA5"), null);

const source = (name: string, value: number, libraryKey = "tcx") => ({
  fileName: name,
  libraryKey,
  version: "test-v1",
  labWhitePoint: "D50" as const,
  bytes: makeAse([
    { name: "11-0001 TCX", space: "LAB ", components: [value, 0, 0] },
  ]),
});
const first = source("first.ase", 0.5);
const second = source("second.ase", 0.5);
const merged = buildColorCatalog([first, second, first]);
assert.equal(merged.length, 1);
assert.equal(merged[0].variants.length, 1);
assert.equal(merged[0].variants[0].sources.length, 2);
assert.deepEqual(merged, buildColorCatalog([second, first]));
const conflict = buildColorCatalog([first, source("other.ase", 0.6)]);
assert.equal(conflict[0].status, "conflict");
assert.equal(conflict[0].variants.length, 2);
assert.deepEqual(recommendTcxColors("#777777", conflict), []);
assert.equal(
  buildColorCatalog([first, source("other-library.ase", 0.5, "other")]).length,
  2,
);
const suggestions = recommendTcxColors("#777777", merged);
assert.equal(suggestions.length, 1);
assert.equal(suggestions[0].approximate, true);
assert.equal(suggestions[0].catalogId, merged[0].id);
const rgbSource = {
  ...first,
  bytes: makeAse([
    { name: "11-0001 TCX", space: "RGB ", components: [0.5, 0.5, 0.5] },
  ]),
};
assert.equal(
  buildColorCatalog([
    rgbSource,
    { ...rgbSource, fileName: "no-lab-white.ase", labWhitePoint: undefined },
  ])[0].status,
  "ready",
);
const repeated = buildColorCatalog([
  {
    ...first,
    bytes: makeAse(
      Array.from({ length: 3000 }, () => ({
        name: "11-0001 TCX",
        space: "LAB ",
        components: [0.5, 0, 0],
      })),
    ),
  },
]);
assert.equal(repeated[0].variants[0].sources.length, 3000);
console.log("色彩转换、CIEDE2000、来源合并/冲突与近似候选测试通过");

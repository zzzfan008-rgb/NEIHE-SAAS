import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = process.cwd();
const sourceRoots = ["src"];
const sourceExtensions = new Set([".css", ".tsx", ".ts", ".jsx", ".js"]);

function collectFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...collectFiles(path));
    else if (sourceExtensions.has(path.slice(path.lastIndexOf(".")))) files.push(path);
  }
  return files;
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function increment(map, key, count = 1) {
  map.set(key, (map.get(key) ?? 0) + count);
}

const colors = new Map();
const fontSizes = new Map();
const shadows = new Map();
const radii = new Map();
const hardcodedColorsByFile = new Map();
const themeVariableDefinitions = new Set();
const themeVariableUsageFiles = new Map();
const files = sourceRoots.flatMap((root) => collectFiles(join(repoRoot, root)));

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const source = relative(repoRoot, file);

  for (const match of text.matchAll(/(--gc-[\w-]+)\s*:\s*([^;\n]+)/g)) {
    themeVariableDefinitions.add(match[1]);
    increment(colors, `token:${match[1]}`);
  }
  for (const match of text.matchAll(/var\((--gc-[\w-]+)/g)) {
    const sources = themeVariableUsageFiles.get(match[1]) ?? new Set();
    sources.add(source);
    themeVariableUsageFiles.set(match[1], sources);
  }
  for (const match of text.matchAll(/#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\([^)]*\)/gi)) {
    increment(colors, match[0].toLowerCase());
    increment(hardcodedColorsByFile, source);
  }
  for (const match of text.matchAll(/(?:text|bg|border|from|to|via)-\[#[0-9a-f]{3,8}\]/gi)) increment(colors, match[0].toLowerCase());

  for (const match of text.matchAll(/text-\[(\d+)px\]|font-size\s*:\s*(\d+(?:\.\d+)?)px|text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b/g)) {
    const value = match[1] ? `${match[1]}px` : match[2] ? `${match[2]}px` : match[3];
    increment(fontSizes, value);
  }

  for (const match of text.matchAll(/shadow(?:-([\w/.[\]%-]+))?|box-shadow\s*:/g)) increment(shadows, match[1] ? `utility:${match[1]}` : "box-shadow");
  for (const match of text.matchAll(/rounded(?:-([\w.[\]%-]+))?|border-radius\s*:/g)) increment(radii, match[1] ? `utility:${match[1]}` : "border-radius");
}

function sortedEntries(map) {
  return Object.fromEntries([...map.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

const undefinedThemeVariables = Object.fromEntries(
  [...themeVariableUsageFiles.entries()]
    .filter(([name]) => !themeVariableDefinitions.has(name))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, sources]) => [name, [...sources].sort()]),
);

const report = {
  filesScanned: files.length,
  summary: {
    uniqueColors: colors.size,
    uniqueFontSizes: fontSizes.size,
    uniqueShadows: shadows.size,
    uniqueBorderRadii: radii.size,
    undefinedThemeVariables: Object.keys(undefinedThemeVariables).length,
  },
  undefinedThemeVariables,
  topHardcodedColorFiles: Object.fromEntries([...hardcodedColorsByFile.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 15)),
  colors: sortedEntries(colors),
  fontSizes: sortedEntries(fontSizes),
  shadows: sortedEntries(shadows),
  borderRadii: sortedEntries(radii),
};

console.log(JSON.stringify(report, null, 2));
if (Object.keys(undefinedThemeVariables).length > 0) process.exitCode = 1;

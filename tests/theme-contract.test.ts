import assert from "node:assert/strict";
import fs from "node:fs";
import {
  applyTheme,
  getAppliedTheme,
  getTheme,
  subscribeTheme,
  THEMES,
} from "../src/lib/theme";

type StorageStub = Pick<Storage, "getItem" | "setItem">;

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

function installBrowser(search: string, storedTheme: string | null = null) {
  const values = new Map<string, string>();
  if (storedTheme !== null) values.set("garment-canvas-theme", storedTheme);
  const storage: StorageStub = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
  const dataset: Record<string, string> = {};

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { search }, localStorage: storage },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { documentElement: { dataset } },
  });

  return { dataset, values };
}

function restoreGlobal(name: "window" | "document", descriptor?: PropertyDescriptor): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete (globalThis as Record<string, unknown>)[name];
}

function cssBlock(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{`, "g").exec(source);
  assert.ok(match, `缺少 CSS 作用域：${selector}`);
  const open = source.indexOf("{", match.index);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`CSS 作用域未闭合：${selector}`);
}

function declaration(source: string, property: string, expectedValue: string): void {
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedValue = expectedValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(
    source,
    new RegExp(`${escapedProperty}\\s*:\\s*${escapedValue}\\s*;`),
    `${property} 必须映射到 ${expectedValue}`,
  );
}

console.log("单一暗金主题与 Tailwind CSS 契约测试");

try {
  assert.deepEqual(THEMES.map((theme) => theme.id), ["current"]);

  installBrowser("?theme=eye", "white");
  assert.equal(getTheme(), "current", "已删除主题必须回退到暗金主题");

  installBrowser("", "white");
  assert.equal(getTheme(), "current");

  installBrowser("", "black");
  assert.equal(getTheme(), "current", "旧主题值必须迁移为暗金主题");

  installBrowser("?theme=unknown", "unknown");
  assert.equal(getTheme(), "current", "无效主题必须安全回退");

  const browser = installBrowser("", null);
  applyTheme("current");
  assert.equal(browser.dataset.theme, "current");
  assert.equal(browser.values.get("garment-canvas-theme"), undefined, "单主题无需持久化用户偏好");

  const observedThemes: string[] = [];
  const unsubscribe = subscribeTheme(() => observedThemes.push(getAppliedTheme()));
  applyTheme("current");
  applyTheme("current");
  unsubscribe();
  assert.deepEqual(observedThemes, [], "单主题无需派发主题切换事件");

  console.log("  ✓ 旧主题值安全回退，data-theme 固定为暗金主题且不再保存切换偏好");
} finally {
  restoreGlobal("window", originalWindow);
  restoreGlobal("document", originalDocument);
}

const css = fs.readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

const reducedMotionBlock = cssBlock(css, "@media (prefers-reduced-motion: reduce)");
assert.match(reducedMotionBlock, /\.gc-workflow-edge\s*\{[\s\S]*?transition:\s*none/);
assert.match(reducedMotionBlock, /\.gc-edge-flow-dots\s*\{[\s\S]*?display:\s*none/);
assert.match(reducedMotionBlock, /\.gc-node-card[\s\S]*?animation-duration:\s*0\.001ms\s*!important/);
console.log("  ✓ 减少动态效果模式禁用路径动画并压缩节点动画时长");

assert.match(css, /@import\s+["']tailwindcss["'](?:\s+source\(none\))?\s*;/);
assert.doesNotMatch(css, /@tailwind\s+(?:base|components|utilities)\s*;/);
for (const [token, value] of [
  ["--color-ink", "#0a0a0a"],
  ["--color-paper", "#fafaf8"],
  ["--color-gold", "#c9a66b"],
  ["--color-golddeep", "#896932"],
] as const) {
  declaration(css, token, value);
}
console.log("  ✓ Tailwind 4 入口与历史品牌色 token 未丢失");

const coreThemeTokens = [
  "--gc-shell",
  "--gc-canvas",
  "--gc-panel",
  "--gc-panel-hover",
  "--gc-control",
  "--gc-text",
  "--gc-text-muted",
  "--gc-border",
  "--gc-accent",
  "--gc-primary-foreground",
  "--gc-node-main",
  "--gc-node-header",
  "--gc-node-inner",
  "--gc-node-inner-hover",
  "--gc-node-border",
  "--gc-node-text",
  "--gc-node-muted",
  "--gc-node-accent",
  "--gc-handle-highlight",
  "--gc-handle-mid",
  "--gc-handle-dark",
  "--gc-handle-ring",
  "--gc-handle-glow",
];

for (const theme of ["current"] as const) {
  const block = cssBlock(css, `[data-theme="${theme}"]`);
  for (const token of coreThemeTokens) {
    assert.match(block, new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`), `${theme} 缺少 ${token}`);
  }
}
assert.doesNotMatch(css, /\[data-theme=["'](?:white|eye)["']\]/);
console.log("  ✓ 仅 current 暗金主题保留完整核心 token");

for (const [semanticToken, garmentToken] of [
  ["--color-background", "--gc-shell"],
  ["--color-foreground", "--gc-text"],
  ["--color-card", "--gc-panel"],
  ["--color-card-foreground", "--gc-text"],
  ["--color-popover", "--gc-panel"],
  ["--color-popover-foreground", "--gc-text"],
  ["--color-primary", "--gc-accent"],
  ["--color-primary-foreground", "--gc-primary-foreground"],
  ["--color-muted", "--gc-control"],
  ["--color-muted-foreground", "--gc-text-muted"],
  ["--color-accent", "--gc-panel-hover"],
  ["--color-accent-foreground", "--gc-text"],
  ["--color-border", "--gc-border"],
  ["--color-input", "--gc-border"],
  ["--color-ring", "--gc-accent"],
] as const) {
  declaration(css, semanticToken, `var(${garmentToken})`);
}

assert.doesNotMatch(css, /@custom-variant\s+dark\s+\([^;]*\.dark\s+\*[^;]*\)\s*;/);
assert.match(css, /@custom-variant\s+dark\s+\([^;]*\[data-theme=["']?current["']?\][^;]*\)\s*;/);
assert.doesNotMatch(css, /(?:^|\n)\.dark\s*\{/);
assert.doesNotMatch(cssBlock(css, "@theme inline"), /--radius-(?:sm|md|lg|xl|2xl|3xl|4xl)\s*:/);
console.log("  ✓ shadcn 语义 token 桥接暗金主题，未引入 .dark 或全局圆角双轨");

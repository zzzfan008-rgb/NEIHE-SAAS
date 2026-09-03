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

console.log("三主题与 Tailwind CSS 契约测试");

try {
  assert.deepEqual(THEMES.map((theme) => theme.id), ["current", "white", "eye"]);

  installBrowser("?theme=eye", "white");
  assert.equal(getTheme(), "eye", "URL 主题必须优先于本地偏好");

  installBrowser("", "white");
  assert.equal(getTheme(), "white");

  installBrowser("", "black");
  assert.equal(getTheme(), "white", "旧版 black 必须迁移为 white");

  installBrowser("?theme=unknown", "unknown");
  assert.equal(getTheme(), "current", "无效主题必须安全回退");

  const browser = installBrowser("", null);
  applyTheme("eye");
  assert.equal(browser.dataset.theme, "eye");
  assert.equal(browser.values.get("garment-canvas-theme"), "eye");

  const observedThemes: string[] = [];
  const unsubscribe = subscribeTheme(() => observedThemes.push(getAppliedTheme()));
  applyTheme("white");
  applyTheme("white");
  unsubscribe();
  assert.deepEqual(observedThemes, ["white"], "所有 useTheme 消费者应共享同一订阅状态且重复写入幂等");

  console.log("  ✓ URL、本地偏好、旧值迁移、data-theme 写入与跨消费者同步保持一致");
} finally {
  restoreGlobal("window", originalWindow);
  restoreGlobal("document", originalDocument);
}

const css = fs.readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

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

for (const theme of ["current", "white", "eye"] as const) {
  const block = cssBlock(css, `[data-theme="${theme}"]`);
  for (const token of coreThemeTokens) {
    assert.match(block, new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`), `${theme} 缺少 ${token}`);
  }
}
console.log("  ✓ current / white / eye 三套主题拥有完整核心 token");

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
console.log("  ✓ shadcn 语义 token 桥接三主题，未引入 .dark 或全局圆角双轨");

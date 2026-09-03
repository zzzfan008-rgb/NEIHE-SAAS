import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsRoot = path.join(repoRoot, "dist", "assets");

assert.ok(fs.existsSync(assetsRoot), "缺少 dist/assets；请先运行 Vite 构建");

const cssFiles = fs.readdirSync(assetsRoot)
  .filter((name) => name.endsWith(".css"))
  .sort();
assert.ok(cssFiles.length > 0, "Vite 构建没有生成 CSS 资源");

const css = cssFiles
  .map((name) => fs.readFileSync(path.join(assetsRoot, name), "utf8"))
  .join("\n");

function requirePattern(label, pattern) {
  if (!pattern.test(css)) throw new Error(`构建 CSS 缺少 ${label}`);
}

requirePattern("品牌背景工具类 bg-ink", /\.bg-ink(?:[,{:]|\s*\{)/);
requirePattern("品牌主色工具类 bg-gold", /\.bg-gold(?:[,{:]|\s*\{)/);
requirePattern("品牌文字工具类 text-gold", /\.text-gold(?:[,{:]|\s*\{)/);
requirePattern("响应式工具类", /\.(?:sm|md|lg)\\:/);
requirePattern("图片上传焦点 ring", /\.focus-within\\:ring-1/);
requirePattern("shadcn 弹层背景工具类", /\.bg-popover(?:[,{:]|\s*\{)/);
requirePattern("shadcn 弹层文字工具类", /\.text-popover-foreground(?:[,{:]|\s*\{)/);
requirePattern("画布节点主题样式", /\.gc-node-card/);
requirePattern("经典暗金主题", /\[data-theme=["']?current["']?\]/);
requirePattern("简白主题", /\[data-theme=["']?white["']?\]/);
requirePattern("护眼绿主题", /\[data-theme=["']?eye["']?\]/);
requirePattern("运行时主题变量", /--gc-shell\s*:/);

if (/@tailwind\s+(?:base|components|utilities)/.test(css)) {
  throw new Error("构建产物仍包含未展开的 @tailwind 指令");
}
if (/@source\s+/.test(css)) throw new Error("构建产物仍包含未消费的 @source 指令");
assert.ok(css.length > 20_000, `构建 CSS 体积异常（${css.length} bytes），可能未扫描前端源码`);

console.log(`CSS 产物门禁通过：${cssFiles.join(", ")}（${css.length} bytes）`);

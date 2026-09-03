import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_INITIAL_GZIP_BUDGET = 210_000;
export const DEFAULT_SINGLE_CHUNK_BUDGET = 500_000;

function readManifest(distRoot) {
  const manifestPath = path.join(distRoot, ".vite", "manifest.json");
  assert.ok(fs.existsSync(manifestPath), "缺少 dist/.vite/manifest.json；请启用 Vite manifest 并先构建");
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function initialChunkFiles(manifest) {
  const entries = Object.values(manifest).filter((entry) => entry?.isEntry === true);
  assert.ok(entries.length > 0, "Vite manifest 没有入口 chunk");
  const files = new Set();
  const visit = (entry) => {
    if (!entry || typeof entry.file !== "string" || files.has(entry.file)) return;
    files.add(entry.file);
    for (const importedKey of entry.imports ?? []) visit(manifest[importedKey]);
  };
  for (const entry of entries) visit(entry);
  return [...files].filter((file) => file.endsWith(".js")).sort();
}

function fileMetrics(distRoot, file) {
  const bytes = fs.readFileSync(path.join(distRoot, file));
  return { file, bytes: bytes.length, gzipBytes: gzipSync(bytes).length };
}

export function verifyBundleBudget({
  distRoot,
  initialGzipBudget = DEFAULT_INITIAL_GZIP_BUDGET,
  singleChunkBudget = DEFAULT_SINGLE_CHUNK_BUDGET,
  writeReport = true,
}) {
  const manifest = readManifest(distRoot);
  const initialChunks = initialChunkFiles(manifest).map((file) => fileMetrics(distRoot, file));
  const assetsRoot = path.join(distRoot, "assets");
  const allChunks = fs.readdirSync(assetsRoot)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => fileMetrics(distRoot, `assets/${name}`));
  const initialGzipBytes = initialChunks.reduce((total, chunk) => total + chunk.gzipBytes, 0);
  const oversizedChunks = allChunks.filter((chunk) => chunk.bytes > singleChunkBudget);
  const report = {
    budgets: { initialGzipBytes: initialGzipBudget, singleChunkBytes: singleChunkBudget },
    totals: {
      initialGzipBytes,
      initialBytes: initialChunks.reduce((total, chunk) => total + chunk.bytes, 0),
      chunkCount: allChunks.length,
    },
    initialChunks,
    allChunks,
  };

  if (writeReport) {
    fs.writeFileSync(path.join(distRoot, "bundle-budget.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
  assert.equal(
    oversizedChunks.length,
    0,
    `存在超过 ${singleChunkBudget} bytes 的 JS chunk：${oversizedChunks.map((chunk) => `${chunk.file} (${chunk.bytes})`).join(", ")}`,
  );
  assert.ok(
    initialGzipBytes <= initialGzipBudget,
    `初始必需 JS gzip ${initialGzipBytes} bytes，超过预算 ${initialGzipBudget} bytes`,
  );
  return report;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const report = verifyBundleBudget({ distRoot: path.join(repoRoot, "dist") });
  console.log(
    `包体门禁通过：初始 JS gzip ${report.totals.initialGzipBytes} / ${report.budgets.initialGzipBytes} bytes；` +
    `${report.totals.chunkCount} 个 JS chunk，单 chunk 上限 ${report.budgets.singleChunkBytes} bytes`,
  );
}

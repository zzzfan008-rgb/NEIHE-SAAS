import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_INITIAL_GZIP_BUDGET,
  DEFAULT_SINGLE_CHUNK_BUDGET,
  verifyBundleBudget,
} from "../scripts/verify-bundle-budget.mjs";

assert.equal(DEFAULT_INITIAL_GZIP_BUDGET, 210_000);
assert.equal(DEFAULT_SINGLE_CHUNK_BUDGET, 500_000);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "garment-bundle-budget-"));
  fs.mkdirSync(path.join(root, ".vite"), { recursive: true });
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets", "entry.js"), "import './vendor.js';\nconsole.log('entry');\n");
  fs.writeFileSync(path.join(root, "assets", "vendor.js"), "export const vendor = 'shared';\n");
  fs.writeFileSync(path.join(root, "assets", "lazy.js"), "export const lazy = 'deferred';\n");
  fs.writeFileSync(path.join(root, ".vite", "manifest.json"), JSON.stringify({
    "src/main.tsx": {
      file: "assets/entry.js",
      isEntry: true,
      imports: ["_vendor.js"],
      dynamicImports: ["src/lazy.tsx"],
    },
    "_vendor.js": { file: "assets/vendor.js" },
    "src/lazy.tsx": { file: "assets/lazy.js", isDynamicEntry: true },
  }));
  return root;
}

const root = fixture();
try {
  const report = verifyBundleBudget({
    distRoot: root,
    initialGzipBudget: 10_000,
    singleChunkBudget: 10_000,
    writeReport: false,
  });
  assert.deepEqual(report.initialChunks.map((chunk) => chunk.file), [
    "assets/entry.js",
    "assets/vendor.js",
  ]);
  assert.ok(!report.initialChunks.some((chunk) => chunk.file.endsWith("lazy.js")));
  assert.deepEqual(report.budgets, {
    initialGzipBytes: 10_000,
    singleChunkBytes: 10_000,
  });
  assert.throws(() => verifyBundleBudget({
    distRoot: root,
    initialGzipBudget: 1,
    singleChunkBudget: 10_000,
    writeReport: false,
  }), /初始必需 JS gzip/);
  console.log("  ✓ 包体预算固定为初始 gzip 210KB / 单 chunk 500KB，只统计入口静态依赖并阻断超预算构建");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

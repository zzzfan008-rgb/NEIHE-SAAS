import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readColorCatalogManifest } from "../server/lib/colorCatalogManifest";
import { makeAse } from "./color-import-fixtures";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-manifest-"));
try {
  const bytes = makeAse([
    { name: "11-0001 TCX", space: "LAB ", components: [0.5, 0, 0] },
  ]);
  fs.writeFileSync(path.join(root, "sample.ase"), bytes);
  const source = {
    path: "sample.ase",
    libraryKey: "tcx",
    version: "synthetic-v1",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    labWhitePoint: "D50",
  };
  const file = path.join(root, "manifest.json");
  const write = (sources: unknown[], usageRightsConfirmed = true) =>
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, usageRightsConfirmed, sources }),
    );
  write([source]);
  const parsed = readColorCatalogManifest(file);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].libraryKey, "tcx");
  assert.deepEqual(parsed[0].bytes, bytes);
  assert.equal(parsed[0].fileName, "sample.ase");
  write([source], false);
  assert.throws(() => readColorCatalogManifest(file));
  write([{ ...source, sha256: "0".repeat(64) }]);
  assert.throws(() => readColorCatalogManifest(file));
  write([{ ...source, path: "../outside.ase" }]);
  assert.throws(() => readColorCatalogManifest(file));
  write([{ ...source, path: path.join(root, "sample.ase") }]);
  assert.throws(() => readColorCatalogManifest(file));
  fs.symlinkSync("sample.ase", path.join(root, "link.ase"));
  write([{ ...source, path: "link.ase" }]);
  assert.throws(() => readColorCatalogManifest(file));
  write([{ ...source, labWhitePoint: "D65" }]);
  assert.throws(() => readColorCatalogManifest(file));
  write([source, source]);
  assert.throws(() => readColorCatalogManifest(file));
  write([]);
  assert.throws(() => readColorCatalogManifest(file));
  write([source]);
  const cli = fileURLToPath(
    new URL("../scripts/import-color-catalog.ts", import.meta.url),
  );
  const dryRun = spawnSync(
    process.execPath,
    ["--import", "tsx", cli, "--manifest", file],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://test:test@127.0.0.1:1/garment_canvas_test",
      },
    },
  );
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /"dryRun":true/);
  assert.match(dryRun.stdout, /"identities":1/);
  const incompleteApply = spawnSync(
    process.execPath,
    ["--import", "tsx", cli, "--manifest", file, "--apply"],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(incompleteApply.status, 1);
  assert.match(incompleteApply.stderr, /用法/);
  const empty = makeAse([]);
  fs.writeFileSync(path.join(root, "empty.ase"), empty);
  write([
    {
      ...source,
      path: "empty.ase",
      sha256: createHash("sha256").update(empty).digest("hex"),
    },
  ]);
  const emptyRun = spawnSync(
    process.execPath,
    ["--import", "tsx", cli, "--manifest", file],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(emptyRun.status, 1);
  assert.match(emptyRun.stderr, /空目录/);
  const fifo = path.join(root, "fifo.ase");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  write([{ ...source, path: "fifo.ase" }]);
  const fifoRun = spawnSync(
    process.execPath,
    ["--import", "tsx", cli, "--manifest", file],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(
    fifoRun.status,
    1,
    "FIFO must be rejected without waiting for a writer",
  );
  assert.match(fifoRun.stderr, /普通文件/);
  console.log(
    "主库清单：哈希、权利声明、路径/符号链接、白点与重复来源边界通过",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

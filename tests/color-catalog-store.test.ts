import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { makeAse } from "./color-import-fixtures";
import { resetPostgresTestDatabase } from "./postgresTestDatabase";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-store-"));
process.env.DATA_DIR = temp;
process.env.SQLITE_IMPORT_FILE = "missing.db";
process.env.INITIAL_ADMIN_ACCOUNT_ID = "catalog-test-admin";
process.env.INITIAL_ADMIN_PASSWORD = "Initial1234";
await resetPostgresTestDatabase();
const { initializeDatabase, closeDatabaseForTests, query, queryOne } =
  await import("../server/lib/database");
const { createSession, requireAuth, requirePasswordChanged, SESSION_COOKIE } =
  await import("../server/lib/auth");
const { colorsRouter } = await import("../server/routes/colors");
const {
  activeColorCatalog,
  publishColorCatalog,
  colorCatalogDetail,
  ColorCatalogError,
} = await import("../server/lib/colorCatalogStore");
await initializeDatabase();
const now = new Date().toISOString();
for (const id of ["reader", "admin", "change-password"]) {
  await query(
    `INSERT INTO users(id, account_id, display_name, role, password_hash, must_change_password, active, created_at, updated_at)
    VALUES ($1, $1, $1, $2, 'test-only', $3, 1, $4, $4)`,
    [
      id,
      id === "admin" ? "admin" : "user",
      id === "change-password" ? 1 : 0,
      now,
    ],
  );
}
const sessions = new Map<string, string>();
for (const id of ["reader", "admin", "change-password"])
  sessions.set(id, (await createSession(id)).token);
const app = express();
app.use(express.json());
app.use("/api", requireAuth, requirePasswordChanged);
app.use("/api/colors", colorsRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/colors`;
const get = (url: string, user = "reader", method = "GET") =>
  fetch(base + url, {
    method,
    headers: sessions.has(user)
      ? { cookie: `${SESSION_COOKIE}=${sessions.get(user)}` }
      : {},
  });
const source = (lightness: number, code = "11-0001 TCX") => ({
  libraryKey: "tcx",
  fileName: "synthetic.ase",
  version: `test-${lightness}`,
  labWhitePoint: "D50" as const,
  bytes: makeAse([
    { name: code, space: "LAB ", components: [lightness, 0, 0] },
    { name: "11-0002 TCX", space: "RGB ", components: [1, 0, 0] },
  ]),
});
try {
  assert.equal((await get("/catalog", "anonymous")).status, 401);
  assert.equal((await get("/catalog", "change-password")).status, 403);
  assert.deepEqual(await activeColorCatalog(), {
    releaseId: null,
    revision: 0,
  });
  const empty = await (await get("/catalog")).json();
  assert.equal(empty.total, 0);
  assert.equal(empty.releaseId, null);
  assert.equal((await get("/catalog", "admin", "POST")).status, 404);
  const first = await publishColorCatalog([source(0.5)], 0);
  assert.equal(first.revision, 1);
  assert.deepEqual(await publishColorCatalog([source(0.5)], 0), first);
  const pageResponse = await get("/catalog?limit=1");
  assert.equal(pageResponse.headers.get("cache-control"), "no-store");
  const page = await pageResponse.json();
  assert.equal(page.total, 2);
  assert.equal(page.colors.length, 1);
  assert.equal(page.nextOffset, 1);
  assert.equal(page.colors[0].code, "11-0001 TCX");
  assert.equal(page.colors[0].hue, "neutral");
  assert.equal("variants" in page.colors[0], false);
  const id = page.colors[0].id;
  const original = await colorCatalogDetail(id, first.releaseId!);
  const originalHex = original.color.variants[0].display?.hex;
  assert.equal(original.color.variants[0].sources[0].fileHash.length, 64);
  assert.equal((await (await get("/catalog?hue=red")).json()).total, 1);
  assert.equal(
    (await (await get("/catalog?q=0002&libraryKey=tcx&status=ready")).json())
      .total,
    1,
  );
  assert.equal((await (await get("/catalog?q=%25")).json()).total, 0);
  assert.equal(
    (await (await get("/catalog/libraries")).json()).libraries[0].ready,
    2,
  );
  for (const invalid of [
    "limit=0",
    "limit=101",
    "offset=-1",
    "hue=invalid",
    "status=invalid",
    "q=x&q=y",
    "releaseId=bad",
  ])
    assert.equal((await get(`/catalog?${invalid}`)).status, 400);
  assert.equal((await get(`/catalog/${"0".repeat(64)}`)).status, 404);
  assert.equal((await get(`/catalog?releaseId=${"0".repeat(64)}`)).status, 404);
  await assert.rejects(
    () => publishColorCatalog([source(0.6)], 0),
    (error) => error instanceof ColorCatalogError && error.status === 409,
  );
  const second = await publishColorCatalog([source(0.6)], 1);
  assert.equal(second.revision, 2);
  assert.notEqual(second.releaseId, first.releaseId);
  assert.equal(
    (await colorCatalogDetail(id, first.releaseId!)).color.variants[0].display
      ?.hex,
    originalHex,
  );
  assert.notEqual(
    (await colorCatalogDetail(id)).color.variants[0].display?.hex,
    originalHex,
  );
  const oldPage = await (
    await get(`/catalog?releaseId=${first.releaseId}&offset=1&limit=1`)
  ).json();
  assert.equal(oldPage.releaseId, first.releaseId);
  assert.equal(oldPage.activeReleaseId, second.releaseId);
  assert.equal(oldPage.colors[0].code, "11-0002 TCX");
  const results = await Promise.allSettled([
    publishColorCatalog([source(0.7)], 2),
    publishColorCatalog([source(0.8)], 2),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal((await activeColorCatalog()).revision, 3);
  assert.equal(
    (
      await queryOne<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM color_catalog_releases",
      )
    )?.count,
    3,
  );
  const before = await activeColorCatalog();
  await query(
    "INSERT INTO color_catalog_identities(id, library_key, code) VALUES ($1, 'tcx', '19-9999 TCX')",
    ["f".repeat(64)],
  );
  await assert.rejects(() =>
    publishColorCatalog([source(0.9, "19-9999 TCX")], 3),
  );
  assert.deepEqual(await activeColorCatalog(), before);
  assert.equal(
    (
      await queryOne<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM color_catalog_releases",
      )
    )?.count,
    3,
  );
  await assert.rejects(() => publishColorCatalog([], 3));
  assert.deepEqual(await activeColorCatalog(), before);
  await closeDatabaseForTests();
  await initializeDatabase();
  assert.deepEqual(await activeColorCatalog(), before);
  await publishColorCatalog(
    [
      source(0.5),
      { ...source(0.6), fileName: "second.ase" },
      {
        libraryKey: "tcx",
        fileName: "cmyk.ase",
        version: "test",
        bytes: makeAse([
          { name: "11-0003 TCX", space: "CMYK", components: [0, 0, 0, 0] },
        ]),
      },
    ],
    before.revision,
  );
  const conflicts = await (await get("/catalog?status=conflict")).json();
  assert.equal(conflicts.total, 1);
  assert.equal(conflicts.colors[0].hex, null);
  const unconverted = await (await get("/catalog?status=unconverted")).json();
  assert.equal(unconverted.total, 1);
  assert.equal(unconverted.colors[0].hex, null);
  assert.equal(unconverted.colors[0].hue, null);
  assert.equal((await (await get("/catalog?hue=red")).json()).total, 1);
  const entry = fs.readFileSync(
    new URL("../server/index.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    entry.indexOf('app.use("/api/colors", colorsRouter)') >
      entry.indexOf('app.use("/api", requireAuth, requirePasswordChanged)'),
  );
  console.log(
    "主库持久化：真实鉴权、分页/筛选、旧版本、幂等、并发冲突、事务回滚与迁移重入通过",
  );
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closeDatabaseForTests();
  fs.rmSync(temp, { recursive: true, force: true });
}

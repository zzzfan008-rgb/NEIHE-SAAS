import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  makeAse,
  makeZip,
  xlsxEntries,
  headerRow,
} from "./color-import-fixtures";
import { resetPostgresTestDatabase } from "./postgresTestDatabase";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "brand-colors-"));
process.env.DATA_DIR = temp;
process.env.SQLITE_IMPORT_FILE = "missing.db";
process.env.INITIAL_ADMIN_ACCOUNT_ID = "brand-test-admin";
process.env.INITIAL_ADMIN_PASSWORD = "Initial1234";
await resetPostgresTestDatabase();
const { initializeDatabase, closeDatabaseForTests, query } = await import(
  "../server/lib/database"
);
const { createSession, requireAuth, requirePasswordChanged, SESSION_COOKIE } =
  await import("../server/lib/auth");
const { colorsRouter } = await import("../server/routes/colors");
const { publishColorCatalog, searchColorCatalog } = await import(
  "../server/lib/colorCatalogStore"
);
await initializeDatabase();
const sessions = new Map<string, string>();
const now = new Date().toISOString();
for (const user of ["admin", "other-admin", "reader"]) {
  await query(
    `INSERT INTO users(id,account_id,display_name,role,password_hash,must_change_password,active,created_at,updated_at)
    VALUES ($1,$1,$1,$2,'test-only',0,1,$3,$3)`,
    [user, user === "reader" ? "user" : "admin", now],
  );
  sessions.set(user, (await createSession(user)).token);
}
const app = express();
app.use(express.json({ limit: "20mb" }));
app.use("/api", requireAuth, requirePasswordChanged);
app.use("/api/colors", colorsRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/colors`;
const request = (url: string, method = "GET", body?: unknown, user = "admin") =>
  fetch(base + url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(sessions.has(user)
        ? { cookie: `${SESSION_COOKIE}=${sessions.get(user)}` }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function ok(
  url: string,
  method = "GET",
  body?: unknown,
  status = 200,
  user = "admin",
) {
  const response = await request(url, method, body, user);
  const text = await response.text();
  assert.equal(response.status, status, text);
  return text ? JSON.parse(text) : undefined;
}
try {
  assert.equal(
    (await request("/brands", "GET", undefined, "anonymous")).status,
    401,
  );
  assert.equal(
    (await ok("/brands", "GET", undefined, 200, "reader")).items.length,
    3,
  );
  for (const [url, method] of [
    ["/brands", "POST"],
    ["/brands/neihe", "PATCH"],
    ["/brands/neihe", "DELETE"],
    ["/series", "POST"],
    ["/series/x", "PATCH"],
    ["/series/x", "DELETE"],
    ["/groups", "POST"],
    ["/groups/x", "PUT"],
    ["/groups/x", "DELETE"],
    ["/imports", "GET"],
    ["/imports", "POST"],
    ["/imports/x", "PATCH"],
    ["/imports/x/confirm", "POST"],
  ])
    assert.equal(
      (await request(url, method, method === "GET" ? undefined : {}, "reader"))
        .status,
      403,
    );
  assert.equal(
    (await request("/brands/neihe", "DELETE", { revision: 1 })).status,
    409,
  );
  const brand = await ok("/brands", "POST", { name: "Synthetic Brand" }, 201);
  assert.equal(
    (await request("/brands", "POST", { name: "synthetic brand" })).status,
    409,
  );
  const series = await ok(
    "/series",
    "POST",
    { brandId: brand.id, name: "Unmarked" },
    201,
  );
  assert.equal(series.year, null);
  assert.equal(series.season, null);
  const colors = Array.from({ length: 9 }, (_, index) => ({
    name: `11-${1000 + index} TCX`,
    space: "RGB " as const,
    components: [0.5, 0.5, 0.5],
  }));
  const sources = [
    {
      libraryKey: "tcx",
      fileName: "synthetic.ase",
      version: "test",
      bytes: makeAse(colors),
    },
  ];
  const release = await publishColorCatalog(sources, 0);
  const catalog = await searchColorCatalog({ limit: 100, offset: 0 });
  const refs = catalog.colors.map((color) => ({
    catalogId: color.id,
    releaseId: release.releaseId,
    ratio: null,
  }));
  const group = await ok(
    "/groups",
    "POST",
    {
      brandId: brand.id,
      seriesId: series.id,
      name: "Nine identical HEX, distinct codes",
      members: refs,
    },
    201,
  );
  assert.equal(group.members.length, 9);
  assert.equal(
    new Set(group.members.map((m: { hex: string }) => m.hex)).size,
    1,
  );
  assert.equal(
    (
      await request("/groups", "POST", {
        brandId: "neihe",
        seriesId: series.id,
        name: "Wrong brand",
        members: [],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/groups", "POST", {
        brandId: brand.id,
        name: "Invalid",
        members: [{ ...refs[0], catalogId: "0".repeat(64) }],
      })
    ).status,
    400,
  );
  const concurrent = await Promise.all([
    request(`/groups/${group.id}`, "PUT", {
      name: "A",
      seriesId: series.id,
      members: refs,
      revision: 1,
    }),
    request(`/groups/${group.id}`, "PUT", {
      name: "B",
      seriesId: series.id,
      members: refs,
      revision: 1,
    }),
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (await request(`/series/${series.id}`, "DELETE", { revision: 1 })).status,
    409,
  );
  const target = await ok(
    "/groups",
    "POST",
    { brandId: "ralph-lauren", name: "Import", members: [] },
    201,
  );
  const row = (r: number, code: string, ratio = "") =>
    `<row r="${r}"><c r="A${r}" t="inlineStr"><is><t>${code}</t></is></c>${ratio ? `<c r="B${r}"><v>${ratio}</v></c>` : ""}</row>`;
  const xlsx = makeZip(
    xlsxEntries(
      headerRow +
        row(2, "11-1000.TCX", "0.38") +
        row(3, "11-1001.TCX") +
        row(4, "99-9999.TCX"),
    ),
  );
  const imported = await ok(
    "/imports",
    "POST",
    {
      groupId: target.id,
      libraryKey: "tcx",
      format: "xlsx",
      base64: xlsx.toString("base64"),
    },
    201,
  );
  const filteredImports = await ok(
    `/imports?groupId=${encodeURIComponent(target.id)}&limit=25&offset=0`,
  );
  assert.deepEqual(
    filteredImports.items.map((item: { id: string }) => item.id),
    [imported.id],
  );
  const otherAdminImports = await ok(
    `/imports?groupId=${encodeURIComponent(target.id)}&limit=25&offset=0`,
    "GET",
    undefined,
    200,
    "other-admin",
  );
  assert.deepEqual(otherAdminImports.items, []);
  assert.equal((await request("/imports?groupId=../bad")).status, 400);
  assert.deepEqual(
    imported.rows.map((r: { status: string }) => r.status),
    ["matched", "matched", "unmatched"],
  );
  assert.deepEqual(imported.rows[0].matchedColor, {
    catalogId: refs[0].catalogId,
    libraryKey: "tcx",
    code: "11-1000 TCX",
    hex: catalog.colors[0].hex,
  });
  await query(
    `UPDATE color_imports
     SET rows=(SELECT jsonb_agg(value - 'matchedColor') FROM jsonb_array_elements(rows) value)
     WHERE id=$1`,
    [imported.id],
  );
  const hydratedLegacyImport = await ok(`/imports/${imported.id}`);
  assert.equal(hydratedLegacyImport.rows[0].matchedColor.code, "11-1000 TCX");
  assert.equal(hydratedLegacyImport.rows[0].matchedColor.hex, catalog.colors[0].hex);
  assert.ok(
    imported.decisions.every((d: { action: string }) => d.action === "pending"),
  );
  assert.equal(
    (await request(`/imports/${imported.id}`, "GET", undefined, "other-admin"))
      .status,
    404,
  );
  assert.equal(
    (
      await request(`/imports/${imported.id}/confirm`, "POST", {
        revision: 1,
        groupRevision: 1,
      })
    ).status,
    400,
  );
  const firstDecision = {
    action: "confirm",
    catalogId: refs[0].catalogId,
    ratio: 0.38,
  };
  await ok(`/imports/${imported.id}`, "PATCH", {
    revision: 1,
    decisions: [firstDecision, { action: "pending" }, { action: "pending" }],
  });
  const commits = await Promise.all([
    ok(`/imports/${imported.id}/confirm`, "POST", {
      revision: 2,
      groupRevision: 1,
    }),
    ok(`/imports/${imported.id}/confirm`, "POST", {
      revision: 2,
      groupRevision: 1,
    }),
  ]);
  assert.deepEqual(commits[0], commits[1]);
  assert.equal(commits[0].added, 1);
  const partial = await ok(`/imports/${imported.id}`);
  assert.deepEqual(partial.publishedRows, [0]);
  assert.equal(
    (await ok(`/groups/${target.id}`, "GET", undefined, 200, "reader"))
      .members[0].ratio,
    0.38,
  );
  assert.equal(
    (
      await request(`/imports/${imported.id}`, "PATCH", {
        revision: 3,
        decisions: [
          { action: "skip" },
          { action: "pending" },
          { action: "pending" },
        ],
      })
    ).status,
    409,
  );
  await ok(`/imports/${imported.id}`, "PATCH", {
    revision: 3,
    decisions: [
      firstDecision,
      { action: "confirm", catalogId: refs[1].catalogId, ratio: null },
      { action: "pending" },
    ],
  });
  assert.equal(
    (
      await request(`/imports/${imported.id}/confirm`, "POST", {
        revision: 4,
        groupRevision: 1,
      })
    ).status,
    409,
  );
  await ok(`/imports/${imported.id}/confirm`, "POST", {
    revision: 4,
    groupRevision: 2,
  });
  assert.equal((await ok(`/groups/${target.id}`)).members.length, 2);
  const duplicateImport = await ok(
    "/imports",
    "POST",
    {
      groupId: target.id,
      libraryKey: "tcx",
      format: "xlsx",
      base64: makeZip(
        xlsxEntries(headerRow + row(2, "11-1000.TCX")),
      ).toString("base64"),
    },
    201,
  );
  await ok(`/imports/${duplicateImport.id}`, "PATCH", {
    revision: 1,
    decisions: [
      { action: "confirm", catalogId: refs[0].catalogId, ratio: null },
    ],
  });
  assert.equal(
    (
      await request(`/imports/${duplicateImport.id}/confirm`, "POST", {
        revision: 2,
        groupRevision: 3,
      })
    ).status,
    400,
  );
  assert.deepEqual(
    (await ok(`/imports/${duplicateImport.id}`)).publishedRows,
    [],
  );
  assert.equal((await ok(`/groups/${target.id}`)).members.length, 2);
  const chloe = await ok(
    "/groups",
    "POST",
    { brandId: "chloe", name: "Manual HEX mapping", members: [] },
    201,
  );
  const ase = makeAse([
    {
      name: "#ECDBA5",
      space: "RGB ",
      components: [236 / 255, 219 / 255, 165 / 255],
    },
  ]);
  const approximate = await ok(
    "/imports",
    "POST",
    {
      groupId: chloe.id,
      libraryKey: "tcx",
      format: "ase",
      base64: ase.toString("base64"),
    },
    201,
  );
  assert.equal(approximate.rows[0].matchedCatalogId, null);
  assert.equal(approximate.rows[0].candidates[0].approximate, true);
  await ok(`/imports/${approximate.id}`, "PATCH", {
    revision: 1,
    decisions: [
      { action: "confirm", catalogId: refs[2].catalogId, ratio: null },
    ],
  });
  await ok(`/imports/${approximate.id}/confirm`, "POST", {
    revision: 2,
    groupRevision: 1,
  });
  assert.equal(
    (await ok(`/groups/${chloe.id}`)).members[0].originalHex,
    "#ECDBA5",
  );
  const changedRelease = await publishColorCatalog(
    [{ ...sources[0], version: "v2" }],
    1,
  );
  assert.notEqual(changedRelease.releaseId, release.releaseId);
  await ok(`/imports/${imported.id}`, "PATCH", {
    revision: 5,
    decisions: [
      firstDecision,
      { action: "confirm", catalogId: refs[1].catalogId, ratio: null },
      { action: "confirm", catalogId: refs[3].catalogId, ratio: null },
    ],
  });
  assert.equal(
    (
      await request(`/imports/${imported.id}/confirm`, "POST", {
        revision: 6,
        groupRevision: 3,
      })
    ).status,
    409,
  );
  assert.equal((await ok(`/groups/${target.id}`)).members.length, 2);
  await ok(`/groups/${group.id}`, "DELETE", { revision: 2 }, 204);
  await ok(`/series/${series.id}`, "PATCH", {
    revision: 1,
    year: 2026,
    season: "Spring",
  });
  const renamedSeries = await ok(`/series/${series.id}`, "PATCH", {
    revision: 2,
    name: "Renamed",
  });
  assert.equal(renamedSeries.year, 2026);
  assert.equal(renamedSeries.season, "Spring");
  await ok(`/series/${series.id}`, "DELETE", { revision: 3 }, 204);
  await ok(`/brands/${brand.id}`, "DELETE", { revision: 1 }, 204);
  assert.equal((await request(`/groups/${group.id}`)).status, 404);
  assert.equal(
    (
      await request("/imports", "POST", {
        groupId: target.id,
        libraryKey: "tcx",
        format: "ase",
        base64: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64"),
      })
    ).status,
    400,
  );
  let importRateLimited = false;
  for (let attempt = 0; attempt < 25; attempt++) {
    const response = await request("/imports", "POST", {});
    if (response.status === 429) {
      importRateLimited = true;
      break;
    }
    assert.equal(response.status, 400);
  }
  assert.equal(importRateLimited, true);
  console.log(
    "品牌管理：鉴权、跨品牌校验、9色同HEX身份、并发revision、私有预览、部分发布、重放与旧色库保护通过",
  );
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closeDatabaseForTests();
  fs.rmSync(temp, { recursive: true, force: true });
}

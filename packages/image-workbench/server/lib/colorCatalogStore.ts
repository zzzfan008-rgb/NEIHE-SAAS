import {
  ColorCatalogError,
  prepareColorCatalogRelease,
} from "./colorCatalogRelease";
import type { CatalogColor } from "../../src/types/colorImport";
import type {
  CatalogColorSummary,
  CatalogLibrariesPage,
  CatalogHue,
  CatalogPage,
  CatalogReleaseState,
  CatalogSearch,
} from "../../src/types/colorManagement";
import type { CatalogSourceInput } from "./colorCatalog";
import { query, queryOne, transaction } from "./database";

export { ColorCatalogError } from "./colorCatalogRelease";

/** Screen-HSL buckets; these classify the converted preview, not physical spot inks. */
function previewHue(hex: string): CatalogHue {
  const [r, g, b] = [1, 3, 5].map(
    (start) => parseInt(hex.slice(start, start + 2), 16) / 255,
  );
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(max + min - 1));
  if (saturation < 0.1) return "neutral";
  let angle: number;
  if (max === r) angle = (g - b) / delta;
  else if (max === g) angle = (b - r) / delta + 2;
  else angle = (r - g) / delta + 4;
  const hue = (angle * 60 + 360) % 360;
  if (hue < 15 || hue >= 345) return "red";
  if (hue < 45) return "orange";
  if (hue < 75) return "yellow";
  if (hue < 165) return "green";
  if (hue < 195) return "cyan";
  if (hue < 255) return "blue";
  if (hue < 285) return "purple";
  return "pink";
}

export async function activeColorCatalog(): Promise<CatalogReleaseState> {
  const state = await queryOne<{ release_id: string | null; revision: number }>(
    "SELECT release_id, revision FROM color_catalog_state WHERE singleton = TRUE",
  );
  if (!state) throw new Error("色彩主库状态尚未初始化");
  return { releaseId: state.release_id, revision: state.revision };
}

/** Offline/operator-only. No HTTP write endpoint is exported for the master catalog. */
export async function publishColorCatalog(
  sources: readonly CatalogSourceInput[],
  expectedRevision: number,
): Promise<CatalogReleaseState> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new ColorCatalogError("主库 revision 无效", 400);
  const { colors, releaseId } = prepareColorCatalogRelease(sources);
  const rows = colors.map((color) => {
    const display = color.status === "ready" ? color.variants[0].display : null;
    return {
      id: color.id,
      library_key: color.libraryKey,
      code: color.code,
      status: color.status,
      hex: display?.hex ?? null,
      hue: display ? previewHue(display.hex) : null,
      out_of_gamut: display?.outOfGamut ?? null,
      data: color,
    };
  });
  return transaction(async (client) => {
    const state = await queryOne<{
      release_id: string | null;
      revision: number;
    }>(
      "SELECT release_id, revision FROM color_catalog_state WHERE singleton = TRUE FOR UPDATE",
      [],
      client,
    );
    if (!state) throw new Error("色彩主库状态尚未初始化");
    if (state.release_id === releaseId)
      return { releaseId, revision: state.revision };
    if (state.revision !== expectedRevision)
      throw new ColorCatalogError("主库版本已改变，请重新核对后导入", 409);
    await client.query(
      "INSERT INTO color_catalog_releases(id, created_at, color_count) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
      [releaseId, new Date().toISOString(), colors.length],
    );
    const data = JSON.stringify(rows);
    await client.query(
      `INSERT INTO color_catalog_identities(id, library_key, code)
      SELECT id, library_key, code FROM jsonb_to_recordset($1::jsonb) AS r(id text, library_key text, code text)
      ON CONFLICT (id) DO NOTHING`,
      [data],
    );
    await client.query(
      `INSERT INTO color_catalog_versions(release_id, color_id, status, hex, hue, out_of_gamut, data)
      SELECT $1, id, status, hex, hue, out_of_gamut, data FROM jsonb_to_recordset($2::jsonb)
        AS r(id text, status text, hex text, hue text, out_of_gamut boolean, data jsonb)
      ON CONFLICT (release_id, color_id) DO NOTHING`,
      [releaseId, data],
    );
    const revision = state.revision + 1;
    await client.query(
      "UPDATE color_catalog_state SET release_id = $1, revision = $2 WHERE singleton = TRUE",
      [releaseId, revision],
    );
    return { releaseId, revision };
  });
}

async function catalogSnapshot(requested?: string) {
  const state = await activeColorCatalog();
  const releaseId = requested ?? state.releaseId;
  if (
    requested &&
    !(await queryOne("SELECT id FROM color_catalog_releases WHERE id = $1", [
      requested,
    ]))
  )
    throw new ColorCatalogError("色库版本不存在", 404);
  return { ...state, activeReleaseId: state.releaseId, releaseId };
}

export async function searchColorCatalog(
  input: CatalogSearch,
): Promise<CatalogPage> {
  const snapshot = await catalogSnapshot(input.releaseId);
  if (!snapshot.releaseId)
    return { ...snapshot, total: 0, colors: [], nextOffset: null };
  const values: unknown[] = [snapshot.releaseId];
  const conditions = ["v.release_id = $1"];
  const where = (sql: string, value: unknown) => {
    values.push(value);
    conditions.push(`${sql} $${values.length}`);
  };
  if (input.libraryKey) where("i.library_key =", input.libraryKey);
  if (input.status) where("v.status =", input.status);
  if (input.hue) where("v.hue =", input.hue);
  if (input.q) {
    values.push(`%${input.q.replace(/[\\%_]/g, "\\$&")}%`);
    conditions.push(`(i.code ILIKE $${values.length} OR v.data::text ILIKE $${values.length})`);
  }
  const from = `FROM color_catalog_versions v JOIN color_catalog_identities i ON i.id = v.color_id WHERE ${conditions.join(" AND ")}`;
  const count = await queryOne<{ total: number }>(
    `SELECT COUNT(*)::int AS total ${from}`,
    values,
  );
  const colors = await query<CatalogColorSummary>(
    `SELECT i.id, i.library_key AS "libraryKey", i.code, v.status, v.hex, v.hue, v.out_of_gamut AS "outOfGamut"
    ${from} ORDER BY i.library_key COLLATE "C", i.code COLLATE "C", i.id
    LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, input.limit, input.offset],
  );
  const total = count?.total ?? 0;
  return {
    ...snapshot,
    total,
    colors,
    nextOffset:
      input.offset + colors.length < total
        ? input.offset + colors.length
        : null,
  };
}

export async function colorCatalogDetail(id: string, releaseId?: string) {
  const snapshot = await catalogSnapshot(releaseId);
  const row = snapshot.releaseId
    ? await queryOne<{ data: CatalogColor }>(
        "SELECT data FROM color_catalog_versions WHERE release_id = $1 AND color_id = $2",
        [snapshot.releaseId, id],
      )
    : undefined;
  if (!row) throw new ColorCatalogError("色号不存在", 404);
  return { ...snapshot, color: row.data };
}

export async function colorCatalogLibraries(
  releaseId?: string,
): Promise<CatalogLibrariesPage> {
  const snapshot = await catalogSnapshot(releaseId);
  const libraries = snapshot.releaseId
    ? await query<{ libraryKey: string; total: number; ready: number }>(
        `SELECT i.library_key AS "libraryKey", COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE v.status = 'ready')::int AS ready
    FROM color_catalog_versions v JOIN color_catalog_identities i ON i.id = v.color_id
    WHERE v.release_id = $1 GROUP BY i.library_key ORDER BY i.library_key COLLATE "C"`,
        [snapshot.releaseId],
      )
    : [];
  return { ...snapshot, libraries };
}

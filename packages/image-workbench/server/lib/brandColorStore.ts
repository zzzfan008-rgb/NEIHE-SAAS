import { nanoid } from "nanoid";
import type { PoolClient } from "pg";
import type {
  BrandColorMember,
  BrandColorReference,
  ColorBrand,
  ColorGroup,
  ColorSeries,
} from "../../src/types/brandColors";
import { query, queryOne, transaction } from "./database";
import { ColorCatalogError } from "./colorCatalogRelease";
import * as validate from "./brandColorValidation";

const B = "id, kind, name, revision";
const S = 's.id, s.brand_id AS "brandId", s.name, s.year, s.season, s.revision';
const G =
  'g.id, g.brand_id AS "brandId", g.series_id AS "seriesId", g.name, g.revision';
function found<T>(row: T | undefined): T {
  if (!row) throw new ColorCatalogError("资源不存在", 404);
  return row;
}
export function checkRevision(actual: number, expected: unknown): void {
  if (actual !== validate.revision(expected))
    throw new ColorCatalogError("内容已改变，请刷新后重试", 409);
}
export async function lockBrand(client: PoolClient, brandId: string) {
  return found(
    await queryOne<ColorBrand>(
      `SELECT ${B} FROM color_brands WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
      [brandId],
      client,
    ),
  );
}
export async function lockGroup(
  client: PoolClient,
  groupId: string,
): Promise<ColorGroup> {
  const initial = found(
    await queryOne<{ brand_id: string }>(
      "SELECT brand_id FROM color_groups WHERE id=$1 AND deleted_at IS NULL",
      [groupId],
      client,
    ),
  );
  await lockBrand(client, initial.brand_id);
  return found(
    await queryOne<ColorGroup>(
      `SELECT ${G} FROM color_groups g WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
      [groupId],
      client,
    ),
  );
}
function page<T>(rows: T[], input: { limit: number; offset: number }) {
  return {
    items: rows.slice(0, input.limit),
    nextOffset: rows.length > input.limit ? input.offset + input.limit : null,
  };
}
export async function listBrands(input: { limit: number; offset: number }) {
  return page(
    await query<ColorBrand>(
      `SELECT ${B} FROM color_brands WHERE deleted_at IS NULL ORDER BY name COLLATE "C",id LIMIT $1 OFFSET $2`,
      [input.limit + 1, input.offset],
    ),
    input,
  );
}
export async function createBrand(body: unknown) {
  const input = validate.fields(body, ["name"]);
  return queryOne<ColorBrand>(
    `INSERT INTO color_brands(id,kind,name) VALUES ($1,'reference',$2) RETURNING ${B}`,
    [nanoid(), validate.name(input.name)],
  );
}
export async function changeBrand(
  brandId: string,
  body: unknown,
  remove = false,
) {
  const input = validate.fields(
    body,
    remove ? ["revision"] : ["name", "revision"],
  );
  return transaction(async (client) => {
    const brand = await lockBrand(client, brandId);
    checkRevision(brand.revision, input.revision);
    if (!remove)
      return queryOne<ColorBrand>(
        `UPDATE color_brands SET name=$2, revision=revision+1 WHERE id=$1 RETURNING ${B}`,
        [brandId, validate.name(input.name)],
        client,
      );
    if (brand.kind === "neihe")
      throw new ColorCatalogError("NEIHE Color 根目录不能删除", 409);
    if (
      await queryOne(
        "SELECT 1 FROM color_groups WHERE brand_id=$1 AND deleted_at IS NULL UNION ALL SELECT 1 FROM color_series WHERE brand_id=$1 AND deleted_at IS NULL LIMIT 1",
        [brandId],
        client,
      )
    )
      throw new ColorCatalogError("请先处理品牌下的系列与色组", 409);
    await client.query(
      "UPDATE color_brands SET deleted_at=$2,revision=revision+1 WHERE id=$1",
      [brandId, new Date().toISOString()],
    );
  });
}
export async function listSeries(
  brandId: string,
  input: { limit: number; offset: number },
) {
  return page(
    await query<ColorSeries>(
      `SELECT ${S} FROM color_series s JOIN color_brands b ON b.id=s.brand_id WHERE s.brand_id=$1 AND s.deleted_at IS NULL AND b.deleted_at IS NULL ORDER BY s.name COLLATE "C",s.id LIMIT $2 OFFSET $3`,
      [brandId, input.limit + 1, input.offset],
    ),
    input,
  );
}
export async function createSeries(body: unknown) {
  const input = validate.fields(body, ["brandId", "name", "year", "season"]);
  const brandId = validate.id(input.brandId);
  const values = validate.seriesFields(input);
  return transaction(async (client) => {
    await lockBrand(client, brandId);
    return queryOne<ColorSeries>(
      `INSERT INTO color_series AS s(id,brand_id,name,year,season) VALUES ($1,$2,$3,$4,$5) RETURNING ${S}`,
      [nanoid(), brandId, values.name, values.year, values.season],
      client,
    );
  });
}
export async function changeSeries(
  seriesId: string,
  body: unknown,
  remove = false,
) {
  const input = validate.fields(
    body,
    remove ? ["revision"] : ["name", "year", "season", "revision"],
  );
  return transaction(async (client) => {
    const initial = found(
      await queryOne<{ brand_id: string }>(
        "SELECT brand_id FROM color_series WHERE id=$1 AND deleted_at IS NULL",
        [seriesId],
        client,
      ),
    );
    await lockBrand(client, initial.brand_id);
    const series = found(
      await queryOne<ColorSeries>(
        `SELECT ${S} FROM color_series s WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [seriesId],
        client,
      ),
    );
    checkRevision(series.revision, input.revision);
    if (!remove) {
      const values = validate.seriesFields({ ...series, ...input });
      return queryOne<ColorSeries>(
        `UPDATE color_series s SET name=$2,year=$3,season=$4,revision=revision+1 WHERE id=$1 RETURNING ${S}`,
        [seriesId, values.name, values.year, values.season],
        client,
      );
    }
    if (
      await queryOne(
        "SELECT 1 FROM color_groups WHERE series_id=$1 AND deleted_at IS NULL LIMIT 1",
        [seriesId],
        client,
      )
    )
      throw new ColorCatalogError("请先处理系列下的色组", 409);
    await client.query(
      "UPDATE color_series SET deleted_at=$2,revision=revision+1 WHERE id=$1",
      [seriesId, new Date().toISOString()],
    );
  });
}
export async function listGroups(
  brandId: string,
  input: { limit: number; offset: number },
  seriesId?: string,
) {
  return page(
    await query<ColorGroup>(
      `SELECT ${G} FROM color_groups g JOIN color_brands b ON b.id=g.brand_id
    WHERE g.brand_id=$1 AND g.deleted_at IS NULL AND b.deleted_at IS NULL AND ($2::text IS NULL OR g.series_id=$2)
    ORDER BY g.name COLLATE "C",g.id LIMIT $3 OFFSET $4`,
      [brandId, seriesId ?? null, input.limit + 1, input.offset],
    ),
    input,
  );
}
export async function readGroup(groupId: string, client?: PoolClient) {
  // One MVCC statement keeps metadata/revision and ordered members in the same snapshot.
  return found(
    await queryOne<ColorGroup & { members: BrandColorMember[] }>(
      `SELECT ${G},
    COALESCE((SELECT jsonb_agg(jsonb_build_object('catalogId',m.catalog_id,'releaseId',m.release_id,
      'ratio',m.ratio,'originalHex',m.original_hex,'libraryKey',i.library_key,'code',i.code,'hex',v.hex) ORDER BY m.position)
      FROM color_group_members m JOIN color_catalog_identities i ON i.id=m.catalog_id
      JOIN color_catalog_versions v ON v.color_id=m.catalog_id AND v.release_id=m.release_id WHERE m.group_id=g.id), '[]'::jsonb) AS members
    FROM color_groups g JOIN color_brands b ON b.id=g.brand_id
    WHERE g.id=$1 AND g.deleted_at IS NULL AND b.deleted_at IS NULL`,
      [groupId],
      client,
    ),
  );
}
export interface StoredBrandColor extends BrandColorReference {
  originalHex: string | null;
  originImportId: string | null;
}
export function storedMembers(groupId: string, client: PoolClient) {
  return query<StoredBrandColor>(
    'SELECT catalog_id AS "catalogId",release_id AS "releaseId",ratio,original_hex AS "originalHex",origin_import_id AS "originImportId" FROM color_group_members WHERE group_id=$1 ORDER BY position',
    [groupId],
    client,
  );
}
export async function validateReferences(
  members: readonly BrandColorReference[],
  client: PoolClient,
): Promise<void> {
  const matches = await query<{ catalogId: string }>(
    `SELECT v.color_id AS "catalogId" FROM jsonb_to_recordset($1::jsonb) AS r("catalogId" text,"releaseId" text)
    JOIN color_catalog_versions v ON v.color_id=r."catalogId" AND v.release_id=r."releaseId" WHERE v.status='ready'`,
    [JSON.stringify(members)],
    client,
  );
  if (matches.length !== members.length)
    validate.invalid("色号不存在、存在冲突或尚未转换");
}
export async function replaceMembers(
  groupId: string,
  members: readonly StoredBrandColor[],
  client: PoolClient,
): Promise<void> {
  validate.colorReferences(
    members.map(({ catalogId, releaseId, ratio }) => ({
      catalogId,
      releaseId,
      ratio,
    })),
  );
  await validateReferences(members, client);
  await client.query("DELETE FROM color_group_members WHERE group_id=$1", [
    groupId,
  ]);
  await client.query(
    `INSERT INTO color_group_members(group_id,position,catalog_id,release_id,ratio,original_hex,origin_import_id)
    SELECT $1,position,"catalogId","releaseId",ratio,"originalHex","originImportId"
    FROM jsonb_to_recordset($2::jsonb) AS r(position int,"catalogId" text,"releaseId" text,ratio double precision,"originalHex" text,"originImportId" text)`,
    [
      groupId,
      JSON.stringify(
        members.map((member, position) => ({ ...member, position })),
      ),
    ],
  );
}
async function checkSeries(
  client: PoolClient,
  seriesId: string | null,
  brandId: string,
) {
  if (
    seriesId &&
    !(await queryOne(
      "SELECT 1 FROM color_series WHERE id=$1 AND brand_id=$2 AND deleted_at IS NULL",
      [seriesId, brandId],
      client,
    ))
  )
    validate.invalid("系列不属于此品牌或已删除");
}
export async function saveGroup(body: unknown, groupId?: string) {
  const input = validate.fields(
    body,
    groupId
      ? ["name", "seriesId", "members", "revision"]
      : ["name", "brandId", "seriesId", "members"],
  );
  const groupName = validate.name(input.name);
  const seriesId = input.seriesId == null ? null : validate.id(input.seriesId);
  const references = validate.colorReferences(input.members);
  return transaction(async (client) => {
    let group: ColorGroup;
    if (groupId) {
      group = await lockGroup(client, groupId);
      checkRevision(group.revision, input.revision);
    } else {
      const brandId = validate.id(input.brandId);
      await lockBrand(client, brandId);
      group = { id: nanoid(), brandId, seriesId, name: groupName, revision: 1 };
    }
    await checkSeries(client, seriesId, group.brandId);
    if (!groupId)
      await client.query(
        "INSERT INTO color_groups(id,brand_id,series_id,name) VALUES ($1,$2,$3,$4)",
        [group.id, group.brandId, seriesId, groupName],
      );
    const old = new Map(
      (await storedMembers(group.id, client)).map((member) => [
        `${member.catalogId}:${member.releaseId}`,
        member,
      ]),
    );
    const members = references.map((member) => {
      const previous = old.get(`${member.catalogId}:${member.releaseId}`);
      return {
        ...member,
        originalHex: previous?.originalHex ?? null,
        originImportId: previous?.originImportId ?? null,
      };
    });
    await replaceMembers(group.id, members, client);
    if (groupId)
      await client.query(
        "UPDATE color_groups SET name=$2,series_id=$3,revision=revision+1 WHERE id=$1",
        [groupId, groupName, seriesId],
      );
    return readGroup(group.id, client);
  });
}
export async function deleteGroup(groupId: string, body: unknown) {
  const input = validate.fields(body, ["revision"]);
  await transaction(async (client) => {
    const group = await lockGroup(client, groupId);
    checkRevision(group.revision, input.revision);
    await client.query(
      "UPDATE color_groups SET deleted_at=$2,revision=revision+1 WHERE id=$1",
      [groupId, new Date().toISOString()],
    );
  });
}

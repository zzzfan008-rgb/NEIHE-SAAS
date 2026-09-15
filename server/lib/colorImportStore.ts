import { nanoid } from "nanoid";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import type { CatalogColor } from "../../src/types/colorImport";
import type {
  ColorImportCommit,
  ColorImportListItem,
  ManagedColorImport,
} from "../../src/types/brandColors";
import { query, queryOne, transaction } from "./database";
import { activeColorCatalog } from "./colorCatalogStore";
import { ColorCatalogError } from "./colorCatalogRelease";
import { parseColorImport } from "./colorImport";
import {
  checkRevision,
  lockGroup,
  replaceMembers,
  storedMembers,
  validateReferences,
} from "./brandColorStore";
import * as validate from "./brandColorValidation";

const I =
  'id,group_id AS "groupId",release_id AS "releaseId",library_key AS "libraryKey",file_hash AS "fileHash",revision,rows,decisions,published_rows AS "publishedRows"';

async function hydrateMatchedColors(
  record: ManagedColorImport,
  client?: PoolClient,
 ): Promise<ManagedColorImport> {
  const missingIds = [
    ...new Set(
      record.rows.flatMap((row) =>
        row.status === "matched" && row.matchedCatalogId && !row.matchedColor
          ? [row.matchedCatalogId]
          : [],
      ),
    ),
  ];
  if (!missingIds.length) return record;
  const colors = await query<{
    catalogId: string;
    libraryKey: string;
    code: string;
    hex: `#${string}` | null;
  }>(
    `SELECT i.id AS "catalogId",i.library_key AS "libraryKey",i.code,v.hex
    FROM color_catalog_identities i
    JOIN color_catalog_versions v ON v.color_id=i.id
    WHERE v.release_id=$1 AND i.id=ANY($2::text[])`,
    [record.releaseId, missingIds],
    client,
  );
  const byId = new Map(colors.map((color) => [color.catalogId, color]));
  return {
    ...record,
    rows: record.rows.map((row) => ({
      ...row,
      matchedColor:
        row.matchedColor ??
        (row.matchedCatalogId ? (byId.get(row.matchedCatalogId) ?? null) : null),
    })),
  };
}
export async function readManagedImport(
  importId: string,
  ownerId: string,
  client?: PoolClient,
  lock = false,
): Promise<ManagedColorImport> {
  const row = await queryOne<ManagedColorImport>(
    `SELECT ${I} FROM color_imports WHERE id=$1 AND owner_id=$2${lock ? " FOR UPDATE" : ""}`,
    [importId, ownerId],
    client,
  );
  if (!row) throw new ColorCatalogError("导入记录不存在", 404);
  return hydrateMatchedColors(row, client);
}
export async function listManagedImports(
  ownerId: string,
  input: { limit: number; offset: number; groupId?: string },
) {
  const rows = await query<ColorImportListItem>(
    `SELECT id,group_id AS "groupId",revision,created_at AS "createdAt"
     FROM color_imports
     WHERE owner_id=$1 AND ($2::text IS NULL OR group_id=$2)
     ORDER BY created_at DESC,id LIMIT $3 OFFSET $4`,
    [ownerId, input.groupId ?? null, input.limit + 1, input.offset],
  );
  return {
    items: rows.slice(0, input.limit),
    nextOffset: rows.length > input.limit ? input.offset + input.limit : null,
  };
}
export async function createManagedImport(ownerId: string, body: unknown) {
  const input = validate.fields(body, [
    "groupId",
    "libraryKey",
    "format",
    "base64",
  ]);
  const groupId = validate.id(input.groupId);
  if (
    typeof input.libraryKey !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.libraryKey)
  )
    validate.invalid("色库系列无效");
  if (input.format !== "ase" && input.format !== "xlsx")
    validate.invalid("仅支持 XLSX 与 ASE");
  if (
    typeof input.base64 !== "string" ||
    !input.base64.length ||
    input.base64.length > 14 * 1024 * 1024 ||
    input.base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)
  )
    validate.invalid("导入文件编码无效或过大");
  const bytes = Buffer.from(input.base64, "base64");
  if (
    bytes.length > 10 * 1024 * 1024 ||
    bytes.toString("base64") !== input.base64
  )
    validate.invalid("导入文件超限或编码不规范");
  const { releaseId } = await activeColorCatalog();
  if (!releaseId) throw new ColorCatalogError("尚未初始化色彩主库", 409);
  const catalog = await query<{ data: CatalogColor }>(
    `SELECT v.data FROM color_catalog_versions v JOIN color_catalog_identities i ON i.id=v.color_id WHERE v.release_id=$1 AND i.library_key=$2`,
    [releaseId, input.libraryKey],
  );
  if (!catalog.length) validate.invalid("色库系列不存在");
  let preview: Awaited<ReturnType<typeof parseColorImport>>;
  try {
    preview = await parseColorImport(
      bytes,
      input.format,
      catalog.map((entry) => entry.data),
      input.libraryKey,
    );
  } catch {
    validate.invalid("无法解析文件：请检查格式、公式、行数与资源限制");
  }
  if (!preview.rows.length) validate.invalid("导入文件没有颜色记录");
  if (Buffer.byteLength(JSON.stringify(preview.rows)) > 16 * 1024 * 1024)
    validate.invalid("导入预览超出 16 MiB，请拆分文件");
  return transaction(async (client) => {
    await lockGroup(client, groupId);
    const importId = nanoid();
    await client.query(
      `INSERT INTO color_imports(id,owner_id,group_id,release_id,library_key,file_hash,format,rows,decisions,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)`,
      [
        importId,
        ownerId,
        groupId,
        releaseId,
        input.libraryKey,
        preview.fileHash,
        preview.format,
        JSON.stringify(preview.rows),
        JSON.stringify(preview.rows.map(() => ({ action: "pending" }))),
        new Date().toISOString(),
      ],
    );
    return readManagedImport(importId, ownerId, client);
  });
}
async function validateMappings(
  record: ManagedColorImport,
  client: PoolClient,
) {
  const selected = record.decisions.filter(
    (decision) => decision.action === "confirm",
  );
  const references = validate.colorReferences(
    selected.map((decision) => ({
      catalogId: decision.catalogId,
      releaseId: record.releaseId,
      ratio: decision.ratio,
    })),
  );
  await validateReferences(references, client);
  const wrongLibrary = await queryOne(
    "SELECT 1 FROM color_catalog_identities WHERE id=ANY($1::text[]) AND library_key<>$2 LIMIT 1",
    [references.map((reference) => reference.catalogId), record.libraryKey],
    client,
  );
  if (wrongLibrary)
    validate.invalid("确认色号必须属于导入时选定的色库，不得跨系列替代");
}
export async function updateManagedImport(
  importId: string,
  ownerId: string,
  body: unknown,
) {
  const input = validate.fields(body, ["revision", "decisions"]);
  return transaction(async (client) => {
    const record = await readManagedImport(importId, ownerId, client, true);
    checkRevision(record.revision, input.revision);
    const decisions = validate.importDecisions(
      input.decisions,
      record.rows.length,
    );
    for (const index of record.publishedRows)
      if (!isDeepStrictEqual(record.decisions[index], decisions[index]))
        throw new ColorCatalogError("已发布行不能改写；请在色组中编辑", 409);
    await validateMappings({ ...record, decisions }, client);
    await client.query(
      "UPDATE color_imports SET decisions=$2::jsonb,revision=revision+1 WHERE id=$1",
      [importId, JSON.stringify(decisions)],
    );
    return readManagedImport(importId, ownerId, client);
  });
}
export async function confirmManagedImport(
  importId: string,
  ownerId: string,
  body: unknown,
): Promise<ColorImportCommit> {
  const input = validate.fields(body, ["revision", "groupRevision"]);
  const expected = validate.revision(input.revision);
  validate.revision(input.groupRevision);
  return transaction(async (client) => {
    // Lock order: catalog state -> brand -> group -> import. All publication paths follow it.
    const active = await queryOne<{ release_id: string | null }>(
      "SELECT release_id FROM color_catalog_state WHERE singleton=TRUE FOR SHARE",
      [],
      client,
    );
    const initial = await readManagedImport(importId, ownerId, client);
    const previous = await queryOne<{ result: ColorImportCommit }>(
      "SELECT result FROM color_import_commits WHERE import_id=$1 AND request_revision=$2",
      [importId, expected],
      client,
    );
    if (previous) return previous.result;
    const group = await lockGroup(client, initial.groupId);
    const record = await readManagedImport(importId, ownerId, client, true);
    const replay = await queryOne<{ result: ColorImportCommit }>(
      "SELECT result FROM color_import_commits WHERE import_id=$1 AND request_revision=$2",
      [importId, expected],
      client,
    );
    if (replay) return replay.result;
    checkRevision(record.revision, expected);
    checkRevision(group.revision, input.groupRevision);
    if (record.releaseId !== active?.release_id)
      throw new ColorCatalogError("色库已更新，请重新导入后核对", 409);
    await validateMappings(record, client);
    const published = new Set(record.publishedRows);
    const additions = record.decisions.flatMap((decision, index) => {
      if (decision.action !== "confirm" || published.has(index)) return [];
      published.add(index);
      return [
        {
          catalogId: decision.catalogId,
          releaseId: record.releaseId,
          ratio: decision.ratio,
          originalHex: record.rows[index].sourceHex ?? null,
          originImportId: importId,
        },
      ];
    });
    if (!additions.length) validate.invalid("没有待发布的人工确认行");
    await replaceMembers(
      group.id,
      [...(await storedMembers(group.id, client)), ...additions],
      client,
    );
    await client.query(
      "UPDATE color_groups SET revision=revision+1 WHERE id=$1",
      [group.id],
    );
    await client.query(
      "UPDATE color_imports SET published_rows=$2::jsonb,revision=revision+1 WHERE id=$1",
      [importId, JSON.stringify([...published].sort((a, b) => a - b))],
    );
    const result: ColorImportCommit = {
      importId,
      groupId: group.id,
      groupRevision: group.revision + 1,
      importRevision: record.revision + 1,
      added: additions.length,
    };
    await client.query(
      "INSERT INTO color_import_commits(import_id,request_revision,result) VALUES ($1,$2,$3::jsonb)",
      [importId, expected, JSON.stringify(result)],
    );
    return result;
  });
}

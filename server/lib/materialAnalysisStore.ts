import path from "node:path";
import { nanoid } from "nanoid";
import type { PoolClient } from "pg";
import { query, queryOne, transaction } from "./database";
import {
  deleteStoredImage,
  resolveToDataUrl,
  saveNormalizedUploadDataUrl,
} from "./fileStore";
import { lockActiveOwner } from "./ownerMutation";
import { analyzeMaterialImage, cropMaterialImage } from "./materialAnalysis";
import { ProviderError } from "../providers/base";
import { parseColorValue } from "../../src/lib/colorPalette";
import type {
  MaterialAnalysisCalibration,
  MaterialAnalysisColor,
  MaterialAnalysisModel,
  MaterialAnalysisRecord,
  MaterialAnalysisSuggestion,
} from "../../src/types/materialAnalysis";
import type { PantoneColorReference } from "../../src/types/colorPreferences";

const MATERIAL_DRAFT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MATERIAL_ANALYSIS_LEASE_MS = 15 * 60 * 1_000;
const MAX_MATERIAL_DRAFTS_PER_OWNER = 20;
const MAX_MATERIAL_DRAFT_BYTES_PER_OWNER = 100 * 1024 * 1024;

export class MaterialAnalysisQuotaError extends Error {
  constructor() {
    super(
      `每个账号最多保留 ${MAX_MATERIAL_DRAFTS_PER_OWNER} 个或 100 MiB 未入库材质草稿`,
    );
    this.name = "MaterialAnalysisQuotaError";
  }
}

interface AnalysisRow {
  id: string;
  revision: number;
  status: MaterialAnalysisRecord["status"];
  source_image: string;
  crop_image: string;
  crop: MaterialAnalysisRecord["crop"];
  model_id: string | null;
  suggestion: MaterialAnalysisSuggestion | null;
  calibration: MaterialAnalysisCalibration | null;
  error: string | null;
  asset_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapAnalysis(row: AnalysisRow): MaterialAnalysisRecord {
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    sourceImage: row.source_image,
    cropImage: row.crop_image,
    crop: row.crop,
    modelId: row.model_id,
    suggestion: row.suggestion,
    calibration: row.calibration,
    error: row.error,
    assetId: row.asset_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function expectedRevision(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1)
    throw new Error("expectedRevision 无效");
  return value as number;
}

async function insertFile(
  client: PoolClient,
  ownerId: string,
  saved: Awaited<ReturnType<typeof saveNormalizedUploadDataUrl>>,
  createdAt: string,
) {
  const purgeAfter = new Date(
    Date.parse(createdAt) + MATERIAL_DRAFT_RETENTION_MS,
  ).toISOString();
  await client.query(
    `
    INSERT INTO files(id,owner_id,source_type,mime_type,width,height,byte_length,normalized,created_at,purge_after)
    VALUES ($1,$2,'material-analysis',$3,$4,$5,$6,TRUE,$7,$8)
  `,
    [
      saved.id,
      ownerId,
      saved.mimeType,
      saved.width,
      saved.height,
      saved.byteLength,
      createdAt,
      purgeAfter,
    ],
  );
}

export async function createMaterialAnalysis(
  ownerId: string,
  image: unknown,
  crop: unknown,
) {
  const prepared = await cropMaterialImage(image, crop);
  const source = await saveNormalizedUploadDataUrl(prepared.sourceDataUrl);
  let cropped:
    | Awaited<ReturnType<typeof saveNormalizedUploadDataUrl>>
    | undefined;
  let committed = false;
  try {
    cropped = await saveNormalizedUploadDataUrl(prepared.cropDataUrl);
    const createdAt = new Date().toISOString();
    const id = nanoid(14);
    const result = await transaction(async (client) => {
      if (!(await lockActiveOwner(client, ownerId))) return null;
      const quota = (
        await client.query<{ draft_count: string; byte_count: string }>(
          `
        SELECT COUNT(DISTINCT analysis.id)::text AS draft_count, COALESCE(SUM(file.byte_length),0)::text AS byte_count
        FROM material_analyses analysis
        LEFT JOIN files file ON file.id IN (substring(analysis.source_image from 12), substring(analysis.crop_image from 12))
        WHERE analysis.owner_id=$1 AND analysis.status <> 'saved'
      `,
          [ownerId],
        )
      ).rows[0];
      if (
        Number(quota?.draft_count ?? 0) >= MAX_MATERIAL_DRAFTS_PER_OWNER ||
        Number(quota?.byte_count ?? 0) +
          source.byteLength +
          cropped!.byteLength >
          MAX_MATERIAL_DRAFT_BYTES_PER_OWNER
      ) {
        throw new MaterialAnalysisQuotaError();
      }
      await insertFile(client, ownerId, source, createdAt);
      await insertFile(client, ownerId, cropped!, createdAt);
      const rows = await client.query<AnalysisRow>(
        `
        INSERT INTO material_analyses(
          id,owner_id,status,source_image,crop_image,crop,created_at,updated_at
        ) VALUES ($1,$2,'draft',$3,$4,$5::jsonb,$6,$6)
        RETURNING *
      `,
        [
          id,
          ownerId,
          source.url,
          cropped!.url,
          JSON.stringify(prepared.crop),
          createdAt,
        ],
      );
      return rows.rows[0];
    });
    if (!result) throw new Error("账号已停用或删除");
    committed = true;
    return mapAnalysis(result);
  } finally {
    if (!committed) {
      deleteStoredImage(source.id);
      if (cropped) deleteStoredImage(cropped.id);
    }
  }
}

export async function purgeExpiredMaterialDrafts(): Promise<number> {
  const now = new Date().toISOString();
  const leaseCutoff = new Date(
    Date.now() - MATERIAL_ANALYSIS_LEASE_MS,
  ).toISOString();
  const expiredFileIds = await transaction(async (client) => {
    await client.query(
      `
      UPDATE material_analyses
      SET status='outcome_unknown',error='分析服务中断，结果可能未知；请人工确认后重试',
        revision=revision+1,updated_at=$1
      WHERE status='analyzing' AND updated_at <= $2
    `,
      [now, leaseCutoff],
    );
    const rows = await client.query<
      Pick<AnalysisRow, "id" | "source_image" | "crop_image">
    >(
      `
      SELECT id,source_image,crop_image FROM material_analyses
      WHERE status NOT IN ('saved','analyzing')
        AND EXISTS (
          SELECT 1 FROM files
          WHERE files.id IN (substring(material_analyses.source_image from 12), substring(material_analyses.crop_image from 12))
            AND files.purge_after IS NOT NULL AND files.purge_after <= $1
        )
      FOR UPDATE
    `,
      [now],
    );
    if (rows.rows.length === 0) return [];
    const analysisIds = rows.rows.map((row) => row.id);
    const fileIds = rows.rows.flatMap((row) => [
      path.basename(row.source_image),
      path.basename(row.crop_image),
    ]);
    await client.query(
      "DELETE FROM material_analyses WHERE id = ANY($1::text[])",
      [analysisIds],
    );
    const deleted = await client.query<{ id: string }>(
      "DELETE FROM files WHERE id = ANY($1::text[]) RETURNING id",
      [fileIds],
    );
    return deleted.rows.map((row) => row.id);
  });
  expiredFileIds.forEach(deleteStoredImage);
  return expiredFileIds.length;
}

export async function recoverExpiredMaterialAnalysisLeasesForOwner(
  ownerId: string,
  client: PoolClient,
) {
  const result = await client.query(
    `
    UPDATE material_analyses
    SET status='outcome_unknown',error='分析服务中断，结果可能未知；请人工确认后重试',
      revision=revision+1,updated_at=$1
    WHERE owner_id=$2 AND status='analyzing' AND updated_at <= $3
  `,
    [
      new Date().toISOString(),
      ownerId,
      new Date(Date.now() - MATERIAL_ANALYSIS_LEASE_MS).toISOString(),
    ],
  );
  return result.rowCount ?? 0;
}

async function recoverExpiredAnalysisLease(
  ownerId: string,
  id: string,
  client?: PoolClient,
) {
  const leaseCutoff = new Date(
    Date.now() - MATERIAL_ANALYSIS_LEASE_MS,
  ).toISOString();
  await query(
    `
    UPDATE material_analyses
    SET status='outcome_unknown',error='上次分析在服务重启或超时后未能确认结果，请人工决定是否重试',
      revision=revision+1,updated_at=$1
    WHERE id=$2 AND owner_id=$3 AND status='analyzing' AND updated_at <= $4
  `,
    [new Date().toISOString(), id, ownerId, leaseCutoff],
    client,
  );
}

export async function readMaterialAnalysis(ownerId: string, id: string) {
  await recoverExpiredAnalysisLease(ownerId, id);
  const row = await queryOne<AnalysisRow>(
    `
    SELECT id,revision,status,source_image,crop_image,crop,model_id,suggestion,calibration,error,asset_id,created_at,updated_at
    FROM material_analyses WHERE id=$1 AND owner_id=$2
  `,
    [id, ownerId],
  );
  return row ? mapAnalysis(row) : null;
}

export async function listMaterialModels(admin = false) {
  const state = await queryOne<{ revision: number }>(
    "SELECT revision FROM material_analysis_model_state WHERE singleton=TRUE",
  );
  const rows = await query<{
    id: string;
    label: string;
    protocol: MaterialAnalysisModel["protocol"];
    enabled: boolean;
    is_default: boolean;
    revision: number;
  }>(`SELECT id,label,protocol,enabled,is_default,revision FROM material_analysis_models
      WHERE retired_at IS NULL${admin ? "" : " AND enabled=TRUE"} ORDER BY is_default DESC,label COLLATE "C"`);
  return {
    revision: state?.revision ?? 1,
    models: rows.map((row) => ({
      id: row.id,
      label: row.label,
      protocol: row.protocol,
      enabled: row.enabled,
      isDefault: row.is_default,
      revision: row.revision,
    })),
  };
}

export async function replaceMaterialModels(
  rawRevision: unknown,
  rawModels: unknown,
) {
  const revision = expectedRevision(rawRevision);
  if (
    !Array.isArray(rawModels) ||
    rawModels.length < 1 ||
    rawModels.length > 16
  ) {
    throw new Error("分析模型必须是 1–16 项数组");
  }
  const seen = new Set<string>();
  const models = rawModels.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("分析模型格式无效");
    const item = raw as Record<string, unknown>;
    if (
      Object.keys(item).some(
        (key) =>
          !["id", "label", "protocol", "enabled", "isDefault"].includes(key),
      ) ||
      typeof item.id !== "string" ||
      !/^[A-Za-z0-9._-]{1,120}$/.test(item.id) ||
      seen.has(item.id) ||
      typeof item.label !== "string" ||
      !item.label.trim() ||
      item.label.length > 120 ||
      item.protocol !== "gemini-generate-content" ||
      typeof item.enabled !== "boolean" ||
      typeof item.isDefault !== "boolean"
    ) {
      throw new Error("分析模型格式无效");
    }
    seen.add(item.id);
    return {
      id: item.id,
      label: item.label.trim(),
      protocol: item.protocol,
      enabled: item.enabled,
      isDefault: item.isDefault,
    };
  });
  if (
    models.filter((model) => model.enabled && model.isDefault).length !== 1 ||
    models.some((model) => model.isDefault && !model.enabled)
  ) {
    throw new Error("必须且只能设置一个已启用的默认模型");
  }
  const updated = await transaction(async (client) => {
    const state = await client.query<{ revision: number }>(
      "SELECT revision FROM material_analysis_model_state WHERE singleton=TRUE FOR UPDATE",
    );
    if (state.rows[0]?.revision !== revision) return false;
    const now = new Date().toISOString();
    await client.query(
      "UPDATE material_analysis_models SET enabled=FALSE,is_default=FALSE,retired_at=$1,revision=revision+1,updated_at=$1",
      [now],
    );
    for (const model of models) {
      await client.query(
        `
        INSERT INTO material_analysis_models(id,label,protocol,enabled,is_default,revision,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,1,$6,$6)
        ON CONFLICT(id) DO UPDATE SET label=EXCLUDED.label,protocol=EXCLUDED.protocol,
          enabled=EXCLUDED.enabled,is_default=EXCLUDED.is_default,retired_at=NULL,
          revision=material_analysis_models.revision+1,updated_at=EXCLUDED.updated_at
      `,
        [
          model.id,
          model.label,
          model.protocol,
          model.enabled,
          model.isDefault,
          now,
        ],
      );
    }
    await client.query(
      "UPDATE material_analysis_model_state SET revision=revision+1 WHERE singleton=TRUE",
    );
    return true;
  });
  return updated ? listMaterialModels(true) : null;
}

export async function runMaterialAnalysis(
  ownerId: string,
  id: string,
  rawRevision: unknown,
  modelId: unknown,
) {
  const revision = expectedRevision(rawRevision);
  if (typeof modelId !== "string" || !/^[A-Za-z0-9._-]{1,120}$/.test(modelId))
    throw new Error("分析模型无效");
  const running = await transaction(async (client) => {
    if (!(await lockActiveOwner(client, ownerId)))
      return { status: "owner" as const };
    await recoverExpiredAnalysisLease(ownerId, id, client);
    const row = await client.query<AnalysisRow>(
      "SELECT * FROM material_analyses WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [id, ownerId],
    );
    const current = row.rows[0];
    if (!current) return { status: "missing" as const };
    if (
      current.revision !== revision ||
      current.status === "analyzing" ||
      current.status === "saved"
    )
      return { status: "conflict" as const };
    const model = await client.query<{ id: string }>(
      "SELECT id FROM material_analysis_models WHERE id=$1 AND enabled=TRUE FOR SHARE",
      [modelId],
    );
    if (!model.rows[0]) return { status: "model" as const };
    const now = new Date().toISOString();
    const updated = await client.query<AnalysisRow>(
      `
      UPDATE material_analyses SET status='analyzing',model_id=$1,suggestion=NULL,error=NULL,
        revision=revision+1,updated_at=$2 WHERE id=$3 RETURNING *
    `,
      [modelId, now, id],
    );
    return { status: "running" as const, row: updated.rows[0] };
  });
  if (running.status !== "running") return running;
  const runningRevision = running.row.revision;
  try {
    const suggestion = await analyzeMaterialImage(
      await resolveToDataUrl(running.row.crop_image),
      modelId,
    );
    const updated = await queryOne<AnalysisRow>(
      `
      UPDATE material_analyses SET status='analyzed',suggestion=$1::jsonb,error=NULL,
        revision=revision+1,updated_at=$2
      WHERE id=$3 AND owner_id=$4 AND revision=$5 AND status='analyzing' RETURNING *
    `,
      [
        JSON.stringify(suggestion),
        new Date().toISOString(),
        id,
        ownerId,
        runningRevision,
      ],
    );
    return updated
      ? { status: "analyzed" as const, row: mapAnalysis(updated) }
      : { status: "superseded" as const };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 500) : "材质分析失败";
    const outcomeUnknown =
      error instanceof ProviderError &&
      (error.category === "outcome_unknown" ||
        (error.category === "unknown" && (error.status ?? 500) >= 500));
    const status = outcomeUnknown ? "outcome_unknown" : "failed";
    await query(
      `
      UPDATE material_analyses SET status=$1,error=$2,revision=revision+1,updated_at=$3
      WHERE id=$4 AND owner_id=$5 AND revision=$6 AND status='analyzing'
    `,
      [status, message, new Date().toISOString(), id, ownerId, runningRevision],
    );
    throw error;
  }
}

export class MaterialCalibrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialCalibrationError";
  }
}

function calibrationHex(raw: string): `#${string}` {
  try {
    return parseColorValue(raw);
  } catch {
    throw new MaterialCalibrationError("校准颜色无效");
  }
}

async function canonicalPantone(
  client: PoolClient,
  raw: unknown,
): Promise<PantoneColorReference> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new MaterialCalibrationError("Pantone 色号格式无效");
  const value = raw as Record<string, unknown>;
  if (
    typeof value.catalogId !== "string" ||
    typeof value.releaseId !== "string" ||
    typeof value.libraryKey !== "string" ||
    typeof value.code !== "string" ||
    typeof value.hex !== "string"
  ) {
    throw new MaterialCalibrationError("Pantone 色号格式无效");
  }
  const hex = calibrationHex(value.hex);
  const result = await client.query<PantoneColorReference>(
    `
    SELECT i.id AS "catalogId",v.release_id AS "releaseId",i.library_key AS "libraryKey",i.code,v.hex
    FROM color_catalog_identities i JOIN color_catalog_versions v ON v.color_id=i.id
    WHERE i.id=$1 AND v.release_id=$2 AND v.status='ready' AND v.hex IS NOT NULL
  `,
    [value.catalogId, value.releaseId],
  );
  const canonical = result.rows[0];
  if (
    !canonical ||
    canonical.libraryKey !== value.libraryKey ||
    canonical.code !== value.code ||
    canonical.hex !== hex
  ) {
    throw new MaterialCalibrationError("Pantone 色号与主库版本不一致");
  }
  return canonical;
}

export async function validateMaterialCalibration(
  client: PoolClient,
  raw: unknown,
): Promise<MaterialAnalysisCalibration> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new MaterialCalibrationError("校准数据无效");
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => !["name", "materialDescription", "colors"].includes(key),
    ) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 200 ||
    typeof value.materialDescription !== "string" ||
    !value.materialDescription.trim() ||
    value.materialDescription.length > 1_000 ||
    !Array.isArray(value.colors) ||
    value.colors.length < 1 ||
    value.colors.length > 12
  ) {
    throw new MaterialCalibrationError(
      "入库前需要名称、材质描述和 1–12 个颜色",
    );
  }
  const seen = new Set<string>();
  const colors: MaterialAnalysisColor[] = [];
  for (const rawColor of value.colors) {
    if (!rawColor || typeof rawColor !== "object" || Array.isArray(rawColor))
      throw new MaterialCalibrationError("校准颜色无效");
    const color = rawColor as Record<string, unknown>;
    if (typeof color.hex !== "string")
      throw new MaterialCalibrationError("校准颜色无效");
    const hex = calibrationHex(color.hex);
    const pantone =
      color.pantone === undefined
        ? undefined
        : await canonicalPantone(client, color.pantone);
    const key = pantone ? `pantone:${pantone.catalogId}` : `hex:${hex}`;
    if (seen.has(key)) throw new MaterialCalibrationError("校准颜色重复");
    seen.add(key);
    colors.push({
      hex,
      ...(typeof color.name === "string" && color.name.trim()
        ? { name: color.name.trim().slice(0, 80) }
        : {}),
      ...(pantone ? { pantone } : {}),
    });
  }
  return {
    name: value.name.trim(),
    materialDescription: value.materialDescription.trim(),
    colors,
  };
}

export async function saveMaterialAsset(
  ownerId: string,
  id: string,
  rawRevision: unknown,
  rawCalibration: unknown,
) {
  const revision = expectedRevision(rawRevision);
  return transaction(async (client) => {
    if (!(await lockActiveOwner(client, ownerId)))
      return { status: "owner" as const };
    const rows = await client.query<AnalysisRow>(
      "SELECT * FROM material_analyses WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [id, ownerId],
    );
    const row = rows.rows[0];
    if (!row) return { status: "missing" as const };
    if (
      row.revision !== revision ||
      row.status !== "analyzed" ||
      !row.model_id ||
      !row.suggestion
    )
      return { status: "conflict" as const };
    const confirmed = await validateMaterialCalibration(client, rawCalibration);
    const now = new Date().toISOString();
    const assetId = nanoid(10);
    const metadata = {
      analysisId: id,
      modelId: row.model_id,
      crop: row.crop,
      materialDescription: confirmed.materialDescription,
      colors: confirmed.colors,
      analyzedAt: row.updated_at,
      confirmedAt: now,
    };
    await client.query(
      "UPDATE files SET purge_after=NULL WHERE id=ANY($1::text[])",
      [[path.basename(row.source_image), path.basename(row.crop_image)]],
    );
    await client.query(
      `
      INSERT INTO assets(id,owner_id,scope,name,category,image,source_note,material_metadata,created_at)
      VALUES ($1,$2,'shared',$3,'fabric',$4,$5,$6::jsonb,$7)
    `,
      [
        assetId,
        ownerId,
        confirmed.name,
        row.crop_image,
        `材质分析 ${id}`,
        JSON.stringify(metadata),
        now,
      ],
    );
    const updated = await client.query<AnalysisRow>(
      `
      UPDATE material_analyses SET status='saved',calibration=$1::jsonb,asset_id=$2,
        revision=revision+1,updated_at=$3 WHERE id=$4 RETURNING *
    `,
      [JSON.stringify(confirmed), assetId, now, id],
    );
    return {
      status: "saved" as const,
      assetId,
      row: mapAnalysis(updated.rows[0]),
    };
  });
}

export async function deleteMaterialDraft(ownerId: string, id: string) {
  const deleted = await transaction(async (client) => {
    const rows = await client.query<AnalysisRow>(
      "SELECT * FROM material_analyses WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [id, ownerId],
    );
    const row = rows.rows[0];
    if (!row) return null;
    if (row.status === "saved") throw new Error("已入库分析不能删除");
    await client.query("DELETE FROM material_analyses WHERE id=$1", [id]);
    await client.query("DELETE FROM files WHERE id = ANY($1::text[])", [
      [path.basename(row.source_image), path.basename(row.crop_image)],
    ]);
    return row;
  });
  if (deleted) {
    deleteStoredImage(path.basename(deleted.source_image));
    deleteStoredImage(path.basename(deleted.crop_image));
  }
  return Boolean(deleted);
}

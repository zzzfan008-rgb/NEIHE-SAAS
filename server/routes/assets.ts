import { Router } from "express";
import { nanoid } from "nanoid";
import path from "node:path";
import { requestUser } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { query, queryOne, transaction } from "../lib/database";
import { deleteStoredImage, saveNormalizedUploadDataUrl, thumbnailUrlForImage } from "../lib/fileStore";
import { ImageValidationError, isLocalImageReference } from "../lib/imageValidation";
import { lockActiveOwner } from "../lib/ownerMutation";
import { MaterialCalibrationError, validateMaterialCalibration } from "../lib/materialAnalysisStore";
import type { Asset } from "../../src/types/workflow";

export const assetsRouter = Router();
const CATEGORIES: Asset["category"][] = ["upload", "generated", "print", "fabric", "reference"];
const TRASH_DAYS = 15;

interface AssetRow {
  id: string; owner_id: string | null; owner_name: string | null;
  scope: "global" | "private" | "shared"; name: string; category: Asset["category"];
  image: string; source_note: string | null; material_metadata: Asset["material"] | null;
  created_at: string; deleted_at: string | null; purge_after: string | null;
}

function mapAsset(row: AssetRow, currentUserId: string) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    scope: row.scope,
    name: row.name,
    category: row.category,
    image: row.image,
    thumbnail: thumbnailUrlForImage(row.image),
    ...(row.source_note ? { sourceNote: row.source_note } : {}),
    ...(row.material_metadata ? { material: row.material_metadata } : {}),
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    purgeAfter: row.purge_after,
    canManage: row.scope === "global" ? false : row.owner_id === currentUserId,
  };
}

async function purgeExpiredAssets(): Promise<void> {
  await query(`
    DELETE FROM assets WHERE purge_after IS NOT NULL AND purge_after <= $1
      AND NOT EXISTS (SELECT 1 FROM project_asset_refs r WHERE r.asset_id = assets.id)
  `, [new Date().toISOString()]);
}

assetsRouter.get("/", asyncHandler(async (req, res) => {
  await purgeExpiredAssets();
  const user = requestUser(req);
  const category = req.query.category as string | undefined;
  if (category && !CATEGORIES.includes(category as Asset["category"])) {
    res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(", ")}` });
    return;
  }
  const includeDeleted = req.query.deleted === "true";
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  // 名称模糊搜索：转义 LIKE 通配符（%、_、\），按字面子串匹配整库。
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const searchPattern = search ? `%${search.replace(/[\\%_]/g, "\\$&")}%` : null;
  const rows = await query<AssetRow>(`
    SELECT a.*, u.display_name AS owner_name
    FROM assets a LEFT JOIN users u ON u.id = a.owner_id
    WHERE ($1::text IS NULL OR a.category = $1)
      AND ($6::text IS NULL OR a.name ILIKE $6)
      AND (${includeDeleted ? "a.deleted_at IS NOT NULL" : "a.deleted_at IS NULL"})
      AND (${includeDeleted
        ? "$2 = 'admin' OR a.owner_id = $3"
        : "$2 = 'admin' OR a.scope IN ('global','shared') OR a.owner_id = $3"})
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT $4 OFFSET $5
  `, [category ?? null, user.role, user.id, limit, offset, searchPattern]);
  res.json(rows.map((row) => ({
    ...mapAsset(row, user.id),
    canManage: row.owner_id === user.id || (user.role === "admin" && row.scope !== "private"),
  })));
}));

assetsRouter.post("/", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { name, category, image, sourceNote, scope } = req.body as {
    name?: string; category?: Asset["category"]; image?: string; sourceNote?: string;
    scope?: "global" | "private" | "shared";
  };
  if (typeof name !== "string" || !name.trim() || name.length > 200 || !category ||
      !CATEGORIES.includes(category) || typeof image !== "string" || !image) {
    res.status(400).json({ error: "name, category and image are required" });
    return;
  }
  if (scope === "global" && user.role !== "admin") {
    res.status(403).json({ error: "只有管理员可以创建通用素材" });
    return;
  }
  let saved: Awaited<ReturnType<typeof saveNormalizedUploadDataUrl>> | undefined;
  let committed = false;
  try {
    if (sourceNote !== undefined && (typeof sourceNote !== "string" || sourceNote.length > 2_000)) {
      throw new ImageValidationError("sourceNote must be a string of at most 2000 characters");
    }
    const finalScope = scope === "global" && user.role === "admin" ? "global" : scope === "shared" ? "shared" : "private";
    saved = image.startsWith("data:") ? await saveNormalizedUploadDataUrl(image) : undefined;
    const imageUrl = saved?.url ?? (isLocalImageReference(image) ? image : "");
    if (!imageUrl) throw new ImageValidationError("image must be a local image reference or valid image dataURL");
    const id = nanoid(10);
    const createdAt = new Date().toISOString();
    const created = await transaction(async (client) => {
      if (!await lockActiveOwner(client, user.id)) return "owner_unavailable" as const;
      if (saved) {
        await client.query(`
          INSERT INTO files (
            id, owner_id, source_type, mime_type, width, height, byte_length, normalized, created_at
          ) VALUES ($1, $2, 'asset', $3, $4, $5, $6, TRUE, $7)
          ON CONFLICT (id) DO NOTHING
        `, [
          saved.id, finalScope === "global" ? null : user.id, saved.mimeType, saved.width,
          saved.height, saved.byteLength, createdAt,
        ]);
      } else {
        // 已有本地文件的授权按 assets → files 顺序持锁。共享来源在新素材提交前
        // 不能被撤回，文件也不能在校验与 INSERT 之间被 TTL 清理。
        const supportingAsset = await queryOne<{ id: string }>(`
          SELECT id FROM assets
          WHERE image = $1 AND deleted_at IS NULL AND scope IN ('global','shared')
          ORDER BY id
          LIMIT 1
          FOR SHARE
        `, [imageUrl], client);
        const shared = supportingAsset !== undefined;
        const fileLock = finalScope === "global" ? "FOR UPDATE" : "FOR SHARE";
        const access = await queryOne<{ owner_id: string | null }>(`
          SELECT owner_id FROM files
          WHERE id = $1 AND deleted_at IS NULL
          ${fileLock}
        `, [path.basename(imageUrl)], client);
        if (!access || (access.owner_id !== null && access.owner_id !== user.id && user.role !== "admin" && !shared)) {
          return "missing" as const;
        }
      }
      if (finalScope === "global") {
        await client.query(`
          UPDATE files SET owner_id = NULL, deleted_at = NULL, purge_after = NULL WHERE id = $1
        `, [path.basename(imageUrl)]);
      }
      await client.query(`
        INSERT INTO assets (id, owner_id, scope, name, category, image, source_note, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [id, finalScope === "global" ? null : user.id, finalScope, name.trim(), category, imageUrl, sourceNote ?? null, createdAt]);
      return "created" as const;
    });
    if (created !== "created") {
      if (saved) deleteStoredImage(saved.id);
      if (created === "owner_unavailable") {
        res.status(409).json({ error: "账号已停用或删除，不能继续创建素材" });
        return;
      }
      res.status(404).json({ error: "image file not found" });
      return;
    }
    committed = true;
    res.status(201).json({
      ok: true,
      id,
      url: imageUrl,
      ...(saved ? {
        mimeType: saved.mimeType,
        width: saved.width,
        height: saved.height,
        byteLength: saved.byteLength,
        normalized: true,
      } : {}),
    });
  } catch (error) {
    if (saved && !committed) deleteStoredImage(saved.id);
    res.status(error instanceof ImageValidationError ? 400 : 500)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
}));

assetsRouter.patch("/:id", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { name, scope, category, material } = req.body as {
    name?: string; scope?: "global" | "private" | "shared"; category?: Asset["category"]; material?: unknown;
  };
  if (category !== undefined && !CATEGORIES.includes(category)) {
    res.status(400).json({ error: "素材分类无效" });
    return;
  }
  if (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 200)) {
    res.status(400).json({ error: "素材名称无效" });
    return;
  }
  if (scope === "global" && user.role !== "admin") {
    res.status(403).json({ error: "只有管理员可以设置通用素材" });
    return;
  }
  const result = await transaction(async (client) => {
    if (!await lockActiveOwner(client, user.id)) return "owner_unavailable" as const;
    const row = await queryOne<{
      owner_id: string | null; scope: "global" | "private" | "shared"; image: string;
      category: Asset["category"]; material_metadata: Asset["material"] | null;
    }>(
      "SELECT owner_id, scope, image, category, material_metadata FROM assets WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
      [req.params.id],
      client,
    );
    if (!row) return "missing" as const;
    const canManage = row.owner_id === user.id || (user.role === "admin" && row.scope !== "private");
    if (!canManage) return "forbidden" as const;
    let confirmedMaterial: Awaited<ReturnType<typeof validateMaterialCalibration>> | null = null;
    if (material !== undefined) {
      if ((category ?? row.category) !== "fabric") return "material_category" as const;
      try { confirmedMaterial = await validateMaterialCalibration(client, material); }
      catch (error) {
        if (error instanceof MaterialCalibrationError) return { validation: error.message } as const;
        throw error;
      }
    }
    const nextScope = scope ?? row.scope;
    const nextOwnerId = nextScope === "global" ? null : (row.owner_id ?? user.id);
    if (scope !== undefined && nextScope === "private" && row.scope !== "private") {
      const foreignProjectReference = await queryOne<{ project_id: string }>(`
        SELECT refs.project_id
        FROM project_asset_refs refs
        JOIN projects project ON project.id = refs.project_id
        WHERE refs.asset_id = $1 AND project.owner_id <> $2
        LIMIT 1
        FOR SHARE OF project
      `, [req.params.id, nextOwnerId], client);
      if (foreignProjectReference) return "project_reference" as const;
    }
    if (scope !== undefined && scope !== row.scope && isLocalImageReference(row.image)) {
      const sharedReference = await queryOne<{ id: string }>(`
        SELECT id FROM assets
        WHERE image = $1 AND id <> $2
        LIMIT 1
        FOR SHARE
      `, [row.image, req.params.id], client);
      if (sharedReference) return "shared_reference" as const;
      await client.query(`
        UPDATE files SET owner_id = $1, deleted_at = NULL, purge_after = NULL WHERE id = $2
      `, [nextOwnerId, path.basename(row.image)]);
    }
    const updatedMaterial = confirmedMaterial ? {
      ...(row.material_metadata ?? {}),
      materialDescription: confirmedMaterial.materialDescription,
      colors: confirmedMaterial.colors,
      confirmedAt: new Date().toISOString(),
    } : null;
    await client.query(
      `UPDATE assets SET name = COALESCE($1, name), scope = $2, owner_id = $3,
       category = COALESCE($5, category), material_metadata = COALESCE($6::jsonb, material_metadata) WHERE id = $4`,
      [name?.trim() ?? confirmedMaterial?.name ?? null, nextScope, nextOwnerId, req.params.id, category ?? null,
        updatedMaterial ? JSON.stringify(updatedMaterial) : null],
    );
    return "updated" as const;
  });
  if (result === "owner_unavailable") {
    res.status(409).json({ error: "账号已停用或删除，不能继续修改素材" });
    return;
  }
  if (result === "material_category") {
    res.status(400).json({ error: "只有面料素材可以编辑材质校准信息" });
    return;
  }
  if (typeof result === "object" && "validation" in result) {
    res.status(400).json({ error: result.validation });
    return;
  }
  if (result === "missing") {
    res.status(404).json({ error: "asset not found" });
    return;
  }
  if (result === "forbidden") {
    res.status(403).json({ error: "无权修改此素材" });
    return;
  }
  if (result === "project_reference") {
    res.status(409).json({ error: "该素材仍被其他账号的项目引用，不能收窄为私有" });
    return;
  }
  if (result === "shared_reference") {
    res.status(409).json({ error: "该图片仍被其他活跃素材引用，不能切换可见范围" });
    return;
  }
  res.json({ ok: true });
}));

assetsRouter.post("/:id/references", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { projectId } = req.body as { projectId?: string };
  if (typeof projectId !== "string" || !projectId) {
    res.status(400).json({ error: "projectId is required" });
    return;
  }
  const linked = await transaction(async (client) => {
    if (!await lockActiveOwner(client, user.id)) return "owner_unavailable" as const;
    const project = await queryOne<{ id: string }>(`
      SELECT id FROM projects
      WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL
      FOR UPDATE
    `, [projectId, user.id], client);
    if (!project) return "missing" as const;
    const asset = await queryOne<{ id: string }>(`
      SELECT id FROM assets WHERE id = $1 AND deleted_at IS NULL
        AND (scope IN ('global','shared') OR owner_id = $2)
      FOR KEY SHARE
    `, [req.params.id, user.id], client);
    if (!asset) return "missing" as const;
    await client.query(`
      INSERT INTO project_asset_refs (project_id, asset_id, created_at) VALUES ($1, $2, $3)
      ON CONFLICT (project_id, asset_id) DO NOTHING
    `, [projectId, req.params.id, new Date().toISOString()]);
    return "linked" as const;
  });
  if (linked === "owner_unavailable") {
    res.status(409).json({ error: "账号已停用或删除，不能继续关联素材" });
    return;
  }
  if (linked === "missing") {
    // 统一 404，避免泄露项目或私有素材是否存在。
    res.status(404).json({ error: "project or asset not found" });
    return;
  }
  res.json({ ok: true });
}));

assetsRouter.delete("/:id", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const result = await transaction(async (client) => {
    if (!await lockActiveOwner(client, user.id)) return { status: "owner_unavailable" as const };
    const row = await queryOne<{ owner_id: string | null; scope: "global" | "private" | "shared" }>(
      "SELECT owner_id, scope FROM assets WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
      [req.params.id],
      client,
    );
    if (!row) return { status: "missing" as const };
    const canManage = row.owner_id === user.id || (user.role === "admin" && row.scope !== "private");
    if (!canManage) return { status: "forbidden" as const };
    const ref = await queryOne<{ project_id: string }>(
      "SELECT project_id FROM project_asset_refs WHERE asset_id = $1 LIMIT 1",
      [req.params.id],
      client,
    );
    if (ref) return { status: "referenced" as const };
    const deletedAt = new Date();
    const purgeAfter = new Date(deletedAt.getTime() + TRASH_DAYS * 24 * 60 * 60 * 1000);
    await client.query("UPDATE assets SET deleted_at = $1, purge_after = $2 WHERE id = $3", [
      deletedAt.toISOString(), purgeAfter.toISOString(), req.params.id,
    ]);
    return { status: "deleted" as const, purgeAfter: purgeAfter.toISOString() };
  });
  if (result.status === "missing") {
    res.status(404).json({ error: "asset not found" });
    return;
  }
  if (result.status === "owner_unavailable") {
    res.status(409).json({ error: "账号已停用或删除，不能继续删除素材" });
    return;
  }
  if (result.status === "forbidden") {
    res.status(403).json({ error: "无权删除此素材" });
    return;
  }
  if (result.status === "referenced") {
    res.status(409).json({ error: "素材正在被项目使用，不能删除" });
    return;
  }
  res.json({ ok: true, purgeAfter: result.purgeAfter });
}));

assetsRouter.post("/:id/restore", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const result = await transaction(async (client) => {
    if (!await lockActiveOwner(client, user.id)) return "owner_unavailable" as const;
    const row = await queryOne<{ owner_id: string | null; scope: "global" | "private" | "shared" }>(
      "SELECT owner_id, scope FROM assets WHERE id = $1 AND deleted_at IS NOT NULL FOR UPDATE",
      [req.params.id],
      client,
    );
    if (!row) return "missing" as const;
    const canManage = row.owner_id === user.id || (user.role === "admin" && row.scope !== "private");
    if (!canManage) return "forbidden" as const;
    await client.query("UPDATE assets SET deleted_at = NULL, purge_after = NULL WHERE id = $1", [req.params.id]);
    return "restored" as const;
  });
  if (result === "owner_unavailable") {
    res.status(409).json({ error: "账号已停用或删除，不能继续恢复素材" });
    return;
  }
  if (result === "missing") {
    res.status(404).json({ error: "回收站中没有此素材" });
    return;
  }
  if (result === "forbidden") {
    res.status(403).json({ error: "无权恢复此素材" });
    return;
  }
  res.json({ ok: true });
}));

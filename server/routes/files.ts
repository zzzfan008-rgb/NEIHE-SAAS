/**
 * 文件上传/读取：
 *   POST /api/files      { dataUrl } → 保真存储或大图压缩后的图片元数据（base64 JSON，body limit 50mb）
 *   GET  /api/files/:id  读取图片（id 含扩展名，如 abc12.png）
 */
import { Router, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import {
  deleteStoredImage, ensureThumbnail, isSupportedImageFile, isSupportedMediaFile, mimeOfFile,
  normalizeImageRef, resolveToDataUrl, saveDataUrl, saveNormalizedUploadDataUrl, saveVideoUploadDataUrl, uploadsDir,
} from "../lib/fileStore";
import { ProviderError } from "../providers/base";
import { ImageValidationError } from "../lib/imageValidation";
import { requestUser } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { query, queryOne, transaction } from "../lib/database";
import { lockActiveOwner } from "../lib/ownerMutation";
import {
  assertImageReferencesAccessible,
  ImageReferenceAccessError,
} from "../lib/imageReferenceAccess";
import { validateMaskForSource } from "../lib/maskProcessing";
import { MAX_WORKFLOW_NODES } from "../lib/workflowSchema";

export const filesRouter = Router();

const SAFE_PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_NODE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MASK_DRAFT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_MASK_COPY_REFS = MAX_WORKFLOW_NODES;

type FileAccess = "public" | "private" | "denied";

async function canAccessFile(id: string, req: Parameters<typeof requestUser>[0]): Promise<FileAccess> {
  const user = requestUser(req);
  const access = await queryOne<{ owner_id: string | null; shared: boolean }>(`
    SELECT f.owner_id,
      EXISTS(SELECT 1 FROM assets a WHERE a.image = $1 AND a.deleted_at IS NULL AND a.scope IN ('global','shared')) AS shared
    FROM files f WHERE f.id = $2
  `, [`/api/files/${id}`, id]);
  // SQLite/旧版本导入会补 files 元数据；没有记录的物理文件只能是未完成写入或
  // 回收失败留下的孤儿，不能绕过账号 ACL 继续读取。
  if (!access) return "denied";
  if (access.owner_id === null || access.shared) return "public";
  if (access.owner_id === user.id || user.role === "admin") return "private";
  return "denied";
}

function setFileCacheHeaders(res: Response): void {
  // 文件路由始终需要登录，且 shared/global 素材都允许后续撤回共享。
  // 因此原图与缩略图都不能进入浏览器或代理的长期公共缓存。
  res.setHeader("Cache-Control", "private, no-store");
  res.vary("Cookie");
}

filesRouter.post("/", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { dataUrl } = req.body as { dataUrl?: string };
  if (!dataUrl) {
    res.status(400).json({ error: "dataUrl is required" });
    return;
  }
  try {
    const saved = await saveNormalizedUploadDataUrl(dataUrl);
    try {
      const registered = await transaction(async (client) => {
        if (!await lockActiveOwner(client, user.id)) return false;
        await client.query(`
          INSERT INTO files (
            id, owner_id, source_type, mime_type, width, height, byte_length, normalized, created_at
          ) VALUES ($1, $2, 'upload', $3, $4, $5, $6, TRUE, $7)
        `, [
          saved.id, user.id, saved.mimeType, saved.width, saved.height,
          saved.byteLength, new Date().toISOString(),
        ]);
        return true;
      });
      if (!registered) {
        deleteStoredImage(saved.id);
        res.status(409).json({ error: "账号已停用或删除，不能继续上传文件" });
        return;
      }
    } catch (error) {
      deleteStoredImage(saved.id);
      throw error;
    }
    res.json(saved);
  } catch (err) {
    if (err instanceof ProviderError || err instanceof ImageValidationError) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
}));

filesRouter.post("/video", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const dataUrl = typeof req.body?.dataUrl === "string" ? req.body.dataUrl : "";
  if (!dataUrl) return res.status(400).json({ error: "dataUrl is required" });
  let saved: ReturnType<typeof saveVideoUploadDataUrl> | undefined;
  try {
    saved = saveVideoUploadDataUrl(dataUrl);
    const registered = await transaction(async (client) => {
      if (!await lockActiveOwner(client, user.id)) return false;
      await client.query(`
        INSERT INTO files (
          id, owner_id, source_type, mime_type, byte_length, normalized, created_at
        ) VALUES ($1, $2, 'video-upload', $3, $4, FALSE, $5)
      `, [saved!.id, user.id, saved!.mimeType, saved!.byteLength, new Date().toISOString()]);
      return true;
    });
    if (!registered) {
      deleteStoredImage(saved.id);
      return res.status(409).json({ error: "账号已停用或删除，不能继续上传视频" });
    }
    return res.json(saved);
  } catch (error) {
    if (saved) deleteStoredImage(saved.id);
    return res.status(400).json({ error: error instanceof Error ? error.message : "视频上传失败" });
  }
}));

/**
 * 蒙版必须保持原始像素尺寸与 Alpha，不能走普通素材的缩放/重编码流程。
 * 新文件先以有期限的 draft 保存；项目成功保存后会认领当前引用并清除期限。
 */
filesRouter.post("/mask", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { dataUrl, sourceRef, projectId, nodeId } = req.body as {
    dataUrl?: string;
    sourceRef?: string;
    projectId?: string;
    nodeId?: string;
  };
  if (
    typeof dataUrl !== "string" || !dataUrl ||
    typeof sourceRef !== "string" || !sourceRef ||
    typeof projectId !== "string" || !SAFE_PROJECT_ID.test(projectId) ||
    typeof nodeId !== "string" || !SAFE_NODE_ID.test(nodeId)
  ) {
    res.status(400).json({ error: "dataUrl, sourceRef, projectId and nodeId are required" });
    return;
  }

  let saved: { id: string; url: string } | undefined;
  let committed = false;
  try {
    // normalizeImageRef 会直接读本地文件；必须先按当前账号做一次访问检查。
    await assertImageReferencesAccessible(sourceRef, user.id);
    const sourceDataUrl = await normalizeImageRef(sourceRef);
    const pair = await validateMaskForSource(sourceDataUrl, dataUrl);
    const storedMask = saveDataUrl(dataUrl);
    saved = storedMask;
    try {
      const registered = await transaction(async (client) => {
        if (!await lockActiveOwner(client, user.id)) return false;
        // 在登记事务内重查，防止共享素材在解码期间被撤销。
        await assertImageReferencesAccessible(sourceRef, user.id, client);
        const now = new Date();
        await client.query(`
          INSERT INTO files (
            id, owner_id, source_type, project_id, node_id,
            mime_type, width, height, byte_length, normalized,
            created_at, purge_after
          ) VALUES ($1, $2, 'mask-draft', $3, $4, 'image/png', $5, $6, $7, FALSE, $8, $9)
        `, [
          storedMask.id, user.id, projectId, nodeId,
          pair.width, pair.height, pair.maskBuffer.byteLength,
          now.toISOString(), new Date(now.getTime() + MASK_DRAFT_RETENTION_MS).toISOString(),
        ]);
        return true;
      });
      if (!registered) {
        deleteStoredImage(storedMask.id);
        saved = undefined;
        res.status(409).json({ error: "账号已停用或删除，不能继续保存蒙版" });
        return;
      }
      committed = true;
    } catch (error) {
      deleteStoredImage(storedMask.id);
      saved = undefined;
      throw error;
    }
    res.json({
      ...storedMask,
      mimeType: "image/png",
      width: pair.width,
      height: pair.height,
      byteLength: pair.maskBuffer.byteLength,
      preserved: true,
    });
  } catch (error) {
    if (saved && !committed) deleteStoredImage(saved.id);
    const status = error instanceof ImageReferenceAccessError
      ? 403
      : error instanceof ProviderError || error instanceof ImageValidationError
        ? 400
        : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  }
}));

/**
 * 项目身份变化时复制而非移动蒙版。原项目继续持有原文件；复制件先作为
 * mask-draft 绑定目标项目，待目标草稿同步或正式保存成功后再由项目路由认领。
 */
filesRouter.post("/masks/copy", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { sourceProjectId, targetProjectId, createTarget, masks } = req.body as {
    sourceProjectId?: unknown;
    targetProjectId?: unknown;
    createTarget?: unknown;
    masks?: unknown;
  };
  const wantsFreshTarget = createTarget === true;
  const hasExistingTarget = typeof targetProjectId === "string" && SAFE_PROJECT_ID.test(targetProjectId);
  if (
    typeof sourceProjectId !== "string" || !SAFE_PROJECT_ID.test(sourceProjectId) ||
    !Array.isArray(masks) || masks.length === 0 || masks.length > MAX_MASK_COPY_REFS ||
    (wantsFreshTarget ? targetProjectId !== undefined : !hasExistingTarget) ||
    (!wantsFreshTarget && sourceProjectId === targetProjectId)
  ) {
    res.status(400).json({ error: "sourceProjectId, a target mode and one or more masks are required" });
    return;
  }

  const requested = masks.map((value) => {
    if (!value || typeof value !== "object") return null;
    const candidate = value as { fileId?: unknown; nodeId?: unknown };
    if (
      typeof candidate.fileId !== "string" ||
      candidate.fileId !== path.basename(candidate.fileId) ||
      !candidate.fileId.endsWith(".png") ||
      !isSupportedImageFile(candidate.fileId) ||
      typeof candidate.nodeId !== "string" || !SAFE_NODE_ID.test(candidate.nodeId)
    ) return null;
    return { fileId: candidate.fileId, nodeId: candidate.nodeId };
  });
  if (requested.some((value) => value === null)) {
    res.status(400).json({ error: "each mask must contain a valid PNG fileId and nodeId" });
    return;
  }
  const refs = requested as Array<{ fileId: string; nodeId: string }>;
  if (new Set(refs.map((ref) => ref.fileId)).size !== refs.length) {
    res.status(400).json({ error: "mask fileId values must be unique" });
    return;
  }

  const copiedFileIds: string[] = [];
  let committed = false;
  try {
    const outcome = await transaction(async (client) => {
      if (!await lockActiveOwner(client, user.id)) return { status: "owner_unavailable" as const };
      let resolvedTargetId: string | undefined;
      if (wantsFreshTarget) {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const candidate = nanoid(10);
          const occupied = await queryOne<{ occupied: number }>(`
            SELECT 1 AS occupied FROM projects WHERE id = $1
            UNION ALL
            SELECT 1 AS occupied FROM files WHERE project_id = $1
            LIMIT 1
          `, [candidate], client);
          if (!occupied) {
            resolvedTargetId = candidate;
            break;
          }
        }
        if (!resolvedTargetId) return { status: "target_unavailable" as const };
      } else {
        const target = await queryOne<{ id: string }>(`
          SELECT id FROM projects
          WHERE id = $1 AND owner_id = $2
            AND lifecycle = 'initial_draft' AND deleted_at IS NULL
          FOR UPDATE
        `, [targetProjectId, user.id], client);
        if (!target) return { status: "target_unavailable" as const };
        resolvedTargetId = target.id;
      }

      const ids = refs.map((ref) => ref.fileId);
      const now = new Date();
      const nowIso = now.toISOString();
      const rows = ids.length === 0 ? [] : (await client.query<{
        id: string;
        owner_id: string | null;
        source_type: string;
        project_id: string | null;
        node_id: string | null;
        mime_type: string | null;
        width: number | null;
        height: number | null;
        byte_length: number | null;
        deleted_at: string | null;
        purge_after: string | null;
      }>(`
        SELECT id, owner_id, source_type, project_id, node_id, mime_type,
          width, height, byte_length, deleted_at, purge_after
        FROM files
        WHERE id = ANY($1::text[])
          AND (deleted_at IS NULL OR purge_after > $2)
        ORDER BY id
        FOR UPDATE
      `, [ids, nowIso])).rows;
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const ref of refs) {
        const row = byId.get(ref.fileId);
        if (
          !row || row.owner_id !== user.id ||
          (row.source_type !== "mask-draft" && row.source_type !== "mask") ||
          row.project_id !== sourceProjectId || row.node_id !== ref.nodeId ||
          row.mime_type !== "image/png"
        ) return { status: "source_forbidden" as const };
      }

      const purgeAfter = new Date(now.getTime() + MASK_DRAFT_RETENTION_MS).toISOString();
      const copies: Array<{ sourceUrl: string; targetUrl: string; nodeId: string }> = [];
      for (const ref of refs) {
        const row = byId.get(ref.fileId)!;
        const saved = saveDataUrl(resolveToDataUrl(`/api/files/${ref.fileId}`));
        copiedFileIds.push(saved.id);
        await client.query(`
          INSERT INTO files (
            id, owner_id, source_type, project_id, node_id,
            mime_type, width, height, byte_length, normalized,
            created_at, purge_after
          ) VALUES ($1, $2, 'mask-draft', $3, $4, 'image/png', $5, $6, $7, FALSE, $8, $9)
        `, [
          saved.id, user.id, resolvedTargetId, ref.nodeId,
          row.width, row.height, row.byte_length, nowIso, purgeAfter,
        ]);
        copies.push({
          sourceUrl: `/api/files/${ref.fileId}`,
          targetUrl: saved.url,
          nodeId: ref.nodeId,
        });
      }
      return { status: "copied" as const, targetProjectId: resolvedTargetId, copies };
    });
    committed = outcome.status === "copied";

    if (outcome.status === "owner_unavailable") {
      res.status(409).json({ error: "账号已停用或删除，不能复制蒙版" });
      return;
    }
    if (outcome.status === "target_unavailable") {
      res.status(404).json({ error: "目标初始草稿不可用" });
      return;
    }
    if (outcome.status === "source_forbidden") {
      res.status(403).json({ error: "蒙版文件与来源项目、节点或当前账号不匹配" });
      return;
    }
    res.json({ targetProjectId: outcome.targetProjectId, masks: outcome.copies });
  } catch (error) {
    if (!committed) copiedFileIds.forEach(deleteStoredImage);
    throw error;
  }
}));

filesRouter.get("/:id/thumbnail", asyncHandler(async (req, res) => {
  const id = path.basename(req.params.id);
  if (id !== req.params.id || !isSupportedImageFile(id)) {
    res.status(400).json({ error: "invalid file id" });
    return;
  }
  const access = await canAccessFile(id, req);
  if (access === "denied") {
    res.status(404).json({ error: "file not found" });
    return;
  }
  try {
    const thumbnail = await ensureThumbnail(id);
    res.setHeader("Content-Type", "image/webp");
    setFileCacheHeaders(res);
    fs.createReadStream(thumbnail).pipe(res);
  } catch (error) {
    res.status(error instanceof Error && error.message === "file not found" ? 404 : 422)
      .json({ error: error instanceof Error ? error.message : "thumbnail failed" });
  }
}));

filesRouter.get("/:id", asyncHandler(async (req, res) => {
  const id = path.basename(req.params.id); // 防路径穿越
  if (id !== req.params.id || !isSupportedMediaFile(id)) {
    res.status(400).json({ error: "invalid file id" });
    return;
  }
  const filePath = path.join(uploadsDir(), id);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "file not found" });
    return;
  }
  const access = await canAccessFile(id, req);
  if (access === "denied") {
    res.status(404).json({ error: "file not found" });
    return;
  }
  res.setHeader("Content-Type", mimeOfFile(id));
  setFileCacheHeaders(res);
  fs.createReadStream(filePath).pipe(res);
}));

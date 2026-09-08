import path from "node:path";
import { Router } from "express";
import { nanoid } from "nanoid";
import { requestUser } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { query, queryOne, transaction } from "../lib/database";
import { thumbnailUrlForImage } from "../lib/fileStore";
import { isLocalImageReference } from "../lib/imageValidation";
import { lockActiveOwner } from "../lib/ownerMutation";
import { BUILT_IN_TRY_ON_STYLE_PRESETS } from "../../src/lib/tryOnStylePresets";

export const tryOnStylePresetsRouter = Router();

interface TryOnStylePresetRow {
  id: string;
  owner_id: string;
  name: string;
  prompt: string;
  reference_image: string | null;
  created_at: string;
  updated_at: string;
}

tryOnStylePresetsRouter.get("/", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const custom = await query<TryOnStylePresetRow>(`
    SELECT id, owner_id, name, prompt, reference_image, created_at, updated_at
    FROM try_on_style_presets
    WHERE owner_id = $1 AND deleted_at IS NULL
    ORDER BY updated_at DESC, id DESC
  `, [user.id]);
  res.json([
    ...BUILT_IN_TRY_ON_STYLE_PRESETS.map((preset) => ({
      ...preset,
      builtIn: true,
      referenceImage: preset.referenceAsset,
    })),
    ...custom.map((preset) => ({
      id: preset.id,
      name: preset.name,
      description: "我的风格预设",
      prompt: preset.prompt,
      referenceImage: preset.reference_image ?? undefined,
      thumbnail: preset.reference_image ? thumbnailUrlForImage(preset.reference_image) : undefined,
      builtIn: false,
      ownerId: preset.owner_id,
      createdAt: preset.created_at,
      updatedAt: preset.updated_at,
    })),
  ]);
}));

tryOnStylePresetsRouter.post("/", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const body = req.body as { name?: unknown; prompt?: unknown; referenceImage?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const referenceImage = typeof body.referenceImage === "string" && body.referenceImage
    ? body.referenceImage
    : undefined;
  if (!name || name.length > 80 || !prompt || prompt.length > 2_000) {
    res.status(400).json({ error: "预设名称需为 1-80 字，提示词片段需为 1-2000 字" });
    return;
  }
  if (referenceImage && !isLocalImageReference(referenceImage)) {
    res.status(400).json({ error: "风格参考图必须来自本地素材库" });
    return;
  }

  const result = await transaction(async (client) => {
    if (!await lockActiveOwner(client, user.id)) return "owner_unavailable" as const;
    if (referenceImage) {
      const fileId = path.basename(referenceImage);
      const accessible = await queryOne<{ id: string }>(`
        SELECT f.id FROM files f
        WHERE f.id = $1 AND f.deleted_at IS NULL AND (
          f.owner_id IS NULL OR f.owner_id = $2 OR $3 = 'admin' OR EXISTS (
            SELECT 1 FROM assets a
            WHERE a.image = $4 AND a.deleted_at IS NULL AND a.scope IN ('global','shared')
          )
        )
        FOR KEY SHARE
      `, [fileId, user.id, user.role, referenceImage], client);
      if (!accessible) return "missing" as const;
    }
    const duplicate = await queryOne<{ id: string }>(`
      SELECT id FROM try_on_style_presets
      WHERE owner_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL
      FOR UPDATE
    `, [user.id, name], client);
    if (duplicate) return "duplicate" as const;
    const id = nanoid(12);
    const now = new Date().toISOString();
    await client.query(`
      INSERT INTO try_on_style_presets (
        id, owner_id, name, prompt, reference_image, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $6)
    `, [id, user.id, name, prompt, referenceImage ?? null, now]);
    return { id, now };
  });
  if (result === "owner_unavailable") {
    res.status(409).json({ error: "账号已停用或删除，不能保存风格预设" });
    return;
  }
  if (result === "missing") {
    res.status(404).json({ error: "风格参考图不存在或无权访问" });
    return;
  }
  if (result === "duplicate") {
    res.status(409).json({ error: "已有同名风格预设" });
    return;
  }
  res.status(201).json({ ok: true, id: result.id, createdAt: result.now });
}));

tryOnStylePresetsRouter.delete("/:id", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const result = await transaction(async (client) => {
    if (!await lockActiveOwner(client, user.id)) return "owner_unavailable" as const;
    const preset = await queryOne<{ owner_id: string }>(`
      SELECT owner_id FROM try_on_style_presets
      WHERE id = $1 AND deleted_at IS NULL
      FOR UPDATE
    `, [req.params.id], client);
    if (!preset || (preset.owner_id !== user.id && user.role !== "admin")) return "missing" as const;
    const now = new Date().toISOString();
    await client.query(
      "UPDATE try_on_style_presets SET deleted_at = $1, updated_at = $1 WHERE id = $2",
      [now, req.params.id],
    );
    return "deleted" as const;
  });
  if (result === "owner_unavailable") {
    res.status(409).json({ error: "账号已停用或删除，不能删除风格预设" });
    return;
  }
  if (result === "missing") {
    res.status(404).json({ error: "风格预设不存在" });
    return;
  }
  res.json({ ok: true });
}));

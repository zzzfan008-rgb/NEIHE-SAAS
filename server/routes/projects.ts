import { Router } from "express";
import { nanoid } from "nanoid";
import type { PoolClient } from "pg";
import { requestUser } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { query, queryOne, transaction } from "../lib/database";
import { deleteStoredImage } from "../lib/fileStore";
import { validateAndMigrateFlow, WorkflowValidationError } from "../lib/workflowSchema";
import {
  assertImageReferencesAccessible,
  ImageReferenceAccessError,
} from "../lib/imageReferenceAccess";
import { lockActiveOwner } from "../lib/ownerMutation";
import { isLocalImageReference } from "../lib/imageValidation";
import type { PersistedWorkflow } from "../../src/types/workflow";
import { assertDrawingBoardReferences, DrawingBoardAccessError } from "../lib/drawingBoard";

export const projectsRouter = Router();

interface ProjectRow {
  id: string;
  owner_id: string;
  owner_name: string;
  name: string;
  flow_json: string;
  updated_at: string;
}

interface InitialDraftRow extends ProjectRow {
  lifecycle: "initial_draft";
  draft_revision: number;
  created_at: string;
}

interface ProjectMaskFileRef {
  fileId: string;
  nodeId: string;
}

const RETIRED_MASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const INITIAL_DRAFT_TRASH_RETENTION_MS = 15 * 24 * 60 * 60 * 1_000;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_DRAFT_REVISION = 2_147_483_646;

export function initialDraftProjectName(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `未修改项目名称${part("year")}${part("month")}${part("day")}000000`;
}

function initialDraftPayload(row: InitialDraftRow) {
  return {
    id: row.id,
    name: row.name,
    flow: validateAndMigrateFlow(JSON.parse(row.flow_json)),
    revision: row.draft_revision,
    lifecycle: row.lifecycle,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function lockActiveOwnerForDraftBootstrap(
  client: PoolClient,
  ownerId: string,
): Promise<boolean> {
  const owner = (await client.query<{ active: number; deleted_at: string | null }>(`
    SELECT active, deleted_at FROM users WHERE id = $1 FOR NO KEY UPDATE
  `, [ownerId])).rows[0];
  return Boolean(owner && owner.active === 1 && owner.deleted_at === null);
}

async function findInitialDraft(
  client: PoolClient,
  ownerId: string,
  lock = false,
): Promise<InitialDraftRow | undefined> {
  return queryOne<InitialDraftRow>(`
    SELECT p.id, p.owner_id, u.display_name AS owner_name, p.name, p.flow_json,
      p.lifecycle, p.draft_revision, p.created_at, p.updated_at
    FROM projects p JOIN users u ON u.id = p.owner_id
    WHERE p.owner_id = $1 AND p.lifecycle = 'initial_draft' AND p.deleted_at IS NULL
    ${lock ? "FOR UPDATE OF p" : ""}
  `, [ownerId], client);
}

function imageRefs(value: unknown, output = new Set<string>()): Set<string> {
  if (typeof value === "string" && value.startsWith("/api/files/")) output.add(value);
  else if (Array.isArray(value)) value.forEach((item) => imageRefs(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => imageRefs(item, output));
  return output;
}

async function syncAssetRefs(
  client: PoolClient,
  projectId: string,
  ownerId: string,
  flow: PersistedWorkflow,
): Promise<void> {
  const refs = [...imageRefs(flow)];
  const assets = await query<{ id: string; image: string }>(`
    SELECT id, image FROM assets
    WHERE deleted_at IS NULL AND (scope IN ('global','shared') OR owner_id = $1)
      AND image = ANY($2::text[])
    FOR KEY SHARE
  `, [ownerId, refs], client);
  const wanted = assets.map((asset) => asset.id);
  const now = new Date().toISOString();
  await client.query("DELETE FROM project_asset_refs WHERE project_id = $1", [projectId]);
  for (const assetId of wanted) {
    await client.query(
      "INSERT INTO project_asset_refs (project_id, asset_id, created_at) VALUES ($1, $2, $3)",
      [projectId, assetId, now],
    );
  }
}

function projectMaskFileRefs(flow: PersistedWorkflow): ProjectMaskFileRef[] {
  return flow.nodes.flatMap((node) => {
    if (node.data.kind !== "mask-redraw" || typeof node.data.mask !== "string") return [];
    if (!isLocalImageReference(node.data.mask)) return [];
    return [{
      fileId: node.data.mask.slice("/api/files/".length),
      nodeId: node.id,
    }];
  });
}

/** 认领当前蒙版文件，并让同项目已替换的旧蒙版进入延迟回收。 */
async function syncMaskFiles(
  client: PoolClient,
  projectId: string,
  ownerId: string,
  flow: PersistedWorkflow,
  now: Date,
): Promise<void> {
  const refs = projectMaskFileRefs(flow);
  const ids = [...new Set(refs.map((ref) => ref.fileId))];
  const rows = ids.length === 0
    ? []
    : (await client.query<{
        id: string;
        owner_id: string | null;
        source_type: string;
        project_id: string | null;
        node_id: string | null;
        mime_type: string | null;
      }>(`
        SELECT id, owner_id, source_type, project_id, node_id, mime_type
        FROM files
        WHERE id = ANY($1::text[]) AND deleted_at IS NULL
        ORDER BY id
        FOR UPDATE
      `, [ids])).rows;
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const ref of refs) {
    const row = byId.get(ref.fileId);
    if (
      !row || row.owner_id !== ownerId ||
      (row.source_type !== "mask-draft" && row.source_type !== "mask") ||
      row.project_id !== projectId || row.node_id !== ref.nodeId ||
      row.mime_type !== "image/png"
    ) {
      throw new ImageReferenceAccessError("蒙版文件与当前项目或节点不匹配，请重新保存蒙版");
    }
  }

  const retireAt = new Date(now.getTime() + RETIRED_MASK_RETENTION_MS).toISOString();
  await client.query(`
    UPDATE files
    SET purge_after = COALESCE(purge_after, $3)
    WHERE owner_id = $1 AND project_id = $2
      AND source_type IN ('mask-draft', 'mask')
      AND NOT (id = ANY($4::text[]))
  `, [ownerId, projectId, retireAt, ids]);
  if (ids.length > 0) {
    await client.query(`
      UPDATE files
      SET source_type = 'mask', purge_after = NULL
      WHERE owner_id = $1 AND project_id = $2 AND id = ANY($3::text[])
    `, [ownerId, projectId, ids]);
  }
}

export async function purgeExpiredProjects(): Promise<void> {
  const now = new Date().toISOString();
  const expiredFileIds = await transaction(async (client) => {
    await client.query(`
      DELETE FROM project_asset_refs
      WHERE project_id IN (SELECT id FROM projects WHERE purge_after IS NOT NULL AND purge_after <= $1)
    `, [now]);
    await client.query("DELETE FROM usage_events WHERE purge_after IS NOT NULL AND purge_after <= $1", [now]);
    await client.query("DELETE FROM generation_runs WHERE purge_after IS NOT NULL AND purge_after <= $1", [now]);
    await client.query(`
      DELETE FROM assets
      WHERE purge_after IS NOT NULL AND purge_after <= $1
        AND NOT EXISTS (SELECT 1 FROM project_asset_refs r WHERE r.asset_id = assets.id)
    `, [now]);
    // 先锁定有限的过期候选，再检查 durable run。入队按 files → run 写入；这里沿用
    // 相同顺序，保证若入队先持有文件共享锁，等待后执行的 DELETE 能看到新提交的 run。
    const candidates = await client.query<{ id: string }>(`
      SELECT f.id
      FROM files f
      WHERE f.purge_after IS NOT NULL AND f.purge_after <= $1
        AND NOT EXISTS (
          SELECT 1 FROM assets a
          WHERE a.image = '/api/files/' || f.id
        )
      ORDER BY f.id
      FOR UPDATE OF f
    `, [now]);
    const candidateIds = candidates.rows.map((row) => row.id);
    const files = candidateIds.length === 0
      ? { rows: [] as Array<{ id: string }> }
      : await client.query<{ id: string }>(`
          DELETE FROM files f
          WHERE f.id = ANY($2::text[])
            AND f.purge_after IS NOT NULL AND f.purge_after <= $1
            AND NOT EXISTS (
              SELECT 1 FROM assets a
              WHERE a.image = '/api/files/' || f.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM generation_runs r
              WHERE r.deleted_at IS NULL
                AND r.plan_json IS NOT NULL
                AND r.status IN ('queued','running','retry_wait','cancel_requested')
                AND jsonb_path_exists(
                  r.plan_json::jsonb,
                  '$.** ? (@ == $ref)',
                  jsonb_build_object('ref', '/api/files/' || f.id)
                )
            )
          RETURNING f.id
        `, [now, candidateIds]);
    await client.query("DELETE FROM projects WHERE purge_after IS NOT NULL AND purge_after <= $1", [now]);
    return files.rows.map((row) => row.id);
  });
  expiredFileIds.forEach(deleteStoredImage);
}

projectsRouter.post("/", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { id, name, flow, expectedDraftRevision } = req.body as {
    id?: string;
    name?: string;
    flow?: unknown;
    expectedDraftRevision?: unknown;
  };
  if (typeof name !== "string" || !name.trim() || name.length > 200 || flow === undefined) {
    res.status(400).json({ error: "name and flow are required" });
    return;
  }
  if (id !== undefined && (typeof id !== "string" || !PROJECT_ID_PATTERN.test(id))) {
    res.status(400).json({ error: "id must contain only letters, digits, underscore or hyphen" });
    return;
  }
  if (
    expectedDraftRevision !== undefined &&
    (
      typeof expectedDraftRevision !== "number" ||
      !Number.isSafeInteger(expectedDraftRevision) ||
      expectedDraftRevision < 0 ||
      expectedDraftRevision > MAX_DRAFT_REVISION
    )
  ) {
    res.status(400).json({ error: "expectedDraftRevision must be a non-negative integer" });
    return;
  }
  try {
    const normalized = validateAndMigrateFlow(flow);
    const projectId = id || nanoid(10);
    const now = new Date().toISOString();
    const outcome = await transaction(async (client) => {
      if (!await lockActiveOwner(client, user.id)) return { status: "owner_unavailable" as const };
      const existing = await queryOne<{
        owner_id: string;
        deleted_at: string | null;
        lifecycle: "initial_draft" | "saved";
        draft_revision: number;
      }>(
        "SELECT owner_id, deleted_at, lifecycle, draft_revision FROM projects WHERE id = $1 FOR UPDATE",
        [projectId],
        client,
      );
      if (existing?.owner_id !== undefined && existing.owner_id !== user.id) {
        return { status: "forbidden" as const };
      }
      if (existing?.deleted_at) return { status: "deleted" as const };
      if (
        expectedDraftRevision !== undefined &&
        existing?.lifecycle !== "initial_draft"
      ) {
        return { status: "draft_unavailable" as const };
      }
      if (
        existing?.lifecycle === "initial_draft" &&
        expectedDraftRevision !== existing.draft_revision
      ) {
        return {
          status: "draft_revision_conflict" as const,
          currentRevision: existing.draft_revision,
        };
      }
      await assertImageReferencesAccessible(normalized, user.id, client, { fileLock: "update" });
      await assertDrawingBoardReferences(client, user.id, projectId, normalized);
      await syncMaskFiles(client, projectId, user.id, normalized, new Date(now));
      const result = await client.query(`
        INSERT INTO projects (
          id, owner_id, name, flow_json, lifecycle, draft_revision, updated_at, created_at
        ) VALUES ($1, $2, $3, $4, 'saved', 0, $5, $5)
        ON CONFLICT(id) DO UPDATE
          SET name = excluded.name,
              flow_json = excluded.flow_json,
              lifecycle = 'saved',
              updated_at = excluded.updated_at
          WHERE projects.owner_id = excluded.owner_id
        RETURNING id
      `, [projectId, user.id, name.trim(), JSON.stringify(normalized), now]);
      if (result.rowCount !== 1) return { status: "forbidden" as const };
      await syncAssetRefs(client, projectId, user.id, normalized);
      return { status: "saved" as const };
    });
    if (outcome.status === "forbidden") {
      res.status(403).json({ error: "管理员只能查看其他用户项目，不能修改" });
      return;
    }
    if (outcome.status === "deleted") {
      res.status(409).json({ error: "项目已在回收站中，请先恢复项目再保存" });
      return;
    }
    if (outcome.status === "owner_unavailable") {
      res.status(409).json({ error: "账号已停用或删除，不能继续保存项目" });
      return;
    }
    if (outcome.status === "draft_revision_conflict") {
      res.status(409).json({
        error: "初始草稿已在其他页面或设备更新，请先合并最新内容",
        currentRevision: outcome.currentRevision,
      });
      return;
    }
    if (outcome.status === "draft_unavailable") {
      res.status(409).json({
        error: "初始草稿已在其他页面保存或不再可用，请刷新后继续",
      });
      return;
    }
    res.json({ ok: true, id: projectId });
  } catch (error) {
    res.status(error instanceof WorkflowValidationError ? 400 : error instanceof ImageReferenceAccessError ? 403 : error instanceof DrawingBoardAccessError ? 409 : 500)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
}));

projectsRouter.get("/", asyncHandler(async (req, res) => {
  await purgeExpiredProjects();
  const user = requestUser(req);
  const rows = await query<Omit<ProjectRow, "flow_json">>(`
    SELECT p.id, p.owner_id, u.display_name AS owner_name, p.name, p.updated_at
    FROM projects p JOIN users u ON u.id = p.owner_id
    WHERE p.deleted_at IS NULL AND p.lifecycle = 'saved'
      AND ($1 = 'admin' OR p.owner_id = $2)
    ORDER BY p.updated_at DESC
  `, [user.role, user.id]);
  res.json(rows.map((row) => ({
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    readOnly: row.owner_id !== user.id,
    updatedAt: row.updated_at,
  })));
}));

projectsRouter.get("/initial-draft", asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const user = requestUser(req);
  const row = await transaction((client) => findInitialDraft(client, user.id));
  if (!row) {
    res.json({ draft: null });
    return;
  }
  try {
    res.json({ draft: initialDraftPayload(row) });
  } catch (error) {
    res.status(422).json({
      error: error instanceof WorkflowValidationError
        ? `初始草稿数据无法迁移：${error.message}`
        : "初始草稿数据损坏",
    });
  }
}));

projectsRouter.post("/initial-draft/bootstrap", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { id, name, flow } = req.body as { id?: unknown; name?: unknown; flow?: unknown };
  if (id !== undefined && (typeof id !== "string" || !PROJECT_ID_PATTERN.test(id))) {
    res.status(400).json({ error: "id must contain only letters, digits, underscore or hyphen" });
    return;
  }
  if (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 200)) {
    res.status(400).json({ error: "name must be a non-empty string up to 200 characters" });
    return;
  }
  try {
    const outcome = await transaction(async (client) => {
      if (!await lockActiveOwnerForDraftBootstrap(client, user.id)) {
        return { status: "owner_unavailable" as const };
      }
      const existing = await findInitialDraft(client, user.id, true);
      if (existing) return { status: "found" as const, row: existing };
      if (flow === undefined) return { status: "flow_required" as const };

      const normalized = validateAndMigrateFlow(flow);
      const projectId = typeof id === "string" ? id : nanoid(10);
      const collision = await queryOne<{ id: string }>(
        "SELECT id FROM projects WHERE id = $1 FOR UPDATE",
        [projectId],
        client,
      );
      if (collision) return { status: "id_conflict" as const };

      const now = new Date();
      const nowIso = now.toISOString();
      const projectName = typeof name === "string" ? name.trim() : initialDraftProjectName(now);
      await assertImageReferencesAccessible(normalized, user.id, client, { fileLock: "update" });
      await assertDrawingBoardReferences(client, user.id, projectId, normalized);
      await syncMaskFiles(client, projectId, user.id, normalized, now);
      const inserted = (await client.query<InitialDraftRow>(`
        INSERT INTO projects (
          id, owner_id, name, flow_json, lifecycle, draft_revision, updated_at, created_at
        ) VALUES ($1, $2, $3, $4, 'initial_draft', 0, $5, $5)
        RETURNING id, owner_id, ''::text AS owner_name, name, flow_json,
          lifecycle, draft_revision, created_at, updated_at
      `, [projectId, user.id, projectName, JSON.stringify(normalized), nowIso])).rows[0];
      await syncAssetRefs(client, projectId, user.id, normalized);
      return { status: "created" as const, row: inserted };
    });

    if (outcome.status === "owner_unavailable") {
      res.status(409).json({ error: "账号已停用或删除，不能创建初始草稿" });
      return;
    }
    if (outcome.status === "flow_required") {
      res.status(400).json({ error: "首次创建初始草稿时必须提供 flow" });
      return;
    }
    if (outcome.status === "id_conflict") {
      res.status(409).json({ error: "本地草稿项目 ID 已被占用，请刷新后重试" });
      return;
    }
    res.status(outcome.status === "created" ? 201 : 200).json({
      created: outcome.status === "created",
      draft: initialDraftPayload(outcome.row),
    });
  } catch (error) {
    res.status(error instanceof WorkflowValidationError ? 400 : error instanceof ImageReferenceAccessError ? 403 : error instanceof DrawingBoardAccessError ? 409 : 500)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
}));

projectsRouter.put("/initial-draft/:id", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { expectedRevision, name, flow } = req.body as {
    expectedRevision?: unknown;
    name?: unknown;
    flow?: unknown;
  };
  if (!PROJECT_ID_PATTERN.test(req.params.id)) {
    res.status(400).json({ error: "invalid project id" });
    return;
  }
  if (
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    expectedRevision > MAX_DRAFT_REVISION
  ) {
    res.status(400).json({ error: "expectedRevision must be a non-negative integer" });
    return;
  }
  if (typeof name !== "string" || !name.trim() || name.length > 200 || flow === undefined) {
    res.status(400).json({ error: "name and flow are required" });
    return;
  }
  try {
    const normalized = validateAndMigrateFlow(flow);
    const outcome = await transaction(async (client) => {
      if (!await lockActiveOwner(client, user.id)) return { status: "owner_unavailable" as const };
      const existing = await queryOne<{
        deleted_at: string | null;
        lifecycle: "initial_draft" | "saved";
        draft_revision: number;
      }>(`
        SELECT deleted_at, lifecycle, draft_revision
        FROM projects WHERE id = $1 AND owner_id = $2 FOR UPDATE
      `, [req.params.id, user.id], client);
      if (!existing) return { status: "not_found" as const };
      if (existing.deleted_at) return { status: "deleted" as const };
      if (existing.lifecycle !== "initial_draft") return { status: "already_saved" as const };
      if (existing.draft_revision !== expectedRevision) {
        return {
          status: "revision_conflict" as const,
          currentRevision: existing.draft_revision,
        };
      }

      const now = new Date();
      const nowIso = now.toISOString();
      await assertImageReferencesAccessible(normalized, user.id, client, { fileLock: "update" });
      await assertDrawingBoardReferences(client, user.id, req.params.id, normalized);
      await syncMaskFiles(client, req.params.id, user.id, normalized, now);
      const updated = (await client.query<InitialDraftRow>(`
        UPDATE projects
        SET name = $1, flow_json = $2, draft_revision = draft_revision + 1, updated_at = $3
        WHERE id = $4 AND owner_id = $5 AND lifecycle = 'initial_draft' AND deleted_at IS NULL
        RETURNING id, owner_id, ''::text AS owner_name, name, flow_json,
          lifecycle, draft_revision, created_at, updated_at
      `, [name.trim(), JSON.stringify(normalized), nowIso, req.params.id, user.id])).rows[0];
      await syncAssetRefs(client, req.params.id, user.id, normalized);
      return { status: "updated" as const, row: updated };
    });

    if (outcome.status === "owner_unavailable") {
      res.status(409).json({ error: "账号已停用或删除，不能同步初始草稿" });
      return;
    }
    if (outcome.status === "not_found") {
      res.status(404).json({ error: "initial draft not found" });
      return;
    }
    if (outcome.status === "deleted") {
      res.status(409).json({ error: "初始草稿已在回收站中" });
      return;
    }
    if (outcome.status === "already_saved") {
      res.status(409).json({ error: "项目已经正式保存，不能再作为初始草稿同步" });
      return;
    }
    if (outcome.status === "revision_conflict") {
      res.status(409).json({
        error: "初始草稿已在其他页面或设备更新，请先合并最新内容",
        currentRevision: outcome.currentRevision,
      });
      return;
    }
    res.json({ draft: initialDraftPayload(outcome.row) });
  } catch (error) {
    res.status(error instanceof WorkflowValidationError ? 400 : error instanceof ImageReferenceAccessError ? 403 : error instanceof DrawingBoardAccessError ? 409 : 500)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
}));

projectsRouter.delete("/initial-draft/:id", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { confirm, expectedRevision } = req.body as {
    confirm?: unknown;
    expectedRevision?: unknown;
  };
  if (!PROJECT_ID_PATTERN.test(req.params.id)) {
    res.status(400).json({ error: "invalid project id" });
    return;
  }
  if (confirm !== true) {
    res.status(400).json({ error: "confirm must be true to abandon an initial draft" });
    return;
  }
  if (
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    expectedRevision > MAX_DRAFT_REVISION
  ) {
    res.status(400).json({ error: "expectedRevision must be a non-negative integer" });
    return;
  }

  const outcome = await transaction(async (client) => {
    if (!await lockActiveOwner(client, user.id)) return { status: "owner_unavailable" as const };
    const existing = await queryOne<{
      lifecycle: "initial_draft" | "saved";
      draft_revision: number;
    }>(`
      SELECT lifecycle, draft_revision
      FROM projects
      WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL
      FOR UPDATE
    `, [req.params.id, user.id], client);
    if (!existing) return { status: "not_found" as const };
    if (existing.lifecycle !== "initial_draft") return { status: "already_saved" as const };
    if (existing.draft_revision !== expectedRevision) {
      return {
        status: "revision_conflict" as const,
        currentRevision: existing.draft_revision,
      };
    }

    const deletedAt = new Date();
    const purgeAfter = new Date(deletedAt.getTime() + INITIAL_DRAFT_TRASH_RETENTION_MS);
    const deletedAtIso = deletedAt.toISOString();
    const purgeAfterIso = purgeAfter.toISOString();
    await client.query(`
      UPDATE projects
      SET deleted_at = $1, purge_after = $2, updated_at = $1
      WHERE id = $3 AND owner_id = $4 AND lifecycle = 'initial_draft' AND deleted_at IS NULL
    `, [deletedAtIso, purgeAfterIso, req.params.id, user.id]);
    await client.query(`
      UPDATE files
      SET deleted_at = $1, purge_after = $2
      WHERE owner_id = $3 AND project_id = $4
        AND source_type = 'mask' AND deleted_at IS NULL AND purge_after IS NULL
    `, [deletedAtIso, purgeAfterIso, user.id, req.params.id]);
    return { status: "abandoned" as const, purgeAfter: purgeAfterIso };
  });

  if (outcome.status === "owner_unavailable") {
    res.status(409).json({ error: "账号已停用或删除，不能放弃初始草稿" });
    return;
  }
  if (outcome.status === "not_found") {
    res.status(404).json({ error: "initial draft not found" });
    return;
  }
  if (outcome.status === "already_saved") {
    res.status(409).json({ error: "项目已经正式保存，不能作为初始草稿放弃" });
    return;
  }
  if (outcome.status === "revision_conflict") {
    res.status(409).json({
      error: "初始草稿已在其他页面或设备更新，请先合并最新内容",
      currentRevision: outcome.currentRevision,
    });
    return;
  }
  res.json({ ok: true, purgeAfter: outcome.purgeAfter });
}));

projectsRouter.post("/initial-draft/:id/restore", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  if (!PROJECT_ID_PATTERN.test(req.params.id)) {
    res.status(400).json({ error: "invalid project id" });
    return;
  }
  const outcome = await transaction(async (client) => {
    if (!await lockActiveOwner(client, user.id)) return { status: "owner_unavailable" as const };
    const existing = await queryOne<{
      lifecycle: "initial_draft" | "saved";
      deleted_at: string;
      purge_after: string | null;
    }>(`
      SELECT lifecycle, deleted_at, purge_after
      FROM projects
      WHERE id = $1 AND owner_id = $2 AND deleted_at IS NOT NULL
      FOR UPDATE
    `, [req.params.id, user.id], client);
    if (!existing || existing.lifecycle !== "initial_draft") return { status: "not_found" as const };
    if (!existing.purge_after || existing.purge_after <= new Date().toISOString()) {
      return { status: "expired" as const };
    }
    const activeDraft = await findInitialDraft(client, user.id, true);
    if (activeDraft) {
      return { status: "active_conflict" as const, currentDraftId: activeDraft.id };
    }
    const restored = (await client.query<InitialDraftRow>(`
      UPDATE projects
      SET deleted_at = NULL, purge_after = NULL, updated_at = $1
      WHERE id = $2 AND owner_id = $3 AND lifecycle = 'initial_draft'
      RETURNING id, owner_id, ''::text AS owner_name, name, flow_json,
        lifecycle, draft_revision, created_at, updated_at
    `, [new Date().toISOString(), req.params.id, user.id])).rows[0];
    await client.query(`
      UPDATE files
      SET deleted_at = NULL, purge_after = NULL
      WHERE owner_id = $1 AND project_id = $2
        AND source_type = 'mask'
        AND deleted_at = $3 AND purge_after = $4
    `, [user.id, req.params.id, existing.deleted_at, existing.purge_after]);
    return { status: "restored" as const, row: restored };
  });

  if (outcome.status === "owner_unavailable") {
    res.status(409).json({ error: "账号已停用或删除，不能恢复初始草稿" });
    return;
  }
  if (outcome.status === "not_found") {
    res.status(404).json({ error: "recoverable initial draft not found" });
    return;
  }
  if (outcome.status === "expired") {
    res.status(410).json({ error: "初始草稿已超过 15 天恢复期" });
    return;
  }
  if (outcome.status === "active_conflict") {
    res.status(409).json({
      error: "当前账号已有另一个有效初始草稿",
      currentDraftId: outcome.currentDraftId,
    });
    return;
  }
  res.json({ draft: initialDraftPayload(outcome.row) });
}));

projectsRouter.get("/:id", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const row = await queryOne<ProjectRow>(`
    SELECT p.id, p.owner_id, u.display_name AS owner_name, p.name, p.flow_json, p.updated_at
    FROM projects p JOIN users u ON u.id = p.owner_id
    WHERE p.id = $1 AND p.deleted_at IS NULL AND p.lifecycle = 'saved'
  `, [req.params.id]);
  if (!row) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  if (row.owner_id !== user.id && user.role !== "admin") {
    res.status(403).json({ error: "无权查看此项目" });
    return;
  }
  try {
    const flow = validateAndMigrateFlow(JSON.parse(row.flow_json));
    res.json({
      id: row.id, name: row.name, flow, updatedAt: row.updated_at,
      ownerId: row.owner_id, ownerName: row.owner_name, readOnly: row.owner_id !== user.id,
    });
  } catch (error) {
    res.status(422).json({
      error: error instanceof WorkflowValidationError ? `项目数据无法迁移：${error.message}` : "项目数据损坏",
    });
  }
}));

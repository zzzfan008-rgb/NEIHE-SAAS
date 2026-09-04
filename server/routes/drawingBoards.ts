import { Router } from "express";
import { nanoid } from "nanoid";
import { asyncHandler } from "../lib/asyncHandler";
import { requestUser } from "../lib/auth";
import { queryOne, transaction } from "../lib/database";
import {
  DrawingBoardAccessError,
  canonicalDrawingDocumentJson,
  drawingBoardRequestSha256,
  drawingDocumentSha256,
  drawingNodeFromFlow,
} from "../lib/drawingBoard";
import { lockActiveOwner } from "../lib/ownerMutation";
import { validateAndMigrateFlow, WorkflowValidationError } from "../lib/workflowSchema";
import { DrawingBoardValidationError } from "../../src/components/drawing/drawingModel";

export const drawingBoardsRouter = Router();

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{8,200}$/;

drawingBoardsRouter.post("/versions", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { clientRequestId, projectId, nodeId, baseContentRef, document } = req.body as Record<string, unknown>;
  if (
    typeof clientRequestId !== "string" || !REQUEST_ID_PATTERN.test(clientRequestId) ||
    typeof projectId !== "string" || !ID_PATTERN.test(projectId) ||
    typeof nodeId !== "string" || !ID_PATTERN.test(nodeId) ||
    (baseContentRef !== undefined && baseContentRef !== null && (
      typeof baseContentRef !== "string" || !ID_PATTERN.test(baseContentRef)
    ))
  ) {
    res.status(400).json({ error: "clientRequestId、projectId、nodeId 或 baseContentRef 无效" });
    return;
  }

  try {
    const contentJson = canonicalDrawingDocumentJson(document);
    const contentSha256 = drawingDocumentSha256(document);
    const normalizedBase = typeof baseContentRef === "string" ? baseContentRef : null;
    const requestSha256 = drawingBoardRequestSha256({
      projectId, nodeId, baseContentRef: normalizedBase, documentSha256: contentSha256,
    });
    const outcome = await transaction(async (client) => {
      if (!await lockActiveOwner(client, user.id)) return { status: "owner-unavailable" as const };
      const project = (await client.query<{ owner_id: string; flow_json: string }>(`
        SELECT owner_id, flow_json FROM projects
        WHERE id = $1 AND deleted_at IS NULL
        FOR UPDATE
      `, [projectId])).rows[0];
      if (!project || project.owner_id !== user.id) return { status: "not-found" as const };
      const flow = validateAndMigrateFlow(JSON.parse(project.flow_json));
      const node = drawingNodeFromFlow(flow, nodeId);
      if (node.data.kind !== "drawing-board") return { status: "not-found" as const };
      if (node.data.width !== (document as { canvas?: { width?: unknown } })?.canvas?.width ||
          node.data.height !== (document as { canvas?: { height?: unknown } })?.canvas?.height) {
        return { status: "mismatch" as const };
      }
      if ((node.data.contentRef ?? null) !== normalizedBase) return { status: "base-mismatch" as const };
      if (normalizedBase) {
        const base = (await client.query(`
          SELECT id FROM drawing_document_versions
          WHERE id = $1 AND owner_id = $2 AND project_id = $3 AND node_id = $4
          FOR KEY SHARE
        `, [normalizedBase, user.id, projectId, nodeId])).rows[0];
        if (!base) return { status: "not-found" as const };
      }
      const replay = (await client.query<{
        request_sha256: string; content_ref: string; sha256: string; created_at: string;
      }>(`
        SELECT i.request_sha256, i.content_ref, v.sha256, v.created_at
        FROM drawing_board_idempotency i
        JOIN drawing_document_versions v ON v.id = i.content_ref
        WHERE i.owner_id = $1 AND i.client_request_id = $2
        FOR UPDATE OF i
      `, [user.id, clientRequestId])).rows[0];
      if (replay) {
        return replay.request_sha256 === requestSha256
          ? { status: "replay" as const, contentRef: replay.content_ref, sha256: replay.sha256, createdAt: replay.created_at }
          : { status: "idempotency-conflict" as const };
      }
      const contentRef = `draw_${nanoid(20)}`;
      const createdAt = new Date().toISOString();
      await client.query(`
        INSERT INTO drawing_document_versions (
          id, owner_id, project_id, node_id, version, content_json, sha256, base_content_ref, created_at
        ) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8)
      `, [contentRef, user.id, projectId, nodeId, contentJson, contentSha256, normalizedBase, createdAt]);
      await client.query(`
        INSERT INTO drawing_board_idempotency (
          owner_id, client_request_id, request_sha256, content_ref, created_at
        ) VALUES ($1, $2, $3, $4, $5)
      `, [user.id, clientRequestId, requestSha256, contentRef, createdAt]);
      return { status: "created" as const, contentRef, sha256: contentSha256, createdAt };
    });

    if (outcome.status === "created" || outcome.status === "replay") {
      res.status(outcome.status === "created" ? 201 : 200).json({
        contentRef: outcome.contentRef, sha256: outcome.sha256, createdAt: outcome.createdAt,
      });
      return;
    }
    if (outcome.status === "owner-unavailable") {
      res.status(409).json({ error: "账号已停用或删除，不能保存画板" });
      return;
    }
    if (outcome.status === "not-found") {
      res.status(404).json({ error: "画板资源不存在" });
      return;
    }
    if (outcome.status === "base-mismatch") {
      res.status(409).json({ error: "画板基准已变化，请重新加载后保存" });
      return;
    }
    if (outcome.status === "idempotency-conflict") {
      res.status(409).json({ error: "同一请求号不能保存不同画板内容" });
      return;
    }
    res.status(409).json({ error: "画板尺寸与节点不匹配" });
  } catch (error) {
    const status = error instanceof DrawingBoardValidationError || error instanceof WorkflowValidationError
      ? 400 : error instanceof DrawingBoardAccessError && error.code === "not-found" ? 404 : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : "画板保存失败" });
  }
}));

drawingBoardsRouter.get("/versions/:id", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  if (!ID_PATTERN.test(req.params.id)) {
    res.status(404).json({ error: "画板资源不存在" });
    return;
  }
  const row = await queryOne<{
    id: string; owner_id: string; content_json: string; sha256: string; created_at: string;
  }>(`
    SELECT id, owner_id, content_json, sha256, created_at
    FROM drawing_document_versions
    WHERE id = $1
  `, [req.params.id]);
  if (!row || row.owner_id !== user.id) {
    res.status(404).json({ error: "画板资源不存在" });
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    contentRef: row.id,
    sha256: row.sha256,
    document: JSON.parse(row.content_json),
    createdAt: row.created_at,
  });
}));

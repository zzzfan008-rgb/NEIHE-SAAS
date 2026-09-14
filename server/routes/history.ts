import { Router } from "express";
import { requestUser } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { query, queryOne, transaction } from "../lib/database";
import { thumbnailUrlForImage } from "../lib/fileStore";
import { ACTIVE_RUN_LIMIT } from "../lib/generationLimits";
import { lockActiveOwner } from "../lib/ownerMutation";

export const historyRouter = Router();

interface HistoryCursor {
  before: number;
  startedAt: number;
  runId: string;
}

function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: unknown): HistoryCursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000) {
    throw new Error("invalid history cursor");
  }
  const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<HistoryCursor>;
  if (!Number.isSafeInteger(decoded.before) || Number(decoded.before) < 0 ||
      !Number.isSafeInteger(decoded.startedAt) || Number(decoded.startedAt) < 0 ||
      typeof decoded.runId !== "string" || !decoded.runId) {
    throw new Error("invalid history cursor");
  }
  return { before: Number(decoded.before), startedAt: Number(decoded.startedAt), runId: decoded.runId };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Keep successful checkpoints and synthesize stable cards for the unfinished batch. */
export function expandStylingHistoryRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  for (const row of rows) {
    if (row.kind !== "ai-styling") { output.push(row); continue; }
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const batch = rows.filter(candidate => candidate.id === row.id);
    const successes = batch.filter(candidate => candidate.output_status === "success" && candidate.image);
    output.push(...successes);
    const active = ["queued", "running", "retry_wait", "cancel_requested"].includes(String(row.status));
    const requested = Math.max(1, Math.min(4, Number(row.requested_count) || 1));
    const remaining = Math.max(active ? 1 : 0, requested - successes.length);
    for (let index = 0; index < remaining; index++) {
      output.push({ ...row, output_id: index === 0 ? row.id : `${row.id}:pending:${index}`,
        image: "", output_prompt: null, provider_output_size: null,
        output_status: null, output_error: null,
        ...(row.status === "succeeded" ? { status: "failed", error: row.error ?? "搭配方案未完成" } : {}),
      });
    }
  }
  return output;
}

historyRouter.get("/", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const requestedUserId = typeof req.query.userId === "string" ? req.query.userId : undefined;
  if (requestedUserId && user.role !== "admin" && requestedUserId !== user.id) {
    res.status(403).json({ error: "无权查看其他用户记录" });
    return;
  }
  const ownerId = requestedUserId ?? (user.role === "admin" && req.query.all === "true" ? null : user.id);
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 100));
  let cursor: HistoryCursor | undefined;
  try {
    cursor = decodeCursor(req.query.cursor);
  } catch {
    res.status(400).json({ error: "历史分页游标无效" });
    return;
  }
  const requestedBefore = Number(req.query.before);
  const before = cursor?.before ?? (Number.isFinite(requestedBefore) && requestedBefore >= 0 ? requestedBefore : Date.now());
  const runCandidates = await query<{ id: string; started_at: number }>(`
    SELECT r.id, r.started_at
    FROM generation_runs r
    WHERE ($1::text IS NULL OR r.owner_id = $1)
      AND r.deleted_at IS NULL
      AND r.started_at <= $2
      AND (
        $3::bigint IS NULL OR r.started_at < $3
        OR (r.started_at = $3 AND r.id < $4)
      )
      AND (
        (r.plan_json IS NOT NULL AND r.status IN ('queued','running','retry_wait','cancel_requested'))
        OR r.status IN ('cancelled','outcome_unknown','failed','succeeded')
        OR EXISTS (SELECT 1 FROM generation_outputs output WHERE output.run_id = r.id)
      )
    ORDER BY r.started_at DESC, r.id DESC
    LIMIT $5
  `, [ownerId, before, cursor?.startedAt ?? null, cursor?.runId ?? null, limit + 1]);
  const hasMore = runCandidates.length > limit;
  const pageRuns = runCandidates.slice(0, limit);
  if (pageRuns.length === 0) {
    res.json({ records: [], nextCursor: null, hasMore: false });
    return;
  }
  const rows = await query<Record<string, unknown>>(`
    SELECT r.*, o.id AS output_id, o.image, o.prompt AS output_prompt,
      o.provider_output_size, o.status AS output_status, o.error AS output_error,
      u.display_name AS owner_name, s.execution_meta_json
    FROM generation_runs r
    JOIN users u ON u.id = r.owner_id
    LEFT JOIN generation_outputs o ON o.run_id = r.id
    LEFT JOIN generation_run_steps s ON s.run_id = r.id AND s.node_id = r.node_id
    WHERE r.id = ANY($1::text[])
    ORDER BY r.started_at DESC, r.id DESC, o.created_at ASC, o.id ASC
  `, [pageRuns.map((run) => run.id)]);
  const records = expandStylingHistoryRows(rows).map((row) => {
    const runStatus = row.status === "succeeded" ? "success" : row.status === "failed" ? "error" : row.status;
    return ({
    id: (row.output_id as string | null) ?? (row.id as string),
    runId: row.id,
    clientRequestId: row.client_request_id,
    image: (row.image as string | null) ?? "",
    thumbnail: row.image ? thumbnailUrlForImage(row.image as string) : "",
    nodeId: row.node_id,
    nodeLabel: row.node_label,
    kind: row.kind,
    projectId: row.project_id,
    projectName: row.project_name,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    prompt: (row.output_prompt as string | null) ?? row.prompt,
    parameters: parseJson<Record<string, unknown>>(row.parameters_json, {}),
    referenceImages: parseJson<string[]>(row.reference_images_json, []),
    executionMeta: parseJson<Record<string, unknown>>(row.execution_meta_json, {}),
    model: row.model,
    requestedCount: row.requested_count,
    successfulCount: row.successful_count,
    providerRequests: row.provider_requests,
    providerOutputSize: row.provider_output_size,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: (row.output_status as string | null) ?? runStatus,
    error: (row.output_error as string | null) ?? row.error,
    });
  });
  const lastRun = pageRuns.at(-1);
  res.json({
    records,
    nextCursor: hasMore && lastRun
      ? encodeCursor({ before, startedAt: lastRun.started_at, runId: lastRun.id })
      : null,
    hasMore,
  });
}));

/** 首屏恢复必须使用完整活动集；有限分页的“缺席”不能证明某个 Run 已结束。 */
historyRouter.get("/active", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const rows = await query<Record<string, unknown>>(`
    SELECT
      r.id, r.client_request_id, r.node_id, r.node_label, r.kind,
      r.project_id, r.project_name, r.owner_id, r.prompt, r.model,
      r.requested_count, r.successful_count, r.provider_requests,
      r.started_at, r.status, r.error,
      u.display_name AS owner_name
    FROM generation_runs r
    JOIN users u ON u.id = r.owner_id
    WHERE r.owner_id = $1
      AND r.deleted_at IS NULL
      AND r.plan_json IS NOT NULL
      AND r.status IN ('queued','running','retry_wait','cancel_requested')
    ORDER BY r.started_at DESC, r.id DESC
    LIMIT $2
  `, [user.id, ACTIVE_RUN_LIMIT + 1]);
  if (rows.length > ACTIVE_RUN_LIMIT) {
    res.status(409).json({ error: "活动任务过多，暂时禁止创建新任务，请联系管理员处理" });
    return;
  }
  res.json({
    records: rows.map((row) => ({
      id: row.id,
      runId: row.id,
      clientRequestId: row.client_request_id,
      image: "",
      thumbnail: "",
      nodeId: row.node_id,
      nodeLabel: row.node_label,
      kind: row.kind,
      projectId: row.project_id,
      projectName: row.project_name,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      prompt: row.prompt,
      model: row.model,
      requestedCount: row.requested_count,
      successfulCount: row.successful_count,
      providerRequests: row.provider_requests,
      startedAt: row.started_at,
      status: row.status,
      error: row.error,
    })),
    nextCursor: null,
    hasMore: false,
  });
}));

historyRouter.delete("/:id", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const result = await transaction(async (client) => {
    if (!await lockActiveOwner(client, user.id)) return "owner_unavailable" as const;
    const row = await queryOne<{ run_id: string }>(`
      SELECT r.id AS run_id FROM generation_outputs o
      JOIN generation_runs r ON r.id = o.run_id
      WHERE o.id = $1 AND r.owner_id = $2 AND r.deleted_at IS NULL
      FOR UPDATE OF r, o
    `, [req.params.id, user.id], client);
    if (!row) return "missing" as const;
    await client.query("DELETE FROM generation_outputs WHERE id = $1", [req.params.id]);
    return "deleted" as const;
  });
  if (result === "owner_unavailable") {
    res.status(409).json({ error: "账号已停用或删除，不能继续删除历史记录" });
    return;
  }
  if (result === "missing") {
    res.status(404).json({ error: "记录不存在" });
    return;
  }
  res.json({ ok: true });
}));

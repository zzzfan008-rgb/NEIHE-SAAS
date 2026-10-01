/**
 * 工作流执行：
 *   POST /api/run-plan            { clientRequestId, projectId, nodes, edges, onlyNodeId?, includeDownstream? }
 *                                   → 202 { runId, status }
 *                                   （事务入队后立即返回，由 PostgreSQL Worker 执行）
 *   GET  /api/run-plan/:id/events SSE 事件流（含重放，事件见 engine/runner.ts RunEvent）
 */
import { Router, type Request, type Response } from "express";
import type { PoolClient } from "pg";
import { assertStylingAnalyses } from './outfitAnalysis';
import { isDeepStrictEqual } from "node:util";
import {
  WORKFLOW_SCHEMA_VERSION,
  type NodeExecution,
  type PersistedWorkflow,
} from "../../src/types/workflow";
import { assertPlanInputs, buildExecutionPlan, DagError } from "../engine/dag";
import { getRunForUser, normalizedRequestedCountForStep, type RunEvent } from "../engine/runner";
import {
  ActiveRunLimitError,
  assertGenerationOwnerActive,
  CLIENT_REQUEST_ID_PATTERN,
  DURABLE_RUN_EVENT_BATCH_SIZE,
  enqueueGenerationRunInTransaction,
  GenerationOwnerUnavailableError,
  GenerationRequestConflictError,
  getDurableRunForUser,
  readDurableRunEvents,
} from "../engine/runQueue";
import { validateAndMigrateFlow, WorkflowValidationError } from "../lib/workflowSchema";
import { assertWorkflowPantoneReferences } from "../lib/workflowPantoneValidation";
import { requestUser } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { queryOne, transaction } from "../lib/database";
import {
  assertImageReferencesAccessible,
  ImageReferenceAccessError,
} from "../lib/imageReferenceAccess";
import { createExecutionInputFingerprint } from "../lib/executionInputFingerprint";

export const runPlanRouter = Router();

export function requestedCountForStep(kind: string, params: Record<string, unknown>): number {
  return normalizedRequestedCountForStep(kind, params);
}

async function assertApprovedBaselineExecution(
  client: PoolClient,
  flow: PersistedWorkflow,
  targetStep: NodeExecution,
  ownerId: string,
  projectId: string,
): Promise<void> {
  if (
    targetStep.kind !== "virtual-try-on" ||
    targetStep.params.workflowStage !== "garment-refine"
  ) return;

  const baselineEdge = flow.edges.find(
    (edge) => edge.target === targetStep.nodeId && edge.targetHandle === "baseline",
  );
  const approvalNode = baselineEdge
    ? flow.nodes.find((node) => node.id === baselineEdge.source)
    : undefined;
  // Manual baseline selection is validated by assertPlanInputs and image ownership
  // checks before this call. Fingerprint/revision approval remains for legacy nodes.
  if (approvalNode?.data.kind !== "stage-approval") return;
  const candidateEdge = approvalNode?.data.kind === "stage-approval"
    ? flow.edges.find(
        (edge) => edge.target === approvalNode.id && edge.targetHandle === "baseline-candidate",
      )
    : undefined;
  const candidateNode = candidateEdge
    ? flow.nodes.find((node) => node.id === candidateEdge.source)
    : undefined;
  const approvedBaselineRef = typeof targetStep.params.approvedBaselineRef === "string"
    ? targetStep.params.approvedBaselineRef
    : undefined;
  const approvedBasisRevision = candidateNode?.data.kind === "virtual-try-on"
    && candidateNode.data.workflowStage === "scene-stabilize"
    ? candidateNode.data.basisRevision ?? 0
    : undefined;

  if (
    !candidateNode ||
    !approvedBaselineRef ||
    approvedBasisRevision === undefined ||
    !Number.isSafeInteger(approvedBasisRevision)
  ) {
    throw new DagError("第二轮基准无法验证对应的第一轮完整输入，请重新生成并确认第一轮基准");
  }

  const firstStagePlan = buildExecutionPlan(flow.nodes, flow.edges, {
    onlyNodeId: candidateNode.id,
    includeDownstream: false,
  });
  const fingerprint = createExecutionInputFingerprint({
    runType: "workflow",
    projectId,
    nodeId: candidateNode.id,
    plan: firstStagePlan,
  });
  const verified = await queryOne<{ id: string }>(`
    SELECT run.id
    FROM generation_runs run
    JOIN generation_outputs output ON output.run_id = run.id
    WHERE run.owner_id = $1
      AND run.project_id = $2
      AND run.node_id = $3
      AND run.request_fingerprint = $4
      AND run.status IN ('succeeded', 'success')
      AND run.deleted_at IS NULL
      AND output.status = 'success'
      AND output.image = $5
    LIMIT 1
  `, [ownerId, projectId, candidateNode.id, fingerprint, approvedBaselineRef], client);
  if (!verified) {
    throw new DagError("第二轮基准无法验证对应的第一轮完整输入，请重新生成并确认第一轮基准");
  }
}

runPlanRouter.post("/", asyncHandler(async (req, res) => {
  const { nodes, edges, onlyNodeId, includeDownstream, projectId, clientRequestId, multiImagePromptMode, candidateReviewMode } = req.body as {
    nodes?: unknown[];
    edges?: unknown[];
    onlyNodeId?: string;
    includeDownstream?: boolean;
    projectId?: string;
    clientRequestId?: string;
    multiImagePromptMode?: unknown;
    candidateReviewMode?: unknown;
  };
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    res.status(400).json({ error: "nodes and edges arrays are required" });
    return;
  }
  if (onlyNodeId !== undefined && (typeof onlyNodeId !== "string" || !onlyNodeId.trim())) {
    res.status(400).json({ error: "onlyNodeId must be a non-empty string" });
    return;
  }
  if (includeDownstream !== undefined && typeof includeDownstream !== "boolean") {
    res.status(400).json({ error: "includeDownstream must be a boolean" });
    return;
  }
  if (multiImagePromptMode !== undefined &&
      (multiImagePromptMode !== "concise" || !onlyNodeId || includeDownstream === true)) {
    res.status(400).json({ error: "简化提示词仅支持单个多图编辑节点" });
    return;
  }
  if (candidateReviewMode !== undefined &&
      (candidateReviewMode !== "disabled" || !onlyNodeId || includeDownstream === true)) {
    res.status(400).json({ error: "关闭候选评审仅支持单个多图编辑节点" });
    return;
  }
  if (typeof projectId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) {
    res.status(400).json({ error: "projectId is required" });
    return;
  }
  if (typeof clientRequestId !== "string" || !CLIENT_REQUEST_ID_PATTERN.test(clientRequestId)) {
    res.status(400).json({ error: "clientRequestId is required" });
    return;
  }
  try {
    const user = requestUser(req);
    const outcome = await transaction(async (client) => {
      // 与账号转移/删除统一 user → project → assets → files → run 的锁顺序。
      await assertGenerationOwnerActive(client, user.id);
      // 与入队处于同一事务并持有共享锁，避免项目/素材在授权后、入队前被并发替换。
      const project = await queryOne<{ owner_id: string; name: string; flow_json: string }>(`
        SELECT owner_id, name, flow_json FROM projects
        WHERE id = $1 AND deleted_at IS NULL AND lifecycle = 'saved'
        FOR SHARE
      `, [projectId], client);
      if (!project) return { status: "not_found" as const };
      if (project.owner_id !== user.id) return { status: "forbidden" as const };

      // 执行语义必须与刚保存的项目一致；实际入队始终使用数据库中的计划与项目名称。
      const submittedFlow = validateAndMigrateFlow({
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes,
        edges,
      });
      const flow = validateAndMigrateFlow(JSON.parse(project.flow_json));
      await assertWorkflowPantoneReferences(submittedFlow, client);
      await assertWorkflowPantoneReferences(flow, client);
      const planOptions = {
        onlyNodeId,
        includeDownstream: includeDownstream ?? false,
      };
      const submittedPlan = buildExecutionPlan(submittedFlow.nodes, submittedFlow.edges, planOptions);
      const plan = buildExecutionPlan(flow.nodes, flow.edges, planOptions);
      if (!isDeepStrictEqual(submittedPlan, plan)) return { status: "conflict" as const };
      // 点击单节点默认只执行自己，避免无意触发整条下游产生额外费用。
      if (plan.steps.length === 0) return { status: "empty" as const };
      assertPlanInputs(plan, flow.edges);
      await assertImageReferencesAccessible(plan, user.id, client);
      await assertStylingAnalyses(plan,user.id,projectId,client);
      const targetStep = plan.steps.find((step) => step.nodeId === onlyNodeId) ?? plan.steps[plan.steps.length - 1];
      if (multiImagePromptMode === "concise") {
        if (plan.steps.length !== 1 || targetStep.kind !== "virtual-try-on" ||
            targetStep.params.workflowStage !== "scene-stabilize" || targetStep.params.sceneInputMode !== "multi-reference-edit") {
          throw new DagError("简化提示词仅支持单个多图编辑节点");
        }
        // Run-only override: verified saved graph stays untouched; fingerprint/history include this mode.
        targetStep.params = { ...targetStep.params, multiImagePromptMode };
      }
      if (candidateReviewMode === "disabled") {
        if (plan.steps.length !== 1 || targetStep.kind !== "virtual-try-on" ||
            targetStep.params.workflowStage !== "scene-stabilize" || targetStep.params.sceneInputMode !== "multi-reference-edit") {
          throw new DagError("关闭候选评审仅支持单个多图编辑节点");
        }
        // Run-only diagnostic override. Persist it with the run, never in the saved project.
        targetStep.params = { ...targetStep.params, candidateReviewMode };
      }
      await assertApprovedBaselineExecution(client, flow, targetStep, user.id, projectId);
      const targetNode = flow.nodes.find((node) => node.id === targetStep.nodeId);
      const params = targetStep.params;
      const requestedCount = requestedCountForStep(targetStep.kind, params);
      const run = await enqueueGenerationRunInTransaction(client, plan, user.id, {
        userId: user.id,
        clientRequestId,
        projectId,
        projectName: project.name,
        nodeId: targetStep.nodeId,
        nodeLabel: targetNode?.data.label ?? targetStep.kind,
        kind: targetStep.kind,
        prompt: typeof params.prompt === "string" ? params.prompt : undefined,
        parameters: params,
        referenceImages: targetStep.inputImages,
        requestedCount,
      });
      return { status: "queued" as const, runId: run.id };
    });
    if (outcome.status === "not_found") {
      res.status(404).json({ error: "项目不存在或已删除" });
    } else if (outcome.status === "forbidden") {
      res.status(403).json({ error: "管理员只能查看其他用户项目，不能运行或修改" });
    } else if (outcome.status === "conflict") {
      res.status(409).json({ error: "画布尚未保存或已在其他位置更新，请保存后重试" });
    } else if (outcome.status === "empty") {
      res.status(400).json({ error: "workflow contains no executable nodes" });
    } else {
      res.status(202).json({ runId: outcome.runId, status: "queued" });
    }
  } catch (err) {
    if (err instanceof DagError || err instanceof WorkflowValidationError) {
      res.status(400).json({ error: err.message });
    } else if (err instanceof ImageReferenceAccessError) {
      res.status(403).json({ error: err.message });
    } else if (err instanceof GenerationRequestConflictError) {
      res.status(409).json({ error: err.message });
    } else if (err instanceof ActiveRunLimitError) {
      res.status(409).json({ error: err.message });
    } else if (err instanceof GenerationOwnerUnavailableError) {
      res.status(409).json({ error: err.message });
    } else {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
}));

function streamInMemoryRun(
  run: NonNullable<ReturnType<typeof getRunForUser>>,
  req: Request,
  res: Response,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");

  const send = (event: RunEvent) => {
    if (event.seq !== undefined) res.write(`id: ${event.seq}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const lastEventId = Number(req.get("Last-Event-ID") ?? 0);
  const cursor = Number.isSafeInteger(lastEventId) && lastEventId >= 0 ? lastEventId : 0;
  // 晚连接拿全量；重连只补发游标后的事件，避免终态/最近生成重复记账。
  for (const event of run.events) {
    if ((event.seq ?? 0) > cursor) send(event);
  }
  if (run.finished) {
    res.end();
    return;
  }
  run.emitter.on("event", send);
  const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15_000);
  const close = () => {
    clearInterval(heartbeat);
    run.emitter.off("event", send);
    res.end();
  };
  run.emitter.once("finish", close);
  req.on("close", () => {
    clearInterval(heartbeat);
    run.emitter.off("event", send);
    run.emitter.off("finish", close);
  });
}

interface DurableRunEventStreamDependencies {
  readEvents: typeof readDurableRunEvents;
  getRun: typeof getDurableRunForUser;
  wait: (milliseconds: number) => Promise<void>;
}

const durableRunEventStreamDependencies: DurableRunEventStreamDependencies = {
  readEvents: readDurableRunEvents,
  getRun: getDurableRunForUser,
  wait: (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
};

export async function streamDurableRunEvents(
  runId: string,
  ownerId: string,
  req: Request,
  res: Response,
  overrides: Partial<DurableRunEventStreamDependencies> = {},
): Promise<void> {
  const dependencies = { ...durableRunEventStreamDependencies, ...overrides };
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  let cursor = Number(req.get("Last-Event-ID") ?? 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
  let closed = false;
  req.on("close", () => { closed = true; });
  const heartbeat = setInterval(() => {
    if (!closed) res.write(": keepalive\n\n");
  }, 15_000);
  heartbeat.unref();

  const drain = async (): Promise<boolean> => {
    while (!closed) {
      const events = await dependencies.readEvents(runId, ownerId, cursor);
      if (!events) return false;
      for (const event of events) {
        if (closed) return true;
        if (event.seq !== undefined) {
          cursor = Math.max(cursor, event.seq);
          res.write(`id: ${event.seq}\n`);
        }
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      if (events.length < DURABLE_RUN_EVENT_BATCH_SIZE) return true;
    }
    return true;
  };

  try {
    while (!closed) {
      if (!await drain()) break;
      const status = await dependencies.getRun(runId, ownerId);
      if (!status) break;
      if (status.finished) {
        // 终态状态与最后事件在同一事务提交；状态查询后再 drain 一次可关闭竞态窗口。
        await drain();
        break;
      }
      await dependencies.wait(500);
    }
  } finally {
    clearInterval(heartbeat);
    if (!closed) res.end();
  }
}

runPlanRouter.get("/:id/events", asyncHandler(async (req, res) => {
  const ownerId = requestUser(req).id;
  const durable = await getDurableRunForUser(req.params.id, ownerId);
  if (!durable) {
    const legacyRun = getRunForUser(req.params.id, ownerId);
    if (!legacyRun) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    streamInMemoryRun(legacyRun, req, res);
    return;
  }
  await streamDurableRunEvents(req.params.id, ownerId, req, res);
}));

/** 刷新后先确认内存中的 Run 仍可恢复，避免对已丢失的 id 无限 SSE 重连。 */
runPlanRouter.get("/:id", asyncHandler(async (req, res) => {
  const ownerId = requestUser(req).id;
  const durable = await getDurableRunForUser(req.params.id, ownerId);
  if (durable) {
    res.json({ runId: durable.id, status: durable.status, finished: durable.finished });
    return;
  }
  const run = getRunForUser(req.params.id, ownerId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  res.json({ runId: run.id, finished: run.finished });
}));

import type { PersistedWorkflow } from "@/types/workflow";
import type { ServerInitialDraftSnapshot } from "@/store/flowStore";
import { nanoid } from "nanoid";

export class InitialDraftApiError extends Error {
  readonly status: number;
  readonly currentRevision?: number;
  readonly currentDraftId?: string;

  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === "string" ? body.error : `HTTP ${status}`);
    this.name = "InitialDraftApiError";
    this.status = status;
    if (typeof body.currentRevision === "number") this.currentRevision = body.currentRevision;
    if (typeof body.currentDraftId === "string") this.currentDraftId = body.currentDraftId;
  }
}

function isWorkflow(value: unknown): value is PersistedWorkflow {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedWorkflow>;
  return Number.isInteger(candidate.schemaVersion) &&
    Array.isArray(candidate.nodes) && Array.isArray(candidate.edges);
}

export function parseInitialDraft(value: unknown): ServerInitialDraftSnapshot {
  if (!value || typeof value !== "object") throw new Error("初始草稿响应格式无效");
  const draft = value as Partial<ServerInitialDraftSnapshot>;
  if (
    typeof draft.id !== "string" || !draft.id ||
    typeof draft.name !== "string" || !draft.name ||
    !isWorkflow(draft.flow) ||
    typeof draft.revision !== "number" || !Number.isSafeInteger(draft.revision) || draft.revision < 0 ||
    draft.lifecycle !== "initial_draft" ||
    typeof draft.createdAt !== "string" ||
    typeof draft.updatedAt !== "string"
  ) throw new Error("初始草稿响应格式无效");
  return draft as ServerInitialDraftSnapshot;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new InitialDraftApiError(response.status, body);
  return body;
}

function projectMaskRefs(flow: PersistedWorkflow): Array<{
  sourceUrl: string;
  fileId: string;
  nodeId: string;
}> {
  return flow.nodes.flatMap((node) => {
    if (node.data.kind !== "mask-redraw" || typeof node.data.mask !== "string") return [];
    const match = /^\/api\/files\/([^/?#]+\.png)$/.exec(node.data.mask);
    return match ? [{ sourceUrl: node.data.mask, fileId: match[1], nodeId: node.id }] : [];
  });
}

/** 复制项目级蒙版并把工作流引用改写为目标项目的独立文件。 */
export async function copyProjectScopedMasks(input: {
  sourceProjectId: string;
  targetProjectId?: string;
  createFreshTarget?: boolean;
  flow: PersistedWorkflow;
  signal?: AbortSignal;
}): Promise<{ flow: PersistedWorkflow; targetProjectId: string }> {
  const createFreshTarget = input.createFreshTarget === true;
  if (!createFreshTarget && input.targetProjectId === input.sourceProjectId) {
    return { flow: input.flow, targetProjectId: input.sourceProjectId };
  }
  if (
    createFreshTarget === Boolean(input.targetProjectId)
  ) throw new Error("蒙版复制目标无效");
  const refs = projectMaskRefs(input.flow);
  if (refs.length === 0) {
    return {
      flow: input.flow,
      targetProjectId: createFreshTarget ? nanoid(10) : input.targetProjectId!,
    };
  }
  const response = await fetch("/api/files/masks/copy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceProjectId: input.sourceProjectId,
      ...(createFreshTarget
        ? { createTarget: true }
        : { targetProjectId: input.targetProjectId }),
      masks: refs.map(({ fileId, nodeId }) => ({ fileId, nodeId })),
    }),
    signal: input.signal,
  });
  const body = await json(response);
  if (
    typeof body.targetProjectId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.targetProjectId) ||
    body.targetProjectId === input.sourceProjectId ||
    (!createFreshTarget && body.targetProjectId !== input.targetProjectId) ||
    !Array.isArray(body.masks)
  ) throw new Error("蒙版复制响应格式无效");
  const expected = new Map(refs.map((ref) => [ref.sourceUrl, ref.nodeId]));
  const replacements = new Map<string, string>();
  for (const value of body.masks) {
    if (!value || typeof value !== "object") throw new Error("蒙版复制响应格式无效");
    const copy = value as { sourceUrl?: unknown; targetUrl?: unknown; nodeId?: unknown };
    if (
      typeof copy.sourceUrl !== "string" ||
      typeof copy.targetUrl !== "string" || !/^\/api\/files\/[^/?#]+\.png$/.test(copy.targetUrl) ||
      typeof copy.nodeId !== "string" || expected.get(copy.sourceUrl) !== copy.nodeId ||
      replacements.has(copy.sourceUrl)
    ) throw new Error("蒙版复制响应格式无效");
    replacements.set(copy.sourceUrl, copy.targetUrl);
  }
  if (replacements.size !== expected.size) throw new Error("蒙版复制响应不完整");
  return {
    targetProjectId: body.targetProjectId,
    flow: {
      ...input.flow,
      nodes: input.flow.nodes.map((node) => {
        if (node.data.kind !== "mask-redraw" || typeof node.data.mask !== "string") return node;
        const mask = replacements.get(node.data.mask);
        return mask ? { ...node, data: { ...node.data, mask } } : node;
      }),
    },
  };
}

export async function fetchInitialDraft(signal?: AbortSignal): Promise<ServerInitialDraftSnapshot | null> {
  const response = await fetch("/api/projects/initial-draft", {
    cache: "no-store",
    signal,
  });
  const body = await json(response);
  return body.draft === null ? null : parseInitialDraft(body.draft);
}

export interface ServerProjectSummary {
  id: string;
  name: string;
  ownerName?: string;
  readOnly?: boolean;
  updatedAt: string;
}

export interface ServerProjectDetail extends ServerProjectSummary {
  flow: PersistedWorkflow;
}

function parseProjectSummary(value: unknown): ServerProjectSummary {
  if (!value || typeof value !== "object") throw new Error("项目列表响应格式无效");
  const project = value as Partial<ServerProjectSummary>;
  if (
    typeof project.id !== "string" || !project.id ||
    typeof project.name !== "string" || !project.name ||
    typeof project.updatedAt !== "string" || !Number.isFinite(Date.parse(project.updatedAt)) ||
    (project.ownerName !== undefined && typeof project.ownerName !== "string") ||
    (project.readOnly !== undefined && typeof project.readOnly !== "boolean")
  ) throw new Error("项目列表响应格式无效");
  return project as ServerProjectSummary;
}

export async function fetchSavedProjects(signal?: AbortSignal): Promise<ServerProjectSummary[]> {
  const response = await fetch("/api/projects", { cache: "no-store", signal });
  if (!response.ok) throw new Error(`项目列表 HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body)) throw new Error("项目列表响应格式无效");
  return body.map(parseProjectSummary);
}

export async function fetchSavedProject(id: string, signal?: AbortSignal): Promise<ServerProjectDetail> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`项目 HTTP ${response.status}`);
  const body = await response.json();
  const project = parseProjectSummary(body);
  if (!isWorkflow(body.flow)) throw new Error("项目详情响应格式无效");
  return { ...project, flow: body.flow };
}

export async function bootstrapInitialDraft(input: {
  id: string;
  name?: string;
  flow: PersistedWorkflow;
  signal?: AbortSignal;
}): Promise<{ created: boolean; draft: ServerInitialDraftSnapshot }> {
  const response = await fetch("/api/projects/initial-draft/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: input.id, ...(input.name ? { name: input.name } : {}), flow: input.flow }),
    signal: input.signal,
  });
  const body = await json(response);
  return { created: body.created === true, draft: parseInitialDraft(body.draft) };
}

export async function syncInitialDraft(input: {
  id: string;
  expectedRevision: number;
  name: string;
  flow: PersistedWorkflow;
  signal?: AbortSignal;
}): Promise<ServerInitialDraftSnapshot> {
  const response = await fetch(`/api/projects/initial-draft/${encodeURIComponent(input.id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedRevision: input.expectedRevision,
      name: input.name,
      flow: input.flow,
    }),
    signal: input.signal,
  });
  const body = await json(response);
  return parseInitialDraft(body.draft);
}

export async function abandonInitialDraft(input: {
  id: string;
  expectedRevision: number;
}): Promise<{ purgeAfter: string }> {
  const response = await fetch(`/api/projects/initial-draft/${encodeURIComponent(input.id)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: true, expectedRevision: input.expectedRevision }),
  });
  const body = await json(response);
  if (typeof body.purgeAfter !== "string") throw new Error("草稿放弃响应格式无效");
  return { purgeAfter: body.purgeAfter };
}

export function isServerInitialDraftPristine(draft: ServerInitialDraftSnapshot): boolean {
  if (!/^未修改项目名称\d{8}000000$/.test(draft.name) || draft.flow.edges.length !== 0) return false;
  if (draft.flow.nodes.length !== 1) return false;
  const node = draft.flow.nodes[0];
  return node.data.kind === "image-input" && node.data.status === "idle" && !node.data.imageUrl;
}

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  validateDrawingDocument,
  type DrawingDocument,
} from "../../src/components/drawing/drawingModel";
import type { PersistedWorkflow } from "../../src/types/workflow";

export class DrawingBoardAccessError extends Error {
  constructor(message: string, readonly code: "not-found" | "conflict" | "invalid" = "invalid") {
    super(message);
    this.name = "DrawingBoardAccessError";
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function canonicalDrawingDocumentJson(input: unknown): string {
  const document = validateDrawingDocument(input);
  return JSON.stringify(canonicalize(document));
}

export function drawingDocumentSha256(input: unknown): string {
  return createHash("sha256").update(canonicalDrawingDocumentJson(input)).digest("hex");
}

export function drawingBoardRequestSha256(input: {
  projectId: string;
  nodeId: string;
  baseContentRef: string | null;
  documentSha256: string;
  creation?: {
    position: { x: number; y: number };
    previewImageRef: string;
  };
}): string {
  return createHash("sha256").update(JSON.stringify([
    input.projectId, input.nodeId, input.baseContentRef, input.documentSha256,
    ...(input.creation ? [input.creation.position.x, input.creation.position.y, input.creation.previewImageRef] : []),
  ])).digest("hex");
}

export function drawingNodeFromFlow(flow: PersistedWorkflow, nodeId: string) {
  const node = flow.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.data.kind !== "drawing-board") {
    throw new DrawingBoardAccessError("画板节点不存在或已变更", "not-found");
  }
  return node;
}

export async function assertDrawingBoardReferences(
  client: PoolClient,
  ownerId: string,
  projectId: string,
  flow: PersistedWorkflow,
): Promise<void> {
  const boards = flow.nodes.filter((node) => node.data.kind === "drawing-board");
  for (const node of boards) {
    if (node.data.kind !== "drawing-board") continue;
    const contentRef = node.data.contentRef;
    const previewImageRef = node.data.previewImageRef;
    if (!contentRef) {
      if (previewImageRef) throw new DrawingBoardAccessError("画板预览缺少已提交内容，请重新保存画板");
      continue;
    }
    if (!previewImageRef) throw new DrawingBoardAccessError("已提交画板缺少预览图片，请重新保存画板");
    const version = (await client.query<{ width: number; height: number }>(`
      SELECT (content_json::jsonb #>> '{canvas,width}')::int AS width,
             (content_json::jsonb #>> '{canvas,height}')::int AS height
      FROM drawing_document_versions
      WHERE id = $1 AND owner_id = $2 AND project_id = $3 AND node_id = $4
      FOR KEY SHARE
    `, [contentRef, ownerId, projectId, node.id])).rows[0];
    if (!version || version.width !== node.data.width || version.height !== node.data.height) {
      throw new DrawingBoardAccessError("画板内容与当前项目或节点不匹配，请重新保存画板");
    }
  }
}

export interface DrawingDocumentVersionResponse {
  contentRef: string;
  sha256: string;
  document: DrawingDocument;
  createdAt: string;
}

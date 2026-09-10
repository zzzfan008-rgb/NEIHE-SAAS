import type { DrawingDocument } from "@/components/drawing/drawingModel";

export interface DrawingBoardVersionMeta {
  contentRef: string;
  sha256: string;
  createdAt: string;
}

export interface LoadedDrawingBoardVersion extends DrawingBoardVersionMeta {
  document: DrawingDocument;
}

export class DrawingBoardClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DrawingBoardClientError";
  }
}

export function drawingBoardCreationOutcomeIsUnknown(failure: unknown): boolean {
  if (!(failure instanceof DrawingBoardClientError)) return true;
  return failure.status === undefined || failure.status >= 500;
}

type Fetcher = typeof fetch;

async function boundedError(response: Response, fallback: string): Promise<DrawingBoardClientError> {
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  const detail = typeof body.error === "string" ? body.error.trim().slice(0, 240) : "";
  return new DrawingBoardClientError(detail || fallback, response.status);
}

export async function saveDrawingBoardVersion(
  input: {
    clientRequestId: string;
    projectId: string;
    nodeId: string;
    baseContentRef?: string;
    document: DrawingDocument;
  },
  options?: { fetcher?: Fetcher; signal?: AbortSignal },
): Promise<DrawingBoardVersionMeta> {
  const response = await (options?.fetcher ?? fetch)("/api/drawing-boards/versions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: options?.signal,
  });
  if (!response.ok) throw await boundedError(response, "画板内容保存失败");
  return await response.json() as DrawingBoardVersionMeta;
}

export async function createDrawingBoard(
  input: {
    clientRequestId: string;
    projectId: string;
    nodeId: string;
    position: { x: number; y: number };
    previewImageRef: string;
    document: DrawingDocument;
  },
  options?: { fetcher?: Fetcher; signal?: AbortSignal },
): Promise<DrawingBoardVersionMeta> {
  const response = await (options?.fetcher ?? fetch)("/api/drawing-boards/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: options?.signal,
  });
  if (!response.ok) throw await boundedError(response, "画板创建失败");
  return await response.json() as DrawingBoardVersionMeta;
}

export async function loadDrawingBoardVersion(
  contentRef: string,
  options?: { fetcher?: Fetcher; signal?: AbortSignal },
): Promise<LoadedDrawingBoardVersion> {
  const response = await (options?.fetcher ?? fetch)(
    `/api/drawing-boards/versions/${encodeURIComponent(contentRef)}`,
    { cache: "no-store", signal: options?.signal },
  );
  if (!response.ok) throw await boundedError(response, "画板内容读取失败");
  return await response.json() as LoadedDrawingBoardVersion;
}

export async function uploadDrawingPreview(
  dataUrl: string,
  options?: { fetcher?: Fetcher; signal?: AbortSignal },
): Promise<{ id: string; url: string }> {
  const response = await (options?.fetcher ?? fetch)("/api/files", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dataUrl }),
    signal: options?.signal,
  });
  if (!response.ok) throw await boundedError(response, "画板预览上传失败");
  return await response.json() as { id: string; url: string };
}

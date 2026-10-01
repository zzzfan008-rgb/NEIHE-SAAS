export interface MaskDraftUploadRequest {
  dataUrl: string;
  sourceRef: string;
  projectId: string;
  nodeId: string;
}

export interface MaskDraftUploadResponse {
  id: string;
  url: string;
  mimeType: "image/png";
  width: number;
  height: number;
  byteLength: number;
  preserved: true;
}

type Fetcher = typeof fetch;

export interface LatestMaskLoadGuard {
  begin(): () => boolean;
  invalidate(): void;
}

/** 让旧 source/initialMask 启动的 Image 回调在输入变化后自动失效。 */
export function createLatestMaskLoadGuard(): LatestMaskLoadGuard {
  let generation = 0;
  return {
    begin: () => {
      const current = ++generation;
      return () => current === generation;
    },
    invalidate: () => { generation += 1; },
  };
}

export async function uploadMaskDraft(
  request: MaskDraftUploadRequest,
  fetcher: Fetcher = fetch,
): Promise<MaskDraftUploadResponse> {
  const response = await fetcher("/api/files/mask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = await response.json().catch(() => ({})) as Partial<MaskDraftUploadResponse> & { error?: string };
  if (!response.ok) throw new Error(body.error || `蒙版保存失败 HTTP ${response.status}`);
  if (
    body.preserved !== true || body.mimeType !== "image/png" ||
    typeof body.id !== "string" || !body.id ||
    typeof body.url !== "string" || !/^\/api\/files\/[^/?#]+\.png$/.test(body.url) ||
    !Number.isInteger(body.width) || Number(body.width) <= 0 ||
    !Number.isInteger(body.height) || Number(body.height) <= 0 ||
    !Number.isInteger(body.byteLength) || Number(body.byteLength) <= 0
  ) {
    throw new Error("服务端未原样保存 PNG 蒙版，请重试");
  }
  return body as MaskDraftUploadResponse;
}

/** 上传成功后才提交节点状态并关闭编辑器；任一失败都会保留原节点与编辑界面。 */
export async function saveMaskDraft(
  request: MaskDraftUploadRequest,
  callbacks: { commit(url: string): void; close(): void },
  fetcher: Fetcher = fetch,
): Promise<MaskDraftUploadResponse> {
  const uploaded = await uploadMaskDraft(request, fetcher);
  callbacks.commit(uploaded.url);
  callbacks.close();
  return uploaded;
}

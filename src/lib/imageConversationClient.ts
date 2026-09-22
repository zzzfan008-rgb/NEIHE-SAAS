import type { DocumentTarget } from "@/store/flowStore";
import type {
  ConversationImageInput,
  ImageConversationMode,
  ImageConversationParameters,
  ImageConversationPlan,
  ImageConversationSourceKind,
  ImageConversationView,
  ImageConversationRoundView,
} from "@/types/imageConversation";

export interface ImageConversationPlanRequest {
  clientRequestId: string;
  mode: ImageConversationMode;
  inputManifest: ConversationImageInput[];
  prompt: string;
  parameters: ImageConversationParameters;
  sourceResultId?: string | null;
  effectiveRequirements?: Record<string, unknown>;
  incrementalRequirements?: Record<string, unknown>;
  maskRef?: string | null;
  clarificationRoundId?: string;
  clarificationAnswer?: string;
}

export interface ImageConversationPlanResponse {
  kind: "ready" | "clarification" | "rejected" | "replayed";
  plan?: ImageConversationPlan;
  replayed?: boolean;
  round: ImageConversationRoundView;
}

export interface ImageConversationRetryResponse {
  replayed: boolean;
  attemptId: string;
  attemptNumber: number;
  generationRunId: string;
  round: ImageConversationRoundView;
}

export interface ImageConversationReconcileResponse {
  round: ImageConversationRoundView;
}

type Fetcher = typeof fetch;

export class ImageConversationRequestError extends Error {
  constructor(message: string, readonly requestSettled: boolean) {
    super(message);
  }
}

async function requestJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
  fetcher: Fetcher = fetch,
): Promise<T> {
  const response = await fetcher(input, init);
  const body = await response.json().catch(() => ({})) as { error?: string; requestSettled?: boolean } & T;
  if (!response.ok) {
    throw new ImageConversationRequestError(
      body.error || `对话请求失败 HTTP ${response.status}`,
      body.requestSettled === true,
    );
  }
  return body;
}

function projectQuery(target: DocumentTarget): string {
  return new URLSearchParams({ projectId: target.projectId }).toString();
}

export function sourceKindForConversationReference(sourceRef: string): ImageConversationSourceKind {
  if (sourceRef.startsWith("asset/")) return "asset";
  if (sourceRef.startsWith("generation-output/")) return "generation-output";
  return "file";
}

export async function resolveImageConversation(
  target: DocumentTarget,
  sourceRef: string,
  fetcher: Fetcher = fetch,
): Promise<ImageConversationView | null> {
  const response = await fetcher(
    `/api/image-conversations/resolve?${new URLSearchParams({ projectId: target.projectId, sourceRef })}`,
  );
  if (response.status === 404) return null;
  const body = await response.json().catch(() => ({})) as { error?: string } & ImageConversationView;
  if (!response.ok) throw new Error(body.error || `对话查询失败 HTTP ${response.status}`);
  return body;
}

export async function createOrResolveImageConversation(
  target: DocumentTarget,
  sourceRef: string,
  fetcher: Fetcher = fetch,
): Promise<ImageConversationView> {
  return requestJson<ImageConversationView>("/api/image-conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: target.projectId,
      sourceRef,
      sourceKind: sourceKindForConversationReference(sourceRef),
    }),
  }, fetcher);
}

export async function createImageConversation(
  target: DocumentTarget,
  sourceRef: string,
  fetcher: Fetcher = fetch,
): Promise<ImageConversationView> {
  return requestJson<ImageConversationView>("/api/image-conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: target.projectId,
      sourceRef,
      sourceKind: sourceKindForConversationReference(sourceRef),
      startNew: true,
    }),
  }, fetcher);
}

export async function getImageConversation(
  target: DocumentTarget,
  conversationId: string,
  fetcher: Fetcher = fetch,
): Promise<ImageConversationView> {
  return requestJson<ImageConversationView>(
    `/api/image-conversations/${encodeURIComponent(conversationId)}?${projectQuery(target)}`,
    undefined,
    fetcher,
  );
}

export async function planImageConversationRound(
  target: DocumentTarget,
  conversationId: string,
  request: ImageConversationPlanRequest,
  fetcher: Fetcher = fetch,
): Promise<ImageConversationPlanResponse> {
  return requestJson<ImageConversationPlanResponse>(
    `/api/image-conversations/${encodeURIComponent(conversationId)}/rounds/plan`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: target.projectId,
        ...request,
      }),
    },
    fetcher,
  );
}

export async function retryImageConversationIntent(
  target: DocumentTarget,
  conversationId: string,
  intentId: string,
  clientRequestId: string,
  fetcher: Fetcher = fetch,
): Promise<ImageConversationRetryResponse> {
  return requestJson<ImageConversationRetryResponse>(
    `/api/image-conversations/${encodeURIComponent(conversationId)}/intents/${encodeURIComponent(intentId)}/retry`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: target.projectId, clientRequestId }),
    },
    fetcher,
  );
}

export async function reconcileImageConversationRound(
  target: DocumentTarget,
  conversationId: string,
  roundId: string,
  fetcher: Fetcher = fetch,
): Promise<ImageConversationView> {
  const body = await requestJson<ImageConversationReconcileResponse>(
    `/api/image-conversations/${encodeURIComponent(conversationId)}/rounds/${encodeURIComponent(roundId)}/reconcile`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: target.projectId }),
    },
    fetcher,
  );
  const conversation = await requestJson<ImageConversationView>(
    `/api/image-conversations/${encodeURIComponent(conversationId)}?${projectQuery(target)}`,
    undefined,
    fetcher,
  );
  if (!conversation.rounds.some((round) => round.id === body.round.id)) {
    throw new Error("结果核对返回的轮次不属于当前对话");
  }
  return conversation;
}

export async function uploadImageConversationFile(file: File, fetcher: Fetcher = fetch): Promise<{ url: string }> {
  const image = await readAsDataUrl(file);
  const name = file.name.replace(/\.[^.]+$/, "").trim().slice(0, 180) || "对话修改图片";
  const body = await requestJson<{
    normalized?: boolean;
    url?: string;
  } & { error?: string }>("/api/assets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      category: "upload",
      scope: "private",
      image,
      sourceNote: "来自对话修改",
    }),
  }, fetcher);
  if (body.normalized !== true || typeof body.url !== "string" || !body.url.startsWith("/api/files/")) {
    throw new Error("服务端未完成图片标准化，请重试");
  }
  return { url: body.url };
}

export function createImageConversationRequestId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.call(globalThis.crypto);
  return `image-conversation-${randomUuid ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

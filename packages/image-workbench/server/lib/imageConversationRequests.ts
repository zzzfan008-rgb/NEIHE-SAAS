import { createHash } from "node:crypto";
import { query, queryOne, transaction } from "./database";
import { ImageConversationAccessError, ImageConversationConflictError } from "./imageConversationStore";

export interface PlanningRequestIdentity {
  ownerId: string;
  projectId: string;
  conversationId: string;
  clientRequestId: string;
}
type CachedResponse = { status: number; body: Record<string, unknown> };

/** Reservations older than this are treated as orphaned (their worker is long gone). */
const PLANNING_RESERVATION_TTL_MS = 5 * 60 * 1000;
type Reservation = { kind: "reserved" } | { kind: "pending" } | ({ kind: "settled" } & CachedResponse);

export async function pendingImageConversationRequestIds(identity: PlanningRequestIdentity): Promise<string[]> {
  const rows = await query<{ client_request_id: string }>(`SELECT client_request_id FROM image_conversation_requests
    WHERE owner_id = $1 AND project_id = $2 AND conversation_id = $3 AND response_status IS NULL`,
  [identity.ownerId, identity.projectId, identity.conversationId]);
  return rows.map((row) => row.client_request_id);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

/** Committed before any provider call. A lost worker never grants a second paid call. */
export async function reserveImageConversationRequest(
  identity: PlanningRequestIdentity, payload: unknown,
): Promise<Reservation> {
  const fingerprint = createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
  return transaction(async (client) => {
    const owner = await queryOne<{ active: number; deleted_at: string | null }>(
      "SELECT active,deleted_at FROM users WHERE id=$1 FOR UPDATE", [identity.ownerId], client,
    );
    if (!owner || owner.active !== 1 || owner.deleted_at !== null) throw new ImageConversationAccessError();
    // Crash recovery: a reservation whose planner/apply died before settling leaves no recoverable
    // round/clarification. Once it is older than the planning TTL it can be reclaimed so the
    // conversation is not permanently blocked (otherwise the pending check below returns forever).
    await client.query(`
      DELETE FROM image_conversation_requests
      WHERE owner_id = $1 AND response_status IS NULL
        AND (conversation_id = $2 OR client_request_id = $3)
        AND created_at < now() - ($4 || ' milliseconds')::interval
    `, [identity.ownerId, identity.conversationId, identity.clientRequestId, String(PLANNING_RESERVATION_TTL_MS)]);
    const existing = await queryOne<{
      fingerprint: string; project_id: string; conversation_id: string;
      response_status: number | null; response_body: Record<string, unknown> | null;
    }>(`SELECT * FROM image_conversation_requests WHERE owner_id = $1 AND client_request_id = $2`,
    [identity.ownerId, identity.clientRequestId], client);
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.project_id !== identity.projectId ||
          existing.conversation_id !== identity.conversationId) throw new ImageConversationConflictError();
      return existing.response_status && existing.response_body
        ? { kind: "settled", status: existing.response_status, body: existing.response_body }
        : { kind: "pending" };
    }
    const pending = await queryOne(`SELECT 1 FROM image_conversation_requests
      WHERE owner_id = $1 AND conversation_id = $2 AND response_status IS NULL`,
    [identity.ownerId, identity.conversationId], client);
    if (pending) return { kind: "pending" };
    await client.query(`INSERT INTO image_conversation_requests
      (owner_id, project_id, conversation_id, client_request_id, fingerprint)
      VALUES ($1,$2,$3,$4,$5)`,
    [identity.ownerId, identity.projectId, identity.conversationId, identity.clientRequestId, fingerprint]);
    return { kind: "reserved" };
  });
}

export async function settleImageConversationRequest(identity: PlanningRequestIdentity, response: CachedResponse): Promise<void> {
  await queryOne(`UPDATE image_conversation_requests SET response_status = $3, response_body = $4::jsonb
    WHERE owner_id = $1 AND client_request_id = $2 AND response_status IS NULL RETURNING client_request_id`,
  [identity.ownerId, identity.clientRequestId, response.status, JSON.stringify(response.body)]);
}

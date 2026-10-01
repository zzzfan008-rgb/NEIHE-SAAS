import type { PoolClient } from "pg";

export async function migrateImageConversationRequests(client: PoolClient): Promise<void> {
  await client.query(`CREATE TABLE image_conversation_requests (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES image_conversations(id) ON DELETE CASCADE,
    client_request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    response_status INTEGER,
    response_body JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(owner_id, client_request_id),
    CHECK ((response_status IS NULL) = (response_body IS NULL))
  );
  CREATE INDEX image_conversation_requests_pending ON image_conversation_requests(owner_id, conversation_id)
    WHERE response_status IS NULL;
  INSERT INTO schema_migrations(version,name,applied_at)
    VALUES (27,'image_conversation_requests',NOW()::text);`);
}

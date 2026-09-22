import type { PoolClient } from "pg";

/** Stores clarification prompts and answers without creating a generation task. */
export async function migrateImageConversationPlanning(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS image_conversation_clarifications (
      id TEXT PRIMARY KEY,
      round_id TEXT NOT NULL UNIQUE REFERENCES image_conversation_rounds(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES image_conversations(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      question TEXT NOT NULL CHECK (length(btrim(question)) > 0),
      reason TEXT NOT NULL CHECK (reason IN ('count_mismatch','ambiguous_requirement')),
      requested_count INTEGER CHECK (requested_count IS NULL OR requested_count BETWEEN 1 AND 8),
      specified_intent_count INTEGER CHECK (
        specified_intent_count IS NULL OR specified_intent_count BETWEEN 0 AND 8
      ),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
      responses JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(responses) = 'array'),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS image_conversation_clarifications_lookup_idx
      ON image_conversation_clarifications(owner_id, project_id, conversation_id, updated_at DESC);
  `);
  await client.query(
    `INSERT INTO schema_migrations(version, name, applied_at)
     VALUES (25, 'image_conversation_planning', $1)
     ON CONFLICT (version) DO NOTHING`,
    [new Date().toISOString()],
  );
}

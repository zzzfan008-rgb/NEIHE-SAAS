import type { PoolClient } from "pg";

/** Allows an explicitly requested new conversation to reuse an image source. */
export async function migrateImageConversationStartNew(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE image_conversations
      DROP CONSTRAINT IF EXISTS image_conversations_owner_id_project_id_source_ref_key;
    ALTER TABLE image_conversation_sources
      DROP CONSTRAINT IF EXISTS image_conversation_sources_owner_id_project_id_source_ref_key;
    CREATE INDEX IF NOT EXISTS image_conversations_source_lookup_idx
      ON image_conversations(owner_id, project_id, source_ref, updated_at DESC);
    CREATE INDEX IF NOT EXISTS image_conversation_sources_source_lookup_idx
      ON image_conversation_sources(owner_id, project_id, source_ref, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS image_conversation_sources_conversation_source_key
      ON image_conversation_sources(conversation_id, source_ref);
  `);
  await client.query(
    `INSERT INTO schema_migrations(version, name, applied_at)
     VALUES (26, 'image_conversation_start_new', $1)
     ON CONFLICT (version) DO NOTHING`,
    [new Date().toISOString()],
  );
}

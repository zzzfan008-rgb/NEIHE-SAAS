import type { PoolClient } from "pg";

/**
 * Image conversations are a domain index over existing files, generation runs,
 * and generation outputs. They do not duplicate any binary, queue, or usage
 * record.
 */
export async function migrateImageConversations(client: PoolClient): Promise<void> {
  const now = new Date().toISOString();
  await client.query(`
    CREATE TABLE IF NOT EXISTS image_conversations (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 2048),
      source_kind TEXT NOT NULL CHECK (source_kind IN ('file','generation-output','asset')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_id, project_id, source_ref)
    );
    CREATE INDEX IF NOT EXISTS image_conversations_project_idx
      ON image_conversations(owner_id, project_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS image_conversation_sources (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES image_conversations(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 2048),
      source_kind TEXT NOT NULL CHECK (source_kind IN ('file','generation-output','asset')),
      relation TEXT NOT NULL CHECK (relation IN ('origin','generated-output','alias')),
      created_at TEXT NOT NULL,
      UNIQUE(owner_id, project_id, source_ref)
    );
    CREATE INDEX IF NOT EXISTS image_conversation_sources_conversation_idx
      ON image_conversation_sources(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS image_conversation_rounds (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES image_conversations(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      client_request_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('single','fusion','mask')),
      source_result_id TEXT,
      input_manifest JSONB NOT NULL CHECK (jsonb_typeof(input_manifest) = 'array'),
      prompt TEXT NOT NULL CHECK (length(btrim(prompt)) > 0),
      parameters JSONB NOT NULL CHECK (jsonb_typeof(parameters) = 'object'),
      effective_requirements JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(effective_requirements) = 'object'),
      incremental_requirements JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(incremental_requirements) = 'object'),
      mask_ref TEXT,
      request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
        'draft','clarification_required','queued','running','partial',
        'succeeded','failed','outcome_unknown'
      )),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(conversation_id, ordinal),
      UNIQUE(owner_id, client_request_id)
    );
    CREATE INDEX IF NOT EXISTS image_conversation_rounds_lookup_idx
      ON image_conversation_rounds(owner_id, project_id, conversation_id, ordinal);

    CREATE TABLE IF NOT EXISTS image_conversation_intents (
      id TEXT PRIMARY KEY,
      round_id TEXT NOT NULL REFERENCES image_conversation_rounds(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES image_conversations(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      label TEXT NOT NULL CHECK (length(btrim(label)) > 0),
      instruction TEXT NOT NULL CHECK (length(btrim(instruction)) > 0),
      requirements JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(requirements) = 'object'),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending','clarification_required','rejected','queued','running',
        'succeeded','failed','outcome_unknown'
      )),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(round_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS image_conversation_intents_round_idx
      ON image_conversation_intents(round_id, ordinal);

    CREATE TABLE IF NOT EXISTS image_conversation_attempts (
      id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL REFERENCES image_conversation_intents(id) ON DELETE CASCADE,
      round_id TEXT NOT NULL REFERENCES image_conversation_rounds(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES image_conversations(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
      client_request_id TEXT NOT NULL,
      generation_run_id TEXT REFERENCES generation_runs(id) ON DELETE SET NULL,
      retry_of_attempt_id TEXT REFERENCES image_conversation_attempts(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN (
        'queued','running','succeeded','failed','outcome_unknown'
      )),
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(intent_id, attempt_number),
      UNIQUE(owner_id, client_request_id)
    );
    CREATE INDEX IF NOT EXISTS image_conversation_attempts_run_idx
      ON image_conversation_attempts(generation_run_id);

    CREATE TABLE IF NOT EXISTS image_conversation_outputs (
      id TEXT PRIMARY KEY,
      round_id TEXT NOT NULL REFERENCES image_conversation_rounds(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES image_conversations(id) ON DELETE CASCADE,
      intent_id TEXT REFERENCES image_conversation_intents(id) ON DELETE SET NULL,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      generation_output_id TEXT REFERENCES generation_outputs(id) ON DELETE SET NULL,
      image_ref TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending','ready','failed','unknown')),
      prompt TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(generation_output_id),
      CONSTRAINT image_conversation_output_reference_check CHECK (
        generation_output_id IS NOT NULL OR image_ref IS NOT NULL OR error IS NOT NULL
      )
    );
    CREATE INDEX IF NOT EXISTS image_conversation_outputs_round_idx
      ON image_conversation_outputs(round_id, created_at);
  `);
  await client.query(
    `INSERT INTO schema_migrations(version, name, applied_at)
     VALUES (24, 'image_conversations', $1)
     ON CONFLICT (version) DO NOTHING`,
    [now],
  );
}

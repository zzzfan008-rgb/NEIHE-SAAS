import type { PoolClient } from "pg";

export async function migrateAiGateways(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE ai_gateway_settings (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      active_gateway TEXT NOT NULL CHECK (active_gateway IN ('apiyi','tuzi')),
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO ai_gateway_settings (singleton, active_gateway) VALUES (TRUE, 'apiyi');
    ALTER TABLE generation_runs ADD COLUMN gateway_id TEXT NOT NULL DEFAULT 'apiyi'
      CHECK (gateway_id IN ('apiyi','tuzi'));
    INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (29, 'global_ai_gateway_and_run_routing', now()::text);
  `);
}

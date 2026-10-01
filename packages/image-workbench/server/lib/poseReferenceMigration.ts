import type { PoolClient } from 'pg';

export async function migratePoseReferences(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE pose_references (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('skeleton','depth')),
      configuration TEXT NOT NULL, attempt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','outcome_unknown')),
      result JSONB, error TEXT, provider_requests INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
      UNIQUE(owner_id,project_id,node_id,source,kind,configuration)
    );
    CREATE INDEX pose_references_owner ON pose_references(owner_id,project_id,node_id,source);
    INSERT INTO schema_migrations(version,name,applied_at) VALUES(23,'pose_reference_comparison',NOW()::text);
  `);
}

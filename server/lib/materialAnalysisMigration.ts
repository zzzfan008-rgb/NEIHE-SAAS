import type { PoolClient } from "pg";

export async function migrateMaterialAnalysis(
  client: PoolClient,
  defaultModelId: string,
): Promise<void> {
  await client.query(`
    CREATE TABLE material_analysis_models (
      id TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._-]{1,120}$'),
      label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
      protocol TEXT NOT NULL CHECK (protocol = 'gemini-generate-content'),
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      retired_at TEXT
    );
    CREATE UNIQUE INDEX material_analysis_default_model_idx
      ON material_analysis_models(is_default) WHERE is_default;
    CREATE TABLE material_analysis_model_state (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
    );
    INSERT INTO material_analysis_model_state(singleton,revision) VALUES (TRUE,1);

    CREATE TABLE material_analyses (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      status TEXT NOT NULL CHECK (status IN ('draft','analyzing','analyzed','failed','outcome_unknown','saved')),
      source_image TEXT NOT NULL CHECK (source_image ~ '^/api/files/[A-Za-z0-9_.-]+$'),
      crop_image TEXT NOT NULL CHECK (crop_image ~ '^/api/files/[A-Za-z0-9_.-]+$'),
      crop JSONB NOT NULL CHECK (jsonb_typeof(crop) = 'object'),
      model_id TEXT REFERENCES material_analysis_models(id) ON DELETE RESTRICT,
      suggestion JSONB CHECK (suggestion IS NULL OR jsonb_typeof(suggestion) = 'object'),
      calibration JSONB CHECK (calibration IS NULL OR jsonb_typeof(calibration) = 'object'),
      error TEXT,
      asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX material_analyses_owner_idx ON material_analyses(owner_id,created_at DESC);
    ALTER TABLE assets ADD COLUMN material_metadata JSONB
      CHECK (material_metadata IS NULL OR jsonb_typeof(material_metadata) = 'object');
  `);
  const now = new Date().toISOString();
  await client.query(
    `
    INSERT INTO material_analysis_models(id,label,protocol,enabled,is_default,created_at,updated_at)
    VALUES ($1,'Gemini 材质分析','gemini-generate-content',TRUE,TRUE,$2,$2)
  `,
    [defaultModelId, now],
  );
  await client.query(
    "INSERT INTO schema_migrations(version,name,applied_at) VALUES (21,$1,$2)",
    ["material_analysis_and_assets", now],
  );
}

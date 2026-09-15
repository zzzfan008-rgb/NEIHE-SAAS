import type { PoolClient } from "pg";

export async function migrateBrandColors(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE color_brands (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('neihe','reference')),
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0), deleted_at TEXT
    );
    CREATE UNIQUE INDEX color_brands_name_idx ON color_brands(lower(name)) WHERE deleted_at IS NULL;
    CREATE UNIQUE INDEX color_brands_neihe_idx ON color_brands(kind) WHERE kind = 'neihe';
    INSERT INTO color_brands(id,kind,name) VALUES ('neihe','neihe','NEIHE Color'), ('chloe','reference','Chloé'), ('ralph-lauren','reference','Ralph Lauren');
    CREATE TABLE color_series (
      id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES color_brands(id) ON DELETE RESTRICT,
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
      year INTEGER CHECK (year BETWEEN 1900 AND 2200), season TEXT CHECK (length(season) BETWEEN 1 AND 80),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0), deleted_at TEXT,
      UNIQUE(id, brand_id)
    );
    CREATE TABLE color_groups (
      id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES color_brands(id) ON DELETE RESTRICT,
      series_id TEXT, name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0), deleted_at TEXT,
      FOREIGN KEY(series_id,brand_id) REFERENCES color_series(id,brand_id) ON DELETE RESTRICT
    );
    CREATE INDEX color_series_brand_idx ON color_series(brand_id) WHERE deleted_at IS NULL;
    CREATE INDEX color_groups_brand_idx ON color_groups(brand_id,series_id) WHERE deleted_at IS NULL;
    CREATE TABLE color_imports (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL REFERENCES color_groups(id) ON DELETE RESTRICT,
      release_id TEXT NOT NULL REFERENCES color_catalog_releases(id) ON DELETE RESTRICT,
      library_key TEXT NOT NULL, file_hash TEXT NOT NULL CHECK (file_hash ~ '^[a-f0-9]{64}$'),
      format TEXT NOT NULL CHECK (format IN ('xlsx','ase')),
      rows JSONB NOT NULL CHECK (jsonb_typeof(rows) = 'array' AND jsonb_array_length(rows) BETWEEN 1 AND 5000),
      decisions JSONB NOT NULL CHECK (jsonb_typeof(decisions) = 'array'),
      published_rows JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(published_rows) = 'array'),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0), created_at TEXT NOT NULL,
      CHECK (jsonb_array_length(rows) = jsonb_array_length(decisions))
    );
    CREATE INDEX color_imports_owner_idx ON color_imports(owner_id,created_at);
    CREATE TABLE color_group_members (
      group_id TEXT NOT NULL REFERENCES color_groups(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 4999),
      catalog_id TEXT NOT NULL, release_id TEXT NOT NULL,
      ratio DOUBLE PRECISION CHECK (ratio >= 0 AND ratio <= 1),
      original_hex TEXT CHECK (original_hex ~ '^#[0-9A-F]{6}$'),
      origin_import_id TEXT REFERENCES color_imports(id) ON DELETE SET NULL,
      PRIMARY KEY(group_id,position), UNIQUE(group_id,catalog_id),
      FOREIGN KEY(release_id,catalog_id) REFERENCES color_catalog_versions(release_id,color_id) ON DELETE RESTRICT
    );
    CREATE TABLE color_import_commits (
      import_id TEXT NOT NULL REFERENCES color_imports(id) ON DELETE CASCADE,
      request_revision INTEGER NOT NULL,
      result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
      PRIMARY KEY(import_id,request_revision)
    );
  `);
  await client.query(
    "INSERT INTO schema_migrations(version,name,applied_at) VALUES (20,$1,$2)",
    ["brand_color_management", new Date().toISOString()],
  );
}

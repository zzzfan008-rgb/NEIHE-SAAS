import type { PoolClient } from "pg";

/** Called inside the existing numbered-migration transaction and schema lock. */
export async function migrateColorCatalog(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE color_catalog_releases (
      id TEXT PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
      created_at TEXT NOT NULL,
      color_count INTEGER NOT NULL CHECK (color_count BETWEEN 1 AND 50000)
    );
    CREATE TABLE color_catalog_identities (
      id TEXT PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
      library_key TEXT NOT NULL CHECK (library_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
      code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 96),
      UNIQUE (library_key, code)
    );
    CREATE TABLE color_catalog_versions (
      release_id TEXT NOT NULL REFERENCES color_catalog_releases(id) ON DELETE RESTRICT,
      color_id TEXT NOT NULL REFERENCES color_catalog_identities(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN ('ready', 'conflict', 'unconverted')),
      hex TEXT CHECK (hex ~ '^#[0-9A-F]{6}$'),
      hue TEXT CHECK (hue IN ('neutral','red','orange','yellow','green','cyan','blue','purple','pink')),
      out_of_gamut BOOLEAN,
      data JSONB NOT NULL CHECK (jsonb_typeof(data) = 'object'),
      PRIMARY KEY (release_id, color_id),
      CHECK ((status = 'ready' AND hex IS NOT NULL AND hue IS NOT NULL AND out_of_gamut IS NOT NULL)
        OR (status <> 'ready' AND hex IS NULL AND hue IS NULL AND out_of_gamut IS NULL))
    );
    CREATE INDEX color_catalog_versions_filter_idx ON color_catalog_versions(release_id, status, hue);
    CREATE TABLE color_catalog_state (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      release_id TEXT REFERENCES color_catalog_releases(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
    );
    INSERT INTO color_catalog_state(singleton, release_id, revision) VALUES (TRUE, NULL, 0);
  `);
  await client.query(
    "INSERT INTO schema_migrations(version, name, applied_at) VALUES (19, $1, $2)",
    ["versioned_color_catalog", new Date().toISOString()],
  );
}

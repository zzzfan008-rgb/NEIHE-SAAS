import type { PoolClient } from "pg";
import type { PersistedWorkflow } from "../../src/types/workflow";
import { query } from "./database";
import { WorkflowValidationError } from "./workflowSchema";

interface CatalogRow {
  color_id: string;
  release_id: string;
  library_key: string;
  code: string;
  hex: string;
}

/**
 * Resolve every v2 Pantone swatch against its immutable catalog release before a
 * workflow crosses a server persistence or execution boundary.
 */
export async function assertWorkflowPantoneReferences(
  flow: PersistedWorkflow,
  client?: PoolClient,
): Promise<void> {
  const references = flow.nodes.flatMap((node) => {
    if (node.data.kind !== "color-palette" || node.data.paletteVersion !== 2)
      return [];
    return node.data.swatches.flatMap((swatch) =>
      swatch.pantone ? [{ ...swatch.pantone, hex: swatch.value }] : [],
    );
  });
  if (references.length === 0) return;

  const catalogIds = [
    ...new Set(references.map((reference) => reference.catalogId)),
  ];
  const releaseIds = [
    ...new Set(references.map((reference) => reference.releaseId)),
  ];
  const rows = await query<CatalogRow>(
    `
    SELECT version.color_id, version.release_id, identity.library_key, identity.code, version.hex
    FROM color_catalog_versions version
    JOIN color_catalog_identities identity ON identity.id = version.color_id
    WHERE version.status = 'ready'
      AND version.color_id = ANY($1::text[])
      AND version.release_id = ANY($2::text[])
  `,
    [catalogIds, releaseIds],
    client,
  );
  const canonical = new Map(
    rows.map((row) => [`${row.release_id}:${row.color_id}`, row]),
  );
  for (const reference of references) {
    const key = `${reference.releaseId}:${reference.catalogId}`;
    const row = canonical.get(key);
    if (
      !row ||
      row.library_key !== reference.libraryKey ||
      row.code !== reference.code ||
      row.hex !== reference.hex
    ) {
      throw new WorkflowValidationError(
        `Pantone 色号 ${reference.code} 与版本主库不一致`,
      );
    }
  }
}

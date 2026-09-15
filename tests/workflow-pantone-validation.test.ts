import assert from "node:assert/strict";
import { resetPostgresTestDatabase } from "./postgresTestDatabase";

console.log("工作流 Pantone 主库引用测试");
process.env.SQLITE_IMPORT_FILE = "missing.db";
process.env.INITIAL_ADMIN_ACCOUNT_ID = "workflow-pantone-admin";
process.env.INITIAL_ADMIN_PASSWORD = "Initial1234";
await resetPostgresTestDatabase();
const { initializeDatabase, closeDatabaseForTests, query } = await import(
  "../server/lib/database"
);
const { validateAndMigrateFlow } = await import("../server/lib/workflowSchema");
const { assertWorkflowPantoneReferences } = await import(
  "../server/lib/workflowPantoneValidation"
);

const releaseId = "1".repeat(64);
const catalogId = "2".repeat(64);
const flow = (pantone: Record<string, string>, value = "#AABBCC") =>
  validateAndMigrateFlow({
    schemaVersion: 12,
    nodes: [
      {
        id: "palette",
        type: "color-palette",
        position: { x: 0, y: 0 },
        data: {
          kind: "color-palette",
          label: "Pantone",
          status: "idle",
          paletteVersion: 2,
          swatches: [{ id: "one", value, source: "pantone", pantone }],
        },
      },
    ],
    edges: [],
  });

try {
  await initializeDatabase();
  const now = new Date().toISOString();
  await query(
    "INSERT INTO color_catalog_releases(id,created_at,color_count) VALUES ($1,$2,1)",
    [releaseId, now],
  );
  await query(
    "INSERT INTO color_catalog_identities(id,library_key,code) VALUES ($1,'pantone-tcx','11-1000 TCX')",
    [catalogId],
  );
  await query(
    `INSERT INTO color_catalog_versions(release_id,color_id,status,hex,hue,out_of_gamut,data)
    VALUES ($1,$2,'ready','#AABBCC','blue',FALSE,'{}'::jsonb)`,
    [releaseId, catalogId],
  );

  const canonical = {
    catalogId,
    releaseId,
    libraryKey: "pantone-tcx",
    code: "11-1000 TCX",
  };
  await assertWorkflowPantoneReferences(flow(canonical));
  await assert.rejects(
    () =>
      assertWorkflowPantoneReferences(flow({ ...canonical, code: "伪造色号" })),
    /主库不一致/,
  );
  await assert.rejects(
    () => assertWorkflowPantoneReferences(flow(canonical, "#FFFFFF")),
    /主库不一致/,
  );
  await assert.rejects(
    () =>
      assertWorkflowPantoneReferences(
        flow({ ...canonical, releaseId: "3".repeat(64) }),
      ),
    /主库不一致/,
  );
  const forgedThenCanonical = validateAndMigrateFlow({
    schemaVersion: 12,
    nodes: [
      {
        id: "forged",
        type: "color-palette",
        position: { x: 0, y: 0 },
        data: {
          kind: "color-palette",
          label: "伪造",
          status: "idle",
          paletteVersion: 2,
          swatches: [
            {
              id: "bad",
              value: "#FFFFFF",
              source: "pantone",
              pantone: { ...canonical, code: "伪造色号" },
            },
          ],
        },
      },
      {
        id: "canonical",
        type: "color-palette",
        position: { x: 0, y: 100 },
        data: {
          kind: "color-palette",
          label: "正确",
          status: "idle",
          paletteVersion: 2,
          swatches: [
            {
              id: "good",
              value: "#AABBCC",
              source: "pantone",
              pantone: canonical,
            },
          ],
        },
      },
    ],
    edges: [],
  });
  await assert.rejects(
    () => assertWorkflowPantoneReferences(forgedThenCanonical),
    /主库不一致/,
  );
  console.log("  ✓ 同一身份跨节点重复时逐条校验，正确后项不能覆盖前项伪造值");
  console.log(
    "  ✓ 持久化与执行边界仅接受 release 内完全一致的 Pantone 身份和 HEX",
  );
} finally {
  await closeDatabaseForTests();
}

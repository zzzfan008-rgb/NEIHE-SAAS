import { pathToFileURL } from "node:url";
import { prepareColorCatalogRelease } from "../server/lib/colorCatalogRelease";
import { readColorCatalogManifest } from "../server/lib/colorCatalogManifest";

const usage =
  "用法：node --import tsx scripts/import-color-catalog.ts --manifest /private/path/manifest.json [--expected-revision N --apply]（默认只检查，不连接数据库）";

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return;
  }
  const apply =
    args.length === 5 &&
    args[2] === "--expected-revision" &&
    args[4] === "--apply";
  if (args[0] !== "--manifest" || !args[1] || (args.length !== 2 && !apply))
    throw new Error(usage);
  const revision = apply ? Number(args[3]) : 0;
  if (apply && (!/^\d+$/.test(args[3]) || !Number.isSafeInteger(revision)))
    throw new Error("expected-revision 必须是非负整数");
  const sources = readColorCatalogManifest(args[1]);
  const { colors } = prepareColorCatalogRelease(sources);
  if (!apply) {
    console.log(
      JSON.stringify({
        dryRun: true,
        sources: sources.length,
        identities: colors.length,
        ready: colors.filter((color) => color.status === "ready").length,
        conflict: colors.filter((color) => color.status === "conflict").length,
        unconverted: colors.filter((color) => color.status === "unconverted")
          .length,
      }),
    );
    return;
  }
  const { initializeDatabase, closeDatabaseForTests } = await import(
    "../server/lib/database"
  );
  const { publishColorCatalog } = await import(
    "../server/lib/colorCatalogStore"
  );
  try {
    await initializeDatabase();
    const result = await publishColorCatalog(sources, revision);
    console.log(JSON.stringify({ applied: true, ...result }));
  } finally {
    await closeDatabaseForTests();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    // Do not print SQL parameters or raw input data on operator failures.
    console.error(error instanceof Error ? error.message : "主库导入失败");
    process.exitCode = 1;
  }
}

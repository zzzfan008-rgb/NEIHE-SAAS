import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";

await build({
  entryPoints: ["server/app.ts", "server/cli.ts"],
  bundle: true, platform: "node", format: "esm", target: "node22",
  packages: "external", outdir: "dist-server",
});
await mkdir("dist-types/server", { recursive: true });
await copyFile("server/public.d.ts", "dist-types/server/app.d.ts");

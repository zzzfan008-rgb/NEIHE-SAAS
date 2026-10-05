import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "garment-portkey-test-"));
const image = "garment-canvas-portkey:acceptance";
function docker(args) {
  const result = spawnSync("docker", args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Portkey Docker verification failed (${result.status})`);
}
try {
  if (!process.argv.includes("--skip-build")) docker(["build", "-t", image, "deploy/portkey"]);
  const script = join(temp, "probe.mjs");
  await build({ entryPoints: [join(root, "tests/portkey-gateway.integration.ts")], outfile: script,
    bundle: true, platform: "node", format: "esm", target: "node22" });
  // No real credentials, project .env, network, published ports or production volumes enter this container.
  docker(["run", "--rm", "--network", "none", "--entrypoint", "node",
    "--mount", `type=bind,src=${script},dst=/probe.mjs,readonly`, image, "/probe.mjs"]);
} finally { rmSync(temp, { recursive: true, force: true }); }

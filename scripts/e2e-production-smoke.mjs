import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createComposeProjectName, acquireTestLock } from "./test-with-postgres.mjs";

async function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve production smoke port"));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

function runCommandSoft(command, args, options = {}) {
  try {
    runCommand(command, args, options);
  } catch (error) {
    console.warn(error instanceof Error ? error.message : String(error));
  }
}

function runNpmScript(script, env) {
  if (process.env.npm_execpath) {
    runCommand(process.execPath, [process.env.npm_execpath, "run", script], { env });
    return;
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  runCommand(npm, ["run", script], { env });
}

function runPlaywrightCommand(env) {
  if (process.env.npm_execpath) {
    runCommand(process.execPath, [process.env.npm_execpath, "exec", "--", "playwright", "test", "--config", "playwright.production.config.ts"], { env });
    return;
  }
  const playwright = process.platform === "win32" ? "npx.cmd" : "npx";
  runCommand(playwright, ["playwright", "test", "--config", "playwright.production.config.ts"], { env });
}

async function main() {
  const shouldBuild = !process.argv.includes("--skip-build");
  const baseProjectName = createComposeProjectName();
  const composeProjectName = `${baseProjectName}-e2e-prod-smoke`;
  const releaseLock = acquireTestLock({ projectName: baseProjectName });
  const composeCommand = [
    "compose",
    "--project-name",
    composeProjectName,
    "-f",
    "compose.test.yaml",
  ];

  const dataDir = mkdtempSync(join(tmpdir(), "garment-canvas-prod-smoke-"));
  let cleanupDone = false;
  let composeEnv = {
    ...process.env,
    COMPOSE_PROJECT_NAME: composeProjectName,
  };

  const cleanup = () => {
    if (cleanupDone) return;
    cleanupDone = true;
    runCommandSoft("docker", [...composeCommand, "down", "--volumes", "--remove-orphans"], { env: composeEnv });
    releaseLock();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(error instanceof Error ? error.message : String(error));
    }
  };

  const handleTerminate = () => {
    cleanup();
    process.exit(128 + 15);
  };
  process.once("SIGINT", handleTerminate);
  process.once("SIGTERM", handleTerminate);

  try {
    const [postgresPort, appPort] = await Promise.all([reserveFreePort(), reserveFreePort()]);
    composeEnv = {
      ...composeEnv,
      POSTGRES_TEST_PORT: String(postgresPort),
    };

    const runnerEnv = {
      ...composeEnv,
      E2E_ISOLATED_RUN: "1",
      NODE_ENV: "production",
      DATABASE_URL: `postgresql://garment_test:garment_test@127.0.0.1:${postgresPort}/garment_canvas_test`,
      DATA_DIR: dataDir,
      SQLITE_IMPORT_FILE: join(dataDir, "missing.db"),
      INITIAL_ADMIN_ACCOUNT_ID: "e2e-admin",
      INITIAL_ADMIN_PASSWORD: "E2eInitial1234",
      E2E_ACCOUNT_ID: "e2e-admin",
      E2E_INITIAL_PASSWORD: "E2eInitial1234",
      E2E_PASSWORD: "E2eFinal5678",
      E2E_AUTH_STATE_PATH: join(dataDir, "auth.json"),
      COOKIE_SECURE: "false",
      API_ONLY: "false",
      APIYI_API_KEY: "e2e-disabled",
      APIYI_BASE_URL: "https://127.0.0.1:9",
      AI_TIMEOUT_MS: "500",
      GENERATION_WORKER_POLL_MS: "60000",
      NO_PROXY: "127.0.0.1,localhost",
      PORT: String(appPort),
      E2E_API_URL: `http://127.0.0.1:${appPort}`,
      E2E_BASE_URL: `http://127.0.0.1:${appPort}`,
      E2E_PRODUCTION_SMOKE: "1",
    };

    if (shouldBuild) {
      runNpmScript("build", runnerEnv);
    }
    runCommand("docker", [...composeCommand, "down", "--volumes", "--remove-orphans"], { env: composeEnv });
    runCommand("docker", [...composeCommand, "up", "-d", "--wait"], { env: composeEnv });
    runPlaywrightCommand(runnerEnv);
  } catch (error) {
    runCommandSoft("docker", [...composeCommand, "logs", "--no-color"], { env: composeEnv });
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    cleanup();
    process.off("SIGINT", handleTerminate);
    process.off("SIGTERM", handleTerminate);
  }
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  await main();
}

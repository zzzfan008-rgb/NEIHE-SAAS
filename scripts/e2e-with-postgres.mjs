import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireTestLock, createComposeProjectName } from "./test-with-postgres.mjs";

async function reserveFreePorts(count) {
  const servers = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServer();
      server.unref();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      servers.push(server);
    }

    return servers.map((server) => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Unable to reserve an E2E port");
      }
      return address.port;
    });
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

function runNpmScript(script, env) {
  if (process.env.npm_execpath) {
    run(process.execPath, [process.env.npm_execpath, "run", script], { env });
    return;
  }
  run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", script], { env });
}

async function main() {
  const baseProjectName = createComposeProjectName();
  const composeProjectName = `${baseProjectName}-e2e`;
  const releaseLock = acquireTestLock({ projectName: baseProjectName });
  const compose = [
    "compose",
    "--project-name",
    composeProjectName,
    "-f",
    "compose.test.yaml",
  ];
  const dataDir = mkdtempSync(join(tmpdir(), "garment-canvas-e2e-"));
  let composeEnv = {
    ...process.env,
    COMPOSE_PROJECT_NAME: composeProjectName,
  };
  let cleanupDone = false;

  const cleanup = () => {
    if (cleanupDone) return;
    cleanupDone = true;
    try {
      spawnSync("docker", [...compose, "down", "--volumes", "--remove-orphans"], {
        stdio: "inherit",
        env: composeEnv,
      });
    } catch (cleanupError) {
      console.warn(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    }
    try {
      rmSync(dataDir, { recursive: true, force: true });
      releaseLock();
    } catch (cleanupError) {
      console.warn(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    }
  };

  const terminate = (signal) => {
    cleanup();
    process.exitCode = signal === "SIGINT" ? 130 : 143;
  };
  process.once("SIGINT", () => terminate("SIGINT"));
  process.once("SIGTERM", () => terminate("SIGTERM"));

  try {
    run("docker", [...compose, "down", "--volumes", "--remove-orphans"], { env: composeEnv });
    const [postgresPort] = await reserveFreePorts(1);
    composeEnv = {
      ...composeEnv,
      POSTGRES_TEST_PORT: String(postgresPort),
    };
    run("docker", [...compose, "up", "-d", "--wait"], { env: composeEnv });
    const [apiPort, webPort] = await reserveFreePorts(2);

    const databaseUrl = `postgresql://garment_test:garment_test@127.0.0.1:${postgresPort}/garment_canvas_test`;
    const e2eEnv = {
      ...composeEnv,
      E2E_ISOLATED_RUN: "1",
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      DATA_DIR: dataDir,
      SQLITE_IMPORT_FILE: join(dataDir, "missing.db"),
      INITIAL_ADMIN_ACCOUNT_ID: "e2e-admin",
      INITIAL_ADMIN_PASSWORD: "E2eInitial1234",
      E2E_ACCOUNT_ID: "e2e-admin",
      E2E_INITIAL_PASSWORD: "E2eInitial1234",
      E2E_PASSWORD: "E2eFinal5678",
      E2E_AUTH_STATE_PATH: join(dataDir, "auth.json"),
      PORT: String(apiPort),
      API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
      E2E_API_URL: `http://127.0.0.1:${apiPort}`,
      E2E_BASE_URL: `http://127.0.0.1:${webPort}`,
      COOKIE_SECURE: "false",
      API_ONLY: "false",
      APIYI_API_KEY: "e2e-disabled",
      APIYI_BASE_URL: "https://127.0.0.1:9",
      AI_TIMEOUT_MS: "500",
      GENERATION_WORKER_POLL_MS: "60000",
      NO_PROXY: "127.0.0.1,localhost",
      GITHUB_PAT: "",
    };

    runNpmScript("test:e2e:run", e2eEnv);
  } catch (error) {
    spawnSync("docker", [...compose, "logs", "--no-color"], {
      stdio: "inherit",
      env: composeEnv,
    });
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    cleanup();
  }
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) await main();

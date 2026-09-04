import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { config as serverConfig } from "../server/config";
import {
  assessPreflight,
  buildPreflightConfig,
  type PreflightObservations,
} from "./dev-preflight-core";

const execFileAsync = promisify(execFile);
const { Client } = pg;

async function portIsOpen(host: string, port: number, timeoutMs = 900): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function httpStatus(url: string): Promise<number | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return response.status;
  } catch {
    return undefined;
  }
}

async function dockerIsReachable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 2_500,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function databaseQueryIsReady(): Promise<boolean> {
  const connectionString = serverConfig.databaseUrl();
  const client = new Client({
    ...(connectionString
      ? { connectionString }
      : {
          host: serverConfig.databaseHost(),
          port: serverConfig.databasePort(),
          database: serverConfig.databaseName(),
          user: serverConfig.databaseUser(),
          password: serverConfig.databasePassword(),
        }),
    connectionTimeoutMillis: 2_500,
  });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  // 导入 server/config 会加载项目根目录的私有 .env；这里只读取非敏感连接参数。
  const runtimeEnv = {
    ...process.env,
    PORT: String(serverConfig.port()),
    PGHOST: serverConfig.databaseHost(),
    PGPORT: String(serverConfig.databasePort()),
  };
  const preflight = buildPreflightConfig(runtimeEnv);
  const proxyBase = preflight.apiProxyTarget.replace(/\/+$/, "");
  const databaseConnectHost = preflight.databaseHost === "localhost"
    ? "127.0.0.1"
    : preflight.databaseHost;

  const [webPortOpen, apiPortOpen, databasePortOpen, databaseQueryOk, dockerReachable, proxyHealthStatus, proxyReadyStatus] =
    await Promise.all([
      portIsOpen("127.0.0.1", preflight.webPort),
      portIsOpen("127.0.0.1", preflight.apiPort),
      portIsOpen(databaseConnectHost, preflight.databasePort),
      databaseQueryIsReady(),
      dockerIsReachable(),
      httpStatus(`${proxyBase}/api/health`),
      httpStatus(`${proxyBase}/api/ready`),
    ]);

  const observations: PreflightObservations = {
    webPortOpen,
    apiPortOpen,
    databasePortOpen,
    databaseQueryOk,
    dockerReachable,
    proxyHealthStatus,
    proxyReadyStatus,
  };
  const result = assessPreflight(preflight, observations);

  console.log("Garment Canvas 本地启动预检");
  console.log(`  Node.js: ${preflight.nodeVersion}`);
  console.log(`  Web: http://localhost:${preflight.webPort}`);
  console.log(`  API: http://localhost:${preflight.apiPort}`);
  console.log(`  API proxy: ${preflight.apiProxyTarget}`);
  console.log(`  PostgreSQL: ${preflight.databaseHost}:${preflight.databasePort}`);

  for (const note of result.notes) console.log(`  ℹ ${note}`);
  for (const warning of result.warnings) console.warn(`  ⚠ ${warning}`);
  for (const blocker of result.blockers) console.error(`  ✗ ${blocker}`);

  if (result.blockers.length > 0) {
    console.error("\n预检未通过；以上问题处理后再执行 pnpm run dev。");
    process.exitCode = 1;
    return;
  }
  console.log("  ✓ 预检通过，可以启动开发服务");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "未知错误";
  console.error(`Garment Canvas 本地启动预检失败：${message}`);
  process.exitCode = 1;
});

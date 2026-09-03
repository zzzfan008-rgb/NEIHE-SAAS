import { resolveApiProxyTarget } from "../vite.config";

export const MINIMUM_NODE_VERSION = [22, 20, 0] as const;
export const DEFAULT_WEB_PORT = 5173;

export interface PreflightConfig {
  nodeVersion: string;
  webPort: number;
  apiPort: number;
  apiProxyTarget: string;
  databaseHost: string;
  databasePort: number;
}

export interface PreflightObservations {
  webPortOpen: boolean;
  apiPortOpen: boolean;
  databasePortOpen: boolean;
  databaseQueryOk: boolean;
  dockerReachable: boolean;
  proxyHealthStatus?: number;
  proxyReadyStatus?: number;
}

export interface PreflightAssessment {
  blockers: string[];
  warnings: string[];
  notes: string[];
}

function parsePort(raw: string | undefined, fallback: number, name: string): number {
  const value = Number(raw?.trim() || fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

function databaseTarget(env: Readonly<Record<string, string | undefined>>): {
  host: string;
  port: number;
} {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(databaseUrl);
    } catch {
      throw new Error("DATABASE_URL must be an absolute PostgreSQL URL");
    }
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error("DATABASE_URL must use postgres:// or postgresql://");
    }
    if (!parsed.hostname) throw new Error("DATABASE_URL must include a database host");
    return {
      host: parsed.hostname,
      port: parsePort(parsed.port, 5_432, "DATABASE_URL port"),
    };
  }
  return {
    host: env.PGHOST?.trim() || "127.0.0.1",
    port: parsePort(env.PGPORT ?? env.POSTGRES_HOST_PORT, 54_329, "PGPORT/POSTGRES_HOST_PORT"),
  };
}

export function nodeVersionAtLeast(
  version: string,
  minimum: readonly number[] = MINIMUM_NODE_VERSION,
): boolean {
  const parts = version.replace(/^v/, "").split(".").map(Number);
  if (parts.some((part) => !Number.isInteger(part) || part < 0)) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    const current = parts[index] ?? 0;
    const required = minimum[index] ?? 0;
    if (current !== required) return current > required;
  }
  return true;
}

export function buildPreflightConfig(
  env: Readonly<Record<string, string | undefined>>,
  nodeVersion = process.version,
): PreflightConfig {
  const database = databaseTarget(env);
  return {
    nodeVersion,
    webPort: DEFAULT_WEB_PORT,
    apiPort: parsePort(env.PORT, 3001, "PORT"),
    apiProxyTarget: resolveApiProxyTarget(env),
    databaseHost: database.host,
    databasePort: database.port,
  };
}

function targetUsesLocalApi(config: PreflightConfig): boolean {
  const target = new URL(config.apiProxyTarget);
  const host = target.hostname === "localhost" ? "127.0.0.1" : target.hostname;
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  return host === "127.0.0.1" && port === config.apiPort;
}

export function assessPreflight(
  config: PreflightConfig,
  observations: PreflightObservations,
): PreflightAssessment {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  if (!nodeVersionAtLeast(config.nodeVersion)) {
    blockers.push(`Node.js ${config.nodeVersion} 低于项目要求的 22.20.0`);
  }
  if (observations.webPortOpen) {
    blockers.push(`前端端口 ${config.webPort} 已被占用；请停止旧 Vite 进程后重试`);
  }
  if (observations.apiPortOpen) {
    blockers.push(`API 端口 ${config.apiPort} 已被占用；请停止旧开发服务或调整 PORT`);
  }
  if (!observations.databasePortOpen) {
    blockers.push(
      `PostgreSQL ${config.databaseHost}:${config.databasePort} 不可达；先运行 docker compose up -d postgres --wait`,
    );
  } else if (!observations.databaseQueryOk) {
    blockers.push(
      "PostgreSQL 端口可达但认证或查询失败；请核对 DATABASE_URL/PG* 凭据与目标数据库",
    );
  }

  if (!observations.dockerReachable) {
    const message = "Docker Engine 当前不可用；如使用本机外部 PostgreSQL，可忽略此提示";
    if (observations.databasePortOpen) warnings.push(message);
    else warnings.push("Docker Engine 当前不可用；请启动 Docker Desktop 或 Colima");
  }

  if (observations.proxyHealthStatus !== undefined) {
    notes.push(`API 代理目标 health 返回 HTTP ${observations.proxyHealthStatus}`);
  } else if (!targetUsesLocalApi(config)) {
    warnings.push(`API_PROXY_TARGET ${config.apiProxyTarget} 当前不可达`);
  } else {
    notes.push("API 将由本次 npm run dev 启动，启动前不可达属于预期状态");
  }

  if (observations.proxyReadyStatus !== undefined && observations.proxyReadyStatus !== 200) {
    warnings.push(`API 代理目标 ready 返回 HTTP ${observations.proxyReadyStatus}，请查看服务端日志`);
  }

  return { blockers, warnings, notes };
}

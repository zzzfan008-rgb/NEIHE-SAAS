import assert from "node:assert/strict";
import {
  assessPreflight,
  buildPreflightConfig,
  nodeVersionAtLeast,
} from "../scripts/dev-preflight-core";

console.log("本地开发启动预检契约测试");

assert.equal(nodeVersionAtLeast("v22.20.0"), true);
assert.equal(nodeVersionAtLeast("22.21.0"), true);
assert.equal(nodeVersionAtLeast("23.0.0"), true);
assert.equal(nodeVersionAtLeast("22.19.9"), false);
assert.equal(nodeVersionAtLeast("invalid"), false);

const defaults = buildPreflightConfig({}, "v22.20.0");
assert.deepEqual(defaults, {
  nodeVersion: "v22.20.0",
  webPort: 5173,
  apiPort: 3001,
  apiProxyTarget: "http://localhost:3001",
  databaseHost: "127.0.0.1",
  databasePort: 54329,
});

const configured = buildPreflightConfig({
  PORT: "3002",
  API_PROXY_TARGET: "https://api.internal.example:8443/",
  PGHOST: "db.internal",
  PGPORT: "5432",
});
assert.equal(configured.apiProxyTarget, "https://api.internal.example:8443");
assert.equal(configured.webPort, 5173);
assert.equal(configured.apiPort, 3002);
assert.equal(configured.databaseHost, "db.internal");
assert.equal(configured.databasePort, 5432);

const databaseUrl = buildPreflightConfig({
  DATABASE_URL: "postgresql://private-user:private-password@db.example:5544/garment_canvas",
  PGHOST: "ignored.example",
  PGPORT: "5999",
});
assert.equal(databaseUrl.databaseHost, "db.example");
assert.equal(databaseUrl.databasePort, 5544);

assert.throws(() => buildPreflightConfig({ PGPORT: "invalid" }), /PGPORT/);
assert.throws(() => buildPreflightConfig({ DATABASE_URL: "https://db.example" }), /postgres/);

const healthy = assessPreflight(defaults, {
  webPortOpen: false,
  apiPortOpen: false,
  databasePortOpen: true,
  databaseQueryOk: true,
  dockerReachable: true,
});
assert.deepEqual(healthy.blockers, []);
assert.equal(healthy.notes.some((note) => note.includes("本次 npm run dev")), true);

const blocked = assessPreflight(defaults, {
  webPortOpen: true,
  apiPortOpen: true,
  databasePortOpen: false,
  databaseQueryOk: false,
  dockerReachable: false,
  proxyHealthStatus: 200,
  proxyReadyStatus: 503,
});
assert.equal(blocked.blockers.length, 3);
assert.equal(blocked.blockers.some((item) => item.includes("Vite")), true);
assert.equal(blocked.blockers.some((item) => item.includes("PostgreSQL")), true);
assert.equal(blocked.warnings.some((item) => item.includes("ready")), true);

const authenticationBlocked = assessPreflight(defaults, {
  webPortOpen: false,
  apiPortOpen: false,
  databasePortOpen: true,
  databaseQueryOk: false,
  dockerReachable: true,
});
assert.equal(authenticationBlocked.blockers.length, 1);
assert.equal(authenticationBlocked.blockers[0]?.includes("认证或查询失败"), true);

console.log("  ✓ 版本、端口、代理目标与阻断/提示分类均通过");

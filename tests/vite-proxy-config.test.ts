import assert from "node:assert/strict";
import { resolveApiProxyTarget } from "../vite.config";

console.log("Vite API 代理配置契约测试");

assert.equal(
  resolveApiProxyTarget({}),
  "http://localhost:3001",
  "未配置时必须保持原有 3001 开发默认值",
);
assert.equal(
  resolveApiProxyTarget({ PORT: "3002" }),
  "http://localhost:3002",
  "Vite 代理必须跟随后端 PORT",
);
assert.equal(
  resolveApiProxyTarget({
    PORT: "3001",
    API_PROXY_TARGET: " https://api.internal.example:8443/ ",
  }),
  "https://api.internal.example:8443",
  "显式 API_PROXY_TARGET 必须优先于 PORT",
);

assert.throws(
  () => resolveApiProxyTarget({ PORT: "not-a-port" }),
  /PORT must be an integer between 1 and 65535/,
);
assert.throws(
  () => resolveApiProxyTarget({ API_PROXY_TARGET: "http://[" }),
  /absolute HTTP\(S\) URL/,
);
assert.throws(
  () => resolveApiProxyTarget({ API_PROXY_TARGET: "file:///tmp/api.sock" }),
  /must use http:\/\/ or https:\/\//,
);

console.log("  ✓ 默认端口、PORT 联动、显式覆盖与无效值门禁均通过");

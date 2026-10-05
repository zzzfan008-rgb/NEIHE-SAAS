import assert from "node:assert/strict";
import { config } from "../server/config";
import { portkeyRequest } from "../server/providers/portkey";
import { fetchAiWithRetry, ProviderError } from "../server/providers/base";
import { withAiGateway } from "../server/providers/gatewayContext";

Object.assign(process.env, {
  APIYI_BASE_URL: "https://apiyi.test", APIYI_API_KEY: "apiyi-fixture",
  TUZI_BASE_URL: "https://tuzi.test", TUZI_API_KEY: "tuzi-fixture",
  SEEDANCE_API_BASE_URL: "https://seedance.test", SEEDANCE_API_KEY: "seedance-fixture",
  PORTKEY_GATEWAY_URL: "http://127.0.0.1:8787",
});

await Promise.all((["apiyi", "tuzi"] as const).map(gateway => withAiGateway(gateway, async () => {
  await Promise.resolve();
  const request = portkeyRequest(`https://${gateway}.test/v1beta/models/image:generateContent?alt=json`, {
    method: "POST", body: "unchanged", headers: {
      authorization: "Bearer must-not-leak", "x-portkey-provider": "anthropic",
      "x-portkey-config": "untrusted", "content-type": "application/json",
    },
  }, { timeoutMs: 300_000 });
  assert.equal(request.url, "http://127.0.0.1:8787/v1/v1beta/models/image:generateContent?alt=json");
  assert.equal(request.init.body, "unchanged");
  const headers = new Headers(request.init.headers);
  assert.equal(headers.has("authorization"), false);
  assert.equal(headers.has("x-portkey-provider"), false);
  assert.deepEqual(JSON.parse(headers.get("x-portkey-metadata")!), { supplier: gateway });
  const routing = JSON.parse(headers.get("x-portkey-config")!);
  assert.equal(routing.strategy.mode, "conditional");
  assert.equal(routing.strategy.default, "unconfigured-supplier");
  assert.equal(routing.targets.find((target: { name: string }) => target.name === gateway).api_key, `${gateway}-fixture`);
  assert.equal(routing.retry.attempts, 0);
  assert.equal(routing.request_timeout, 300_000);
  assert.equal(request.init.redirect, "error");
})));

const video = portkeyRequest("https://seedance.test/seedance/api/v3/contents/generations/tasks", {}, {
  gateway: "apiyi", video: true, timeoutMs: 30_000,
});
assert.equal(video.url, "http://127.0.0.1:8787/v1/seedance/api/v3/contents/generations/tasks");
const videoTargets = JSON.parse(new Headers(video.init.headers).get("x-portkey-config")!).targets;
assert.equal(videoTargets.find((target: { name: string }) => target.name === "apiyi").api_key, "seedance-fixture");
assert.throws(() => portkeyRequest("https://apiyi.test.evil/v1/images/generations", {}, {
  gateway: "apiyi", timeoutMs: 1_000,
}), /任务绑定不匹配/);
assert.throws(() => portkeyRequest("https://apiyi.test/v1/images/generations", {}, {
  gateway: "tuzi", timeoutMs: 1_000,
}), /任务绑定不匹配/);
process.env.TUZI_API_KEY = "";
assert.throws(() => portkeyRequest("https://tuzi.test/v1/images/generations", {}, {
  gateway: "tuzi", timeoutMs: 1_000,
}));
const remaining = portkeyRequest("https://apiyi.test/v1/images/generations", {}, { timeoutMs: 1_000 });
assert.equal(JSON.parse(new Headers(remaining.init.headers).get("x-portkey-config")!).targets.length, 1);

for (const invalid of ["http://external.test:8787", "https://user:pass@portkey.test", "https://portkey.test/v1", "https://portkey.test?key=x"]) {
  process.env.PORTKEY_GATEWAY_URL = invalid;
  assert.throws(() => config.portkeyBaseUrl());
  assert.equal(config.aiConfigReady("apiyi"), false);
}
process.env.PORTKEY_GATEWAY_URL = "http://portkey:8787";
assert.equal(config.portkeyBaseUrl(), "http://portkey:8787");

const originalFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = (async input => {
  calls++;
  assert.equal(String(input), "http://portkey:8787/v1/v1/images/generations");
  throw new TypeError("offline gateway");
}) as typeof fetch;
try {
  await assert.rejects(() => fetchAiWithRetry("https://apiyi.test/v1/images/generations", () => ({ method: "POST" })),
    (error: unknown) => error instanceof ProviderError && error.category === "outcome_unknown");
  assert.equal(calls, 1, "unavailable Portkey must never fall back to a direct provider request");
} finally { globalThis.fetch = originalFetch; }
console.log("Portkey 配置、并发隔离、凭据边界与禁止直连回退回归通过（无网络）");

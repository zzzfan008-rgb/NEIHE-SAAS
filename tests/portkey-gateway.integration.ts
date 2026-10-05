// Executed only inside a --network none container with the official Portkey distribution.
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { portkeyRequest } from "../server/providers/portkey";
import type { AiGatewayId } from "../src/types/aiGateway";

Object.assign(process.env, {
  APIYI_BASE_URL: "https://apiyi.test", APIYI_API_KEY: "apiyi-fixture",
  TUZI_BASE_URL: "https://tuzi.test", TUZI_API_KEY: "tuzi-fixture",
  SEEDANCE_API_BASE_URL: "https://seedance.test", SEEDANCE_API_KEY: "seedance-fixture",
  PORTKEY_GATEWAY_URL: "http://127.0.0.1:48787",
});
const seen: Array<{ url: string; key: string | undefined; method: string | undefined }> = [];
const upstream = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  seen.push({ url: req.url!, key: req.headers.authorization, method: req.method });
  if (req.url!.endsWith("/fail")) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "fixture unavailable" } }));
    return;
  }
  if (req.url!.endsWith("/content")) {
    res.writeHead(200, { "content-type": "video/mp4" });
    res.end(Buffer.from("0000ftypfixture"));
    return;
  }
  let payload: unknown = null;
  // Parse multipart using the platform parser to verify names, ordering and file bytes.
  if (req.headers["content-type"]?.startsWith("multipart/")) {
    const form = await new Response(body, { headers: { "content-type": req.headers["content-type"] } }).formData();
    payload = await Promise.all([...form.entries()].map(async ([key, value]) => [key,
      typeof value === "string" ? value : { name: value.name, text: await value.text() }]));
  } else if (body.length) payload = JSON.parse(body.toString());
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ payload }));
});
await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = (upstream.address() as { port: number }).port;
const gateway = spawn(process.execPath, ["/app/build/start-server.js", "--port=48787", "--headless"], {
  env: { ...process.env, NODE_ENV: "production" }, stdio: "ignore",
});
gateway.on("error", () => {});

function fixtureRequest(gatewayId: AiGatewayId, path: string, init: RequestInit, video = false) {
  const base = gatewayId === "apiyi" && video ? "https://seedance.test" : `https://${gatewayId}.test`;
  const request = portkeyRequest(`${base}${path}`, init, { gateway: gatewayId, video, timeoutMs: 10_000 });
  const headers = new Headers(request.init.headers);
  const routing = JSON.parse(headers.get("x-portkey-config")!);
  for (const target of routing.targets) {
    // Only the transport fixture uses HTTP, entirely within the network-isolated container.
    const name = new URL(target.custom_host).hostname.split(".")[0];
    target.custom_host = `http://127.0.0.1:${upstreamPort}/${name}`;
  }
  headers.set("x-portkey-config", JSON.stringify(routing));
  return { url: request.url, init: { ...request.init, headers, signal: AbortSignal.timeout(15_000) } };
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (gateway.exitCode !== null) throw new Error(`Portkey exited before ready: ${gateway.exitCode}`);
    try { ready = (await fetch("http://127.0.0.1:48787", { signal: AbortSignal.timeout(500) })).ok; } catch { /* starting */ }
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, "official gateway must become ready");
  for (const gatewayId of ["apiyi", "tuzi"] as const) {
    for (const path of ["/v1/images/generations", "/v1/chat/completions", "/v1beta/models/gemini:generateContent", "/v1/videos"]) {
      const payload = { model: "fixture-model", quality: "max", size: "4096x4096", content: [{ image_url: "asset://first" }], refer_model: "normal" };
      const request = fixtureRequest(gatewayId, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const response = await fetch(request.url, request.init);
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json() as { payload: unknown }).payload, payload);
      assert.deepEqual(seen.at(-1), { url: `/${gatewayId}${path}`, key: `Bearer ${gatewayId}-fixture`, method: "POST" });
    }
    // Reference normalization permits 6 MiB of raw images (~8 MiB when base64 encoded).
    const reference = Buffer.alloc(6 * 1024 * 1024, 7).toString("base64");
    const large = fixtureRequest(gatewayId, "/v1beta/models/gemini:generateContent", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ inlineData: { mimeType: "image/png", data: reference } }] }] }),
    });
    const largeResponse = await fetch(large.url, large.init);
    assert.equal(largeResponse.status, 200, "gateway must retain the project's reference size allowance");
    const returned = await largeResponse.json() as { payload: { contents: Array<{ parts: Array<{ inlineData: { data: string } }> }> } };
    assert.equal(returned.payload.contents[0].parts[0].inlineData.data === reference, true);
    for (const path of ["/v1/images/edits", "/v1/seedance/assets"]) {
      const form = new FormData();
      form.append("model", "fixture-model");
      form.append("image[]", new Blob(["first-file"]), "first.png");
      form.append("image[]", new Blob(["second-file"]), "second.png");
      form.append("mask", new Blob(["mask-file"]), "mask.png");
      const request = fixtureRequest(gatewayId, path, { method: "POST", body: form });
      const response = await fetch(request.url, request.init);
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json() as { payload: unknown }).payload, [
        ["model", "fixture-model"], ["image[]", { name: "first.png", text: "first-file" }],
        ["image[]", { name: "second.png", text: "second-file" }], ["mask", { name: "mask.png", text: "mask-file" }],
      ]);
      assert.equal(seen.at(-1)!.key, `Bearer ${gatewayId}-fixture`);
    }
    const request = fixtureRequest(gatewayId, "/v1/videos/task-id?detail=true", { method: "GET" });
    assert.equal((await fetch(request.url, request.init)).status, 200);
    assert.equal(seen.at(-1)!.url, `/${gatewayId}/v1/videos/task-id?detail=true`);
    const binary = fixtureRequest(gatewayId, "/v1/videos/task-id/content", { method: "GET" });
    assert.equal(await (await fetch(binary.url, binary.init)).text(), "0000ftypfixture");
    const count = seen.length;
    const failure = fixtureRequest(gatewayId, "/v1/videos/fail", { method: "POST" });
    assert.equal((await fetch(failure.url, failure.init)).status, 503);
    assert.equal(seen.length, count + 1, "Portkey must not retry or fall back across suppliers");
    assert.equal(seen.at(-1)!.key, `Bearer ${gatewayId}-fixture`);
  }
  const seedance = fixtureRequest("apiyi", "/seedance/api/v3/contents/generations/tasks", { method: "POST" }, true);
  assert.equal((await fetch(seedance.url, seedance.init)).status, 200);
  assert.deepEqual(seen.at(-1), { url: "/seedance/seedance/api/v3/contents/generations/tasks", key: "Bearer seedance-fixture", method: "POST" });
  const missing = fixtureRequest("tuzi", "/v1/images/generations", { method: "POST" });
  missing.init.headers.set("x-portkey-metadata", JSON.stringify({ supplier: "missing" }));
  const count = seen.length;
  assert.equal((await fetch(missing.url, missing.init)).ok, false);
  assert.equal(seen.length, count, "unrecognized supplier must not reach any upstream");
  console.log(`官方 Portkey 实例验证通过：${seen.length} 次模拟请求；双供应商、原生路径、JSON、文件顺序、独立视频凭据、无回退。Node ${process.version}`);
} finally {
  upstream.closeAllConnections();
  await new Promise<void>(resolve => upstream.close(() => resolve()));
  gateway.kill("SIGTERM");
}

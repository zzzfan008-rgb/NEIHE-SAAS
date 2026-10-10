import assert from "node:assert/strict";
import sharp from "sharp";
import { tuziProviders } from "../server/providers/tuzi";
import { ProviderError } from "../server/providers/base";
import { unwrapPortkeyRequest } from "./portkeyMock";

/** Real Tuzi adapter, memory-only HTTP responses; never calls a supplier. */
export async function testTuziImageResponses(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const keys = ["APIYI_BASE_URL", "APIYI_API_KEY", "TUZI_BASE_URL", "TUZI_API_KEY", "PORTKEY_GATEWAY_URL"] as const;
  const saved = keys.map((key) => process.env[key]);
  Object.assign(process.env, { APIYI_BASE_URL: "https://apiyi.example", APIYI_API_KEY: "apiyi-fixture-key", TUZI_BASE_URL: "https://tuzi.example", TUZI_API_KEY: "tuzi-fixture-key", PORTKEY_GATEWAY_URL: "http://127.0.0.1:8787" });
  const logs: unknown[][] = [];
  console.info = (...args: unknown[]) => { logs.push(args); };
  const failures: string[] = [];
  const test = async (name: string, run: () => Promise<void>) => {
    try { await run(); console.log(`  ✓ ${name}`); }
    catch (error) { failures.push(name); console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  let requests = 0;
  let respond: () => Response = () => Response.json({});
  globalThis.fetch = (async (input, init) => {
    const [url] = unwrapPortkeyRequest(input, init);
    assert.ok(String(url).startsWith("https://tuzi.example/v1/images/"));
    requests++;
    return respond();
  }) as typeof fetch;
  const generate = (model = "seedream-5-0-260128") => tuziProviders[model].generate({ prompt: "PRIVATE-PROMPT", modelOptions: model.startsWith("gemini") ? { aspectRatio: "1:1", imageSize: "2K" } : { size: "2K" } });
  const resultUrl = "https://result.example/download?signature=PRIVATE-SIGNATURE";
  const payload = { data: [{ url: resultUrl }], revised_prompt: 'quoted \\" brace } 中文' };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const category = (expected: string) => (error: unknown) => error instanceof ProviderError && error.category === expected;
  try {
    console.log("Tuzi 非流式完整响应与低延迟回归（全部模拟）");
    await test("结构化无后缀 URL、不再误报内容拒绝", async () => {
      respond = () => Response.json(payload);
      assert.deepEqual((await generate("gemini-3.1-flash-image")).images, [resultUrl]);
    });
    for (const declaredLength of [false, true]) {
      await test(`完整 JSON 不等连接关闭（Content-Length=${declaredLength}）`, async () => {
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        respond = () => new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            timer = setTimeout(() => controller.error(new Error("fixture tail disconnected")), 500);
          },
          cancel() { cancelled = true; clearTimeout(timer); },
        }), { headers: { "content-type": "application/json", ...(declaredLength ? { "content-length": String(bytes.length) } : {}) } });
        const started = performance.now();
        try {
          assert.deepEqual((await generate()).images, [resultUrl]);
          assert.ok(performance.now() - started < 450, "完整结果不应等待尾部连接超时");
          assert.equal(cancelled, true);
        } finally { clearTimeout(timer); }
      });
    }
    await test("逐字节分片、UTF-8、转义引号/括号不提前截断", async () => {
      respond = () => new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }));
      assert.deepEqual((await generate()).images, [resultUrl]);
    });
    await test("Base64 与说明字段分离；null Base64 仍可用 URL", async () => {
      const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#123456" } }).png().toBuffer();
      respond = () => Response.json({ data: [{ b64_json: png.toString("base64"), revised_prompt: "Image generated successfully" }] });
      assert.deepEqual((await generate()).images, [`data:image/png;base64,${png.toString("base64")}`]);
      respond = () => Response.json({ data: [{ b64_json: null, url: resultUrl }] });
      assert.deepEqual((await generate()).images, [resultUrl]);
    });
    await test("空结果不是审核拒绝；显式审核错误仍保留", async () => {
      respond = () => Response.json({ data: [], usageMetadata: { candidatesTokenCount: 0 } });
      await assert.rejects(generate, category("empty_response"));
      respond = () => Response.json({ error: { code: "content_policy_violation", message: "blocked by moderation" } });
      await assert.rejects(generate, category("content_refused"));
    });
    await test("残缺/中断结果标记待确认且不在适配层重发", async () => {
      for (const disconnect of [false, true]) {
        const before = requests;
        respond = () => new Response(new ReadableStream({
          start(controller) { controller.enqueue(bytes.slice(0, -1)); if (disconnect) setTimeout(() => controller.error(new Error("fixture disconnect")), 5); else controller.close(); },
        }));
        await assert.rejects(generate, category("outcome_unknown"));
        assert.equal(requests, before + 1);
      }
    });
    await test("损坏 JSON、尾随垃圾、SSE、损坏图片明确拒绝", async () => {
      for (const raw of ['{"data": invalid}', `${JSON.stringify(payload)}garbage`, 'data: {"choices":[]}\n\n']) {
        respond = () => new Response(raw);
        await assert.rejects(generate, category("invalid_response"));
      }
      respond = () => Response.json({ data: [{ b64_json: "corrupt-image" }] });
      await assert.rejects(generate, category("invalid_response"));
    });
    await test("声明或实际超过 80 MiB 都拦截并取消读取", async () => {
      for (const declared of [true, false]) {
        let cancelled = false;
        let chunks = 0;
        const chunk = new Uint8Array(1024 * 1024).fill(97);
        respond = () => new Response(new ReadableStream({
          pull(controller) {
            if (declared) { controller.enqueue(bytes); controller.close(); }
            else if (chunks++ === 0) controller.enqueue(new TextEncoder().encode('{"padding":"'));
            else if (chunks <= 82) controller.enqueue(chunk);
            else controller.close();
          }, cancel() { cancelled = true; },
        }), { headers: declared ? { "content-length": String(80 * 1024 * 1024 + 1) } : {} });
        await assert.rejects(generate, category("invalid_response"));
        assert.equal(cancelled, true);
      }
    });
    await test("响应阶段计时不记录提示词、密钥或签名链接", async () => {
      for (const requestId of ["req-fixture-123", "tuzi-fixture-key", "sk-secret", resultUrl]) {
        respond = () => Response.json(payload, { headers: { "x-request-id": requestId } });
        const result = await generate();
        assert.equal(result.providerRequestId, requestId === "req-fixture-123" ? requestId : undefined);
      }
      const timing = logs.filter((row) => row[0] === "[tuzi-image-timing]").map((row) => JSON.parse(String(row[1])));
      assert.ok(timing.some((row) => row.outcome === "succeeded" && row.readMs >= 0 && row.requestMs >= 0 && row.prepareMs >= 0 && row.validateMs >= 0));
      assert.ok(timing.some((row) => row.outcome === "outcome_unknown"));
      assert.doesNotMatch(JSON.stringify(logs), /PRIVATE-|fixture-key|data:image\/|https:\/\/result/);
    });
  } finally {
    globalThis.fetch = originalFetch; console.info = originalInfo;
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
  }
  assert.deepEqual(failures, [], "Tuzi 响应回归存在失败项");
}

await testTuziImageResponses();

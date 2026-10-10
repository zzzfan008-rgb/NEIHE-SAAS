import assert from "node:assert/strict";
import { unwrapPortkeyRequest } from "./portkeyMock";
import sharp from "sharp";
import https from "node:https";
import dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { config } from "../server/config";
import { getProvider } from "../server/providers";
import { currentAiGateway, withAiGateway } from "../server/providers/gatewayContext";
import { generateTuziVideo, downloadTuziVideoUrl } from "../server/providers/tuziVideo";
import { AcceptedVideoTaskPersistenceError, SEEDANCE_25_MODEL, type ApiYiVideoRequest } from "../server/providers/apiyiVideo";
import { ApiYiImageConversationPlannerModel } from "../server/providers/imageConversationPlanner";
import { gatewayNodeUnavailableReason } from "../src/lib/aiGatewayPolicy";
import { type ImageModelId } from "../src/types/imageModels";
import { ProviderError } from "../server/providers/base";

process.env.APIYI_BASE_URL = "https://apiyi.example";
process.env.APIYI_API_KEY = "apiyi-fixture-key";
process.env.TUZI_BASE_URL = "https://tuzi.example/v1/";
process.env.TUZI_API_KEY = "tuzi-fixture-key";
const originalFetch = globalThis.fetch;
const image = await sharp({ create: { width: 400, height: 500, channels: 3, background: "#998877" } }).png().toBuffer();
const dataUrl = `data:image/png;base64,${image.toString("base64")}`;
const maskPixels = Buffer.alloc(400 * 500 * 4, 255);
for (let y = 100; y < 300; y++) for (let x = 100; x < 300; x++) maskPixels[(y * 400 + x) * 4 + 3] = 0;
const mask = await sharp(maskPixels, { raw: { width: 400, height: 500, channels: 4 } }).png().toBuffer();
const calls: Array<{ url: string; init: RequestInit }> = [];
let response: (url: string, init: RequestInit) => Response = () => Response.json({ data: [{ b64_json: image.toString("base64") }] });
globalThis.fetch = (async (input, init = {}) => {
  [input, init] = unwrapPortkeyRequest(input, init) as [typeof input, RequestInit];
  const url = String(input);
  assert.ok(url.startsWith("https://tuzi.example/") || url.startsWith("https://apiyi.example/"), `unexpected network destination: ${url}`);
  const headers = new Headers(init.headers);
  assert.equal(headers.get("authorization"), `Bearer ${url.includes("tuzi.example") ? "tuzi" : "apiyi"}-fixture-key`);
  calls.push({ url, init });
  return response(url, init);
}) as typeof fetch;

try {
  console.log("TuziAPI 协议与请求隔离回归（全部模拟）");
  await Promise.all((["apiyi", "tuzi"] as const).map((gateway) => withAiGateway(gateway, async () => {
    await Promise.resolve();
    assert.equal(currentAiGateway(), gateway);
    assert.equal(config.aiApiKey(), `${gateway}-fixture-key`);
    const result = await getProvider("gpt-image-2.5-flare").generate({ prompt: "服装设计", modelOptions: { size: "1024x1024", quality: "high" } });
    assert.equal(result.images.length, 1);
  })));
  assert.equal(currentAiGateway(), "apiyi");
  const tuziGpt = calls.find((call) => call.url.includes("tuzi.example"))!;
  assert.equal(JSON.parse(String(tuziGpt.init.body)).model, "gpt-image-2.5-flare");
  assert.equal(JSON.parse(String(tuziGpt.init.body)).quality, "high");
  assert.equal(config.tuziBaseUrl(), "https://tuzi.example");
  console.log("  ✓ 并发供应商隔离、独立密钥与 GPT 2.5 精确型号");

  await withAiGateway("tuzi", async () => {
    await getProvider("gpt-image-2.5-sunburst").edit({ prompt: "局部修改", referenceImages: [dataUrl, dataUrl], mask: `data:image/png;base64,${mask.toString("base64")}`, modelOptions: { size: "1024x1024", quality: "max" } });
    const edit = calls.at(-1)!;
    assert.equal(edit.url, "https://tuzi.example/v1/images/edits");
    const form = edit.init.body as FormData;
    assert.equal(form.get("model"), "gpt-image-2.5-sunburst");
    assert.equal(form.get("quality"), "max");
    assert.equal(form.getAll("image[]").length, 2);
    assert.match((form.getAll("image[]")[0] as File).name, /^reference-1\.(?:png|jpg)$/);
    assert.match((form.getAll("image[]")[1] as File).name, /^reference-2\.(?:png|jpg)$/);
    assert.ok(form.get("mask") instanceof Blob);
    assert.equal(new Headers(edit.init.headers).has("content-type"), false);
    const before = calls.length;
    assert.throws(() => getProvider("flux-2-pro"), /暂无该型号/);
    assert.throws(() => getProvider("grok-imagine-image"), /暂无该型号/);
    await assert.rejects(() => getProvider("gpt-image-2.5-flare").edit({ prompt: "修改", referenceImages: Array(17).fill(dataUrl) }), /参考图/);
    assert.equal(calls.length, before);
  });
  console.log("  ✓ 多图顺序、蒙版、质量档位及不支持型号在请求前拦截");

  // Tuzi 官方非流式图像接口：文生图和多参考图都使用 generations。
  response = () => Response.json({ data: [{ b64_json: image.toString("base64") }] });
  for (const id of ["gemini-3-pro-image-preview", "gemini-3.1-flash-image"] as ImageModelId[]) {
    const result = await withAiGateway("tuzi", () => getProvider(id).edit({ prompt: "修改", referenceImages: [dataUrl], modelOptions: { aspectRatio: "3:4", imageSize: "2K" } }));
    assert.equal(result.images.length, 1);
    assert.equal(calls.at(-1)!.url, "https://tuzi.example/v1/images/generations");
    const body = JSON.parse(String(calls.at(-1)!.init.body));
    assert.equal(body.model, id === "gemini-3.1-flash-image" ? `${id}-preview` : id);
    assert.equal(result.model, body.model);
    assert.equal(body.stream, undefined);
    assert.equal(body.messages, undefined);
    assert.equal(body.prompt, "修改");
    assert.equal(body.size, "3x4");
    assert.equal(body.quality, "2k");
    assert.equal(body.n, 1);
    assert.equal(body.response_format, "b64_json");
    assert.equal(body.image.length, 1);
    assert.ok(body.image[0].startsWith("data:image/jpeg;base64,"));
  }
  const secondImage = await sharp({ create: { width: 200, height: 300, channels: 3, background: "#123456" } }).png().toBuffer();
  await withAiGateway("tuzi", () => getProvider("gemini-3.1-flash-image").edit({ prompt: "按顺序参考", referenceImages: [dataUrl, `data:image/png;base64,${secondImage.toString("base64")}`], modelOptions: { aspectRatio: "16:9", imageSize: "4K" } }));
  const multiple = JSON.parse(String(calls.at(-1)!.init.body));
  assert.equal(multiple.image.length, 2);
  assert.equal((await sharp(Buffer.from(multiple.image[0].split(",")[1], "base64")).metadata()).width, 400);
  assert.equal((await sharp(Buffer.from(multiple.image[1].split(",")[1], "base64")).metadata()).width, 200);
  assert.equal(multiple.size, "16x9"); assert.equal(multiple.quality, "4k");
  await withAiGateway("tuzi", () => getProvider("gemini-3.1-flash-image").generate({ prompt: "文生图", modelOptions: { aspectRatio: "1:1", imageSize: "1K" } }));
  const generated = JSON.parse(String(calls.at(-1)!.init.body));
  assert.equal(generated.image, undefined);
  assert.equal(generated.quality, "1k");
  await withAiGateway("tuzi", async () => {
    const before = calls.length;
    for (const modelOptions of [{ aspectRatio: "1:1", imageSize: "512" }, { aspectRatio: "1:8", imageSize: "2K" }]) {
      const request = { prompt: "不应收费", modelOptions };
      await assert.rejects(() => getProvider("gemini-3.1-flash-image").validate!(request, "generate"), /TuziAPI.*不支持/);
      await assert.rejects(() => getProvider("gemini-3.1-flash-image").generate(request), /TuziAPI.*不支持/);
    }
    assert.equal(calls.length, before);
  });
  response = () => Response.json({ data: [{ url: "https://public.example/output.png" }] });
  await withAiGateway("tuzi", () => getProvider("seedream-5-0-260128").edit({ prompt: "修改", referenceImages: [dataUrl], modelOptions: { size: "2K" } }));
  assert.equal((calls.at(-1)!.init.body as FormData).get("model"), "doubao-seedream-5-0-260128");
  assert.ok((calls.at(-1)!.init.body as FormData).get("image") instanceof Blob);
  console.log("  ✓ Gemini 非流式 generations、正式型号、比例/质量、多图顺序及不支持规格请求前拦截");

  response = () => Response.json({ choices: [{ message: { content: "{}" } }] });
  await withAiGateway("tuzi", () => new ApiYiImageConversationPlannerModel().complete({ systemPrompt: "JSON", userPayload: {} } as never));
  assert.equal(calls.at(-1)!.url, "https://tuzi.example/v1/chat/completions");
  assert.equal(JSON.parse(String(calls.at(-1)!.init.body)).model, "gpt-5.6-terra");
  console.log("  ✓ 对话规划也使用所选供应商");

  const video: ApiYiVideoRequest = { mode: "text-to-video", model: SEEDANCE_25_MODEL, prompt: "镜头缓慢推进", aspectRatio: "16:9", resolution: "720p", seconds: 5, generateAudio: false, outputFormat: "mp4", references: [] };
  const mp4 = Buffer.alloc(12); mp4.write("ftyp", 4, "ascii");
  let submits = 0;
  let uploads = 0;
  let reviews = 0;
  response = (url, init) => {
    if (url.endsWith("/seedance/assets")) { uploads++; return Response.json({ success: true, data: { id: "image1", status: "pending", compliance_started: false } }); }
    if (url.endsWith("/compliance")) { reviews++; return Response.json({ success: true, data: { id: "image1", reference: "asset://image1", asset_type: "image", status: "active" } }); }
    if (url.endsWith("/v1/videos")) {
      submits++; const body = JSON.parse(String(init.body));
      assert.equal(body.resolution, "720P"); assert.equal(body.count, 1); assert.equal(body.duration, 5);
      assert.ok(["textToVideo", "imageToVideo"].includes(body.refer_model));
      if (body.refer_model === "imageToVideo") { assert.equal(body.content[1].image_url.url, "asset://image1"); assert.equal(body.ratio, "adaptive"); }
      return Response.json({ id: "video1", status: "queued" });
    }
    if (url.endsWith("/content")) return new Response(mp4);
    return Response.json({ id: "video1", status: "completed" });
  };
  let accepted = 0;
  const result = await generateTuziVideo({ ...video, onTaskAccepted: () => { accepted++; } });
  assert.equal(result.taskId, "video1"); assert.equal(result.providerRequests, 1); assert.equal(accepted, 1);
  const resumed = await generateTuziVideo({ ...video, resumeTask: { id: "video1", model: video.model } });
  assert.equal(resumed.providerRequests, 0); assert.equal(submits, 1);
  await generateTuziVideo({ ...video, mode: "first-frame-to-video", aspectRatio: "adaptive", references: [{ role: "first-frame", url: dataUrl }] });
  assert.equal(uploads, 1); assert.equal(reviews, 1);
  await assert.rejects(() => generateTuziVideo({ ...video, onTaskAccepted: () => { throw new Error("database failure"); } }), AcceptedVideoTaskPersistenceError);
  const before = calls.length;
  await assert.rejects(() => generateTuziVideo({ ...video, seconds: -1 }), /智能时长/);
  await assert.rejects(() => downloadTuziVideoUrl("https://127.0.0.1/private"), /不可访问/);
  await assert.rejects(() => downloadTuziVideoUrl("http://public.example/video.mp4"), /地址无效/);
  assert.ok(gatewayNodeUnavailableReason("tuzi", "video-generate", { mode: "video-edit" }));
  assert.equal(calls.length, before);
  const originalGet = https.get;
  const originalLookup = dns.lookup;
  let downloads = 0;
  try {
    dns.lookup = (async () => [{ address: "8.8.8.8", family: 4 }]) as typeof dns.lookup;
    https.get = ((url: URL, options: https.RequestOptions, callback: (response: unknown) => void) => {
      downloads++;
      assert.equal(new Headers(options.headers as Record<string, string>).has("authorization"), false);
      assert.equal(options.family, 4);
      options.lookup!(url.hostname, {}, (error: unknown, address: unknown, family: unknown) => {
        assert.equal(error, null); assert.equal(address, "8.8.8.8"); assert.equal(family, 4);
      });
      const request = new EventEmitter();
      queueMicrotask(() => {
        const stream = Object.assign(new PassThrough(), { statusCode: downloads === 1 ? 302 : 200, headers: downloads === 1 ? { location: "https://result.example/video.mp4" } : {} });
        callback(stream);
        stream.end(mp4);
      });
      return request;
    }) as typeof https.get;
    assert.deepEqual(await downloadTuziVideoUrl("https://download.example/task"), mp4);
    assert.equal(downloads, 2);
    dns.lookup = (async () => [{ address: "127.0.0.1", family: 4 }]) as typeof dns.lookup;
    await assert.rejects(() => downloadTuziVideoUrl("https://private.example/video"), /不可访问/);
    assert.equal(downloads, 2);
  } finally { https.get = originalGet; dns.lookup = originalLookup; }
  response = () => Response.json({ id: "video1", status: "failed", error: "secret-provider-detail" });
  await assert.rejects(() => generateTuziVideo({ ...video, resumeTask: { id: "video1", model: video.model } }), (error: unknown) => error instanceof ProviderError && !error.message.includes("secret-provider-detail"));
  console.log("  ✓ 视频协议、素材审核、受理持久化、恢复不重提、公网 DNS 固定及重定向无密钥");
} finally { globalThis.fetch = originalFetch; }

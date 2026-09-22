import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import sharp from "sharp";
import { randomBytes } from "node:crypto";
import { mock } from "node:test";
import sources from "../docs/ai/apiyi/sources.json";
import { config } from "../server/config";
import { deleteStoredImage, saveVideoUploadDataUrl } from "../server/lib/fileStore";
import { compositeMaskedEdit, validateMaskForSource } from "../server/lib/maskProcessing";
import { createRateLimitMiddleware } from "../server/lib/rateLimit";
import { apiyiProviders } from "../server/providers/apiyi";
import {
  AcceptedVideoTaskPersistenceError,
  generateApiYiVideo,
  SEEDANCE_25_MODEL,
} from "../server/providers/apiyiVideo";
import { executeStep } from "../server/engine/runner";
import { fetchWithRetry, ProviderError } from "../server/providers/base";
import { createAiDiagnosticsRouter } from "../server/routes/aiDiagnostics";
import {
  IMAGE_MODEL_IDS,
  getImageModelContract,
  imageModelOptionsError,
} from "../src/types/imageModels";

let passed = 0;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function setEnv(name: string, value: string | undefined): () => void {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  };
}

function installFetchMock(
  implementation: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = implementation as typeof fetch;
  return () => { globalThis.fetch = original; };
}

async function imageDataUrl(
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
  format: "png" | "jpeg" | "webp" = "png",
): Promise<string> {
  const pipeline = sharp({
    create: { width, height, channels: 3, background: color },
  });
  const buffer = format === "webp"
    ? await pipeline.webp().toBuffer()
    : format === "jpeg" ? await pipeline.jpeg().toBuffer() : await pipeline.png().toBuffer();
  const mime = format === "jpeg" ? "image/jpeg" : `image/${format}`;
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function halfEditableMask(width: number, height: number, compressionLevel?: number): Promise<string> {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = 255;
      pixels[offset + 1] = 255;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = x < width / 2 ? 0 : 255;
    }
  }
  const image = sharp(pixels, { raw: { width, height, channels: 4 } });
  const buffer = compressionLevel === undefined
    ? await image.png().toBuffer()
    : await image.png({ compressionLevel }).toBuffer();
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

function jsonBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function pngPayload(dataUrl: string): { data: Array<{ b64_json: string }> } {
  return { data: [{ b64_json: dataUrl.split(",")[1] }] };
}

function mp4Payload(): Buffer {
  const buffer = Buffer.alloc(12);
  buffer.writeUInt32BE(12, 0);
  buffer.write("ftyp", 4, "ascii");
  return buffer;
}

async function withoutTimerDelay<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) => {
    queueMicrotask(() => callback(...args));
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    return await run();
  } finally {
    globalThis.setTimeout = original;
  }
}

function assertPixel(
  data: Buffer,
  width: number,
  channels: number,
  x: number,
  y: number,
  expected: { r: number; g: number; b: number },
): void {
  const offset = (y * width + x) * channels;
  assert.ok(Math.abs(data[offset] - expected.r) <= 2);
  assert.ok(Math.abs(data[offset + 1] - expected.g) <= 2);
  assert.ok(Math.abs(data[offset + 2] - expected.b) <= 2);
}

async function main(): Promise<void> {
  console.log("API易 Provider 契约测试");
  const restoreBase = setEnv("APIYI_BASE_URL", "https://gateway.example");
  const restoreKey = setEnv("APIYI_API_KEY", "apiyi-test-key");
  const restoreSeedanceBase = setEnv("SEEDANCE_API_BASE_URL", "https://video-gateway.example");
  const restoreSeedanceKey = setEnv("SEEDANCE_API_KEY", "seedance-test-key");
  const restoreSeedanceAssetBase = setEnv("SEEDANCE_ASSET_API_BASE_URL", "https://asset-gateway.example");
  const restoreSeedanceAssetKey = setEnv("SEEDANCE_ASSET_API_KEY", "seedance-asset-test-key");
  const white = await imageDataUrl(4, 2, { r: 255, g: 255, b: 255 });
  const blue = await imageDataUrl(4, 2, { r: 20, g: 80, b: 220 });
  const red = await imageDataUrl(4, 2, { r: 220, g: 30, b: 30 });
  const videoWhite = await imageDataUrl(512, 512, { r: 255, g: 255, b: 255 });
  const videoBlue = await imageDataUrl(512, 512, { r: 20, g: 80, b: 220 });
  const videoRed = await imageDataUrl(512, 512, { r: 220, g: 30, b: 30 });
  const mask = await halfEditableMask(4, 2);

  try {
    await test("视频首尾帧在付费调用前拒绝缺失或多余参考图", async () => {
      let calls = 0;
      const restoreFetch = installFetchMock(() => {
        calls += 1;
        return Response.json({ task_id: "must-not-submit" });
      });
      try {
        for (const references of [
          [{ role: "first-frame", url: videoWhite }],
          [
            { role: "first-frame", url: videoWhite },
            { role: "last-frame", url: videoBlue },
            { role: "reference-image", url: videoRed },
          ],
        ] as const) {
            await assert.rejects(
              () => generateApiYiVideo({
                mode: "keyframes-to-video",
                model: SEEDANCE_25_MODEL,
                prompt: "服装动态展示",
                aspectRatio: "adaptive",
                resolution: "720p",
                seconds: 5,
                generateAudio: true,
                outputFormat: "mp4",
                references: [...references],
              }),
              (error: unknown) => error instanceof ProviderError &&
                error.status === 400 && error.category === "invalid_request" &&
                /首帧和尾帧/.test(error.message),
            );
        }
        assert.equal(calls, 0);
      } finally {
        restoreFetch();
      }
    });

    await test("视频首尾帧按角色排序，不受边插入顺序影响", async () => {
      let submittedBody: Record<string, unknown> | undefined;
      const restoreFetch = installFetchMock((input, init) => {
        const url = String(input);
        if (init?.method === "POST") {
          assert.equal(url, "https://video-gateway.example/seedance/api/v3/contents/generations/tasks");
          const headers = new Headers(init.headers);
          assert.equal(headers.get("authorization"), "Bearer seedance-test-key");
          assert.equal(headers.get("accept-encoding"), "identity");
          submittedBody = jsonBody(init);
          return Response.json({ id: "role-ordered-task" });
        }
        if (url === "https://cdn.example/role-ordered.mp4") {
          assert.equal(new Headers(init?.headers).has("authorization"), false);
          return new Response(mp4Payload());
        }
        return Response.json({ status: "succeeded", content: { video_url: "https://cdn.example/role-ordered.mp4" } });
      });
      try {
        await withoutTimerDelay(() => executeStep({
          nodeId: "video-role-order",
          kind: "video-generate",
          inputImages: [],
          params: {
            mode: "keyframes-to-video",
            videoModel: SEEDANCE_25_MODEL,
            prompt: "服装从静止到转身",
            aspectRatio: "adaptive",
            resolution: "720p",
            seconds: 5,
            generateAudio: false,
            outputFormat: "mp4",
          },
        }, [videoBlue, videoWhite], undefined, {
          referenceRoles: ["last-frame", "first-frame"],
        }));
        assert.equal(submittedBody?.model, SEEDANCE_25_MODEL);
        assert.equal(submittedBody?.ratio, "adaptive");
        assert.equal(submittedBody?.duration, 5);
        assert.equal(submittedBody?.generate_audio, false);
        assert.equal(submittedBody?.watermark, false);
        assert.equal(submittedBody?.output_format, "mp4");
        const content = submittedBody?.content as Array<Record<string, unknown>>;
        assert.deepEqual(content.map((item) => item.role ?? item.type), ["text", "first_frame", "last_frame"]);
        assert.deepEqual((content[1].image_url as { url: string }).url, videoWhite);
        assert.deepEqual((content[2].image_url as { url: string }).url, videoBlue);
      } finally {
        restoreFetch();
      }
    });

    await test("换装候选混合失败时保留 outcome_unknown 且不触发安全回退", async () => {
      let calls = 0;
      const provider = {
        id: "try-on-mixed-failure",
        async generate() { throw new Error("不应走文生图"); },
        async edit() {
          calls += 1;
          if (calls === 1) {
            throw new ProviderError("审核拒绝", 400, "try-on-mixed-failure", "content_refused");
          }
          throw new ProviderError("结果状态未知", 504, "try-on-mixed-failure", "outcome_unknown");
        },
      };
      await assert.rejects(
        () => executeStep({
          nodeId: "try-on-mixed-failure",
          kind: "virtual-try-on",
          params: {
            workflowStage: "garment-refine",
            modelId: "gpt-image-2",
            imageSize: "2K",
            prompt: "保持穿搭",
            approvedBaselineRef: videoWhite,
            garmentCategory: "woven",
            materialSpec: "棉质",
            constructionSpec: "梭织",
            promptEnhancement: false,
            qualityMode: "balanced",
            safetyFallback: true,
            stylePresetId: "faithful",
          },
        }, [videoWhite, videoWhite], () => provider, {
          referenceRoles: ["baseline", "outfit"],
        }),
        (error: unknown) => error instanceof ProviderError && error.category === "outcome_unknown",
      );
      assert.equal(calls, 2, "状态未知后不得发起第二批安全回退请求");
    });

    await test("换装候选部分成功时保留结果且不因未知候选重试整批", async () => {
      let calls = 0;
      const provider = {
        id: "try-on-partial-unknown",
        async generate() { throw new Error("不应走文生图"); },
        async edit() {
          calls += 1;
          if (calls === 1) return { images: [videoWhite], model: "try-on-partial-unknown" };
          throw new ProviderError("结果状态未知", 504, "try-on-partial-unknown", "outcome_unknown");
        },
      };
      const result = await executeStep({
        nodeId: "try-on-partial-unknown",
        kind: "virtual-try-on",
        params: {
          workflowStage: "garment-refine",
          modelId: "gpt-image-2",
          imageSize: "2K",
          prompt: "保持穿搭",
          approvedBaselineRef: videoWhite,
          garmentCategory: "woven",
          materialSpec: "棉质",
          constructionSpec: "梭织",
          promptEnhancement: false,
          qualityMode: "balanced",
          safetyFallback: true,
          stylePresetId: "faithful",
        },
      }, [videoWhite, videoWhite], () => provider, {
        referenceRoles: ["baseline", "outfit"],
      });
      assert.deepEqual(result.images, [videoWhite]);
      assert.equal(calls, 2, "已有成功候选时不得重试整批或触发安全回退");
      assert.equal(result.failures?.length, 1);
    });

    await test("Seedance 2.5 多模态按图片、视频、音频角色提交并保留用量", async () => {
      let submittedBody: Record<string, unknown> | undefined;
      const restoreFetch = installFetchMock((input, init) => {
        if (init?.method === "POST") {
          submittedBody = jsonBody(init);
          return Response.json({ id: "reference-task" });
        }
        if (String(input) === "https://cdn.example/reference.mp4") return new Response(mp4Payload());
        return Response.json({
          status: "succeeded",
          content: { video_url: "https://cdn.example/reference.mp4" },
          usage: { completion_tokens: 38_830, total_tokens: 38_830 },
          duration: 4,
          resolution: "480p",
          ratio: "16:9",
          seed: 17,
        });
      });
      try {
        const result = await withoutTimerDelay(() => generateApiYiVideo({
          mode: "multimodal-reference",
          model: SEEDANCE_25_MODEL,
          prompt: "保持服装身份并生成自然转身",
          aspectRatio: "3:4",
          resolution: "1080p",
          seconds: 12,
          generateAudio: true,
          outputFormat: "mov",
          references: [
            { role: "reference-image", url: "asset://image-reference" },
            { role: "reference-video", url: "https://media.example/reference.mp4" },
            { role: "reference-audio", url: "asset://audio-reference" },
          ],
        }));
        const content = submittedBody?.content as Array<Record<string, unknown>>;
        assert.deepEqual(content.map((item) => item.role ?? item.type), ["text", "reference_image", "reference_video", "reference_audio"]);
        assert.equal(submittedBody?.resolution, "1080p");
        assert.equal(submittedBody?.ratio, "3:4");
        assert.equal(submittedBody?.duration, 12);
        assert.equal(submittedBody?.output_format, "mov");
        assert.equal(result.usage.completionTokens, 38_830);
        assert.equal(result.usage.seed, 17);
      } finally {
        restoreFetch();
      }
    });

    await test("Seedance 模型矩阵和视频编辑硬约束在提交前生效", async () => {
      let calls = 0;
      const restoreFetch = installFetchMock((input, init) => {
        calls += 1;
        if (init?.method === "POST") {
          const body = jsonBody(init);
          assert.equal(body.omni_reference_task_type, "edit");
          assert.equal(body.duration, -1);
          assert.equal(body.ratio, "adaptive");
          return Response.json({ id: "edit-task" });
        }
        if (String(input) === "https://cdn.example/edit.mp4") return new Response(mp4Payload());
        return Response.json({ status: "succeeded", content: { video_url: "https://cdn.example/edit.mp4" } });
      });
      try {
        await assert.rejects(() => generateApiYiVideo({
          mode: "text-to-video",
          model: "doubao-seedance-2-0-mini-260615",
          prompt: "越界时长",
          aspectRatio: "16:9",
          resolution: "1080p",
          seconds: 4,
          generateAudio: false,
          outputFormat: "mp4",
          references: [],
        }), /不支持 1080p/);
        assert.equal(calls, 0);

        await withoutTimerDelay(() => generateApiYiVideo({
          mode: "video-edit",
          model: SEEDANCE_25_MODEL,
          prompt: "修改 @视频1 中的天空颜色，同时保持主体动作不变",
          aspectRatio: "adaptive",
          resolution: "480p",
          seconds: -1,
          generateAudio: true,
          outputFormat: "mp4",
          references: [{ role: "source-video", url: "https://media.example/source.mp4" }],
        }));
        assert.equal(calls, 3);
      } finally {
        restoreFetch();
      }
    });

    await test("已受理视频任务恢复时只轮询和下载，不重复 POST", async () => {
      const methods: string[] = [];
      let beforeCalls = 0;
      let acceptedCalls = 0;
      const restoreFetch = installFetchMock((input, init) => {
        methods.push(init?.method ?? "GET");
        if (String(input) === "https://cdn.example/resumed.mp4") {
          assert.equal(new Headers(init?.headers).has("authorization"), false);
          return new Response(mp4Payload());
        }
        return Response.json({ status: "succeeded", content: { video_url: "https://cdn.example/resumed.mp4" } });
      });
      try {
        const result = await withoutTimerDelay(() => generateApiYiVideo({
          mode: "text-to-video",
          model: SEEDANCE_25_MODEL,
          prompt: "服装走秀",
          aspectRatio: "16:9",
          resolution: "720p",
          seconds: 5,
          generateAudio: true,
          outputFormat: "mp4",
          references: [],
          resumeTask: { id: "accepted-video-task", model: SEEDANCE_25_MODEL },
          beforeProviderCall: () => { beforeCalls += 1; },
          onTaskAccepted: () => { acceptedCalls += 1; },
        }));
        assert.deepEqual(methods, ["GET", "GET"]);
        assert.equal(beforeCalls, 0);
        assert.equal(acceptedCalls, 0);
        assert.equal(result.providerRequests, 0);
      } finally {
        restoreFetch();
      }
    });

    await test("已受理旧 VEO 任务升级后只继续轮询和下载", async () => {
      const requests: Array<{ url: string; method: string }> = [];
      const restoreFetch = installFetchMock((input, init) => {
        const url = String(input);
        requests.push({ url, method: init?.method ?? "GET" });
        if (url.endsWith("/content")) return new Response(mp4Payload());
        return Response.json({ status: "completed" });
      });
      try {
        const result = await withoutTimerDelay(() => executeStep({
          nodeId: "legacy-veo-node",
          kind: "video-generate",
          params: {
            mode: "text-to-video",
            videoModel: "veo-3.1",
            prompt: "旧任务",
            aspectRatio: "16:9",
            resolution: "720p",
            seconds: 8,
          },
        }, [], undefined, {
          videoTask: { id: "legacy-veo-task", model: "veo-3.1-fast-generate-preview" },
        }));
        assert.deepEqual(requests, [
          { url: "https://gateway.example/v1/videos/legacy-veo-task", method: "GET" },
          { url: "https://gateway.example/v1/videos/legacy-veo-task/content", method: "GET" },
        ]);
        assert.equal(result.model, "veo-3.1-fast-generate-preview");
        assert.equal(result.providerRequests, 0);
      } finally {
        restoreFetch();
      }
    });

    await test("本地视频经独立素材服务转存后可用于 Seedance 编辑", async () => {
      const local = saveVideoUploadDataUrl(`data:video/mp4;base64,${mp4Payload().toString("base64")}`);
      let seedanceBody: Record<string, unknown> | undefined;
      const restoreFetch = installFetchMock((input, init) => {
        const url = String(input);
        if (url === "https://asset-gateway.example/storage/presign") {
          const headers = new Headers(init?.headers);
          assert.equal(headers.get("authorization"), "Bearer seedance-asset-test-key");
          assert.deepEqual(jsonBody(init), { ext: "mp4", contentType: "video/mp4" });
          return Response.json({ code: 0, data: {
            uploadUrl: "https://upload.example/local-video",
            publicUrl: "https://cdn.example/local-video.mp4",
          } });
        }
        if (url === "https://upload.example/local-video") {
          const headers = new Headers(init?.headers);
          assert.equal(init?.method, "PUT");
          assert.equal(headers.has("authorization"), false);
          assert.equal(headers.get("content-type"), "video/mp4");
          return new Response(null, { status: 200 });
        }
        if (url === "https://video-gateway.example/seedance/api/v3/contents/generations/tasks" && init?.method === "POST") {
          seedanceBody = jsonBody(init);
          return Response.json({ id: "local-video-edit-task" });
        }
        if (url === "https://cdn.example/local-video-edit-result.mp4") return new Response(mp4Payload());
        return Response.json({ status: "succeeded", content: { video_url: "https://cdn.example/local-video-edit-result.mp4" } });
      });
      try {
        await withoutTimerDelay(() => generateApiYiVideo({
          mode: "video-edit",
          model: SEEDANCE_25_MODEL,
          prompt: "修改 @视频1 的服装颜色",
          aspectRatio: "adaptive",
          resolution: "720p",
          seconds: -1,
          generateAudio: true,
          outputFormat: "mp4",
          references: [{ role: "source-video", url: local.url }],
        }));
        const content = seedanceBody?.content as Array<Record<string, unknown>>;
        assert.equal((content[1].video_url as { url: string }).url, "https://cdn.example/local-video.mp4");
      } finally {
        restoreFetch();
        deleteStoredImage(local.id);
      }
    });

    await test("视频任务受理状态保存失败时返回不可重放的专用错误", async () => {
      let calls = 0;
      const restoreFetch = installFetchMock((_input, init) => {
        calls += 1;
        assert.equal(init?.method, "POST");
        return Response.json({ id: "accepted-but-untracked" });
      });
      try {
        await assert.rejects(
          () => generateApiYiVideo({
            mode: "text-to-video",
            model: SEEDANCE_25_MODEL,
            prompt: "服装走秀",
            aspectRatio: "16:9",
            resolution: "720p",
            seconds: 5,
            generateAudio: true,
            outputFormat: "mp4",
            references: [],
            onTaskAccepted: () => { throw new Error("database unavailable"); },
          }),
          (error: unknown) => error instanceof AcceptedVideoTaskPersistenceError &&
            /结果状态未知/.test(error.message) && /database unavailable/.test(error.message),
        );
        assert.equal(calls, 1);
      } finally {
        restoreFetch();
      }
    });

    await test("本地知识库与 Provider 注册表严格覆盖全部模型", () => {
      assert.deepEqual(Object.keys(apiyiProviders).sort(), [...IMAGE_MODEL_IDS].sort());
      for (const modelId of IMAGE_MODEL_IDS) {
        assert.equal(apiyiProviders[modelId].id, modelId);
        assert.equal(getImageModelContract(modelId).id, modelId);
        assert.ok(getImageModelContract(modelId).upstreamModelId);
      }
      assert.equal(getImageModelContract("gpt-image-2").generation, null);
    });

    await test("API易来源清单指向存在的本地整理契约", () => {
      assert.equal(sources.sourceFormat, "official-markdown");
      assert.equal(sources.localKnowledgeBase.rawSourcePagesStored, false);
      for (const document of sources.localKnowledgeBase.documents) {
        assert.ok(fs.statSync(path.join(REPO_ROOT, "docs/ai/apiyi", document)).isFile(), document);
      }
      for (const source of sources.sources) {
        assert.ok(source.markdownUrl.endsWith(".md"), source.markdownUrl);
        assert.match(source.sha256, /^[a-f0-9]{64}$/);
        assert.ok(fs.statSync(path.join(REPO_ROOT, "docs/ai/apiyi", source.localDocument)).isFile());
      }
    });

    await test("API易配置要求非空 Key 与 HTTPS Base URL", () => {
      const restoreMissingKey = setEnv("APIYI_API_KEY", undefined);
      try {
        assert.throws(() => config.apiyiApiKey(), /APIYI_API_KEY/);
        assert.equal(config.aiConfigReady(), false);
      } finally {
        restoreMissingKey();
      }
      const restoreHttp = setEnv("APIYI_BASE_URL", "http://gateway.example");
      try {
        assert.equal(config.aiConfigReady(), false);
      } finally {
        restoreHttp();
      }
      assert.equal(config.aiConfigReady(), true);
    });

    await test("Seedance 视频配置与图片 API 凭据完全隔离", () => {
      assert.equal(config.seedanceApiBaseUrl(), "https://video-gateway.example");
      assert.equal(config.seedanceApiKey(), "seedance-test-key");
      const restoreMissingVideoKey = setEnv("SEEDANCE_API_KEY", undefined);
      try {
        assert.throws(() => config.seedanceApiKey(), /SEEDANCE_API_KEY/);
        assert.equal(config.apiyiApiKey(), "apiyi-test-key");
      } finally {
        restoreMissingVideoKey();
      }
      assert.equal(config.seedanceAssetApiBaseUrl(), "https://asset-gateway.example");
      assert.equal(config.seedanceAssetApiKey(), "seedance-asset-test-key");
    });

    await test("公共请求出口拒绝非 HTTPS 且不会发送 Bearer 请求", async () => {
      let calls = 0;
      const restoreFetch = installFetchMock(() => {
        calls += 1;
        return Response.json({ data: [] });
      });
      try {
        await assert.rejects(
          () => fetchWithRetry("http://gateway.example/v1/images/generations", () => ({
            headers: { Authorization: "Bearer secret" },
          })),
          (error: unknown) => error instanceof ProviderError && error.category === "invalid_request",
        );
        assert.equal(calls, 0);
      } finally {
        restoreFetch();
      }
    });

    await test("gpt-image-2-vip 文生图与多参考图编辑使用文档字段", async () => {
      const captures: Array<{ url: string; init?: RequestInit }> = [];
      const restoreFetch = installFetchMock((input, init) => {
        captures.push({ url: String(input), init });
        return Response.json(pngPayload(white));
      });
      try {
        const generated = await apiyiProviders["gpt-image-2-vip"].generate({
          prompt: "礼服",
          modelOptions: { size: "1280x1280" },
        });
        assert.deepEqual(generated.images, [white]);
        assert.equal(captures[0].url, "https://gateway.example/v1/images/generations");
        assert.equal(new Headers(captures[0].init?.headers).get("authorization"), "Bearer apiyi-test-key");
        assert.deepEqual(jsonBody(captures[0].init), {
          model: "gpt-image-2-vip",
          prompt: "礼服",
          size: "1280x1280",
        });

        await apiyiProviders["gpt-image-2-vip"].edit({
          prompt: "融合参考图",
          referenceImages: [white, blue],
          modelOptions: { size: "2048x2048" },
        });
        const form = captures[1].init?.body as FormData;
        assert.equal(captures[1].url, "https://gateway.example/v1/images/edits");
        assert.equal(form.get("model"), "gpt-image-2-vip");
        assert.equal(form.get("size"), "2048x2048");
        assert.equal(form.get("response_format"), null);
        assert.equal(form.getAll("image").length, 2);
        assert.equal(form.getAll("image[]").length, 0);
        assert.equal(form.get("quality"), null);
        assert.equal(form.get("n"), null);
        assert.equal(form.get("aspect_ratio"), null);
      } finally {
        restoreFetch();
      }
    });

    await test("gpt-image-2 只接受有效 PNG Alpha 蒙版并发送精确合法尺寸", async () => {
      let calls = 0;
      const capturedForms: FormData[] = [];
      const restoreFetch = installFetchMock((_input, init) => {
        calls += 1;
        capturedForms.push(init?.body as FormData);
        return Response.json(pngPayload(red));
      });
      try {
        await assert.rejects(
          () => apiyiProviders["gpt-image-2"].generate({ prompt: "禁止文生图" }),
          /只能由局部修改节点调用|仅用于带 PNG 蒙版的局部修改|不支持文生图/,
        );
        assert.equal(calls, 0);

        const jpegMask = await imageDataUrl(4, 2, { r: 0, g: 0, b: 0 }, "jpeg");
        await assert.rejects(
          () => apiyiProviders["gpt-image-2"].edit({
            prompt: "局部改红", referenceImages: [blue], mask: jpegMask, modelOptions: {},
          }),
          /蒙版必须是 PNG/,
        );
        assert.equal(calls, 0);

        const opaqueMask = await imageDataUrl(4, 2, { r: 0, g: 0, b: 0 });
        await assert.rejects(
          () => apiyiProviders["gpt-image-2"].edit({
            prompt: "局部改红", referenceImages: [blue], mask: opaqueMask, modelOptions: {},
          }),
          /Alpha 通道/,
        );
        assert.equal(calls, 0);

        const wrongSizeMask = await halfEditableMask(2, 2);
        await assert.rejects(
          () => apiyiProviders["gpt-image-2"].edit({
            prompt: "局部改红", referenceImages: [blue], mask: wrongSizeMask, modelOptions: {},
          }),
          /蒙版尺寸必须与原图完全一致/,
        );
        assert.equal(calls, 0);

        const oversizedMask = await halfEditableMask(1024, 1024, 0);
        const maskContract = getImageModelContract("gpt-image-2").edit.mask;
        assert.ok(maskContract);
        assert.ok(
          Buffer.from(oversizedMask.split(",")[1], "base64").length > maskContract.maxBytes,
          "fixture 必须超过蒙版字节上限",
        );
        await assert.rejects(
          () => apiyiProviders["gpt-image-2"].edit({
            prompt: "局部改红", referenceImages: [blue], mask: oversizedMask, modelOptions: {},
          }),
          /image too large/,
        );
        assert.equal(calls, 0);

        await apiyiProviders["gpt-image-2"].edit({
          prompt: "局部改红", referenceImages: [blue], mask,
          modelOptions: { size: "1152x576" },
        });
        assert.equal(calls, 1);
        assert.equal(capturedForms[0].get("model"), "gpt-image-2");
        assert.equal(capturedForms[0].get("n"), null);
        assert.equal(capturedForms[0].get("size"), "1152x576");
        assert.equal(capturedForms[0].get("output_format"), "png");
        assert.equal(
          capturedForms[0].get("background"),
          "opaque",
          "统一局部修改必须请求完整不透明画面",
        );
        assert.equal(capturedForms[0].get("response_format"), null);
        assert.equal(capturedForms[0].get("input_fidelity"), null);
        assert.ok(capturedForms[0].get("image[]") instanceof Blob);
        assert.equal(capturedForms[0].get("image"), null);
        assert.ok(capturedForms[0].get("mask") instanceof Blob);
      } finally {
        restoreFetch();
      }
    });

    await test("虚拟换装可用 GPT Image 2 中等质量无蒙版编辑并保留 14 张参考图顺序", async () => {
      let capturedUrl = "";
      let capturedForm: FormData | undefined;
      const restoreFetch = installFetchMock((input, init) => {
        capturedUrl = String(input);
        capturedForm = init?.body as FormData;
        return Response.json(pngPayload(white));
      });
      try {
        const references = Array.from({ length: 14 }, (_, index) => index % 2 === 0 ? white : blue);
        const result = await apiyiProviders["gpt-image-2"].edit({
          prompt: "将参考服装穿到图1模特身上",
          referenceImages: references,
          modelOptions: { size: "2048x1152", quality: "medium" },
        });
        assert.deepEqual(result.images, [white]);
        assert.equal(capturedUrl, "https://gateway.example/v1/images/edits");
        assert.equal(capturedForm?.get("model"), "gpt-image-2");
        assert.equal(capturedForm?.get("size"), "2048x1152");
        assert.equal(capturedForm?.get("quality"), "medium");
        assert.equal(capturedForm?.getAll("image[]").length, 14);
        assert.equal(capturedForm?.get("mask"), null);
      } finally {
        restoreFetch();
      }
    });

    await test("蒙版外像素由服务端合成硬保护", async () => {
      await validateMaskForSource(blue, mask);
      const output = await compositeMaskedEdit(blue, mask, red);
      const decoded = await sharp(Buffer.from(output.split(",")[1], "base64"))
        .raw()
        .toBuffer({ resolveWithObject: true });
      assertPixel(decoded.data, decoded.info.width, decoded.info.channels, 0, 0, { r: 220, g: 30, b: 30 });
      assertPixel(decoded.data, decoded.info.width, decoded.info.channels, 3, 0, { r: 20, g: 80, b: 220 });
    });

    await test("Gemini 文生图与 WebP 参考图编辑使用 parts 契约并扫描所有图片 part", async () => {
      const captures: Array<{ url: string; init: RequestInit }> = [];
      const restoreFetch = installFetchMock((input, init) => {
        captures.push({ url: String(input), init: init ?? {} });
        return Response.json({
          candidates: [{
            finishReason: "STOP",
            content: { parts: [{ text: "done" }, { inlineData: { mimeType: "image/png", data: white.split(",")[1] } }] },
          }],
        });
      });
      try {
        const options = { aspectRatio: "3:4", imageSize: "1K" };
        const generated = await apiyiProviders["gemini-3.1-flash-image"].generate({
          prompt: "时装大片", modelOptions: options,
        });
        assert.deepEqual(generated.images, [white]);
        assert.equal(
          captures[0].url,
          "https://gateway.example/v1beta/models/gemini-3.1-flash-image:generateContent",
        );
        const generateBody = jsonBody(captures[0].init);
        assert.deepEqual(generateBody, {
          contents: [{ parts: [{ text: "时装大片" }] }],
          generationConfig: { responseModalities: ["IMAGE"], imageConfig: options },
        });

        const webp = await imageDataUrl(4, 2, { r: 90, g: 120, b: 150 }, "webp");
        await apiyiProviders["gemini-3.1-flash-image"].edit({
          prompt: "改图", referenceImages: [webp], modelOptions: options,
        });
        assert.equal(captures[1].url, captures[0].url);
        const editBody = jsonBody(captures[1].init) as { contents: Array<{ parts: Array<Record<string, unknown>> }> };
        const parts = editBody.contents[0].parts;
        assert.deepEqual(parts[0], { text: "改图" });
        assert.equal((parts[1].inlineData as { mimeType: string }).mimeType, "image/png");
      } finally {
        restoreFetch();
      }
    });

    await test("Gemini 不将零输出推断为安全拦截，保留明确审核原因和最后一张终稿", async () => {
      const responses: unknown[] = [
        {
          candidates: null,
          usageMetadata: { promptTokenCount: 271, candidatesTokenCount: 0, totalTokenCount: 271 },
        },
        {
          candidates: [{ finishReason: "IMAGE_SAFETY", content: { parts: [] } }],
          usageMetadata: { candidatesTokenCount: 17 },
        },
        {
          candidates: [{
            finishReason: "STOP",
            content: { parts: [{ text: "无法生成该换装请求，请调整人物参考图后重试。" }] },
          }],
          usageMetadata: { candidatesTokenCount: 23 },
        },
        {
          candidates: [{
            finishReason: "STOP",
            content: { parts: [
              { inlineData: { mimeType: "image/png", data: white.split(",")[1] } },
              { text: "final" },
              { inlineData: { mimeType: "image/png", data: blue.split(",")[1] } },
            ] },
          }],
          usageMetadata: { candidatesTokenCount: 1_120 },
        },
      ];
      let call = 0;
      const restoreFetch = installFetchMock(() => Response.json(responses[call++]));
      const invoke = () => apiyiProviders["gemini-3.1-flash-image"].edit({
        prompt: "虚拟换装",
        referenceImages: [white],
        modelOptions: { aspectRatio: "3:4", imageSize: "2K" },
      });
      try {
        await assert.rejects(
          invoke,
          (error: unknown) => error instanceof ProviderError &&
            error.category === "invalid_response" &&
            !error.message.includes("安全审核") &&
            error.diagnostic?.includes('"candidatesTokenCount":0') === true,
        );
        await assert.rejects(
          invoke,
          (error: unknown) => error instanceof ProviderError && error.category === "image_safety",
        );
        await assert.rejects(
          invoke,
          (error: unknown) => error instanceof ProviderError &&
            error.category === "content_refused" &&
            error.message.includes("无法生成该换装请求"),
        );
        assert.deepEqual((await invoke()).images, [blue]);
        assert.equal(call, 4);
      } finally {
        restoreFetch();
      }
    });

    await test("Gemini promptFeedback 原因优先于零 token，OTHER 不误报 SAFETY", async () => {
      for (const [reason, expected] of [
        ["SAFETY", /安全审核.*SAFETY/],
        ["BLOCKLIST", /屏蔽词.*BLOCKLIST/],
        ["OTHER", /OTHER.*未说明具体原因/],
        ["PROHIBITED_CONTENT", /禁止内容.*PROHIBITED_CONTENT/],
        ["UNRECOGNIZED", /未说明具体原因/],
        ["constructor", /未说明具体原因/],
      ] as const) {
        let calls = 0;
        const restoreFetch = installFetchMock(() => {
          calls++;
          return Response.json({ promptFeedback: { blockReason: reason }, usageMetadata: { candidatesTokenCount: 0 } });
        });
        try {
          await assert.rejects(() => apiyiProviders["gemini-3-pro-image-preview"].edit({
            prompt: "服装展示", referenceImages: [white], modelOptions: { aspectRatio: "3:4", imageSize: "2K" },
          }), (error: unknown) => error instanceof ProviderError && expected.test(error.message));
          assert.equal(calls, 1, "明确拦截不自动重发");
        } finally { restoreFetch(); }
      }
      const restoreFetch = installFetchMock(() => Response.json({
        candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "image/png", data: white.split(",")[1] } }] } }],
        usageMetadata: { candidatesTokenCount: 0 },
      }));
      try {
        const result = await apiyiProviders["gemini-3-pro-image-preview"].edit({ prompt: "服装展示", referenceImages: [white], modelOptions: { aspectRatio: "3:4", imageSize: "2K" } });
        assert.deepEqual(result.images, [white], "token 统计异常不能覆盖实际有效图片");
      } finally { restoreFetch(); }
    });

    await test("Gemini 在 chunked JSON 已完整但连接未收尾时主动回收结果", async () => {
      const restoreGrace = setEnv("AI_IMAGE_TAIL_GRACE_MS", "10");
      const payload = JSON.stringify({
        padding: "x".repeat(2_048),
        candidates: [{
          finishReason: "STOP",
          content: { parts: [{ inlineData: { mimeType: "image/png", data: blue.split(",")[1] } }] },
        }],
        usageMetadata: { candidatesTokenCount: 1_120 },
      });
      const restoreFetch = installFetchMock(() => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          setTimeout(() => controller.error(new Error("missing chunk terminator")), 100);
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked", "x-request-id": "req-tail-test" },
      }));
      try {
        const started = Date.now();
        const result = await apiyiProviders["gemini-3.1-flash-image"].edit({
          prompt: "虚拟换装",
          referenceImages: [white],
          modelOptions: { aspectRatio: "3:4", imageSize: "2K" },
        });
        assert.deepEqual(result.images, [blue]);
        assert.ok(Date.now() - started < 90, "完整 JSON 应在尾部连接报错前主动收尾");
      } finally {
        restoreFetch();
        restoreGrace();
      }
    });

    await test("Gemini 正式模型换装使用 14 个有序 inlineData part", async () => {
      let capturedUrl = "";
      let capturedBody: Record<string, unknown> | undefined;
      const restoreFetch = installFetchMock((input, init) => {
        capturedUrl = String(input);
        capturedBody = jsonBody(init);
        return Response.json({
          candidates: [{
            finishReason: "STOP",
            content: { parts: [{ inlineData: { mimeType: "image/png", data: white.split(",")[1] } }] },
          }],
        });
      });
      try {
        const references = Array.from({ length: 14 }, (_, index) => index % 2 === 0 ? white : blue);
        await apiyiProviders["gemini-3.1-flash-image"].edit({
          prompt: "虚拟换装",
          referenceImages: references,
          modelOptions: { aspectRatio: "16:9", imageSize: "4K" },
        });
        assert.equal(
          capturedUrl,
          "https://gateway.example/v1beta/models/gemini-3.1-flash-image:generateContent",
        );
        const contents = capturedBody?.contents as Array<{ parts: Array<Record<string, unknown>> }>;
        assert.equal(contents[0].parts.length, 15);
        assert.deepEqual(contents[0].parts[0], { text: "虚拟换装" });
        assert.equal(contents[0].parts.slice(1).every((part) => Boolean(part.inlineData)), true);
        assert.deepEqual(capturedBody?.generationConfig, {
          responseModalities: ["IMAGE"],
          imageConfig: { aspectRatio: "16:9", imageSize: "4K" },
        });
      } finally {
        restoreFetch();
      }
    });

    await test("Gemini 压缩保持格式、比例和顺序，并将多图合计控制在 6MB", async () => {
      const noisy = randomBytes(2500 * 1200 * 3);
      const png = await sharp(noisy, { raw: { width: 2500, height: 1200, channels: 3 } }).png().toBuffer();
      const jpeg = await sharp(noisy, { raw: { width: 2500, height: 1200, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
      assert.ok(png.length > 1.5 * 1024 * 1024);
      assert.ok(jpeg.length > 1.5 * 1024 * 1024);
      let sent: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }> = [];
      const restore = installFetchMock((_input, init) => {
        sent = (jsonBody(init).contents as Array<{ parts: typeof sent }>)[0].parts;
        return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [
          { text: "thinking" }, { inlineData: { mimeType: "image/png", data: white.split(",")[1] } },
        ] } }] });
      });
      try {
        const references = [white, ...Array.from({ length: 6 }, (_, i) => i % 2 === 0
          ? `data:image/png;base64,${png.toString("base64")}` : `data:image/jpeg;base64,${jpeg.toString("base64")}`)];
        await apiyiProviders["gemini-3.1-flash-image"].edit({
          prompt: "preserve garment details", referenceImages: references,
          modelOptions: { aspectRatio: "1:1", imageSize: "1K" },
        });
        assert.deepEqual(sent[0], { text: "preserve garment details" });
        assert.equal(sent[1].inlineData?.data, white.split(",")[1], "小图保持原始字节");
        let total = 0;
        for (const [index, part] of sent.slice(1).entries()) {
          assert.equal(part.text, undefined);
          const inline = part.inlineData!;
          const buffer = Buffer.from(inline.data, "base64");
          total += buffer.length;
          const info = await sharp(buffer).metadata();
          assert.ok(Math.max(info.width!, info.height!) <= 2048);
          if (index > 0) {
            assert.equal(inline.mimeType, index % 2 === 1 ? "image/png" : "image/jpeg");
            assert.ok(Math.abs(info.width! / info.height! - 2500 / 1200) < 0.02);
          }
        }
        assert.ok(total <= 6 * 1024 * 1024);

        const failure = mock.method(sharp.prototype, "resize", () => { throw new Error("test compression failure"); });
        try {
          const fallback = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
          await apiyiProviders["gemini-3.1-flash-image"].edit({
            prompt: "fallback", referenceImages: [fallback], modelOptions: { aspectRatio: "1:1", imageSize: "1K" },
          });
          assert.equal(sent[1].inlineData?.data, jpeg.toString("base64"));
          await assert.rejects(() => apiyiProviders["gemini-3.1-flash-image"].edit({
            prompt: "oversized fallback", referenceImages: Array(4).fill(fallback),
            modelOptions: { aspectRatio: "1:1", imageSize: "1K" },
          }), (error: unknown) => error instanceof ProviderError && error.category === "invalid_request");
        } finally { failure.mock.restore(); }
      } finally { restore(); }
    });

    await test("Gemini 总时限和 undici 响应时限至少 360 秒，其他模型保持各自时限", async () => {
      const captures: Array<RequestInit & { dispatcher?: unknown }> = [];
      const timeouts: number[] = [];
      const timer = mock.method(AbortSignal, "timeout", (ms: number) => {
        timeouts.push(ms);
        return new AbortController().signal;
      });
      const restore = installFetchMock((_input, init) => {
        captures.push(init!);
        return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [
          { inlineData: { mimeType: "image/png", data: white.split(",")[1] } },
        ] } }] });
      });
      const restores = [setEnv("AI_HEADERS_TIMEOUT_MS", "360000"), setEnv("AI_BODY_TIMEOUT_MS", "360000"),
        setEnv("AI_TIMEOUT_MS", "1000")];
      try {
        await fetchWithRetry("https://gateway.example/check", () => ({}), { timeoutMs: 360000 });
        process.env.AI_HEADERS_TIMEOUT_MS = "1000";
        process.env.AI_BODY_TIMEOUT_MS = "1000";
        await apiyiProviders["gemini-3.1-flash-image"].generate({
          prompt: "test", modelOptions: { aspectRatio: "1:1", imageSize: "1K" },
        });
        assert.equal(timeouts[1], 360000);
        assert.equal(captures[1].dispatcher, captures[0].dispatcher, "低环境变量不得缩短 Gemini headers/body 时限");
        await fetchWithRetry("https://gateway.example/check", () => ({}), { timeoutMs: 60000 });
        assert.equal(timeouts[2], 60000);
        assert.notEqual(captures[2].dispatcher, captures[0].dispatcher);
      } finally {
        timer.mock.restore(); restore(); restores.reverse().forEach((fn) => fn());
      }
    });

    await test("FLUX.2 Pro 使用 generations 端点、显式尺寸和有序参考图字段", async () => {
      const captures: Array<{ url: string; init?: RequestInit }> = [];
      const resultUrl = "https://cdn.example/flux.png?token=temporary";
      const restoreFetch = installFetchMock((input, init) => {
        captures.push({ url: String(input), init });
        return Response.json({ data: [{ url: resultUrl }] });
      });
      try {
        const modelOptions = { width: 1024, height: 768, outputFormat: "png" as const };
        const generated = await apiyiProviders["flux-2-pro"].generate({ prompt: "生成", modelOptions });
        assert.deepEqual(generated.images, [resultUrl]);
        assert.deepEqual(jsonBody(captures[0].init), {
          model: "flux-2-pro", prompt: "生成", width: 1024, height: 768, output_format: "png",
        });
        await apiyiProviders["flux-2-pro"].edit({
          prompt: "融合", referenceImages: [white, blue], modelOptions,
        });
        const editedBody = jsonBody(captures[1].init);
        const firstInput = String(editedBody.input_image);
        const secondInput = String(editedBody.input_image_2);
        delete editedBody.input_image;
        delete editedBody.input_image_2;
        assert.deepEqual(editedBody, {
          model: "flux-2-pro", prompt: "融合", width: 1024, height: 768, output_format: "png",
        });
        for (const input of [firstInput, secondInput]) {
          assert.match(input, /^data:image\/(?:jpeg|png);base64,/);
          const metadata = await sharp(Buffer.from(input.split(",")[1], "base64")).metadata();
          assert.ok(metadata.width && metadata.height);
          assert.equal(metadata.width % 16, 0);
          assert.equal(metadata.height % 16, 0);
          assert.ok(metadata.width >= 64 && metadata.height >= 64);
          assert.ok(metadata.width * metadata.height <= 4_194_304);
        }

        const largeReference = await imageDataUrl(3000, 2000, { r: 120, g: 80, b: 40 }, "jpeg");
        await apiyiProviders["flux-2-pro"].edit({
          prompt: "缩放输入", referenceImages: [largeReference], modelOptions,
        });
        const adapted = String(jsonBody(captures[2].init).input_image);
        const adaptedMetadata = await sharp(Buffer.from(adapted.split(",")[1], "base64")).metadata();
        assert.ok(adaptedMetadata.width && adaptedMetadata.height);
        assert.equal(adaptedMetadata.width % 16, 0);
        assert.equal(adaptedMetadata.height % 16, 0);
        assert.ok(adaptedMetadata.width * adaptedMetadata.height <= 4_194_304);
        assert.ok(captures.every((capture) => capture.url === "https://gateway.example/v1/images/generations"));
      } finally {
        restoreFetch();
      }
    });

    await test("Seedream 固定关闭水印与序列生成且禁止发送 n", async () => {
      const bodies: Record<string, unknown>[] = [];
      const restoreFetch = installFetchMock((_input, init) => {
        bodies.push(jsonBody(init));
        return Response.json({
          data: [{
            b64_json: white.split(",")[1],
            size: bodies.length === 1 ? "2048x2048" : "3072x3072",
          }],
        });
      });
      try {
        const generated = await apiyiProviders["seedream-5-0-260128"].generate({
          prompt: "生成", batchSize: 8, modelOptions: { size: "2K" },
        });
        const edited = await apiyiProviders["seedream-5-0-260128"].edit({
          prompt: "融合", referenceImages: [white, blue], modelOptions: { size: "3K" },
        });
        assert.deepEqual(generated.providerOutputSizes, ["2048x2048"]);
        assert.deepEqual(edited.providerOutputSizes, ["3072x3072"]);
        assert.deepEqual(bodies[0], {
          model: "seedream-5-0-260128", prompt: "生成", size: "2K", response_format: "b64_json",
          watermark: false, sequential_image_generation: "disabled",
        });
        assert.deepEqual(bodies[1], {
          model: "seedream-5-0-260128", prompt: "融合", image: [white, blue], size: "3K",
          response_format: "b64_json", watermark: false, sequential_image_generation: "disabled",
        });
        assert.equal("n" in bodies[0], false);
      } finally {
        restoreFetch();
      }
    });

    await test("Grok 文生图保留 n，编辑端点不发送无效尺寸参数并限制 4 张参考图", async () => {
      const captures: Array<{ url: string; init?: RequestInit }> = [];
      const restoreFetch = installFetchMock((input, init) => {
        captures.push({ url: String(input), init });
        const count = captures.length === 1 ? 6 : 1;
        return Response.json({ data: Array.from({ length: count }, () => ({ b64_json: white.split(",")[1] })) });
      });
      try {
        const generated = await apiyiProviders["grok-imagine-image"].generate({
          prompt: "生成", batchSize: 6, modelOptions: { aspectRatio: "16:9", resolution: "2k" },
        });
        assert.equal(generated.images.length, 6);
        assert.deepEqual(jsonBody(captures[0].init), {
          model: "grok-imagine-image", prompt: "生成", aspect_ratio: "16:9",
          resolution: "2k", n: 6, response_format: "b64_json",
        });

        await apiyiProviders["grok-imagine-image"].edit({
          prompt: "单图编辑", referenceImages: [white],
          modelOptions: { aspectRatio: "1:1", resolution: "1k" },
        });
        const singleForm = captures[1].init?.body as FormData;
        assert.equal(singleForm.getAll("image").length, 1);
        assert.equal(singleForm.getAll("image[]").length, 0);

        await apiyiProviders["grok-imagine-image"].edit({
          prompt: "编辑", referenceImages: [white, blue],
          modelOptions: { aspectRatio: "1:1", resolution: "1k" },
        });
        const form = captures[2].init?.body as FormData;
        assert.equal(captures[2].url, "https://gateway.example/v1/images/edits");
        assert.equal(form.getAll("image[]").length, 2);
        assert.equal(form.getAll("image").length, 0);
        assert.equal(form.get("resolution"), null);
        assert.equal(form.get("aspect_ratio"), null);
        assert.equal(form.get("n"), null);

        const callsBeforeReject = captures.length;
        await assert.rejects(
          () => apiyiProviders["grok-imagine-image"].edit({
            prompt: "超量", referenceImages: [white, white, white, white, white],
            modelOptions: { aspectRatio: "1:1", resolution: "1k" },
          }),
          /最多支持 4 张参考图/,
        );
        assert.equal(captures.length, callsBeforeReject);
      } finally {
        restoreFetch();
      }
    });

    await test("非法模型原生参数在付费调用前拒绝", async () => {
      assert.match(imageModelOptionsError("flux-2-pro", { width: 513, height: 512, outputFormat: "png" }) ?? "", /unsupported/);
      assert.match(imageModelOptionsError("grok-imagine-image", { aspectRatio: "1:1", resolution: "4k" }) ?? "", /unsupported/);
      assert.match(imageModelOptionsError("gpt-image-2", { quality: "auto" }) ?? "", /unsupported/);
      let calls = 0;
      const restoreFetch = installFetchMock(() => {
        calls += 1;
        return Response.json(pngPayload(white));
      });
      try {
        await assert.rejects(
          () => apiyiProviders["flux-2-pro"].generate({
            prompt: "非法尺寸",
            modelOptions: { width: 513, height: 512, outputFormat: "png" },
          }),
          /模型参数无效/,
        );
        assert.equal(calls, 0);
      } finally {
        restoreFetch();
      }
    });

    await test("HTTP 200 响应体截断标记 outcome_unknown 且只请求一次", async () => {
      let calls = 0;
      const restoreFetch = installFetchMock(() => {
        calls += 1;
        return new Response("{", { status: 200, headers: { "Content-Type": "application/json" } });
      });
      try {
        await assert.rejects(
          () => apiyiProviders["gpt-image-2-vip"].generate({
            prompt: "截断", modelOptions: { size: "1280x1280" },
          }),
          (error: unknown) => error instanceof ProviderError && error.category === "outcome_unknown",
        );
        assert.equal(calls, 1);
      } finally {
        restoreFetch();
      }
    });

    await test("HTTP 200 中的损坏 Base64、伪造 MIME 与非法 URL 均确定失败且只请求一次", async () => {
      const jpeg = await imageDataUrl(4, 2, { r: 70, g: 110, b: 160 }, "jpeg");
      const signatureOnly = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
      let payload: unknown = {};
      let calls = 0;
      const restoreFetch = installFetchMock(() => {
        calls += 1;
        return Response.json(payload);
      });
      const vipRequest = () => apiyiProviders["gpt-image-2-vip"].generate({
        prompt: "响应校验", modelOptions: { size: "1280x1280" },
      });
      try {
        const scenarios: Array<{ payload: unknown; invoke: () => Promise<unknown> }> = [
          { payload: { data: [{ b64_json: "not-canonical-base64-response" }] }, invoke: vipRequest },
          { payload: { data: [{ b64_json: signatureOnly }] }, invoke: vipRequest },
          {
            payload: {
              candidates: [{ content: { parts: [{
                inlineData: { mimeType: "image/png", data: jpeg.split(",")[1] },
              }] } }],
            },
            invoke: () => apiyiProviders["gemini-3.1-flash-image"].generate({
              prompt: "响应校验", modelOptions: { aspectRatio: "1:1", imageSize: "1K" },
            }),
          },
          { payload: { data: [{ url: "/relative-result.png?token=secret" }] }, invoke: vipRequest },
          {
            payload: pngPayload(white),
            invoke: () => apiyiProviders["seedream-5-0-260128"].generate({
              prompt: "响应校验", modelOptions: { size: "2K" },
            }),
          },
        ];
        for (const scenario of scenarios) {
          payload = scenario.payload;
          calls = 0;
          await assert.rejects(
            scenario.invoke,
            (error: unknown) => error instanceof ProviderError &&
              error.status === 502 && error.category === "invalid_response",
          );
          assert.equal(calls, 1, "HTTP 200 内的坏图片不得触发第二次付费请求");
        }
      } finally {
        restoreFetch();
      }
    });

    await test("内容审核常见错误码与措辞统一分类为确定拒绝", async () => {
      let responseBody: unknown = {};
      let calls = 0;
      const restoreFetch = installFetchMock(() => {
        calls += 1;
        return new Response(JSON.stringify(responseBody), { status: 400 });
      });
      try {
        for (const errorBody of [
          { message: "content policy violation: raw gateway detail" },
          { message: "Your request was rejected as a result of our safety system." },
          { code: "content_filter", message: "The response was filtered by the content management policy." },
          { code: "ResponsibleAIPolicyViolation", message: "The request was blocked." },
        ]) {
          responseBody = { error: errorBody };
          calls = 0;
          await assert.rejects(
            () => fetchWithRetry("https://gateway.example/v1/images/edits", () => ({}), { providerId: "test" }),
            (error: unknown) => error instanceof ProviderError &&
              error.category === "content_refused" &&
              error.message === "本次请求未通过 AI 安全审核，请调整提示词或参考图片后重试",
          );
          assert.equal(calls, 1);
        }
      } finally {
        restoreFetch();
      }
    });

    await test("网关 401/403 始终优先归类为鉴权失败且不重试", async () => {
      let status = 401;
      let responseMessage = "content policy violation while validating the API key";
      let calls = 0;
      const restoreFetch = installFetchMock(() => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: responseMessage } }), { status });
      });
      try {
        for (const scenario of [
          { status: 401, message: "content policy violation while validating the API key" },
          { status: 403, message: "model gpt-image-2 is not available for this API key" },
        ]) {
          status = scenario.status;
          responseMessage = scenario.message;
          calls = 0;
          await assert.rejects(
            () => fetchWithRetry("https://gateway.example/v1/images/generations", () => ({}), { providerId: "test" }),
            (error: unknown) => error instanceof ProviderError &&
              error.status === status && error.category === "gateway_authentication" &&
              error.message === "AI 网关鉴权失败，请联系管理员检查 API Key 或账号权限",
          );
          assert.equal(calls, 1);
        }
      } finally {
        restoreFetch();
      }
    });

    await test("AI 诊断列出全部 API易模型且 gpt-image-2 只开放改图探针", async () => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as express.Request & { authUser: unknown }).authUser = {
          id: "admin-test", accountId: "admin-test", displayName: "Admin Test",
          role: "admin", mustChangePassword: false,
        };
        next();
      });
      app.use("/api/ai-diagnostics", createAiDiagnosticsRouter(createRateLimitMiddleware({
        windowMs: 60_000, maxRequests: 1,
      })));
      const server = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}/api/ai-diagnostics`;
      try {
        const response = await fetch(baseUrl);
        assert.equal(response.status, 200);
        const body = await response.json() as {
          gateway: string;
          providers: Array<{ providerId: string; configured: boolean; probes: string[] }>;
        };
        assert.equal(body.gateway, "gateway.example");
        assert.deepEqual(body.providers.map((item) => item.providerId), IMAGE_MODEL_IDS);
        assert.ok(body.providers.every((item) => item.configured));
        assert.deepEqual(body.providers.find((item) => item.providerId === "gpt-image-2")?.probes, ["edit"]);

        const invalid = {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerId: "invalid", mode: "invalid" }),
        };
        assert.equal((await fetch(`${baseUrl}/probe`, invalid)).status, 400);
        assert.equal((await fetch(`${baseUrl}/probe`, invalid)).status, 429);
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    });
  } finally {
    restoreSeedanceKey();
    restoreSeedanceAssetBase();
    restoreSeedanceAssetKey();
    restoreSeedanceBase();
    restoreKey();
    restoreBase();
  }

  console.log(`\n通过 ${passed} 项`);
}

await main();

import assert from "node:assert/strict";
import sharp from "sharp";
import { randomBytes } from "node:crypto";
import { apiyiProviders } from "../server/providers/apiyi";
import { prepareGptReferences } from "../server/providers/gptImage25";
import { validateImageDataUrl } from "../server/lib/imageValidation";

process.env.APIYI_API_KEY = "test-not-a-real-key";
process.env.APIYI_BASE_URL = "https://mock.invalid/v1";
process.env.APIYI_GPT_IMAGE_GENERATION_MODEL = "gpt-image-2.5-flare-2026-09-08";
process.env.APIYI_GPT_IMAGE_EDIT_MODEL = "gpt-image-2.5-sunburst-2026-09-08";
const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "white" } }).png().toBuffer();
const image = `data:image/png;base64,${png.toString("base64")}`;
const requests: { url: string; body: string | FormData }[] = [];
const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
const timeouts: number[] = [];
AbortSignal.timeout = (milliseconds) => { timeouts.push(milliseconds); return originalTimeout(milliseconds); };
process.env.AI_TIMEOUT_MS = "1000";
globalThis.fetch = async (url, init) => {
  assert.ok(String(url).startsWith("https://mock.invalid/v1/images/"));
  requests.push({ url: String(url), body: init!.body as string | FormData });
  return Response.json({ data: [{ b64_json: png.toString("base64") }], usage: {
    input_tokens_details: { text_tokens: 100, image_tokens: 200 }, output_tokens: 300,
  } }, { headers: { "x-request-id": "mock-request" } });
};
try {
  const result = await apiyiProviders["gpt-image-2.5-flare"].generate({ prompt: "test", modelOptions: { size: "1024x1024" } });
  const body = JSON.parse(requests[0].body as string);
  assert.equal(body.quality, "medium");
  assert.equal(body.model, "gpt-image-2.5-flare-2026-09-08");
  assert.equal(body.n, 1);
  assert.equal(body.response_format, undefined);
  assert.equal(body.input_fidelity, undefined);
  assert.equal(result.images[0], image);
  assert.equal(result.providerRequestId, "mock-request");
  assert.equal(result.providerUsage?.estimatedUsd, 0.0111);
  await apiyiProviders["gpt-image-2.5-sunburst"].edit({ prompt: "edit", referenceImages: Array(16).fill(image), modelOptions: { quality: "max", size: "1024x1024" } });
  const form = requests[1].body as FormData;
  assert.equal(form.get("model"), "gpt-image-2.5-sunburst-2026-09-08");
  assert.equal(form.get("quality"), "max");
  assert.equal(form.getAll("image[]").length, 16);
  assert.equal(form.has("response_format"), false);
  assert.equal(form.has("input_fidelity"), false);
  await assert.rejects(apiyiProviders["gpt-image-2.5-flare"].generate({ prompt: "test", modelOptions: { quality: "auto" as never } }));
  await assert.rejects(apiyiProviders["gpt-image-2.5-sunburst"].edit({ prompt: "test", referenceImages: Array(17).fill(image) }));
  assert.equal(requests.length, 2);
  assert.deepEqual(timeouts, [360_000, 600_000]);
  process.env.APIYI_GPT_IMAGE_EDIT_MODEL = "gpt-image-2";
  await assert.rejects(apiyiProviders["gpt-image-2.5-sunburst"].edit({ prompt: "test", referenceImages: [image], modelOptions: { quality: "max" } }));
  assert.equal(requests.length, 2);
  assert.deepEqual(await prepareGptReferences([image]), [image]);
  const noisy = await sharp(randomBytes(2200 * 1000 * 3), { raw: { width: 2200, height: 1000, channels: 3 } }).png().toBuffer();
  const refs = await prepareGptReferences(Array(5).fill(`data:image/png;base64,${noisy.toString("base64")}`));
  assert.ok(refs.reduce((sum, ref) => sum + validateImageDataUrl(ref).buffer.length, 0) <= 6 * 1024 * 1024);
  for (const ref of refs) {
    const parsed = validateImageDataUrl(ref);
    const meta = await sharp(parsed.buffer).metadata();
    assert.equal(parsed.mime, "image/png");
    assert.ok(meta.width! <= 2048 && meta.height! <= 1000);
  }
  const corrupt = Buffer.concat([png.subarray(0, 8), Buffer.alloc(1_600_000)]);
  const broken = `data:image/png;base64,${corrupt.toString("base64")}`;
  assert.deepEqual(await prepareGptReferences([broken]), [broken]);
  console.log("GPT Image 2.5 contracts/compression tests passed (mock only)");
} finally { globalThis.fetch = originalFetch; AbortSignal.timeout = originalTimeout; }

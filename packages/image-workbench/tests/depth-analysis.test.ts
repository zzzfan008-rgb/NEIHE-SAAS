import assert from 'node:assert/strict';
import sharp from 'sharp';

const { analyzeDepthReference } = await import('../server/lib/depthAnalysis');
const png = await sharp({ create: { width: 30, height: 50, channels: 3, background: 'white' } }).png().toBuffer();
const input = `data:image/png;base64,${png.toString('base64')}`;
const originalFetch = globalThis.fetch;
process.env.DEPTH_SERVICE_URL = 'http://127.0.0.1:8766';
process.env.DEPTH_SERVICE_TOKEN = 'test-only-depth-token-at-least-32-characters';
let calls = 0;
globalThis.fetch = async (url, init) => {
  calls++;
  assert.equal(String(url), 'http://127.0.0.1:8766/depth');
  assert.equal(init?.redirect, 'error');
  assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${process.env.DEPTH_SERVICE_TOKEN}`);
  assert.equal(JSON.parse(String(init?.body)).inputSize, 518);
  return new Response(png, { headers: { 'content-type': 'image/png', 'x-depth-model': 'depth-anything-v2-vitl', 'x-depth-checkpoint': 'a'.repeat(64) } });
};
try {
  const result = await analyzeDepthReference(input);
  assert.equal(result.model, 'depth-anything-v2-vitl');
  assert.equal(result.convention, 'near-white');
  assert.equal(result.width, 30);
  assert.equal(result.height, 50);
  assert.equal(result.checkpoint, 'a'.repeat(64));
  assert.match(result.image, /^data:image\/png;base64,/);
  await assert.rejects(() => analyzeDepthReference('https://example.com/image.png'));
  assert.equal(calls, 1);
  globalThis.fetch = async () => new Response('invalid', { status: 503 });
  await assert.rejects(() => analyzeDepthReference(input), /深度服务/);
  globalThis.fetch = async () => new Response(png, { headers: { 'content-type': 'image/png' } });
  await assert.rejects(() => analyzeDepthReference(input), /模型/);
  delete process.env.DEPTH_SERVICE_TOKEN;
  await assert.rejects(() => analyzeDepthReference(input), /配置/);
  console.log('Depth adapter contracts passed (no paid provider calls)');
} finally {
  globalThis.fetch = originalFetch;
}

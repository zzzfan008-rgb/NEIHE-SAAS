import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { analyzeDWPoseReference } from '../server/lib/dwposeAnalysis';

const png = await sharp({ create: { width: 30, height: 50, channels: 3, background: 'black' } }).png().toBuffer();
const input = `data:image/png;base64,${png.toString('base64')}`;
const savedFetch = globalThis.fetch;
process.env.POSE_SERVICE_URL = 'http://127.0.0.1:8767';
process.env.POSE_SERVICE_TOKEN = 'test-only-local-pose-token-over-32-characters';
const checkpoint = 'a'.repeat(64);
const points = Array.from({ length: 133 }, () => null as null | { x: number; y: number; confidence: number });
points[0] = { x: 0.25, y: 0.4, confidence: 0.8 };
const structured = {
  schemaVersion: 1,
  model: 'dwpose-wholebody',
  checkpoint,
  width: 30,
  height: 50,
  imagePngBase64: png.toString('base64'),
  people: [{ keypoints: points }],
};
const structuredHeaders = {
  'content-type': 'application/json',
  'x-pose-model': 'dwpose-wholebody',
  'x-pose-checkpoint': checkpoint,
};
const pngHeaders = {
  'content-type': 'image/png',
  'x-pose-model': 'dwpose-wholebody',
  'x-pose-checkpoint': checkpoint,
};

try {
  const paths: string[] = [];
  globalThis.fetch = async (url, init) => {
    paths.push(new URL(String(url)).pathname);
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${process.env.POSE_SERVICE_TOKEN}`);
    assert.deepEqual(Object.keys(JSON.parse(String(init?.body))), ['image']);
    return new Response(JSON.stringify(structured), { headers: structuredHeaders });
  };
  const result = await analyzeDWPoseReference(input);
  assert.equal(result.model, 'dwpose-wholebody');
  assert.equal(result.checkpoint, checkpoint);
  assert.equal(result.width, 30);
  assert.equal(result.height, 50);
  assert.equal(result.pose?.schemaVersion, 1);
  assert.deepEqual(result.pose?.canvas, { width: 30, height: 50 });
  assert.deepEqual(result.pose?.people, structured.people);
  assert.equal(result.image, input);
  assert.deepEqual(paths, ['/pose/v1']);

  paths.length = 0;
  globalThis.fetch = async (url) => {
    paths.push(new URL(String(url)).pathname);
    return paths.length === 1
      ? new Response('Not found', { status: 404 })
      : new Response(png, { headers: pngHeaders });
  };
  const legacy = await analyzeDWPoseReference(input);
  assert.equal(legacy.pose, null, 'PNG-only fallback must remain explicitly non-editable');
  assert.equal(legacy.image, input);
  assert.deepEqual(paths, ['/pose/v1', '/pose']);

  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('Unavailable', { status: 503 });
  };
  await assert.rejects(() => analyzeDWPoseReference(input), /503/);
  assert.equal(calls, 1, 'only a 404 may use the legacy endpoint');

  globalThis.fetch = async () => new Response(JSON.stringify({ ...structured, width: 31 }), { headers: structuredHeaders });
  await assert.rejects(() => analyzeDWPoseReference(input), /尺寸/);
  globalThis.fetch = async () => new Response(JSON.stringify({ ...structured, people: [{ keypoints: points.slice(1) }] }), { headers: structuredHeaders });
  await assert.rejects(() => analyzeDWPoseReference(input), /关键点/);
  globalThis.fetch = async () => new Response(JSON.stringify(structured), { headers: { ...structuredHeaders, 'x-pose-model': 'gemini' } });
  await assert.rejects(() => analyzeDWPoseReference(input), /模型/);

  await assert.rejects(() => analyzeDWPoseReference('http://example.com/private.png'));
  process.env.POSE_SERVICE_URL = 'http://192.168.1.1:8767';
  await assert.rejects(() => analyzeDWPoseReference(input), /HTTPS/);
  delete process.env.POSE_SERVICE_TOKEN;
  await assert.rejects(() => analyzeDWPoseReference(input), /配置/);
  console.log('DWPose adapter: structured protocol, legacy fallback, identity, size, and local-only checks passed');
} finally {
  globalThis.fetch = savedFetch;
}

await import('./pose-topology.test');
await import('./pose-editing.test');
execFileSync(process.env.PYTHON ?? 'python3', ['tests/dwpose-service-protocol.test.py'], { stdio: 'inherit' });

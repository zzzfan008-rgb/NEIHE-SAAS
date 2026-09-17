import assert from 'node:assert/strict';
import sharp from 'sharp';
import { isImageModelId, imageModelOptionsError } from '../src/types/imageModels';
import { createDocumentSnapshot, documentSnapshotToPersistedWorkflow } from '../src/lib/documentSnapshot';
import { validateAndMigrateFlow } from '../server/lib/workflowSchema';
import { apiyiProviders } from '../server/providers/apiyi';
import type { WorkflowNodeData, ImageGenRequest } from '../src/types/workflow';

assert.ok(isImageModelId('gemini-3-pro-image-preview'), '第一轮必须注册 Gemini Pro');
for (const modelId of ['gemini-3-pro-image-preview', 'gpt-image-2', 'gpt-image-2.5-flare', 'gemini-3.1-flash-image'] as const) {
  const modelOptions = modelId.startsWith('gemini') ? { aspectRatio: '4:5', imageSize: '2K' }
    : { quality: 'high', size: '1632x2048' };
  const snapshot = createDocumentSnapshot({ projectName: '第一轮模型持久化', nodes: [{
    id: 'first', type: 'virtual-try-on', position: { x: 0, y: 0 }, data: {
      kind: 'virtual-try-on', label: '保留自定义标题', status: 'idle', workflowStage: 'scene-stabilize',
      prompt: '自然画册质感', modelId, modelOptions, imageSize: '2K', aspectRatio: '4:5',
      sceneFraming: 'custom', basisRevision: 0, promptEnhancement: false, qualityMode: 'fast',
      safetyFallback: false, stylePresetId: 'faithful', outputImages: [],
    } as WorkflowNodeData,
  }], edges: [] });
  const persisted = documentSnapshotToPersistedWorkflow(snapshot);
  const restored = validateAndMigrateFlow(persisted).nodes[0].data;
  assert.equal(restored.modelId, modelId, '保存加载不得替换第一轮所选模型');
  assert.deepEqual(restored.modelOptions, modelOptions);
  assert.equal(restored.sceneFraming, 'custom');
  assert.equal(restored.prompt, '自然画册质感');
  assert.equal(restored.label, '保留自定义标题');
}
assert.ok(imageModelOptionsError('gpt-image-2', { quality: 'max' }));
assert.ok(imageModelOptionsError('gemini-3-pro-image-preview', { aspectRatio: '1:1', imageSize: '512' }));

process.env.APIYI_API_KEY = 'test-only';
process.env.APIYI_BASE_URL = 'https://mock.invalid';
process.env.APIYI_GPT_IMAGE_EDIT_MODEL = 'gpt-image-2.5-sunburst-2026-09-08';
const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'white' } }).png().toBuffer();
const image = `data:image/png;base64,${png.toString('base64')}`;
const requests: Array<{ url: string; body: string | FormData }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  assert.ok(String(url).startsWith('https://mock.invalid/'));
  requests.push({ url: String(url), body: init!.body as string | FormData });
  return Response.json(String(url).includes('generateContent')
    ? { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] }
    : { data: [{ b64_json: png.toString('base64') }] });
};
try {
  await apiyiProviders['gpt-image-2.5-flare'].edit({ prompt: '多图融合', referenceImages: [image],
    modelOptions: { quality: 'high', size: '1024x1024' },
    modelSelection: 'explicit',
  } as ImageGenRequest);
  assert.equal((requests.at(-1)!.body as FormData).get('model'), 'gpt-image-2.5-flare-2026-09-08');
  await apiyiProviders['gpt-image-2.5-flare'].edit({ prompt: '其他节点保留旧路由', referenceImages: [image] });
  assert.equal((requests.at(-1)!.body as FormData).get('model'), 'gpt-image-2.5-sunburst-2026-09-08');
  await apiyiProviders['gemini-3-pro-image-preview'].edit({ prompt: '场景融合', referenceImages: [image],
    modelOptions: { aspectRatio: '4:5', imageSize: '1K' } });
  assert.match(requests.at(-1)!.url, /gemini-3-pro-image-preview:generateContent$/);
  assert.deepEqual(JSON.parse(requests.at(-1)!.body as string).generationConfig.imageConfig,
    { aspectRatio: '4:5', imageSize: '1K' });
} finally { globalThis.fetch = originalFetch; }
console.log('First-round model identity, options, persistence and provider routing passed (mock only)');

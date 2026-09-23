import assert from 'node:assert/strict';
import sharp from 'sharp';
import { isImageModelId, imageModelOptionsError } from '../src/types/imageModels';
import { createDocumentSnapshot, documentSnapshotToPersistedWorkflow } from '../src/lib/documentSnapshot';
import { validateAndMigrateFlow } from '../server/lib/workflowSchema';
import { apiyiProviders } from '../server/providers/apiyi';
import type { WorkflowNodeData, ImageGenRequest } from '../src/types/workflow';
import { executeStep } from '../server/engine/runner';
import { buildExecutionPlan, assertPlanInputs } from '../server/engine/dag';
import { inputPortSpecs } from '../src/lib/workflowPorts';
import { useFlowStore, selectActiveDocument, ensureGeneratedResultNode } from '../src/store/flowStore';

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
  assert.match(requests.at(-1)!.url, /gemini-3-pro-image:generateContent$/);
  const proBody = JSON.parse(requests.at(-1)!.body as string);
  assert.equal(proBody.contents[0].role, 'user');
  assert.equal(proBody.contents[0].parts[1].inline_data.mime_type, 'image/jpeg');
  assert.deepEqual(proBody.generationConfig.imageConfig, { imageSize: '1K' });
} finally { globalThis.fetch = originalFetch; }
console.log('First-round model identity, options, persistence and provider routing passed (mock only)');

const baselineData = {
  kind: 'virtual-try-on', label: '第一轮', status: 'idle', workflowStage: 'scene-stabilize',
  sceneInputMode: 'composed-person', sceneFraming: 'scene', basisRevision: 0, modelId: 'gemini-3-pro-image-preview',
  modelOptions: { aspectRatio: '3:4', imageSize: '2K' }, imageSize: '2K', aspectRatio: '3:4',
  prompt: '', outputImages: [], promptEnhancement: false, qualityMode: 'fast', safetyFallback: false, stylePresetId: 'faithful',
} as const;
const composedFlow = validateAndMigrateFlow(documentSnapshotToPersistedWorkflow(createDocumentSnapshot({
  projectName: '前置人物合成', nodes: [
    { id: 'compose', type: 'ai-modify', position: { x: 0, y: 0 }, data: {
      kind: 'ai-modify', referenceMode: 'identity-pose', label: 'AI 改款', status: 'success', prompt: '合成人物', modelId: 'gemini-3.1-flash-image',
      modelOptions: { aspectRatio: '3:4', imageSize: '1K' }, aspectRatio: '3:4', batchSize: 1, outputImages: [image],
    } },
    { id: 'outfit', type: 'image-input', position: { x: 0, y: 500 }, data: {
      kind: 'image-input', label: '服装', status: 'success', imageRole: 'garment', imageUrl: image,
    } },
    { id: 'first', type: 'virtual-try-on', position: { x: 800, y: 0 }, data: baselineData },
  ], edges: [
    { id: 'base', source: 'compose', sourceHandle: 'image', target: 'first', targetHandle: 'person' },
    { id: 'outfit', source: 'outfit', sourceHandle: 'image', target: 'first', targetHandle: 'outfit' },
  ],
})));
useFlowStore.getState().loadFlow({ ...composedFlow, projectName: '前置人物合成' });
const restoredDocument = selectActiveDocument(useFlowStore.getState());
const first = restoredDocument.nodes.find(node => node.id === 'first')!;
const composeData = restoredDocument.nodes.find(node => node.id === 'compose')!.data;
assert.equal(composeData.kind === 'ai-modify' && composeData.referenceMode, 'identity-pose');
assert.equal(first.data.kind === 'virtual-try-on' && first.data.sceneInputMode, 'composed-person');
assert.deepEqual(inputPortSpecs(first.data).filter(port => port.required).map(port => port.id), ['person', 'outfit']);
const plan = buildExecutionPlan(composedFlow.nodes, composedFlow.edges, { onlyNodeId: 'first', includeDownstream: false });
assert.doesNotThrow(() => assertPlanInputs(plan, composedFlow.edges));
assert.equal(plan.steps[0].params.sceneInputMode, 'composed-person');
assert.throws(() => assertPlanInputs({ ...plan, steps: plan.steps.map(step => ({ ...step,
  upstream: step.upstream?.filter(source => source.targetHandle !== 'person'),
})) }, composedFlow.edges), /人物/);
const results = ensureGeneratedResultNode(restoredDocument.nodes, restoredDocument.edges, 'compose', [image]);
assert.ok(results.nodes.some(node => node.id === results.resultNodeId && node.data.kind === 'result' && node.data.images[0] === image));
assert.ok(results.edges.some(edge => edge.source === 'compose' && edge.target === 'first'), '结果展示不替换传往第一轮的连线');
let generated = 0;
const generateBaseline = async (request: ImageGenRequest) => {
  generated++;
  assert.match(request.prompt, /局部换装编辑/);
  assert.match(request.prompt, /【服装】参考图2/);
  assert.match(request.prompt, /禁止重新换脸、换姿势或生成新场景/);
  assert.doesNotMatch(request.prompt, /自然安排人物动作|纯场景环境参考|不是修改或放大/);
  assert.equal(request.referenceImages?.length, 2);
  assert.equal(request.modelOptions?.aspectRatio, '1:1', '画幅跟随人物基准');
  return { images: [image], model: baselineData.modelId };
};
const output = await executeStep({ nodeId: 'first', kind: 'virtual-try-on', inputImages: [image, image], params: baselineData },
  [image, image], () => ({ id: baselineData.modelId, generate: generateBaseline, edit: generateBaseline }), {
    referenceRoles: ['person', 'outfit'],
    sceneAnalyzer: async () => { throw new Error('人物基准不能再做场景重建分析'); },
    candidateSelector: async input => {
      assert.deepEqual(input.referenceRoles, ['person', 'outfit', 'scene', 'pose']);
      assert.equal(input.referenceImages[2], image);
      assert.equal(input.referenceImages[3], image);
      return { selectedIndex: 0, scores: [], model: 'mock', providerRequests: 0, allHardFail: false };
    },
  });
assert.equal(generated, 1);
assert.equal(output.images.length, 1);
await assert.rejects(executeStep({ nodeId: 'compose', kind: 'ai-modify', inputImages: [image],
  params: { referenceMode: 'identity-pose' } }, [image], () => { throw new Error('不得调用真实提供商'); }), /请分别上传/);
console.log('Composed-person persistence, input contract, result routing and generation passed (mock only)');

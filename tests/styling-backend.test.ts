import assert from 'node:assert/strict';
import { buildExecutionPlan } from '../server/engine/dag';
import { parseOutfitAnalysis, outfitFingerprint } from '../server/lib/outfitAnalysis';
import { validateDirectGenerateRequest } from '../server/routes/generate';
import { expandStylingHistoryRows } from '../server/routes/history';
for (const status of ['running', 'outcome_unknown', 'cancelled', 'failed']) {
    const history = expandStylingHistoryRows([{ id: 'run', kind: 'ai-styling', status, requested_count: 4, output_id: 'success', output_status: 'success', image: '/api/files/result.png' }]);
    assert.equal(history.length, 4);
    assert.equal(history[0].output_status, 'success');
    assert.equal(history[1].output_id, 'run');
    assert.equal(history[1].output_status, null);
    assert.equal(history[1].status, status);
    assert.equal(new Set(history.map(row => row.output_id)).size, 4);
}
assert.deepEqual(validateDirectGenerateRequest('ai-styling', { prompt: '搭配', aspectRatio: '3:4', batchSize: 1 }), {
    ok: false, error: 'ai-styling requires saved references and outfit analysis; use /api/run-plan',
});
const reference = { kind: 'outfit-reference', images: ['/api/files/detail', '/api/files/main'], mainImage: '/api/files/main' };
const styling = { kind: 'ai-styling', preserve: 'upper', analysisId: 'analysis', referenceFingerprint: 'fingerprint' };
const plan = buildExecutionPlan([{ id: 'reference', data: reference }, { id: 'styling', data: styling }] as never, [{ source: 'reference', target: 'styling', targetHandle: 'references' }], { onlyNodeId: 'styling', includeDownstream: false });
assert.deepEqual(plan.steps[0].inputImages, ['/api/files/main', '/api/files/detail']);
assert.equal(plan.steps[0].params.analysisId, 'analysis');
console.log('styling backend DAG contracts passed');
assert.throws(() => parseOutfitAnalysis({ description: 'garment' }));
const analysis = { categories: ['upper'], description: 'white shirt', hasPerson: true, upperIsOuterwear: false, ambiguous: false, existingExtras: { outerwear: false, shoes: true, bag: false, accessories: false, hat: false } };
assert.deepEqual(parseOutfitAnalysis(analysis), analysis);
assert.notEqual(outfitFingerprint('a', ['x', 'y']), outfitFingerprint('a', ['y', 'x']));
const { executeStep } = await import('../server/engine/runner');
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const calls: string[][] = [];
const provider = { id: 'gemini-3.1-flash-image', edit: async (request: {
        referenceImages: string[];
    }) => { calls.push(request.referenceImages); return { images: [image], model: 'gemini-3.1-flash-image' }; } };
const result = await executeStep({ nodeId: 's', kind: 'ai-styling', inputImages: [image], params: { modelId: 'gemini-3.1-flash-image', batchSize: 2, preserve: 'upper', extras: analysis.existingExtras, prompt: '', outfitAnalysis: analysis } } as never, [image], () => provider as never, { onStylingCheckpoint: async (_index, generated) => generated });
assert.equal(result.images.length, 2);
assert.equal(calls.length, 2);
assert.equal(calls[0].length, 1);
assert.equal(calls[1].length, 2);
calls.length = 0;
const resumed = await executeStep({ nodeId: 's', kind: 'ai-styling', inputImages: [image], params: { modelId: 'gemini-3.1-flash-image', batchSize: 4, preserve: 'upper', extras: analysis.existingExtras, prompt: '', outfitAnalysis: analysis } } as never, [image], () => provider as never, { stylingCompleted: [{ image, prompt: 'previous', model: 'gemini-3.1-flash-image' }], onStylingCheckpoint: async (_index, generated) => generated });
assert.equal(calls.length, 3);
assert.equal(resumed.images.length, 4);
assert.equal(resumed.prompts?.[0], 'previous');
assert.ok(calls.every(refs => refs.length === 2));
const whole = await executeStep({ nodeId: 's', kind: 'ai-styling', inputImages: [image], params: { modelId: 'gemini-3.1-flash-image', batchSize: 1, preserve: 'whole', extras: { ...analysis.existingExtras, shoes: false, outerwear: true }, prompt: '', outfitAnalysis: analysis } } as never, [image], () => provider as never, { onStylingCheckpoint: async (_index, generated) => generated });
assert.match(whole.prompts![0], /外套：允许新增/);
assert.doesNotMatch(whole.prompts![0], /用户补充要求/);
const onePieceAnalysis = { ...analysis, categories: ['one-piece'], description: '黑色连体裤' };
const onePiece = await executeStep({ nodeId: 's', kind: 'ai-styling', inputImages: [image], params: { modelId: 'gemini-3.1-flash-image', batchSize: 1, preserve: 'one-piece', extras: { ...analysis.existingExtras, outerwear: true }, prompt: '', outfitAnalysis: onePieceAnalysis } } as never, [image], () => provider as never, { onStylingCheckpoint: async (_index, generated) => generated });
assert.match(onePiece.prompts![0], /只保留主图中的连体服饰/);
assert.match(onePiece.prompts![0], /外套：允许新增/);
assert.doesNotMatch(onePiece.prompts![0], /保持所有原有服装/);

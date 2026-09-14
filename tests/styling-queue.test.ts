import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetPostgresTestDatabase } from './postgresTestDatabase';
import { ProviderError } from '../server/providers/base';
import type { AIProvider, NodeExecution } from '../src/types/workflow';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { AuthenticatedRequest } from '../server/lib/auth';
import { defaultImageModelOptions } from '../src/types/imageModels';
import { WORKFLOW_SCHEMA_VERSION } from '../src/types/workflow';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'styling-queue-'));
process.env.DATA_DIR = temp;
process.env.SQLITE_IMPORT_FILE = 'missing.db';
process.env.INITIAL_ADMIN_ACCOUNT_ID = 'styling-admin';
process.env.INITIAL_ADMIN_PASSWORD = 'Initial1234';
process.env.APIYI_API_KEY = 'styling-test-only';
process.env.APIYI_BASE_URL = 'https://styling.example';
await resetPostgresTestDatabase();
const db = await import('../server/lib/database');
const queue = await import('../server/engine/runQueue');
await db.initializeDatabase();
const owner = (await db.queryOne<{
    id: string;
}>("SELECT id FROM users WHERE account_id='styling-admin'"))!;
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const analysis = { categories: ['upper'], description: '白衬衫', hasPerson: true, upperIsOuterwear: false, ambiguous: false, existingExtras: { outerwear: false, shoes: false, bag: false, accessories: false, hat: false } };
function step(count: number): NodeExecution { return { nodeId: 'styling', kind: 'ai-styling', inputImages: [image], params: { modelId: 'gemini-3.1-flash-image', batchSize: count, preserve: 'upper', extras: analysis.existingExtras, prompt: '', outfitAnalysis: analysis } }; }
try {
    for (const failure of [undefined, 'invalid_request', 'outcome_unknown'] as const) {
        const s = step(4);
        const run = await queue.enqueueGenerationRun({ steps: [s] }, owner.id, { userId: owner.id, nodeId: s.nodeId, nodeLabel: '搭配', kind: 'ai-styling', requestedCount: 4 });
        const calls: string[][] = [];
        const provider: AIProvider = { id: 'gemini-3.1-flash-image', generate: async () => { throw new Error('must edit'); }, edit: async (request) => { calls.push(request.referenceImages ?? []); if (calls.length === 2 && failure)
                throw new ProviderError('test failure', 400, 'gemini-3.1-flash-image', failure); return { images: [image], model: 'gemini-3.1-flash-image' }; } };
        await queue.processNextGenerationJob('styling-test', { resolveProvider: () => provider });
        const row = await db.queryOne<{
            status: string;
            successful_count: number;
            provider_requests: number;
        }>('SELECT status,successful_count,provider_requests FROM generation_runs WHERE id=$1', [run.id]);
        assert.equal(row?.status, failure === 'outcome_unknown' ? 'outcome_unknown' : failure ? 'failed' : 'succeeded');
        assert.equal(row?.successful_count, failure ? 1 : 4);
        assert.equal(row?.provider_requests, failure ? 2 : 4);
        assert.equal(calls[0].length, 1);
        assert.equal(calls[1].length, 2);
        if (!failure) {
            assert.equal(calls[2].at(-1), calls[1].at(-1));
            assert.equal(calls[3].at(-1), calls[1].at(-1));
        }
        const outputs = await db.query('SELECT * FROM generation_outputs WHERE run_id=$1 AND status=\'success\'', [run.id]);
        assert.equal(outputs.length, failure ? 1 : 4);
        const usage = await db.queryOne<{
            successful_count: number;
        }>('SELECT successful_count FROM usage_events WHERE run_id=$1', [run.id]);
        assert.equal(usage?.successful_count, failure ? 1 : 4);
        const events = await queue.readDurableRunEvents(run.id, owner.id, 0);
        assert.ok(events?.some(e => e.type === 'node-status' && e.status === 'running' && e.images?.length === 1));
        if (failure)
            assert.ok(events?.some(e => e.type === 'node-status' && ['error', 'outcome_unknown'].includes(e.status) && e.images?.length === 1));
        await queue.processNextGenerationJob('styling-test', { resolveProvider: () => provider });
        assert.equal(calls.length, failure ? 2 : 4);
    }
    console.log('styling durable success / partial failure / unknown contracts passed');
    {
        const run = await queue.enqueueGenerationRun({ steps: [step(4)] }, owner.id, { userId: owner.id, nodeId: 'styling', nodeLabel: '搭配', kind: 'ai-styling', requestedCount: 4 });
        let calls = 0;
        let validations = 0;
        const provider: AIProvider = {
            id: 'gemini-3.1-flash-image',
            validate: async () => {
                if (++validations !== 2) return;
                const checkpoints = await db.query('SELECT c.* FROM styling_checkpoints c JOIN generation_run_steps s ON s.id=c.step_id WHERE s.run_id=$1', [run.id]);
                assert.equal(checkpoints.length, 1);
                await db.query("UPDATE generation_jobs SET status='cancel_requested' WHERE run_id=$1", [run.id]);
                await db.query("UPDATE generation_runs SET status='cancel_requested' WHERE id=$1", [run.id]);
            },
            generate: async () => { throw new Error('must edit'); },
            edit: async () => { calls++; return { images: [image], model: 'gemini-3.1-flash-image' }; },
        };
        await queue.processNextGenerationJob('styling-cancel', { resolveProvider: () => provider });
        assert.equal(calls, 1);
        const row = await db.queryOne<{status:string;successful_count:number}>('SELECT status,successful_count FROM generation_runs WHERE id=$1', [run.id]);
        assert.equal(row?.status, 'cancelled');
        assert.equal(row?.successful_count, 1);
        assert.equal((await db.query('SELECT * FROM generation_outputs WHERE run_id=$1 AND status=\'success\'', [run.id])).length, 1);
        assert.equal((await db.queryOne<{successful_count:number}>('SELECT successful_count FROM usage_events WHERE run_id=$1', [run.id]))?.successful_count, 1);
    }
    for (const started of [false, true]) {
        const run = await queue.enqueueGenerationRun({ steps: [step(2)] }, owner.id, { userId: owner.id, nodeId: 'styling', nodeLabel: '搭配', kind: 'ai-styling', requestedCount: 2 });
        const now = Date.now() + 1000;
        const job = await queue.claimNextJob('styling-lost-worker', now, 1);
        assert.ok(job && job.runId === run.id);
        const files = await import('../server/lib/fileStore');
        const saved = await files.persistImageRef(image);
        await db.query("INSERT INTO files(id,owner_id,source_type,run_id,created_at) VALUES($1,$2,'generated',$3,$4)", [saved.slice('/api/files/'.length), owner.id, run.id, new Date().toISOString()]);
        await db.query('INSERT INTO styling_checkpoints(step_id,ordinal,image,prompt,model,created_at) VALUES($1,1,$2,$3,$4,$5)', [job.stepId, saved, 'first checkpoint', 'gemini-3.1-flash-image', now]);
        await db.query("INSERT INTO generation_outputs(id,run_id,image,prompt,status,created_at) VALUES($1,$2,$3,'first checkpoint','success',$4)", [`checkpoint-${run.id}`,run.id,saved,now]);
        await db.query('UPDATE generation_run_steps SET output_images_json=$2,prompts_json=$3,model=$4,provider_requests=$5 WHERE id=$1', [job.stepId,JSON.stringify([saved]),JSON.stringify(['first checkpoint']),'gemini-3.1-flash-image',started?2:1]);
        await db.query('UPDATE generation_runs SET successful_count=1 WHERE id=$1',[run.id]);
        await db.query('UPDATE generation_jobs SET attempt_started_at=$2 WHERE id=$1',[job.id,started?now:null]);
        assert.equal(await queue.recoverExpiredGenerationJobs(now+2),1);
        let calls=0;
        const {resolveImageRefs}=await import('../server/engine/runner');
        const expectedFirst=(await resolveImageRefs([saved]))[0];
        const provider:AIProvider={id:'gemini-3.1-flash-image',generate:async()=>{throw new Error('must edit');},edit:async request=>{calls++;assert.equal(request.referenceImages?.length,2);assert.equal(request.referenceImages?.[1],expectedFirst);return {images:[image],model:'gemini-3.1-flash-image'};}};
        await queue.processNextGenerationJob('styling-recovered',{resolveProvider:()=>provider,now:()=>now+3});
        const row=await db.queryOne<{status:string;successful_count:number;provider_requests:number}>('SELECT status,successful_count,provider_requests FROM generation_runs WHERE id=$1',[run.id]);
        assert.equal(row?.status,started?'outcome_unknown':'succeeded');
        assert.equal(row?.successful_count,started?1:2);
        assert.equal(row?.provider_requests,2);
        assert.equal(calls,started?0:1);
        assert.equal((await db.query('SELECT * FROM styling_checkpoints WHERE step_id=$1 AND ordinal=1 AND image=$2',[job.stepId,saved])).length,1);
    }
    console.log('styling checkpoint cancellation / lease recovery contracts passed');
    const fileStore = await import('../server/lib/fileStore');
    {
        const run = await queue.enqueueGenerationRun({ steps: [step(1)] }, owner.id, { userId: owner.id, nodeId: 'styling', nodeLabel: '搭配', kind: 'ai-styling', requestedCount: 1 });
        const beforeFiles = new Set(fs.readdirSync(fileStore.uploadsDir()));
        const workerId = 'styling-checkpoint-owner';
        const provider: AIProvider = {
            id: 'gemini-3.1-flash-image',
            generate: async () => { throw new Error('must edit'); },
            edit: async () => {
                await db.query("UPDATE generation_jobs SET worker_id='styling-checkpoint-successor' WHERE run_id=$1", [run.id]);
                return { images: [image], model: 'gemini-3.1-flash-image' };
            },
        };
        await queue.processNextGenerationJob(workerId, { resolveProvider: () => provider });
        const leakedFiles = fs.readdirSync(fileStore.uploadsDir()).filter(file => !beforeFiles.has(file));
        assert.deepEqual(leakedFiles, [], '租约丢失导致检查点事务回滚时必须清理未登记的生成图');
        await db.query('DELETE FROM generation_runs WHERE id=$1', [run.id]);
    }
    const ref = await fileStore.persistImageRef(image);
    await db.query("INSERT INTO files(id,owner_id,source_type,created_at) VALUES($1,$2,'upload',$3)", [ref.slice('/api/files/'.length), owner.id, new Date().toISOString()]);
    const flow = { schemaVersion: WORKFLOW_SCHEMA_VERSION, nodes: [{ id: 'reference', type: 'outfit-reference', position: { x: 0, y: 0 }, data: { kind: 'outfit-reference', label: '参考图', status: 'idle', images: [ref], mainImage: ref } }, { id: 'styling', type: 'ai-styling', position: { x: 360, y: 0 }, data: { kind: 'ai-styling', label: '搭配', status: 'idle', prompt: '', aspectRatio: '3:4', batchSize: 1, modelId: 'gemini-3.1-flash-image', modelOptions: defaultImageModelOptions('gemini-3.1-flash-image', '3:4'), outputImages: [], preserve: null, extras: analysis.existingExtras } }], edges: [{ id: 'edge', source: 'reference', target: 'styling', sourceHandle: 'image', targetHandle: 'references' }] };
    await db.query('INSERT INTO projects(id,owner_id,name,flow_json,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)', ['project', owner.id, 'test', JSON.stringify(flow), new Date().toISOString()]);
    const { outfitAnalysisRouter, assertStylingAnalyses } = await import('../server/routes/outfitAnalysis');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as AuthenticatedRequest).authUser = { id: owner.id } as never; next(); });
    app.use('/analysis', outfitAnalysisRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/analysis`;
    const originalFetch = globalThis.fetch;
    let visionCalls = 0;
    globalThis.fetch = async (input, init) => {
        if (String(input).startsWith('https:')) {
            visionCalls++;
            return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(analysis) }] } }] }), { status: 200 });
        }
        return originalFetch(input, init);
    };
    try {
        const body = { projectId: 'project', nodeId: 'styling', images: [ref], mainImage: ref, clientRequestId: 'styling-analysis-request-1' };
        const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal(response.status, 202);
        const pending = await response.json() as {
            id: string;
            referenceFingerprint: string;
        };
        let recognized: {
            status: string;
            sourceNodeId?: string;
            images?: string[];
        } | undefined;
        for (let i = 0; i < 100; i++) {
            recognized = await (await fetch(`${base}/${pending.id}`)).json();
            if (recognized?.status !== 'running')
                break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(recognized?.status, 'succeeded');
        assert.equal(recognized.sourceNodeId, 'reference');
        assert.deepEqual(recognized.images, [ref]);
        const replay = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, clientRequestId: 'styling-analysis-request-2' }) });
        assert.equal((await replay.json() as {
            id: string;
        }).id, pending.id);
        assert.equal(visionCalls, 1);
        const copiedFlow = JSON.parse(JSON.stringify(flow));
        copiedFlow.nodes[0].id = 'reference-copy';
        copiedFlow.nodes[1].id = 'styling-copy';
        copiedFlow.edges[0].source = 'reference-copy';
        copiedFlow.edges[0].target = 'styling-copy';
        await db.query('INSERT INTO projects(id,owner_id,name,flow_json,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)', ['project-copy', owner.id, 'copy', JSON.stringify(copiedFlow), new Date().toISOString()]);
        const copiedResponse = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, projectId: 'project-copy', nodeId: 'styling-copy', clientRequestId: 'styling-analysis-copy' }) });
        const copied = await copiedResponse.json() as {id:string;status:string;sourceNodeId:string};
        assert.equal(copiedResponse.status, 200);
        assert.equal(copied.status, 'succeeded');
        assert.equal(copied.sourceNodeId, 'reference-copy');
        assert.notEqual(copied.id, pending.id);
        assert.equal(visionCalls, 1);
        const plan = { steps: [{ ...step(1), inputImages: [ref], upstream: [{ nodeId: 'reference', images: [ref] }], params: { ...step(1).params, analysisId: pending.id, referenceFingerprint: pending.referenceFingerprint } }] };
        await db.transaction(client => assertStylingAnalyses(plan, owner.id, 'project', client));
        await assert.rejects(db.transaction(client => assertStylingAnalyses({ ...plan, steps: [{ ...plan.steps[0], inputImages: ['/api/files/changed'] }] }, owner.id, 'project', client)), /重新识别/);
        const hidden = await fetch(`${base}/nonexistent`);
        assert.equal(hidden.status, 404);
        const invalid = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, images: ['https://untrusted/image'], mainImage: 'https://untrusted/image' }) });
        assert.equal(invalid.status, 400);
        assert.equal(visionCalls, 1);
    }
    finally {
        globalThis.fetch = originalFetch;
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    console.log('styling recognition POST / GET / dedup / stale generation contracts passed');
}
finally {
    await db.closeDatabaseForTests();
    fs.rmSync(temp, { recursive: true, force: true });
}

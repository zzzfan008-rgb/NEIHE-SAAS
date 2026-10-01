import { Router } from 'express';
import { nanoid } from 'nanoid';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import type { OutfitAnalysis, OutfitAnalysisRecord } from '../../src/types/styling';
import type { ExecutionPlan } from '../../src/types/workflow';
import { orderedOutfitImages, stylingBlockReason } from '../../src/lib/styling';
import { queryOne, transaction } from '../lib/database';
import { requestUser } from '../lib/auth';
import { asyncHandler } from '../lib/asyncHandler';
import { validateAndMigrateFlow } from '../lib/workflowSchema';
import { assertImageReferencesAccessible } from '../lib/imageReferenceAccess';
import { isLocalImageReference } from '../lib/imageValidation';
import { analyzeOutfitImages, outfitFingerprint, parseOutfitAnalysis } from '../lib/outfitAnalysis';
import { resolveImageRefs } from '../engine/runner';
import { assertGenerationOwnerActive, CLIENT_REQUEST_ID_PATTERN } from '../engine/runQueue';
import { DagError } from '../engine/dag';
import { config } from '../config';
import { ProviderError, publicProviderErrorMessage } from '../providers/base';
interface AnalysisRow {
    id: string;
    owner_id: string;
    project_id: string;
    node_id: string;
    source_node_id: string;
    images: string[];
    fingerprint: string;
    status: OutfitAnalysisRecord['status'];
    result: OutfitAnalysis | null;
    error: string | null;
    updated_at: number;
}
function record(row: AnalysisRow): OutfitAnalysisRecord { return { id: row.id, status: row.status, sourceNodeId: row.source_node_id, images: row.images, referenceFingerprint: row.fingerprint, ...(row.result ? { result: parseOutfitAnalysis(row.result) } : {}), ...(row.error ? { error: row.error } : {}) }; }
export const outfitAnalysisRouter = Router();
export async function assertStylingAnalyses(plan: ExecutionPlan, ownerId: string, projectId: string, client: PoolClient): Promise<void> {
    for (const step of plan.steps.filter(s => s.kind === 'ai-styling')) {
        const sources = step.upstream ?? [];
        if (sources.length !== 1)
            throw new DagError('搭配节点必须连接一个参考图上传节点');
        const fingerprint = outfitFingerprint(sources[0].nodeId, step.inputImages);
        const row = await queryOne<AnalysisRow>('SELECT * FROM outfit_analyses WHERE id=$1 AND owner_id=$2 AND project_id=$3 AND node_id=$4 FOR SHARE', [step.params.analysisId ?? '', ownerId, projectId, step.nodeId], client);
        if (!row || row.status !== 'succeeded' || row.fingerprint !== fingerprint || step.params.referenceFingerprint !== fingerprint || !row.result)
            throw new DagError('参考图或识别结果已变化，请重新识别服饰');
        const analysis = parseOutfitAnalysis(row.result);
        const reason = stylingBlockReason(step.params as never, step.inputImages, !analysis.ambiguous && analysis.categories.length > 0, step.params.preserve === 'whole' && analysis.existingExtras.outerwear || step.params.preserve === 'upper' && analysis.upperIsOuterwear);
        if (reason)
            throw new DagError(reason);
        step.params.outfitAnalysis = analysis;
    }
}
async function performAnalysis(id: string, images: string[]): Promise<void> {
    try {
        const resolved = await resolveImageRefs(images);
        await queryOne('UPDATE outfit_analyses SET provider_requests=1,updated_at=$2 WHERE id=$1 RETURNING id', [id, Date.now()]);
        const result = await analyzeOutfitImages(resolved);
        await queryOne("UPDATE outfit_analyses SET status='succeeded',result=$2::jsonb,updated_at=$3 WHERE id=$1 AND status='running' RETURNING id", [id, JSON.stringify(result), Date.now()]);
    }
    catch (error) {
        const status = error instanceof ProviderError && error.category === 'outcome_unknown' ? 'outcome_unknown' : 'failed';
        const message = error instanceof ProviderError ? publicProviderErrorMessage(error) : '服饰识别失败，请重试';
        await queryOne('UPDATE outfit_analyses SET status=$2,error=$3,updated_at=$4 WHERE id=$1 AND status=\'running\' RETURNING id', [id, status, message, Date.now()]).catch(() => undefined);
    }
}
outfitAnalysisRouter.post('/', asyncHandler(async (req, res) => {
    const { projectId, nodeId, images, mainImage, clientRequestId } = req.body ?? {};
    if (typeof projectId !== 'string' || typeof nodeId !== 'string' || typeof clientRequestId !== 'string' || !CLIENT_REQUEST_ID_PATTERN.test(clientRequestId) || !Array.isArray(images) || !images.length || images.length > 8 || new Set(images).size !== images.length || !images.every(v => typeof v === 'string' && isLocalImageReference(v)) || mainImage !== images[0]) {
        res.status(400).json({ error: '请提供主图在前的有效本地参考图' });
        return;
    }
    const ownerId = requestUser(req).id;
    let created = false;
    try {
        const row = await transaction(async (client) => {
            await assertGenerationOwnerActive(client, ownerId);
            const project = await queryOne<{
                flow_json: string;
            }>('SELECT flow_json FROM projects WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND lifecycle=\'saved\' FOR SHARE', [projectId, ownerId], client);
            if (!project)
                return undefined;
            const flow = validateAndMigrateFlow(JSON.parse(project.flow_json));
            const node = flow.nodes.find(n => n.id === nodeId && n.data.kind === 'ai-styling');
            const incoming = flow.edges.filter(e => e.target === nodeId);
            const source = incoming.length === 1 ? flow.nodes.find(n => n.id === incoming[0].source) : undefined;
            if (!node || source?.data.kind !== 'outfit-reference' || !isDeepStrictEqual(orderedOutfitImages(source.data), images))
                throw new DagError('请先保存当前参考图，再识别服饰');
            await assertImageReferencesAccessible(images, ownerId, client);
            const fingerprint = outfitFingerprint(source.id, images);
            // Serialize same owner requests, including distinct request IDs for the same input.
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`outfit:${ownerId}`]);
            const prior = await queryOne<AnalysisRow>('SELECT * FROM outfit_analyses WHERE owner_id=$1 AND client_request_id=$2', [ownerId, clientRequestId], client);
            if (prior) {
                if (prior.project_id !== projectId || prior.node_id !== nodeId || prior.fingerprint !== fingerprint)
                    throw new DagError('请求号已用于其他参考图');
                return prior;
            }
            const cached = await queryOne<AnalysisRow>("SELECT * FROM outfit_analyses WHERE owner_id=$1 AND project_id=$2 AND node_id=$3 AND fingerprint=$4 AND status IN ('running','succeeded','outcome_unknown') ORDER BY created_at DESC LIMIT 1", [ownerId, projectId, nodeId, fingerprint], client);
            if (cached)
                return cached;
            // The cache is content/order + contract version; document identity stays on the new row.
            const cacheKey = outfitFingerprint('', images);
            const reusable = await queryOne<AnalysisRow>("SELECT * FROM outfit_analyses WHERE owner_id=$1 AND cache_key=$2 AND status='succeeded' ORDER BY created_at DESC LIMIT 1", [ownerId, cacheKey], client);
            if (reusable?.result) {
                const result = parseOutfitAnalysis(reusable.result);
                return queryOne<AnalysisRow>("INSERT INTO outfit_analyses(id,owner_id,project_id,node_id,source_node_id,images,fingerprint,cache_key,client_request_id,status,result,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,'succeeded',$10::jsonb,$11,$11) RETURNING *", [nanoid(16),ownerId,projectId,nodeId,source.id,JSON.stringify(images),fingerprint,cacheKey,clientRequestId,JSON.stringify(result),Date.now()],client);
            }
            created = true;
            return queryOne<AnalysisRow>("INSERT INTO outfit_analyses(id,owner_id,project_id,node_id,source_node_id,images,fingerprint,cache_key,client_request_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,'running',$10,$10) RETURNING *", [nanoid(16), ownerId, projectId, nodeId, source.id, JSON.stringify(images), fingerprint, cacheKey, clientRequestId, Date.now()], client);
        });
        if (!row) {
            res.status(404).json({ error: '项目不存在' });
            return;
        }
        res.status(created ? 202 : 200).json(record(row));
        if (created)
            void performAnalysis(row.id, images);
    }
    catch (error) {
        res.status(400).json({ error: error instanceof DagError ? error.message : '无法识别当前参考图，请确认已保存且有访问权限' });
    }
}));
outfitAnalysisRouter.get('/:id', asyncHandler(async (req, res) => {
    const ownerId = requestUser(req).id;
    await queryOne("UPDATE outfit_analyses SET status='outcome_unknown',error='识别响应中断，请核对后使用新参考图重试',updated_at=$3 WHERE id=$1 AND owner_id=$2 AND status='running' AND updated_at<$4 RETURNING id", [req.params.id, ownerId, Date.now(), Date.now() - config.aiTimeoutMs(120000) - 60000]);
    const row = await queryOne<AnalysisRow>('SELECT a.* FROM outfit_analyses a JOIN projects p ON p.id=a.project_id WHERE a.id=$1 AND a.owner_id=$2 AND p.owner_id=$2 AND p.deleted_at IS NULL', [req.params.id, ownerId]);
    if (!row) {
        res.status(404).json({ error: '识别记录不存在' });
        return;
    }
    res.json(record(row));
}));

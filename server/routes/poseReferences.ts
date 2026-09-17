import { Router } from 'express';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import sharp from 'sharp';
import type { PoolClient } from 'pg';
import { query, queryOne, transaction } from '../lib/database';
import { requestUser } from '../lib/auth';
import { asyncHandler } from '../lib/asyncHandler';
import { assertImageReferencesAccessible, ImageReferenceAccessError } from '../lib/imageReferenceAccess';
import { isLocalImageReference, validateImageDataUrl } from '../lib/imageValidation';
import { resolveToDataUrl } from '../lib/fileStore';
import { analyzeDWPoseReference } from '../lib/dwposeAnalysis';
import { analyzeDepthReference } from '../lib/depthAnalysis';
import { config } from '../config';
import { ProviderError } from '../providers/base';
import { isPoseReferenceNode, type PoseOutfitReferenceRecord, type PoseOutfitReferenceStatus, type PoseReferenceKind, type PoseReferenceRecord } from '../../src/types/poseReference';
import type { ExecutionPlan } from '../../src/types/workflow';
import { DEFAULT_GENERATION_MODEL_ID } from '../../src/types/imageModels';
import { POSE_OUTFIT_REFERENCE_PROMPT } from '../engine/runner';
import {
  ActiveRunLimitError,
  assertGenerationOwnerActive,
  CLIENT_REQUEST_ID_PATTERN,
  enqueueGenerationRunInTransaction,
  GenerationOwnerUnavailableError,
  GenerationRequestConflictError,
} from '../engine/runQueue';

interface Row {
  id: string; owner_id: string; project_id: string; node_id: string; source: string;
  kind: PoseReferenceKind; configuration: string; attempt: string;
  status: PoseReferenceRecord['status']; result: PoseReferenceRecord['result'] | null; error: string | null;
}
interface PoseOutfitRow {
  id: string;
  status: string;
  model: string | null;
  error: string | null;
  output_image: string | null;
  provider_output_size: string | null;
}
type Analyzer = (image: string, kind: PoseReferenceKind, markProvider: () => Promise<void>) => Promise<NonNullable<PoseReferenceRecord['result']>>;
class RequestError extends Error { constructor(public status: number, message: string) { super(message); } }
const record = (row: Row): PoseReferenceRecord => ({id:row.id,kind:row.kind,source:row.source,status:row.status,...(row.result?{result:row.result}:{}),...(row.error?{error:row.error}:{})});
const POSE_OUTFIT_REFERENCE_KIND = 'pose-reference-outfit';

function poseOutfitStatus(status: string): PoseOutfitReferenceStatus {
  if (status === 'success' || status === 'succeeded') return 'succeeded';
  if (status === 'error' || status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'outcome_unknown') return 'outcome_unknown';
  if (status === 'cancel_requested') return 'running';
  if (status === 'running' || status === 'retry_wait' || status === 'queued') return status;
  return 'failed';
}

function isPoseOutfitActive(row: PoseOutfitRow): boolean {
  return ['queued', 'running', 'retry_wait', 'cancel_requested'].includes(row.status);
}

async function findPoseOutfitRows(
  owner: string,
  input: {projectId: string; nodeId: string; source: string},
  client: PoolClient,
  legacy = false,
): Promise<PoseOutfitRow[]> {
  return query<PoseOutfitRow>(`
    SELECT r.id, r.status, r.model, r.error,
      output.image AS output_image,
      output.provider_output_size
    FROM generation_runs r
    LEFT JOIN LATERAL (
      SELECT o.image, o.provider_output_size
      FROM generation_outputs o
      WHERE o.run_id = r.id AND o.status = 'success' AND o.image <> ''
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT 1
    ) output ON TRUE
    WHERE r.owner_id = $1 AND r.project_id = $2 AND r.node_id = $3
      AND r.kind = $4 AND r.reference_images_json = $5
      AND r.deleted_at IS NULL
      AND COALESCE(r.parameters_json::jsonb->>'poseOutfitVersion', '') = $6
    ORDER BY r.started_at DESC, r.id DESC
    LIMIT 16
  `, [owner, input.projectId, input.nodeId, POSE_OUTFIT_REFERENCE_KIND, JSON.stringify([input.source]), legacy ? '' : 'leggings-v1'], client);
}

function poseOutfitRecord(
  row: PoseOutfitRow,
  source: string,
  fallback?: PoseOutfitRow,
): PoseOutfitReferenceRecord {
  const output = row.output_image ? row : fallback;
  return {
    id: row.id,
    runId: row.id,
    source,
    status: poseOutfitStatus(row.status),
    ...(output?.output_image ? {
      result: {
        image: output.output_image,
        model: output.model ?? DEFAULT_GENERATION_MODEL_ID,
        providerOutputSize: output.provider_output_size,
      },
    } : {}),
    ...(row.error ? {error: row.error} : {}),
  };
}

function configuration(kind: PoseReferenceKind): string {
  const values = kind === 'skeleton' ? ['dwpose-v1',process.env.POSE_SERVICE_URL ?? '',process.env.POSE_MODEL_REVISION ?? '1a7144101628d69ee7a3768d1ee3a094070dc388'] :
    ['depth-v1', process.env.DEPTH_SERVICE_URL ?? '', process.env.DEPTH_INPUT_SIZE ?? '518', process.env.DEPTH_MODEL_REVISION ?? 'vitl-official-v1'];
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

async function authorize(owner: string, input: {projectId: string; nodeId: string; source: string; analysisSource?: string}, client: PoolClient): Promise<{name: string}> {
  const project = await queryOne<{flow_json:string; name:string}>(`SELECT p.flow_json,p.name FROM projects p JOIN users u ON u.id=p.owner_id
    WHERE p.id=$1 AND p.owner_id=$2 AND p.deleted_at IS NULL AND p.lifecycle='saved'
      AND u.active=1 AND u.deleted_at IS NULL FOR SHARE OF p,u`,[input.projectId,owner],client);
  if (!project) throw new RequestError(404,'项目不存在');
  const flow = JSON.parse(project.flow_json);
  const node = flow.nodes?.find((n: {id:string})=>n.id===input.nodeId);
  if (!node || node.data.imageUrl !== input.source || !isPoseReferenceNode(input.nodeId,flow.nodes,flow.edges)) {
    throw new RequestError(409,'姿势参考图已变化，请保存当前项目后重试');
  }
  await assertImageReferencesAccessible([input.source],owner,client);
  if (input.analysisSource && input.analysisSource !== input.source) {
    const derived = await queryOne(`SELECT o.id FROM generation_outputs o JOIN generation_runs r ON r.id=o.run_id
      WHERE r.owner_id=$1 AND r.project_id=$2 AND r.node_id=$3 AND r.kind=$4
        AND r.reference_images_json=$5 AND r.deleted_at IS NULL AND o.status='success' AND o.image=$6
        AND r.parameters_json::jsonb->>'poseOutfitVersion'='leggings-v1' LIMIT 1`,
      [owner,input.projectId,input.nodeId,POSE_OUTFIT_REFERENCE_KIND,JSON.stringify([input.source]),input.analysisSource],client);
    if (!derived) throw new RequestError(404,'姿势派生图片不存在');
    await assertImageReferencesAccessible([input.analysisSource],owner,client);
  }
  return {name:project.name};
}

function parseInput(body: Record<string,unknown>) {
  if (typeof body.projectId !== 'string' || !/^[\w-]{1,128}$/.test(body.projectId) ||
      typeof body.nodeId !== 'string' || !/^[\w-]{1,128}$/.test(body.nodeId) || !isLocalImageReference(body.source)) {
    throw new RequestError(400,'请提供已保存项目中的本地姿势参考图');
  }
  if (body.analysisSource !== undefined && !isLocalImageReference(body.analysisSource)) throw new RequestError(400,'姿势分析来源无效');
  return {projectId:body.projectId,nodeId:body.nodeId,source:body.source,analysisSource:typeof body.analysisSource==='string'?body.analysisSource:body.source};
}

async function expire(owner: string, client: PoolClient) {
  const timeout = Math.max(180_000,config.aiTimeoutMs(120_000)) + 60_000;
  await client.query(`UPDATE pose_references SET status=CASE WHEN provider_requests>0 THEN 'outcome_unknown' ELSE 'failed' END,
    error='任务中断或超时，请核对结果后手动重试',updated_at=$2
    WHERE owner_id=$1 AND status='running' AND updated_at<$3`,[owner,Date.now(),Date.now()-timeout]);
}

const defaultAnalyze: Analyzer = async (image,kind) => {
  if (kind==='depth') return analyzeDepthReference(image);
  return analyzeDWPoseReference(image);
};

async function perform(row: Row, image: string, analyze: Analyzer) {
  try {
    const mark = async () => { await query(`UPDATE pose_references SET provider_requests=provider_requests+1 WHERE id=$1 AND attempt=$2 AND status='running'`,[row.id,row.attempt]); };
    const result = await analyze(image,row.kind,mark);
    const {buffer} = validateImageDataUrl(result.image);
    await sharp(buffer,{limitInputPixels:40_000_000}).stats();
    if (!result.model || typeof result.model !== 'string') throw new Error('Invalid model');
    await query(`UPDATE pose_references r SET result=$3::jsonb,status='succeeded',error=NULL,updated_at=$4
      WHERE r.id=$1 AND r.attempt=$2 AND r.status='running'
      AND EXISTS(SELECT 1 FROM projects p JOIN users u ON u.id=p.owner_id WHERE p.id=r.project_id AND p.owner_id=r.owner_id AND p.deleted_at IS NULL AND u.active=1 AND u.deleted_at IS NULL)`,
      [row.id,row.attempt,JSON.stringify(result),Date.now()]);
  } catch (error) {
    const unknown = error instanceof ProviderError && error.category==='outcome_unknown';
    await query(`UPDATE pose_references SET status=$3,error=$4,updated_at=$5 WHERE id=$1 AND attempt=$2 AND status='running'`,
      [row.id,row.attempt,unknown?'outcome_unknown':'failed', row.kind==='depth'?'深度生成失败，请检查本地服务后重试':'骨骼生成失败，请确认图片中有人物，并检查本地 DWPose 服务后重试',Date.now()]).catch(()=>undefined);
  }
}

export function createPoseReferencesRouter(options: {analyze?: Analyzer} = {}) {
  const router = Router();
  router.get('/',asyncHandler(async(req,res)=>{
    try {
      const input = parseInput(req.query as Record<string,unknown>);
      const records = await transaction(async(client)=>{
        const owner = requestUser(req).id;
        await authorize(owner,input,client);
        input.source = input.analysisSource;
        await expire(owner,client);
        const rows = await query<Row>(`SELECT DISTINCT ON (kind) current.*,
          COALESCE(current.result, (SELECT previous.result FROM pose_references previous
            WHERE previous.owner_id=current.owner_id AND previous.project_id=current.project_id
              AND previous.node_id=current.node_id AND previous.source=current.source
              AND previous.kind=current.kind AND previous.status='succeeded'
            ORDER BY previous.created_at DESC LIMIT 1)) AS result
          FROM pose_references current
          WHERE owner_id=$1 AND project_id=$2 AND node_id=$3 AND source=$4
          ORDER BY kind,(configuration=CASE WHEN kind='skeleton' THEN $5 ELSE $6 END) DESC,created_at DESC`,
          [owner,input.projectId,input.nodeId,input.source,configuration('skeleton'),configuration('depth')],client);
        return rows.map(record);
      });
      res.setHeader('Cache-Control','no-store');
      res.json({records});
    } catch(error) { handleError(error,res); }
  }));
  router.post('/',asyncHandler(async(req,res)=>{
    try {
      const input = parseInput(req.body ?? {});
      const {kind,requestId,retry} = req.body;
      if (!['skeleton','depth'].includes(kind) || typeof requestId!=='string' || !/^[\w-]{8,128}$/.test(requestId) || (retry!==undefined && typeof retry!=='boolean')) throw new RequestError(400,'生成参数无效');
      let pending: {row:Row;image:string} | undefined;
      const row = await transaction(async(client)=>{
        const owner = requestUser(req).id;
        await authorize(owner,input,client);
        input.source = input.analysisSource;
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`pose:${owner}`]);
        await expire(owner,client);
        const key = configuration(kind);
        const prior = await queryOne<Row>('SELECT * FROM pose_references WHERE owner_id=$1 AND project_id=$2 AND node_id=$3 AND source=$4 AND kind=$5 AND configuration=$6', [owner,input.projectId,input.nodeId,input.source,kind,key],client);
        if (prior && (prior.status==='running' || prior.status==='succeeded' || !retry || prior.attempt===requestId)) return prior;
        const active = await queryOne<{count:number}>("SELECT COUNT(*)::int AS count FROM pose_references WHERE owner_id=$1 AND status='running'",[owner],client);
        if ((active?.count??0)>=2) throw new RequestError(429,'已有姿势任务运行中，请稍后重试');
        if (!prior) {
          const count = await queryOne<{count:number}>('SELECT COUNT(*)::int AS count FROM pose_references WHERE owner_id=$1',[owner],client);
          if ((count?.count??0)>=128) throw new RequestError(429,'姿势参考记录已达上限，请联系管理员');
        }
        const image = resolveToDataUrl(input.source);
        validateImageDataUrl(image);
        const updated = prior ? await queryOne<Row>(`UPDATE pose_references SET attempt=$2,status='running',error=NULL,updated_at=$3 WHERE id=$1 RETURNING *`,[prior.id,requestId,Date.now()],client)
          : await queryOne<Row>(`INSERT INTO pose_references(id,owner_id,project_id,node_id,source,kind,configuration,attempt,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,$9) RETURNING *`,[nanoid(16),owner,input.projectId,input.nodeId,input.source,kind,key,requestId,Date.now()],client);
        pending={row:updated!,image};
        return updated!;
      });
      if (pending) void perform(pending.row,pending.image,options.analyze??defaultAnalyze);
      res.status(row.status==='running'?202:200).json(record(row));
    } catch(error) { handleError(error,res); }
  }));
  router.get('/outfit',asyncHandler(async(req,res)=>{
    try {
      const input = parseInput(req.query as Record<string,unknown>);
      const outfit = await transaction(async(client)=>{
        const owner = requestUser(req).id;
        await authorize(owner,input,client);
        const rows = await findPoseOutfitRows(owner,input,client);
        const latest = rows[0];
        const legacy = (await findPoseOutfitRows(owner,input,client,true)).find(row=>Boolean(row.output_image));
        return {
          record: latest ? poseOutfitRecord(latest,input.source,rows.find((row)=>Boolean(row.output_image))) : null,
          legacyRecord: legacy ? poseOutfitRecord(legacy,input.source) : null,
        };
      });
      res.setHeader('Cache-Control','no-store');
      res.json(outfit);
    } catch(error) { handleError(error,res); }
  }));
  router.post('/outfit',asyncHandler(async(req,res)=>{
    try {
      const input = parseInput(req.body ?? {});
      const {requestId,retry} = req.body as {requestId?: unknown; retry?: unknown};
      if (typeof requestId!=='string' || !CLIENT_REQUEST_ID_PATTERN.test(requestId) || (retry!==undefined && typeof retry!=='boolean')) {
        throw new RequestError(400,'生成参数无效');
      }
      const outcome = await transaction(async(client)=>{
        const owner = requestUser(req).id;
        await assertGenerationOwnerActive(client,owner);
        const project = await authorize(owner,input,client);
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`pose-outfit:${owner}:${input.projectId}:${input.nodeId}`]);
        const rows = await findPoseOutfitRows(owner,input,client);
        const prior = rows[0];
        const legacyPending = (await findPoseOutfitRows(owner,input,client,true)).find(row=>isPoseOutfitActive(row)||row.status==='outcome_unknown');
        if (!prior && legacyPending) throw new RequestError(409,'旧版服饰替换任务尚未确认结束，请先核对历史记录，避免重复扣费');
        const fallback = rows.find((row)=>Boolean(row.output_image));
        if (prior?.status==='outcome_unknown' && retry===true) {
          throw new RequestError(409,'上次请求结果未知，请先核对历史记录后再重试，避免重复扣费');
        }
        if (prior && (isPoseOutfitActive(prior) || ['success','succeeded'].includes(prior.status) || retry!==true)) {
          return {
            status: isPoseOutfitActive(prior) ? 202 : 200,
            record: poseOutfitRecord(prior,input.source,fallback),
            cached: true,
          };
        }
        const plan: ExecutionPlan = {
          steps: [{
            nodeId: input.nodeId,
            kind: 'character-board',
            inputImages: [input.source],
            params: {
              modelId: DEFAULT_GENERATION_MODEL_ID,
              batchSize: 1,
              poseOutfitOnly: true,
              poseOutfitVersion: 'leggings-v1',
            },
          }],
        };
        const run = await enqueueGenerationRunInTransaction(client,plan,owner,{
          userId: owner,
          clientRequestId: requestId,
          projectId: input.projectId,
          projectName: project.name,
          nodeId: input.nodeId,
          nodeLabel: '姿势参考·背心+紧身裤',
          kind: POSE_OUTFIT_REFERENCE_KIND,
          prompt: POSE_OUTFIT_REFERENCE_PROMPT,
          parameters: plan.steps[0].params,
          referenceImages: [input.source],
          requestedCount: 1,
        },'direct');
        return {
          status: 202,
          record: {
            id: run.id,
            runId: run.id,
            source: input.source,
            status: 'queued' as const,
          },
          cached: false,
        };
      });
      res.status(outcome.status).json({record:outcome.record,runId:outcome.record.runId,cached:outcome.cached});
    } catch(error) { handleError(error,res); }
  }));
  return router;
}

function handleError(error: unknown,res: import('express').Response) {
  if (error instanceof RequestError) res.status(error.status).json({error:error.message});
  else if (error instanceof ImageReferenceAccessError) res.status(404).json({error:'图片不存在'});
  else if (error instanceof GenerationRequestConflictError || error instanceof ActiveRunLimitError || error instanceof GenerationOwnerUnavailableError) res.status(409).json({error:error.message});
  else res.status(500).json({error:'姿势参考服务暂不可用，请稍后重试'});
}

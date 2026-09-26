import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import sharp from 'sharp';
import type { PoseDocumentV1, PosePersonV1 } from '../src/types/poseDocument';
import type { AddressInfo } from 'node:net';
import { resetPostgresTestDatabase } from './postgresTestDatabase';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pose-references-'));
process.env.DATA_DIR = temp;
process.env.SQLITE_IMPORT_FILE = 'missing.db';
process.env.INITIAL_ADMIN_ACCOUNT_ID = '';
await resetPostgresTestDatabase();
const { initializeDatabase, closeDatabaseForTests, query, queryOne } = await import('../server/lib/database');
const { createSession, requireAuth, requirePasswordChanged, SESSION_COOKIE } = await import('../server/lib/auth');
const { saveDataUrl } = await import('../server/lib/fileStore');
await initializeDatabase();
const now = new Date().toISOString();
const sessions: Record<string,string> = {};
for (const user of ['owner', 'other']) {
  await query("INSERT INTO users(id,account_id,display_name,role,password_hash,must_change_password,active,created_at,updated_at) VALUES($1,$1,$1,'user','test',0,1,$2,$2)", [user,now]);
  sessions[user] = (await createSession(user)).token;
}
const png = `data:image/png;base64,${(await sharp({create:{width:30,height:50,channels:3,background:'white'}}).png().toBuffer()).toString('base64')}`;
const depthPng = `data:image/png;base64,${(await sharp({create:{width:30,height:50,channels:3,background:'#777777'}}).png().toBuffer()).toString('base64')}`;
const stored = saveDataUrl(png);
await query("INSERT INTO files(id,owner_id,created_at) VALUES($1,'owner',$2)", [stored.id,now]);
const flow = {nodes:[{id:'pose',type:'image-input',position:{x:0,y:0},data:{kind:'image-input',label:'人物姿势参考图（必需）',poseReference:true,status:'idle',imageRole:'reference',imageUrl:stored.url}}, {id:'stabilize',type:'virtual-try-on',position:{x:400,y:0},data:{kind:'virtual-try-on',workflowStage:'scene-stabilize',label:'定版',status:'idle'}}],edges:[]};
await query("INSERT INTO projects(id,owner_id,name,flow_json,created_at,updated_at,lifecycle) VALUES('project','owner','test',$1,$2,$2,'saved')",[JSON.stringify(flow),now]);
let calls = 0;
let promptCalls = 0;
let promptOptions: import('../server/lib/poseAnalysis').PoseAnalysisOptions | undefined;
let release: (()=>void) | undefined;
let delayed = new Promise<void>(resolve=>{release=resolve;});
const app = express();
app.use(express.json());
app.use('/api',requireAuth,requirePasswordChanged);
const router = fs.existsSync('server/routes/poseReferences.ts')
  ? (await import('../server/routes/poseReferences')).createPoseReferencesRouter({
      analyze: async (image: string, kind: string) => {
        calls++;
        await delayed;
        if (kind === 'skeleton' && image === png) throw new Error('private provider detail');
        return {image: kind === 'depth' ? depthPng : png, model: kind === 'skeleton' ? 'test-skeleton' : 'test-depth'};
      },
      analyzePosePrompt: async (image: string, options) => {
        promptOptions = options;
        promptCalls++;
        assert.equal(image,png);
        return {prompt:'身体姿势：肩线左高右低；手部姿势：右手靠近髋部；头部姿势：头部向画面右侧旋转；视线方向：朝向画面右上方。',providerRequests:1,model:'test-pose-analysis',cacheHit:false};
      },
    }) : express.Router();
app.use('/api/pose-references',router);
app.use('/api/pose-local',(await import('../server/routes/poseReferences')).createPoseReferencesRouter());
const server = app.listen(0,'127.0.0.1');
await new Promise<void>(resolve=>server.once('listening',resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const body = {projectId:'project',nodeId:'pose',source:stored.url,kind:'depth',requestId:'request-depth-123'};
const req = (method: string, data: unknown = body, user='owner') => fetch(base+'/api/pose-references'+(method==='GET'?'?'+new URLSearchParams({projectId:'project',nodeId:'pose',source:stored.url}):''),{method,headers:{'content-type':'application/json',cookie:`${SESSION_COOKIE}=${sessions[user]??''}`},...(method==='POST'?{body:JSON.stringify(data)}:{})});
const analyzeBody = {projectId:'project',nodeId:'pose',source:stored.url};
const analyzeReq = (data: unknown = analyzeBody, user='owner') => fetch(base+'/api/pose-references/analyze',{method:'POST',headers:{'content-type':'application/json',cookie:`${SESSION_COOKIE}=${sessions[user]??''}`},body:JSON.stringify(data)});
const manualPoint = {x:15,y:20,confidence:1,origin:'manual' as const};
const renderPerson: PosePersonV1 = {
  id:'00000000-0000-4000-8000-000000000001',topology:'coco-wholebody-133',neck:manualPoint,midHip:manualPoint,
  body:Array.from({length:17},()=>null),feet:Array.from({length:6},()=>null),face:Array.from({length:70},()=>null),faceTopology:'face68',
  hands:{left:Array.from({length:21},()=>null),right:Array.from({length:21},()=>null)},
};
renderPerson.body[5]={...manualPoint,x:10,y:12};
renderPerson.body[6]={...manualPoint,x:20,y:12};
renderPerson.body[11]={...manualPoint,x:12,y:30};
renderPerson.body[12]={...manualPoint,x:18,y:30};
const renderDocument: PoseDocumentV1 = {
  version:1,canvas:{width:30,height:50},people:[renderPerson],
  source:{analysisImage:stored.url,kind:'image',model:'manual'},imageBinding:stored.url,
};
const renderBody = {...analyzeBody,poseDocument:renderDocument};
const renderReq = (data: unknown = renderBody, user='owner') => fetch(base+'/api/pose-references/render',{
  method:'POST',headers:{'content-type':'application/json',cookie:`${SESSION_COOKIE}=${sessions[user]??''}`},body:JSON.stringify(data),
});
const outfitBody = {projectId:'project',nodeId:'pose',source:stored.url,requestId:'outfit-request-123'};
const outfitReq = (method: string, data: unknown = outfitBody, user='owner') => fetch(base+'/api/pose-references/outfit'+(method==='GET'?'?'+new URLSearchParams({projectId:'project',nodeId:'pose',source:stored.url}):''),{method,headers:{'content-type':'application/json',cookie:`${SESSION_COOKIE}=${sessions[user]??''}`},...(method==='POST'?{body:JSON.stringify(data)}:{})});
try {
  assert.equal((await analyzeReq(analyzeBody,'none')).status,401);
  const promptResponse=await analyzeReq();
  assert.equal(promptResponse.status,200,'姿势反推接口必须接受当前已保存的姿势参考图');
  const prompt=await promptResponse.json();
  assert.equal(prompt.prompt,'身体姿势：肩线左高右低；手部姿势：右手靠近髋部；头部姿势：头部向画面右侧旋转；视线方向：朝向画面右上方。');
  assert.equal(prompt.model,'test-pose-analysis');
  assert.equal(prompt.providerRequests,1);
  assert.equal(prompt.cacheHit,false);
  assert.equal(promptCalls,1);
  assert.equal((await analyzeReq({...analyzeBody,provider:'unknown'})).status,400);
  assert.equal((await analyzeReq({...analyzeBody,provider:'deepseek'})).status,400);
  assert.equal(promptCalls,1, 'Invalid options must not call a model');
  const deepseekResponse=await analyzeReq({...analyzeBody,provider:'deepseek',apiKey:'test-deepseek-key',ownerId:'forged-owner'});
  assert.equal(deepseekResponse.status,200);
  assert.deepEqual(promptOptions,{provider:'deepseek',apiKey:'test-deepseek-key',ownerId:'owner'});
  assert.ok(!(await deepseekResponse.text()).includes('test-deepseek-key'));
  assert.equal((await analyzeReq({...analyzeBody,provider:'deepseek',apiKey:'test-deepseek-key'},'other')).status,404);
  assert.equal((await analyzeReq(analyzeBody,'other')).status,404);
  assert.equal((await analyzeReq({...analyzeBody,analysisSource:'https://example.com/pose.png'})).status,400);
  assert.equal((await renderReq(renderBody,'none')).status,401,'pose rendering must require authentication');
  assert.equal((await renderReq(renderBody,'other')).status,404,'pose rendering must enforce project ownership');
  const renderedResponse=await renderReq();
  assert.equal(renderedResponse.status,200,'manual pose documents must render without invoking inference');
  const rendered=await renderedResponse.json();
  assert.ok(rendered.image.startsWith('data:image/png;base64,'));
  assert.equal(rendered.poseDocument.imageBinding,null);
  const renderedMetadata=await sharp(Buffer.from(rendered.image.split(',')[1],'base64')).metadata();
  assert.deepEqual({width:renderedMetadata.width,height:renderedMetadata.height,format:renderedMetadata.format},{width:30,height:50,format:'png'});
  const appliedImage=saveDataUrl(depthPng);
  await query("INSERT INTO files(id,owner_id,created_at) VALUES($1,'owner',$2)", [appliedImage.id,now]);
  const persistedPoseDocument={...renderDocument,imageBinding:appliedImage.url};
  const appliedFlow=structuredClone(flow);
  const appliedNode=appliedFlow.nodes[0];
  appliedNode.data.imageUrl=appliedImage.url;
  appliedNode.data.poseDocument=persistedPoseDocument;
  appliedNode.data.poseReferenceSource={kind:'skeleton',image:appliedImage.url,neutralSource:stored.url};
  await query('UPDATE projects SET flow_json=$1 WHERE id=$2',[JSON.stringify(appliedFlow),'project']);
  const reapplied=await renderReq({...analyzeBody,source:appliedImage.url,analysisSource:stored.url,poseDocument:persistedPoseDocument});
  assert.equal(reapplied.status,200,'已保存的骨骼节点必须能用其绑定的原始分析图再次渲染');
  const unlinkedFlow=structuredClone(appliedFlow);
  delete unlinkedFlow.nodes[0].data.poseDocument;
  delete unlinkedFlow.nodes[0].data.poseReferenceSource;
  await query('UPDATE projects SET flow_json=$1 WHERE id=$2',[JSON.stringify(unlinkedFlow),'project']);
  const unlinked=await renderReq({...analyzeBody,source:appliedImage.url,analysisSource:stored.url,poseDocument:persistedPoseDocument});
  assert.equal(unlinked.status,404,'渲染不得接受未由当前骨骼文档关联的任意分析图');
  await query('UPDATE projects SET flow_json=$1 WHERE id=$2',[JSON.stringify(flow),'project']);
  assert.equal(calls,0,'local skeleton rendering must not call the inference provider');
  assert.equal((await renderReq({...renderBody,poseDocument:{...renderDocument,source:{...renderDocument.source,analysisImage:'/api/files/another.png'}}})).status,409);
  assert.equal((await renderReq({...renderBody,poseDocument:{...renderDocument,imageBinding:'https://example.com/image.png'}})).status,400);
  assert.equal((await req('POST',body,'none')).status,401);
  assert.equal((await req('POST',body,'other')).status,404);
  const first = await req('POST');
  assert.equal(first.status,202,'pose result API must accept an authorized saved pose image');
  const record = await first.json();
  const repeated = await (await req('POST')).json();
  assert.equal(repeated.id,record.id);
  release!();
  for(let i=0;i<100;i++) {
    if((await queryOne<{status:string}>('SELECT status FROM pose_references WHERE id=$1',[record.id]))?.status==='succeeded') break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  const results = await (await req('GET')).json();
  assert.equal(results.records[0].result.image,depthPng);
  assert.equal(calls,1);
  await req('POST');
  assert.equal(calls,1,'cache hit must not generate again');
  assert.equal((await req('GET',undefined,'other')).status,404);
  assert.equal((await req('POST',{...body,source:'https://example.com/private.png'})).status,400);
  const depthSkeletonBody = {
    ...body,
    kind: 'skeleton',
    requestId: 'depth-skeleton-request',
    analysisSourceKind: 'depth',
    analysisSourceRecordId: record.id,
  };
  const depthSkeleton = await req('POST',depthSkeletonBody);
  assert.equal(depthSkeleton.status,202,'深度图应能作为 DWPose 骨骼图来源提交');
  const depthSkeletonRecord = await depthSkeleton.json();
  for(let i=0;i<100;i++) {
    if((await queryOne<{status:string}>('SELECT status FROM pose_references WHERE id=$1',[depthSkeletonRecord.id]))?.status==='succeeded') break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  const depthSkeletonRow = await queryOne<{source:string;kind:string;result:unknown}>('SELECT source,kind,result FROM pose_references WHERE id=$1',[depthSkeletonRecord.id]);
  assert.equal(depthSkeletonRow?.source,stored.url);
  assert.equal(depthSkeletonRow?.kind,'skeleton');
  assert.equal((depthSkeletonRow?.result as {model?:string} | undefined)?.model,'test-skeleton');
  assert.equal(calls,2);
  const depthRecordsResponse = await fetch(base+'/api/pose-references?'+new URLSearchParams({
    projectId:'project',nodeId:'pose',source:stored.url,analysisSource:stored.url,
    analysisSourceKind:'depth',analysisSourceRecordId:record.id,
  }),{headers:{cookie:`${SESSION_COOKIE}=${sessions.owner}`} });
  assert.equal(depthRecordsResponse.status,200);
  const depthRecords = await depthRecordsResponse.json();
  assert.equal(depthRecords.records.find((item:any)=>item.kind==='skeleton').id,depthSkeletonRecord.id);
  assert.equal((await req('POST',{...depthSkeletonBody,analysisSourceRecordId:'missing-depth-record'})).status,404);
  const skeleton = await req('POST',{...body,kind:'skeleton',requestId:'skeleton-request'});
  assert.equal(skeleton.status,202);
  for(let i=0;i<100;i++) {
    if((await queryOne<{status:string}>("SELECT status FROM pose_references WHERE kind='skeleton'"))?.status!=='running') break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  const mixed = await (await req('GET')).json();
  assert.equal(mixed.records.find((x:any)=>x.kind==='depth').status,'succeeded');
  assert.equal(mixed.records.find((x:any)=>x.kind==='skeleton').status,'failed');
  assert.ok(!JSON.stringify(mixed).includes('private provider detail'));
  await query("UPDATE pose_references SET status='running',updated_at=0 WHERE kind='skeleton'");
  const localInterrupted = await (await req('GET')).json();
  assert.equal(localInterrupted.records.find((x:any)=>x.kind==='skeleton').status,'failed');
  await query("UPDATE pose_references SET status='running',provider_requests=1,updated_at=0 WHERE kind='skeleton'");
  const interrupted = await (await req('GET')).json();
  assert.equal(interrupted.records.find((x:any)=>x.kind==='skeleton').status,'outcome_unknown');
  await req('POST',{...body,kind:'skeleton',requestId:'new-request-no-retry'});
  assert.equal(calls,3,'unknown result must not automatically repeat a paid call');
  process.env.DEPTH_MODEL_REVISION='different-checkpoint';
  const revised=await (await req('POST',{...body,requestId:'revised-depth-request'})).json();
  assert.notEqual(revised.id,record.id,'changed model configuration must not reuse previous results');
  delete process.env.DEPTH_MODEL_REVISION;
  const reverted=await (await req('GET')).json();
  assert.equal(reverted.records.find((x:any)=>x.kind==='depth').id,record.id,'restoration must prefer the current configuration');
  assert.equal((await outfitReq('POST',outfitBody,'none')).status,401);
  const outfitResponse=await outfitReq('POST');
  assert.equal(outfitResponse.status,202,'背心+短裤按钮必须把单张替换任务放入持久队列');
  const outfit=await outfitResponse.json();
  assert.equal(outfit.record.status,'queued');
  assert.equal(outfit.record.runId,outfit.runId);
  const outfitRun=await queryOne<{kind:string;prompt:string;parameters_json:string;reference_images_json:string;run_type:string}>(
    'SELECT kind,prompt,parameters_json,reference_images_json,run_type FROM generation_runs WHERE id=$1',[outfit.runId],
  );
  assert.equal(outfitRun?.kind,'pose-reference-outfit');
  assert.equal(outfitRun?.run_type,'direct');
  assert.equal(JSON.parse(outfitRun?.parameters_json ?? '{}').poseOutfitOnly,true);
  assert.equal(JSON.parse(outfitRun?.parameters_json ?? '{}').poseOutfitVersion,'leggings-v1');
  assert.match(outfitRun?.prompt ?? '',/不透肤的紧身长裤/);
  assert.doesNotMatch(outfitRun?.prompt ?? '',/严格2×2|左上：|右上：|四格必须|人物身份参考板/);
  assert.deepEqual(JSON.parse(outfitRun?.reference_images_json ?? '[]'),[stored.url]);
  const outfitRepeated=await (await outfitReq('POST')).json();
  assert.equal(outfitRepeated.record.runId,outfit.runId,'排队中的重复点击必须复用同一个任务');
  const outfitRestored=await (await outfitReq('GET')).json();
  assert.equal(outfitRestored.record.runId,outfit.runId);
  await query("UPDATE generation_runs SET status='succeeded',model='gpt-image-2',successful_count=1 WHERE id=$1",[outfit.runId]);
  await query("INSERT INTO generation_outputs(id,run_id,image,status,created_at) VALUES('outfit-output',$1,$2,'success',$3)",[outfit.runId,stored.url,Date.now()]);
  const outfitCompleted=await (await outfitReq('GET')).json();
  assert.equal(outfitCompleted.record.status,'succeeded');
  assert.equal(outfitCompleted.record.result.image,stored.url);
  const derivedFile=saveDataUrl(png);
  await query("INSERT INTO files(id,owner_id,created_at) VALUES($1,'owner',$2)",[derivedFile.id,now]);
  assert.equal((await req('POST',{...body,analysisSource:derivedFile.url,requestId:'derived-rejected'})).status,404,'同账号无关图片不能冒充换装结果');
  await query("UPDATE generation_outputs SET image=$1 WHERE id='outfit-output'",[derivedFile.url]);
  const derivedResponse=await req('POST',{...body,analysisSource:derivedFile.url,requestId:'derived-depth-123'});
  assert.equal(derivedResponse.status,202);
  const derivedRecord=await derivedResponse.json();
  assert.equal(derivedRecord.source,derivedFile.url);
  assert.notEqual(derivedRecord.id,record.id,'原图与换装图不能共用缓存');
  assert.equal((await req('POST',{...body,analysisSource:derivedFile.url},'other')).status,404);
  const derivedGet=await fetch(base+'/api/pose-references?'+new URLSearchParams({...outfitBody,analysisSource:derivedFile.url}),{headers:{cookie:`${SESSION_COOKIE}=${sessions.owner}`}});
  assert.equal(derivedGet.status,200);
  assert.ok((await derivedGet.json()).records.every((r:any)=>r.source===derivedFile.url));
  await query("UPDATE generation_runs SET status='outcome_unknown' WHERE id=$1",[outfit.runId]);
  assert.equal((await outfitReq('POST',{...outfitBody,retry:true,requestId:'outfit-retry-123'})).status,409,'不确定结果不得盲目再次扣费');
  assert.equal((await outfitReq('GET',undefined,'other')).status,404);
  await query("UPDATE generation_runs SET status='succeeded',parameters_json=$2 WHERE id=$1",[outfit.runId,JSON.stringify({poseOutfitOnly:true})]);
  const legacy=await (await outfitReq('GET')).json();
  assert.equal(legacy.record,null);
  assert.equal(legacy.legacyRecord.result.image,derivedFile.url);
  const fresh=await (await outfitReq('POST',{...outfitBody,requestId:'leggings-new-version'})).json();
  assert.notEqual(fresh.runId,outfit.runId,'旧短裤成功记录不能挡住新版紧身裤任务');
  await query("DELETE FROM generation_runs WHERE id=$1",[outfit.runId]);
  // A legacy success remains visible while a new local configuration runs/fails.
  await query("UPDATE pose_references SET configuration='legacy-gemini',status='succeeded',result=$1::jsonb WHERE kind='skeleton' AND result IS NULL",[JSON.stringify({image:png,model:'gemini-legacy'})]);
  process.env.POSE_SERVICE_URL='http://127.0.0.1:8767';
  process.env.POSE_SERVICE_TOKEN='local-worker-test-token-over-32-characters';
  const savedFetch=globalThis.fetch;
  let finishWorker: (()=>void)|undefined;
  const workerWait=new Promise<void>(r=>{finishWorker=r;});
  globalThis.fetch=async(url,init)=>{
    if(String(url)==='http://127.0.0.1:8767/pose/v1') return new Response(null,{status:404});
    if(String(url)==='http://127.0.0.1:8767/pose') {
      await workerWait;
      return new Response(Buffer.from(png.split(',')[1],'base64'),{headers:{'content-type':'image/png','x-pose-model':'dwpose-wholebody','x-pose-checkpoint':'a'.repeat(64)}});
    }
    return savedFetch(url,init);
  };
  try {
    const local=await (await fetch(base+'/api/pose-local',{method:'POST',headers:{'content-type':'application/json',cookie:`${SESSION_COOKIE}=${sessions.owner}`},body:JSON.stringify({...body,kind:'skeleton',requestId:'local-worker-request'})})).json();
    const during=await (await req('GET')).json();
    assert.equal(during.records.find((r:any)=>r.kind==='skeleton').result.model,'gemini-legacy');
    finishWorker!();
    for(let i=0;i<100;i++) {
      if((await queryOne<{status:string}>('SELECT status FROM pose_references WHERE id=$1',[local.id]))?.status==='succeeded') break;
      await new Promise(r=>setTimeout(r,10));
    }
    const completed=await (await req('GET')).json();
    assert.equal(completed.records.find((r:any)=>r.kind==='skeleton').result.model,'dwpose-wholebody');
    assert.equal((await queryOne<{provider_requests:number}>('SELECT provider_requests FROM pose_references WHERE id=$1',[local.id]))?.provider_requests,0);
  } finally {finishWorker!();globalThis.fetch=savedFetch;}
  flow.nodes[0].data.imageUrl='/api/files/replacement.png';
  await query("UPDATE projects SET flow_json=$1 WHERE id='project'",[JSON.stringify(flow)]);
  assert.equal((await req('POST')).status,409,'stale source must be rejected');
  assert.equal((await req('GET')).status,409);
  await query("DELETE FROM projects WHERE id='project'");
  assert.equal((await queryOne<{count:number}>('SELECT COUNT(*)::int AS count FROM pose_references'))?.count,0);
  console.log('Pose references: auth, persistence, cache, partial failure, unknown outcome and stale source passed');
} finally {
  release!();
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  await closeDatabaseForTests();
  fs.rmSync(temp,{recursive:true,force:true});
}

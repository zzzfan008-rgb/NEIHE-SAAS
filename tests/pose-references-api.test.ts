import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import sharp from 'sharp';
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
const stored = saveDataUrl(png);
await query("INSERT INTO files(id,owner_id,created_at) VALUES($1,'owner',$2)", [stored.id,now]);
const flow = {nodes:[{id:'pose',type:'image-input',position:{x:0,y:0},data:{kind:'image-input',label:'人物姿势参考图（必需）',status:'idle',imageRole:'reference',imageUrl:stored.url}}, {id:'stabilize',type:'virtual-try-on',position:{x:400,y:0},data:{kind:'virtual-try-on',workflowStage:'scene-stabilize',label:'定版',status:'idle'}}],edges:[{id:'pose-edge',source:'pose',target:'stabilize',targetHandle:'pose'}]};
await query("INSERT INTO projects(id,owner_id,name,flow_json,created_at,updated_at,lifecycle) VALUES('project','owner','test',$1,$2,$2,'saved')",[JSON.stringify(flow),now]);
let calls = 0;
let release: (()=>void) | undefined;
let delayed = new Promise<void>(resolve=>{release=resolve;});
const app = express();
app.use(express.json());
app.use('/api',requireAuth,requirePasswordChanged);
const router = fs.existsSync('server/routes/poseReferences.ts')
  ? (await import('../server/routes/poseReferences')).createPoseReferencesRouter({
      analyze: async (_image: string, kind: string) => { calls++; await delayed; if(kind==='skeleton') throw new Error('private provider detail'); return {image:png,model:'test-depth'}; },
    }) : express.Router();
app.use('/api/pose-references',router);
const server = app.listen(0,'127.0.0.1');
await new Promise<void>(resolve=>server.once('listening',resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const body = {projectId:'project',nodeId:'pose',source:stored.url,kind:'depth',requestId:'request-depth-123'};
const req = (method: string, data: unknown = body, user='owner') => fetch(base+'/api/pose-references'+(method==='GET'?'?'+new URLSearchParams({projectId:'project',nodeId:'pose',source:stored.url}):''),{method,headers:{'content-type':'application/json',cookie:`${SESSION_COOKIE}=${sessions[user]??''}`},...(method==='POST'?{body:JSON.stringify(data)}:{})});
try {
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
  assert.equal(results.records[0].result.image,png);
  assert.equal(calls,1);
  await req('POST');
  assert.equal(calls,1,'cache hit must not generate again');
  assert.equal((await req('GET',undefined,'other')).status,404);
  assert.equal((await req('POST',{...body,source:'https://example.com/private.png'})).status,400);
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
  const interrupted = await (await req('GET')).json();
  assert.equal(interrupted.records.find((x:any)=>x.kind==='skeleton').status,'outcome_unknown');
  await req('POST',{...body,kind:'skeleton',requestId:'new-request-no-retry'});
  assert.equal(calls,2,'unknown result must not automatically repeat a paid call');
  process.env.DEPTH_MODEL_REVISION='different-checkpoint';
  const revised=await (await req('POST',{...body,requestId:'revised-depth-request'})).json();
  assert.notEqual(revised.id,record.id,'changed model configuration must not reuse previous results');
  delete process.env.DEPTH_MODEL_REVISION;
  const reverted=await (await req('GET')).json();
  assert.equal(reverted.records.find((x:any)=>x.kind==='depth').id,record.id,'restoration must prefer the current configuration');
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

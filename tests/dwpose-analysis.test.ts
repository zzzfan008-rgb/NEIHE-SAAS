import assert from 'node:assert/strict';
import sharp from 'sharp';
import { analyzeDWPoseReference } from '../server/lib/dwposeAnalysis';

const png=await sharp({create:{width:30,height:50,channels:3,background:'black'}}).png().toBuffer();
const input=`data:image/png;base64,${png.toString('base64')}`;
const savedFetch=globalThis.fetch;
process.env.POSE_SERVICE_URL='http://127.0.0.1:8767';
process.env.POSE_SERVICE_TOKEN='test-only-local-pose-token-over-32-characters';
const headers={'content-type':'image/png','x-pose-model':'dwpose-wholebody','x-pose-checkpoint':'a'.repeat(64)};
let calls=0;
try {
  globalThis.fetch=async(url,init)=>{
    calls++;
    assert.equal(String(url),'http://127.0.0.1:8767/pose');
    assert.equal(init?.redirect,'error');
    assert.equal(new Headers(init?.headers).get('authorization'),`Bearer ${process.env.POSE_SERVICE_TOKEN}`);
    assert.deepEqual(Object.keys(JSON.parse(String(init?.body))),['image']);
    return new Response(png,{headers});
  };
  const result=await analyzeDWPoseReference(input);
  assert.equal(result.model,'dwpose-wholebody');
  assert.equal(result.width,30);assert.equal(result.height,50);
  assert.equal(calls,1);
  await assert.rejects(()=>analyzeDWPoseReference('http://example.com/private.png'));
  assert.equal(calls,1,'never fetch user URLs');
  globalThis.fetch=async()=>new Response(png,{headers:{...headers,'x-pose-model':'gemini'}});
  await assert.rejects(()=>analyzeDWPoseReference(input),/模型/);
  const wrongSize=await sharp(png).resize(50,30).png().toBuffer();
  globalThis.fetch=async()=>new Response(wrongSize,{headers});
  await assert.rejects(()=>analyzeDWPoseReference(input),/尺寸/);
  globalThis.fetch=async()=>new Response('No person',{status:422});
  await assert.rejects(()=>analyzeDWPoseReference(input),/422/);
  process.env.POSE_SERVICE_URL='http://192.168.1.1:8767';
  await assert.rejects(()=>analyzeDWPoseReference(input),/HTTPS/);
  delete process.env.POSE_SERVICE_TOKEN;
  await assert.rejects(()=>analyzeDWPoseReference(input),/配置/);
  console.log('DWPose adapter: local-only, identity, size, missing person, configuration passed');
} finally {globalThis.fetch=savedFetch;}

import assert from 'node:assert/strict';
import { useFlowStore,selectActiveDocumentTarget } from '../src/store/flowStore';
import { isPoseReferenceNode } from '../src/types/poseReference';
import { generatePoseReference,restorePoseReferences,poseReferenceKey,usePoseReferenceRuntime } from '../src/store/poseReferenceRuntime';

const nodes:any[]=[{id:'any-id',type:'image-input',position:{x:0,y:0},data:{kind:'image-input',label:'自定义名称',status:'idle',imageRole:'reference',imageUrl:'/api/files/source.png'}},{id:'target',type:'virtual-try-on',position:{x:400,y:0},data:{kind:'virtual-try-on',workflowStage:'scene-stabilize',label:'定版',status:'idle'}}];
const edges=[{id:'edge',source:'any-id',target:'target',targetHandle:'pose'}];
assert.equal(isPoseReferenceNode('any-id',nodes,edges),true);
assert.equal(isPoseReferenceNode('any-id',nodes,[{...edges[0],targetHandle:'outfit'}]),false);
useFlowStore.getState().loadFlow({projectName:'Pose test',nodes,edges});
const target=selectActiveDocumentTarget(useFlowStore.getState());
const source='/api/files/source.png';
const key=poseReferenceKey(target,'any-id',source);
const originalFetch=globalThis.fetch;
const originalSave=useFlowStore.getState().saveProjectInTab;
let calls=0;
let resolve: ((value:Response)=>void)|undefined;
useFlowStore.setState({saveProjectInTab:async()=>true});
const result={id:'record',source,kind:'depth',status:'succeeded',result:{image:'data:image/png;base64,AAAA',model:'test'}};
try {
  globalThis.fetch=async()=>{calls++;return new Promise<Response>(r=>{resolve=r;});};
  const pending=generatePoseReference(target,'any-id',source,'depth');
  while(!resolve) await new Promise(r=>setTimeout(r,0));
  await generatePoseReference(target,'any-id',source,'depth');
  assert.equal(calls,1,'duplicate click must not make a second POST');
  useFlowStore.getState().updateNodeDataInTab(target,'any-id',{imageUrl:'/api/files/new.png'});
  resolve(new Response(JSON.stringify(result)));
  await pending;
  assert.equal(usePoseReferenceRuntime.getState().entries[key]?.records.depth,undefined,'late result cannot be attached after source changes');
  useFlowStore.getState().updateNodeDataInTab(target,'any-id',{imageUrl:source});
  resolve=undefined;
  const restoring=restorePoseReferences(target,'any-id',source);
  while(!resolve) await new Promise(r=>setTimeout(r,0));
  useFlowStore.getState().loadFlow({projectName:'Replacement document',nodes,edges});
  (resolve as (value:Response)=>void)(new Response(JSON.stringify({records:[result]})));
  await restoring;
  assert.equal(usePoseReferenceRuntime.getState().entries[key]?.records.depth,undefined,'old epoch cannot receive restored results');
  assert.notEqual(poseReferenceKey(selectActiveDocumentTarget(useFlowStore.getState()),'any-id',source),key);
  console.log('Pose runtime: semantic port detection, duplicate click, source and document-epoch boundaries passed');
} finally {
  globalThis.fetch=originalFetch;
  useFlowStore.setState({saveProjectInTab:originalSave});
}

import assert from 'node:assert/strict';
import { useFlowStore,selectActiveDocumentTarget } from '../src/store/flowStore';
import { isPoseReferenceNode } from '../src/types/poseReference';
import { createDocumentSnapshot,documentSnapshotToPersistedWorkflow } from '../src/lib/documentSnapshot';
import { addPoseReferenceToCanvas,generatePoseOutfitReference,generatePoseReference,restorePoseOutfitReference,restorePoseReferences,poseReferenceKey,usePoseReferenceRuntime } from '../src/store/poseReferenceRuntime';

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
  const detachedNodes=nodes.map(n=>n.id==='any-id'?{...n,data:{...n.data,poseReference:true,autoConnectTargets:[{targetNodeId:'target',targetHandle:'pose'}]}}:n);
  useFlowStore.getState().loadFlow({projectName:'Manual references',nodes:detachedNodes,edges:[]});
  const detached=selectActiveDocumentTarget(useFlowStore.getState());
  assert.equal(isPoseReferenceNode('any-id',detachedNodes,[]),true);
  useFlowStore.getState().assignImageInputInTab(detached,'any-id',source);
  assert.equal(useFlowStore.getState().tabs.find(t=>t.id===detached.tabId)!.edges.length,0,'legacy upload must not auto-connect pose');
  await addPoseReferenceToCanvas(detached,'any-id',source,'original');
  const tab=()=>useFlowStore.getState().tabs.find(t=>t.id===detached.tabId)!;
  assert.equal(tab().nodes.length,3);
  assert.equal(tab().nodes.at(-1)?.data.label,'姿势原图');
  assert.equal(tab().edges.length,0,'adding a reference must not create edges');
  useFlowStore.getState().undo();
  assert.equal(tab().nodes.length,2,'one undo removes the exported image node');
  useFlowStore.getState().redo();
  assert.equal(tab().nodes.length,3);
  const exportedId=tab().nodes.at(-1)!.id;
  useFlowStore.getState().onConnect({source:exportedId,sourceHandle:'image',target:'target',targetHandle:'pose'});
  assert.equal(useFlowStore.getState().pendingConnectionDraft?.proposedTargetHandle,'pose');
  assert.equal(useFlowStore.getState().confirmPendingConnection('pose'),true);
  assert.equal(tab().edges.length,1,'the user can manually connect the exported image');
  assert.equal(tab().edges[0].source,exportedId);
  const saved=documentSnapshotToPersistedWorkflow(createDocumentSnapshot({...tab(),nodes:tab().nodes.filter(n=>n.data.kind==='image-input'),edges:[]}));
  assert.equal((saved.nodes[0].data as any).poseReference,true,'pose entry survives save/reload without requiring an edge');
  assert.equal((saved.nodes.at(-1)!.data as any).imageUrl,source);
  assert.deepEqual((saved.nodes.at(-1)!.data as any).poseReferenceSource,{kind:'original',image:source});
  const detachedKey=poseReferenceKey(detached,'any-id',source);
  usePoseReferenceRuntime.setState(s=>({entries:{...s.entries,[detachedKey]:{records:{depth:result as any},busy:{},errors:{}}}}));
  resolve=undefined;
  const exporting=addPoseReferenceToCanvas(detached,'any-id',source,'depth');
  while(!resolve) await new Promise(r=>setTimeout(r,0));
  const beforeDuplicate=calls;
  await addPoseReferenceToCanvas(detached,'any-id',source,'depth');
  assert.equal(calls,beforeDuplicate);
  useFlowStore.getState().loadFlow({projectName:'Replaced while uploading',nodes,edges});
  (resolve as (value:Response)=>void)(new Response(JSON.stringify({url:'/api/files/depth.png'})));
  await exporting;
  assert.equal(useFlowStore.getState().tabs.find(t=>t.id===detached.tabId)!.nodes.length,2,'old epoch cannot receive exported nodes');
  const placementNodes=[
    {...detachedNodes[0],position:{x:0,y:0}},
    {...detachedNodes[1],position:{x:380,y:0}},
    {id:'right-obstacle',type:'image-input',position:{x:380,y:340},data:{kind:'image-input',label:'相邻占位节点',status:'success',imageRole:'reference',imageUrl:'/api/files/obstacle.png'}},
  ];
  useFlowStore.getState().loadFlow({projectName:'Pose placement',nodes:placementNodes,edges:[]});
  const placementTarget=selectActiveDocumentTarget(useFlowStore.getState());
  const skeletonId=useFlowStore.getState().addPoseReferenceImageNode(placementTarget,'any-id',source,'/api/files/skeleton.png','DWPose 骨骼图');
  const depthId=useFlowStore.getState().addPoseReferenceImageNode(placementTarget,'any-id',source,'/api/files/depth.png','人物深度图');
  const placementTab=useFlowStore.getState().tabs.find(t=>t.id===placementTarget.tabId)!;
  const origin=placementTab.nodes.find(n=>n.id==='any-id')!;
  const generated=[skeletonId,depthId].map(id=>placementTab.nodes.find(n=>n.id===id)!);
  assert.ok(generated.every(node=>Math.hypot(node.position.x-origin.position.x,node.position.y-origin.position.y)<=600),'骨骼图和深度图必须落在姿势原图相邻区域');
  assert.notDeepEqual(generated[0].position,generated[1].position,'两个姿势参考结果不能重叠');
  const orderedNodes=[
    {...detachedNodes[0],position:{x:0,y:0}},
    {...detachedNodes[1],position:{x:1400,y:0}},
  ];
  useFlowStore.getState().loadFlow({projectName:'Pose ordered placement',nodes:orderedNodes,edges:[]});
  const orderedTarget=selectActiveDocumentTarget(useFlowStore.getState());
  const orderedSkeleton=useFlowStore.getState().addPoseReferenceImageNode(orderedTarget,'any-id',source,'/api/files/skeleton.png','DWPose 骨骼图');
  const orderedDepth=useFlowStore.getState().addPoseReferenceImageNode(orderedTarget,'any-id',source,'/api/files/depth.png','人物深度图');
  const orderedTab=useFlowStore.getState().tabs.find(t=>t.id===orderedTarget.tabId)!;
  assert.deepEqual([orderedSkeleton,orderedDepth].map(id=>orderedTab.nodes.find(n=>n.id===id)?.position),[
    {x:380,y:0},
    {x:380,y:340},
  ],'无障碍时骨骼图和深度图应在原节点右侧纵向排列');
  useFlowStore.getState().loadFlow({projectName:'Outfit reference',nodes:detachedNodes,edges:[]});
  const outfitTarget=selectActiveDocumentTarget(useFlowStore.getState());
  const outfitKey=poseReferenceKey(outfitTarget,'any-id',source);
  const savedFetch=globalThis.fetch;
  let outfitCalls=0;
  const outfitResult={id:'outfit-run',runId:'outfit-run',source,status:'succeeded',result:{image:'/api/files/outfit.png',model:'gpt-image-2'}};
  globalThis.fetch=async(url,init)=>{
    outfitCalls++;
    assert.match(String(url),/\/api\/pose-references\/outfit/);
    return new Response(JSON.stringify({record:init?.method==='POST'?{...outfitResult,status:'queued'}:outfitResult}));
  };
  try {
    await generatePoseOutfitReference(outfitTarget,'any-id',source);
    await generatePoseOutfitReference(outfitTarget,'any-id',source);
    assert.equal(outfitCalls,1,'背心+紧身裤任务在排队时重复点击不得重复提交');
    assert.equal(usePoseReferenceRuntime.getState().entries[outfitKey]?.neutralOutfit?.status,'queued');
    await restorePoseOutfitReference(outfitTarget,'any-id',source);
    assert.equal(usePoseReferenceRuntime.getState().entries[outfitKey]?.neutralOutfit?.result?.image,'/api/files/outfit.png');
    await addPoseReferenceToCanvas(outfitTarget,'any-id',source,'neutral-outfit');
    const outfitTab=useFlowStore.getState().tabs.find(t=>t.id===outfitTarget.tabId)!;
    assert.equal(outfitTab.nodes.at(-1)?.data.label,'背心+紧身裤姿势参考');
    assert.equal(outfitCalls,2,'已有本地生成文件时导出不得再次上传');
  } finally { globalThis.fetch=savedFetch; }
  console.log('Pose runtime: semantic port detection, duplicate click, source and document-epoch boundaries passed');
} finally {
  globalThis.fetch=originalFetch;
  useFlowStore.setState({saveProjectInTab:originalSave});
}

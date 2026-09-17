import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { useFlowStore, type DocumentTarget } from './flowStore';
import { isPoseReferenceNode, type PoseReferenceKind, type PoseReferenceRecord } from '../types/poseReference';

export interface PoseReferenceState {
  records: Partial<Record<PoseReferenceKind,PoseReferenceRecord>>;
  busy: Partial<Record<PoseReferenceKind,boolean>>;
  errors: Partial<Record<PoseReferenceKind,string>>;
  adding?: Partial<Record<PoseReferenceKind|'original',boolean>>;
  added?: Partial<Record<PoseReferenceKind|'original',string>>;
  addErrors?: Partial<Record<PoseReferenceKind|'original',string>>;
  error?: string;
}
export const EMPTY_POSE_STATE: PoseReferenceState = {records:{},busy:{},errors:{}};
export const usePoseReferenceRuntime = create<{entries:Record<string,PoseReferenceState>}>(()=>({entries:{}}));
const reads = new Set<string>();
const versions = new Map<string,number>();
export function poseReferenceKey(target: DocumentTarget,nodeId:string,source:string) {
  return JSON.stringify([target.tabId,target.projectId,target.documentEpoch,nodeId,source]);
}
function current(target:DocumentTarget,nodeId:string,source:string,write=false) {
  const tab=useFlowStore.getState().tabs.find(t=>t.id===target.tabId&&t.projectId===target.projectId&&t.documentEpoch===target.documentEpoch);
  return tab && (!write||!tab.readOnly) && tab.nodes.some(n=>n.id===nodeId&&n.data.kind==='image-input'&&n.data.imageUrl===source)
    && isPoseReferenceNode(nodeId,tab.nodes,tab.edges);
}
function patch(key:string,update:(state:PoseReferenceState)=>PoseReferenceState) {
  usePoseReferenceRuntime.setState(s=>({entries:{...s.entries,[key]:update(s.entries[key]??EMPTY_POSE_STATE)}}));
}
async function response(response:Response) {
  const value=await response.json();
  if(!response.ok) throw new Error(typeof value.error==='string'?value.error:'姿势参考服务暂不可用');
  return value;
}
function validate(value:PoseReferenceRecord,source:string):PoseReferenceRecord {
  if(!value||typeof value.id!=='string'||!['skeleton','depth'].includes(value.kind)||value.source!==source||!['running','succeeded','failed','outcome_unknown'].includes(value.status)) throw new Error('姿势参考结果格式无效');
  if(value.status==='succeeded'&&(!value.result||!/^data:image\/(png|jpeg|webp);base64,/.test(value.result.image)||typeof value.result.model!=='string')) throw new Error('姿势参考图片格式无效');
  return value;
}
export async function restorePoseReferences(target:DocumentTarget,nodeId:string,source:string) {
  const key=poseReferenceKey(target,nodeId,source);
  if(reads.has(key)||!current(target,nodeId,source)) return;
  reads.add(key);
  const version=versions.get(key)??0;
  try {
    const params=new URLSearchParams({projectId:target.projectId,nodeId,source});
    const value=await response(await fetch(`/api/pose-references?${params}`,{cache:'no-store',signal:AbortSignal.timeout(30_000)}));
    if(!Array.isArray(value.records)) throw new Error('姿势参考结果格式无效');
    const records=value.records.map((r:PoseReferenceRecord)=>validate(r,source));
    if(!current(target,nodeId,source)||(versions.get(key)??0)!==version) return;
    patch(key,s=>({ ...s,error:undefined,records:{...s.records,...Object.fromEntries(records.map((r:PoseReferenceRecord)=>[r.kind,r]))} }));
  } catch(error) {
    if(current(target,nodeId,source)&&(versions.get(key)??0)===version) patch(key,s=>({...s,error:error instanceof Error?error.message:'结果恢复失败'}));
  } finally { reads.delete(key); }
}
export async function generatePoseReference(target:DocumentTarget,nodeId:string,source:string,kind:PoseReferenceKind,retry=false) {
  const key=poseReferenceKey(target,nodeId,source);
  const state=usePoseReferenceRuntime.getState().entries[key];
  if(!current(target,nodeId,source,true)||state?.busy[kind]||state?.records[kind]?.status==='running') return;
  versions.set(key,(versions.get(key)??0)+1);
  patch(key,s=>({...s,error:undefined,busy:{...s.busy,[kind]:true},errors:{...s.errors,[kind]:undefined}}));
  try {
    if(!await useFlowStore.getState().saveProjectInTab(target)) throw new Error('项目保存失败，请先保存后重试');
    if(!current(target,nodeId,source,true)) return;
    const record=validate(await response(await fetch('/api/pose-references',{method:'POST',headers:{'Content-Type':'application/json'},
      signal:AbortSignal.timeout(30_000),body:JSON.stringify({projectId:target.projectId,nodeId,source,kind,retry,requestId:nanoid(16)})})),source);
    if(current(target,nodeId,source)) patch(key,s=>({...s,records:{...s.records,[kind]:{...record,result:record.result??s.records[kind]?.result}}}));
  } catch(error) {
    if(current(target,nodeId,source)) patch(key,s=>({...s,errors:{...s.errors,[kind]:error instanceof Error?error.message:'提交失败，请先刷新结果，避免重复调用'}}));
  } finally { patch(key,s=>({...s,busy:{...s.busy,[kind]:false}})); }
}

/** Persist generated images before atomically exporting into the initiating document. */
export async function addPoseReferenceToCanvas(target:DocumentTarget,nodeId:string,source:string,kind:PoseReferenceKind|'original') {
  const key=poseReferenceKey(target,nodeId,source);
  const state=usePoseReferenceRuntime.getState().entries[key];
  if(!current(target,nodeId,source,true)||state?.adding?.[kind]) return;
  const image=kind==='original'?source:state?.records[kind]?.result?.image;
  if(!image) return;
  patch(key,s=>({...s,adding:{...s.adding,[kind]:true},addErrors:{...s.addErrors,[kind]:undefined},added:{...s.added,[kind]:undefined}}));
  try {
    const url=kind==='original'?source:(await response(await fetch('/api/files',{
      method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(30_000),body:JSON.stringify({dataUrl:image}),
    }))).url;
    if(!current(target,nodeId,source,true)) return;
    if(typeof url!=='string'||!/^\/api\/files\/[\w.-]+$/.test(url)) throw new Error('图片保存结果无效');
    const label=kind==='original'?'姿势原图':kind==='skeleton'?(state?.records.skeleton?.result?.model==='dwpose-wholebody'?'DWPose 骨骼图':'旧版骨骼图'):'人物深度图';
    const id=useFlowStore.getState().addPoseReferenceImageNode(target,nodeId,source,url,label);
    if(!id) throw new Error('文档已变化，未添加图片');
    patch(key,s=>({...s,added:{...s.added,[kind]:id}}));
  } catch(error) {
    if(current(target,nodeId,source)) patch(key,s=>({...s,addErrors:{...s.addErrors,[kind]:error instanceof Error?error.message:'添加失败，请重试'}}));
  } finally { patch(key,s=>({...s,adding:{...s.adding,[kind]:false}})); }
}

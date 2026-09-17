import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { useFlowStore, type DocumentTarget } from './flowStore';
import { isPoseReferenceNode, type PoseReferenceKind, type PoseReferenceRecord } from '../types/poseReference';

export interface PoseReferenceState {
  records: Partial<Record<PoseReferenceKind,PoseReferenceRecord>>;
  busy: Partial<Record<PoseReferenceKind,boolean>>;
  errors: Partial<Record<PoseReferenceKind,string>>;
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
    if(current(target,nodeId,source)) patch(key,s=>({...s,records:{...s.records,[kind]:record}}));
  } catch(error) {
    if(current(target,nodeId,source)) patch(key,s=>({...s,errors:{...s.errors,[kind]:error instanceof Error?error.message:'提交失败，请先刷新结果，避免重复调用'}}));
  } finally { patch(key,s=>({...s,busy:{...s.busy,[kind]:false}})); }
}

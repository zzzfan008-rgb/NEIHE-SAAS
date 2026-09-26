import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { useFlowStore, type DocumentTarget } from './flowStore';
import { isPoseReferenceNode, posePromptForImage, type PoseOutfitReferenceRecord, type PoseReferenceCanvasKind, type PoseReferenceKind, type PoseReferenceRecord } from '../types/poseReference';

export interface PoseReferenceState {
  records: Partial<Record<PoseReferenceKind,PoseReferenceRecord>>;
  busy: Partial<Record<PoseReferenceKind,boolean>>;
  errors: Partial<Record<PoseReferenceKind,string>>;
  posePrompt?: PosePromptInferenceState;
  neutralOutfit?: PoseOutfitReferenceRecord;
  legacyOutfit?: PoseOutfitReferenceRecord;
  neutralOutfitBusy?: boolean;
  neutralOutfitError?: string;
  adding?: Partial<Record<PoseReferenceCanvasKind,boolean>>;
  added?: Partial<Record<PoseReferenceCanvasKind,string>>;
  addErrors?: Partial<Record<PoseReferenceCanvasKind,string>>;
  error?: string;
}
export interface PosePromptInferenceResult {
  prompt: string;
  model: string;
  providerRequests: number;
  cacheHit: boolean;
}
export interface PosePromptInferenceState {
  status: 'running' | 'succeeded' | 'failed';
  result?: PosePromptInferenceResult;
  error?: string;
}
export const EMPTY_POSE_STATE: PoseReferenceState = {records:{},busy:{},errors:{}};
export const usePoseReferenceRuntime = create<{entries:Record<string,PoseReferenceState>}>(()=>({entries:{}}));
const reads = new Set<string>();
const versions = new Map<string,number>();
const outfitReads = new Set<string>();
const outfitVersions = new Map<string,number>();
const promptVersions = new Map<string,number>();
export function poseReferenceKey(target: DocumentTarget,nodeId:string,source:string,analysisSourceRecordId?:string) {
  return JSON.stringify(analysisSourceRecordId
    ? [target.tabId,target.projectId,target.documentEpoch,nodeId,source,`depth:${analysisSourceRecordId}`]
    : [target.tabId,target.projectId,target.documentEpoch,nodeId,source]);
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
function isLocalImageReference(value:unknown): value is string {
  return typeof value==='string'&&/^\/api\/files\/[\w.-]+$/.test(value);
}
function validateOutfit(value:PoseOutfitReferenceRecord|undefined|null,source:string):PoseOutfitReferenceRecord|undefined {
  if(!value) return undefined;
  if(typeof value.id!=='string'||typeof value.runId!=='string'||value.source!==source||!['queued','running','retry_wait','succeeded','failed','outcome_unknown','cancelled'].includes(value.status)) throw new Error('服饰替换结果格式无效');
  if(value.status==='succeeded'&&(!value.result||!isLocalImageReference(value.result.image)||typeof value.result.model!=='string')) throw new Error('服饰替换图片格式无效');
  return value;
}
function validatePosePrompt(value:unknown):PosePromptInferenceResult {
  if (!value || typeof value !== 'object') throw new Error('姿势反推结果格式无效');
  const result=value as Partial<PosePromptInferenceResult>;
  if (typeof result.prompt!=='string' || !result.prompt.trim() || result.prompt.length>4000 ||
      typeof result.model!=='string' || !result.model.trim() ||
      typeof result.providerRequests!=='number' || !Number.isInteger(result.providerRequests) || result.providerRequests<0 ||
      typeof result.cacheHit!=='boolean') throw new Error('姿势反推结果格式无效');
  return {prompt:result.prompt,model:result.model,providerRequests:result.providerRequests,cacheHit:result.cacheHit};
}
export async function restorePoseReferences(target:DocumentTarget,nodeId:string,source:string,analysisSource=source,analysisSourceRecordId?:string) {
  const key=poseReferenceKey(target,nodeId,analysisSource,analysisSourceRecordId);
  if(reads.has(key)||!current(target,nodeId,source)) return;
  reads.add(key);
  const version=versions.get(key)??0;
  try {
    const params=new URLSearchParams({projectId:target.projectId,nodeId,source,analysisSource});
    if (analysisSourceRecordId) {
      params.set('analysisSourceKind','depth');
      params.set('analysisSourceRecordId',analysisSourceRecordId);
    }
    const value=await response(await fetch(`/api/pose-references?${params}`,{cache:'no-store',signal:AbortSignal.timeout(30_000)}));
    if(!Array.isArray(value.records)) throw new Error('姿势参考结果格式无效');
    const records=value.records.map((r:PoseReferenceRecord)=>validate(r,analysisSource));
    if(!current(target,nodeId,source)||(versions.get(key)??0)!==version) return;
    patch(key,s=>({ ...s,error:undefined,records:{...s.records,...Object.fromEntries(records.map((r:PoseReferenceRecord)=>[r.kind,r]))} }));
  } catch(error) {
    if(current(target,nodeId,source)&&(versions.get(key)??0)===version) patch(key,s=>({...s,error:error instanceof Error?error.message:'结果恢复失败'}));
  } finally { reads.delete(key); }
}
export async function generatePoseReference(target:DocumentTarget,nodeId:string,source:string,kind:PoseReferenceKind,retry=false,analysisSource=source,analysisSourceRecordId?:string) {
  const key=poseReferenceKey(target,nodeId,analysisSource,analysisSourceRecordId);
  const state=usePoseReferenceRuntime.getState().entries[key];
  if(!current(target,nodeId,source,true)||state?.busy[kind]||state?.records[kind]?.status==='running') return;
  versions.set(key,(versions.get(key)??0)+1);
  patch(key,s=>({...s,error:undefined,busy:{...s.busy,[kind]:true},errors:{...s.errors,[kind]:undefined}}));
  try {
    if(!await useFlowStore.getState().saveProjectInTab(target)) throw new Error('项目保存失败，请先保存后重试');
    if(!current(target,nodeId,source,true)) return;
    const record=validate(await response(await fetch('/api/pose-references',{method:'POST',headers:{'Content-Type':'application/json'},
      signal:AbortSignal.timeout(30_000),body:JSON.stringify({projectId:target.projectId,nodeId,source,analysisSource,kind,retry,requestId:nanoid(16),...(analysisSourceRecordId?{analysisSourceKind:'depth',analysisSourceRecordId}: {})})})),analysisSource);
    if(current(target,nodeId,source)) patch(key,s=>({...s,records:{...s.records,[kind]:{...record,result:record.result??s.records[kind]?.result}}}));
  } catch(error) {
    if(current(target,nodeId,source)) patch(key,s=>({...s,errors:{...s.errors,[kind]:error instanceof Error?error.message:'提交失败，请先刷新结果，避免重复调用'}}));
  } finally { patch(key,s=>({...s,busy:{...s.busy,[kind]:false}})); }
}

export interface PosePromptRequestOptions {
  provider: 'gemini' | 'deepseek';
  apiKey?: string;
  ownerId?: string;
  candidateOnly?: boolean;
}
export function posePromptRuntimeKey(target:DocumentTarget,nodeId:string,source:string,provider:'gemini'|'deepseek'='gemini',ownerId='') {
  const base=poseReferenceKey(target,nodeId,source);
  return provider==='gemini' ? base : JSON.stringify([base,provider,ownerId]);
}
export async function analyzePosePrompt(target:DocumentTarget,nodeId:string,source:string,retry=false,options?:PosePromptRequestOptions) {
  const key=posePromptRuntimeKey(target,nodeId,source,options?.provider,options?.ownerId);
  const state=usePoseReferenceRuntime.getState().entries[key];
  if (!current(target,nodeId,source) || state?.posePrompt?.status==='running') return;
  const sourceData = useFlowStore.getState().tabs.find(t=>t.id===target.tabId)?.nodes.find(n=>n.id===nodeId)?.data;
  if (!sourceData || sourceData.kind !== 'image-input') return;
  // Saved user text (including an intentionally empty draft) wins over analysis/cache.
  if (posePromptForImage(sourceData) !== undefined && !retry) return;
  const adopt = (result: PosePromptInferenceResult) => {
    if (options?.candidateOnly || options?.provider==='deepseek') return;
    const latest = useFlowStore.getState().tabs.find(t=>t.id===target.tabId)?.nodes.find(n=>n.id===nodeId)?.data;
    if (current(target,nodeId,source,true) && latest?.kind === 'image-input' &&
        posePromptForImage(latest) === undefined && posePromptForImage(sourceData) === undefined) {
      useFlowStore.getState().updateNodeDataInTab(target,nodeId,{posePrompt:result.prompt,posePromptImage:source});
    }
  };
  if (!retry && state?.posePrompt?.status==='succeeded' && state.posePrompt.result) {
    adopt(state.posePrompt.result);
    return;
  }
  if (!retry && state?.posePrompt?.status==='failed') return;
  const version=(promptVersions.get(key)??0)+1;
  promptVersions.set(key,version);
  patch(key,s=>({...s,posePrompt:{status:'running',error:undefined}}));
  try {
    const tab=useFlowStore.getState().tabs.find(t=>t.id===target.tabId&&t.projectId===target.projectId&&t.documentEpoch===target.documentEpoch);
    if (tab?.readOnly===false && !await useFlowStore.getState().saveProjectInTab(target)) throw new Error('项目保存失败，请先保存后重试');
    if (!current(target,nodeId,source)) return;
    const value=await response(await fetch('/api/pose-references/analyze',{method:'POST',headers:{'Content-Type':'application/json'},
      signal:AbortSignal.timeout(130_000),body:JSON.stringify({projectId:target.projectId,nodeId,source,
        ...(options?.provider==='deepseek'?{provider:'deepseek',apiKey:options.apiKey}: {})})}));
    const result=validatePosePrompt(value);
    if (current(target,nodeId,source)&&(promptVersions.get(key)??0)===version) {
      adopt(result);
      patch(key,s=>({...s,posePrompt:{status:'succeeded',result}}));
    }
  } catch(error) {
    if (current(target,nodeId,source)&&(promptVersions.get(key)??0)===version) patch(key,s=>({...s,posePrompt:{status:'failed',error:error instanceof Error?error.message:'反推失败，请重试'}}));
  } finally {
    // A stale response cannot populate the document, but must release its runtime lock.
    if ((promptVersions.get(key)??0)===version && usePoseReferenceRuntime.getState().entries[key]?.posePrompt?.status==='running') {
      patch(key,s=>({...s,posePrompt:undefined}));
    }
  }
}

export async function restorePoseOutfitReference(target:DocumentTarget,nodeId:string,source:string) {
  const key=poseReferenceKey(target,nodeId,source);
  const readKey=`${key}:neutral-outfit`;
  if(outfitReads.has(readKey)||!current(target,nodeId,source)) return;
  outfitReads.add(readKey);
  const version=outfitVersions.get(key)??0;
  try {
    const params=new URLSearchParams({projectId:target.projectId,nodeId,source});
    const value=await response(await fetch(`/api/pose-references/outfit?${params}`,{cache:'no-store',signal:AbortSignal.timeout(30_000)}));
    const outfit=validateOutfit(value.record as PoseOutfitReferenceRecord|undefined,source);
    const legacyOutfit=validateOutfit(value.legacyRecord as PoseOutfitReferenceRecord|undefined,source);
    if(!current(target,nodeId,source)||(outfitVersions.get(key)??0)!==version) return;
    patch(key,s=>({...s,neutralOutfit:outfit,legacyOutfit,neutralOutfitError:undefined}));
  } catch(error) {
    if(current(target,nodeId,source)&&(outfitVersions.get(key)??0)===version) patch(key,s=>({...s,neutralOutfitError:error instanceof Error?error.message:'结果恢复失败'}));
  } finally { outfitReads.delete(readKey); }
}

export async function generatePoseOutfitReference(target:DocumentTarget,nodeId:string,source:string,retry=false) {
  const key=poseReferenceKey(target,nodeId,source);
  const state=usePoseReferenceRuntime.getState().entries[key];
  const status=state?.neutralOutfit?.status;
  const active=status==='queued'||status==='running'||status==='retry_wait';
  if(!current(target,nodeId,source,true)||state?.neutralOutfitBusy||active) return;
  outfitVersions.set(key,(outfitVersions.get(key)??0)+1);
  patch(key,s=>({...s,neutralOutfitBusy:true,neutralOutfitError:undefined}));
  try {
    if(!await useFlowStore.getState().saveProjectInTab(target)) throw new Error('项目保存失败，请先保存后重试');
    if(!current(target,nodeId,source,true)) return;
    const value=await response(await fetch('/api/pose-references/outfit',{method:'POST',headers:{'Content-Type':'application/json'},
      signal:AbortSignal.timeout(30_000),body:JSON.stringify({projectId:target.projectId,nodeId,source,retry,requestId:nanoid(16)})}));
    const outfit=validateOutfit(value.record as PoseOutfitReferenceRecord,source);
    if(!outfit) throw new Error('服饰替换结果格式无效');
    if(current(target,nodeId,source)) patch(key,s=>({...s,neutralOutfit:outfit}));
  } catch(error) {
    if(current(target,nodeId,source)) patch(key,s=>({...s,neutralOutfitError:error instanceof Error?error.message:'提交失败，请先刷新结果，避免重复调用'}));
  } finally {
    if(current(target,nodeId,source)) patch(key,s=>({...s,neutralOutfitBusy:false}));
  }
}

/** Persist generated images before atomically exporting into the initiating document. */
export async function addPoseReferenceToCanvas(target:DocumentTarget,nodeId:string,source:string,kind:PoseReferenceCanvasKind,analysisSource=source,analysisSourceRecordId?:string) {
  const derivedKey = kind==='skeleton'||kind==='depth'
    ? poseReferenceKey(target,nodeId,analysisSource,analysisSourceRecordId)
    : poseReferenceKey(target,nodeId,source);
  const key=derivedKey;
  const state=usePoseReferenceRuntime.getState().entries[key];
  if(!current(target,nodeId,source,true)||state?.adding?.[kind]) return;
  const image=kind==='original'?source:kind==='neutral-outfit'?state?.neutralOutfit?.result?.image:state?.records[kind]?.result?.image;
  if(!image) return;
  patch(key,s=>({...s,adding:{...s.adding,[kind]:true},addErrors:{...s.addErrors,[kind]:undefined},added:{...s.added,[kind]:undefined}}));
  try {
    const url = kind === 'original' || isLocalImageReference(image)
      ? image
      : (await response(await fetch('/api/files',{
          method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(30_000),body:JSON.stringify({dataUrl:image}),
        }))).url;
    if(!current(target,nodeId,source,true)) return;
    if(typeof url!=='string'||!/^\/api\/files\/[\w.-]+$/.test(url)) throw new Error('图片保存结果无效');
    const baseLabel=kind==='original'?'姿势原图':kind==='neutral-outfit'?'背心+紧身裤姿势参考':kind==='skeleton'?(state?.records.skeleton?.result?.model==='dwpose-wholebody'?'DWPose 骨骼图':'旧版骨骼图'):'人物深度图';
    const label=(kind==='skeleton'||kind==='depth')&&analysisSourceRecordId
      ? `${baseLabel}（深度图）`
      : (kind==='skeleton'||kind==='depth')&&analysisSource!==source
        ? `${baseLabel}（背心+紧身裤）`
        : baseLabel;
    const neutral = usePoseReferenceRuntime.getState().entries[poseReferenceKey(target,nodeId,source)]?.neutralOutfit;
    const neutralSource = (kind==='depth'||kind==='skeleton') && !analysisSourceRecordId && analysisSource!==source &&
      state?.records[kind]?.source===analysisSource && neutral?.source===source &&
      neutral.status==='succeeded' && neutral.result?.image===analysisSource
      ? analysisSource : undefined;
    const id=useFlowStore.getState().addPoseReferenceImageNode(target,nodeId,source,url,label,kind,neutralSource);
    if(!id) throw new Error('文档已变化，未添加图片');
    patch(key,s=>({...s,added:{...s.added,[kind]:id}}));
  } catch(error) {
    if(current(target,nodeId,source)) patch(key,s=>({...s,addErrors:{...s.addErrors,[kind]:error instanceof Error?error.message:'添加失败，请重试'}}));
  } finally { patch(key,s=>({...s,adding:{...s.adding,[kind]:false}})); }
}

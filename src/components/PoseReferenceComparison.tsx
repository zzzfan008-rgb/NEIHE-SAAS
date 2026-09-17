import { useEffect, useMemo, useState, type RefObject } from 'react';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription } from './ui/dialog';
import { EMPTY_POSE_STATE,addPoseReferenceToCanvas,generatePoseReference,poseReferenceKey,restorePoseReferences,usePoseReferenceRuntime } from '../store/poseReferenceRuntime';
import type { DocumentTarget } from '../store/flowStore';
import type { PoseReferenceKind } from '../types/poseReference';

export default function PoseReferenceComparison({target,nodeId,source,readOnly,onClose,triggerRef}:{
  target:DocumentTarget;nodeId:string;source:string;readOnly:boolean;onClose:()=>void;triggerRef:RefObject<HTMLButtonElement|null>;
}) {
  const key=poseReferenceKey(target,nodeId,source);
  const state=usePoseReferenceRuntime(s=>s.entries[key]??EMPTY_POSE_STATE);
  const [zoom,setZoom]=useState<string|null>(null);
  const stableTarget=useMemo(()=>target,[target.tabId,target.projectId,target.documentEpoch]);
  const running=Object.values(state.records).some(r=>r?.status==='running');
  useEffect(()=>{
    void restorePoseReferences(stableTarget,nodeId,source);
    const timer=setInterval(()=>{void restorePoseReferences(stableTarget,nodeId,source);},running?1500:15000);
    return ()=>clearInterval(timer);
  },[key,running,stableTarget,nodeId,source]);
  const generate=(kind:PoseReferenceKind,retry=false)=>void generatePoseReference(stableTarget,nodeId,source,kind,retry);
  const panels=[{id:'original' as const,label:'原图',image:source},...(['skeleton','depth'] as const).map(kind=>({id:kind,label:kind==='skeleton'?'骨骼图':'深度图',image:state.records[kind]?.result?.image}))];
  return <Dialog open onOpenChange={open=>{if(!open)onClose();}}>
    <DialogContent aria-describedby="pose-comparison-description" finalFocus={triggerRef}
      onKeyDown={event=>event.stopPropagation()}
      style={{width:'min(1200px, calc(100vw - 48px))',maxWidth:'none',maxHeight:'calc(100vh - 48px)',overflowY:'auto'}}
      className="nodrag nopan bg-[var(--gc-panel)] text-[var(--gc-text)]">
      <DialogHeader>
        <DialogTitle>姿势参考对比</DialogTitle>
        <DialogDescription id="pose-comparison-description">对比后将所需图片添加到画布，再手动连线至「第一轮 · Gemini 场景化定版」的姿势输入。不会自动替换或连线。深度图亮近暗远，仅表示可见表面前后关系。</DialogDescription>
      </DialogHeader>
      <div className="my-3 flex flex-wrap items-center gap-3">
        {!readOnly&&<Button size="sm" disabled={running||Object.values(state.busy).some(Boolean)} onClick={()=>{generate('skeleton');generate('depth');}}>生成两种参考</Button>}
        <Button size="sm" variant="outline" onClick={()=>void restorePoseReferences(stableTarget,nodeId,source)}>刷新结果</Button>
        {zoom&&<Button size="sm" variant="outline" onClick={()=>setZoom(null)}>返回三图对比</Button>}
        <p className="text-xs text-[var(--gc-text-muted)]">DWPose 骨骼与深度均在本地运行，不调用图像模型 API。深度 Large 仅限许可允许的非商业用途。</p>
      </div>
      {state.error&&<p role="alert" className="mb-3 text-sm text-red-600">{state.error}</p>}
      <div style={{display:'grid',gridTemplateColumns:zoom?'minmax(0, 1fr)':'repeat(3, minmax(0, 1fr))',gap:12}}>
        {panels.filter(p=>!zoom||zoom===p.id).map(panel=>{
          const kind=panel.id as PoseReferenceKind;
          const record=state.records[kind];
          const pending=state.busy[kind]||record?.status==='running';
          const error=state.errors[kind]||record?.error;
          const retry=record?.status==='failed'||record?.status==='outcome_unknown';
          return <Card key={panel.id} data-pose-panel={panel.id} role="region" aria-label={panel.label} className="min-w-0 gap-0 border border-[var(--gc-border)] bg-[var(--gc-panel)] p-3 text-[var(--gc-text)]">
            <h3 className="mb-2 text-sm font-medium">{panel.label}{panel.id==='depth'?' · 亮近暗远':''}</h3>
            <div className="flex items-center justify-center overflow-hidden rounded-md bg-[var(--gc-canvas)]" style={{height:zoom?'min(65vh, 700px)':'min(48vh, 500px)'}}>
              {panel.image?<img src={panel.image} alt={panel.label} className="h-full w-full object-contain"/>:<span role="status" className="px-3 text-center text-sm text-[var(--gc-text-muted)]">{pending?'生成中…':record?.status==='outcome_unknown'?'结果未知，请先核对调用记录':retry?'生成失败':'尚未生成'}</span>}
            </div>
            {error&&<p role="alert" className="mt-2 break-words text-xs text-red-600">{error}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              {panel.image&&<>
                <Button size="xs" variant="outline" onClick={()=>setZoom(panel.id)}>放大{panel.label}</Button>
                <Button size="xs" variant="outline" render={<a href={panel.image} download={panel.id==='original'?(source.split('/').pop()||'original.png'):`${panel.id}.png`}/>}>下载{panel.label}</Button>
                {!readOnly&&<Button size="xs" disabled={state.adding?.[panel.id]} aria-label={`添加${panel.label}到画布`} onClick={()=>void addPoseReferenceToCanvas(stableTarget,nodeId,source,panel.id)}>{state.adding?.[panel.id]?'添加中…':'添加到画布'}</Button>}
              </>}
              {panel.id!=='original'&&!readOnly&&(retry||!panel.image||(kind==='skeleton'&&record?.result?.model!=='dwpose-wholebody'))&&<Button size="xs" disabled={pending} onClick={()=>generate(kind,retry)}>{pending?'生成中…':`${retry?'重试':'生成'}${panel.label}（本地）`}</Button>}
            </div>
            {state.addErrors?.[panel.id]&&<p role="alert" className="mt-2 text-xs text-red-600">{state.addErrors[panel.id]}</p>}
            {state.added?.[panel.id]&&<p role="status" className="mt-2 text-xs">已添加到画布，请手动连线。</p>}
            {kind==='skeleton'&&record?.result&&record.result.model!=='dwpose-wholebody'&&<p className="mt-2 text-xs">旧版结果仍可查看；可生成本地 DWPose 骨骼图进行替换。</p>}
            {record?.result?.model&&<p className="mt-2 break-all text-xs text-[var(--gc-text-muted)]">{record.result.model}</p>}
          </Card>;
        })}
      </div>
    </DialogContent>
  </Dialog>;
}

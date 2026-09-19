import { useEffect, useMemo, useState, type RefObject } from 'react';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import {
  EMPTY_POSE_STATE,
  addPoseReferenceToCanvas,
  generatePoseOutfitReference,
  generatePoseReference,
  poseReferenceKey,
  restorePoseOutfitReference,
  restorePoseReferences,
  usePoseReferenceRuntime,
} from '../store/poseReferenceRuntime';
import { useFlowStore, type DocumentTarget } from '../store/flowStore';
import type { PoseReferenceCanvasKind, PoseReferenceKind } from '../types/poseReference';

type ComparisonPanel = {
  id: PoseReferenceCanvasKind;
  label: string;
  image?: string;
};

export default function PoseReferenceComparison({ target, nodeId, source, readOnly, onClose, triggerRef }: {
  target: DocumentTarget;
  nodeId: string;
  source: string;
  readOnly: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const key = poseReferenceKey(target, nodeId, source);
  const state = usePoseReferenceRuntime((s) => s.entries[key] ?? EMPTY_POSE_STATE);
  const [zoom, setZoom] = useState<PoseReferenceCanvasKind | null>(null);
  const [sourceChoice, setSourceChoice] = useState<'auto' | 'original' | 'outfit'>('auto');
  const [skeletonSourceChoice, setSkeletonSourceChoice] = useState<'current' | 'depth'>('current');
  const stableTarget = useMemo(
    () => target,
    [target.tabId, target.projectId, target.documentEpoch],
  );
  const neutralOutfitStatus = state.neutralOutfit?.status;
  const neutralOutfitPending = state.neutralOutfitBusy ||
    neutralOutfitStatus === 'queued' ||
    neutralOutfitStatus === 'running' ||
    neutralOutfitStatus === 'retry_wait';
  const neutralOutfitImage = state.neutralOutfit?.result?.image;
  const analysisSource = sourceChoice !== 'original' && neutralOutfitImage ? neutralOutfitImage : source;
  const referenceKey = poseReferenceKey(target, nodeId, analysisSource);
  const referenceState = usePoseReferenceRuntime(s => s.entries[referenceKey] ?? EMPTY_POSE_STATE);
  const depthRecord = referenceState.records.depth;
  const depthReady = depthRecord?.status === 'succeeded' && Boolean(depthRecord.result?.image) && Boolean(depthRecord.id);
  const useDepthForSkeleton = skeletonSourceChoice === 'depth' && depthReady;
  const skeletonAnalysisSource = useDepthForSkeleton ? depthRecord!.source : analysisSource;
  const skeletonAnalysisSourceRecordId = useDepthForSkeleton ? depthRecord!.id : undefined;
  const skeletonReferenceKey = poseReferenceKey(target, nodeId, skeletonAnalysisSource, skeletonAnalysisSourceRecordId);
  const skeletonState = usePoseReferenceRuntime(s => s.entries[skeletonReferenceKey] ?? EMPTY_POSE_STATE);
  const running = neutralOutfitPending ||
    Object.values(referenceState.records).some(record => record?.status === 'running') ||
    Object.values(referenceState.busy).some(Boolean) ||
    (skeletonReferenceKey !== referenceKey && Object.values(skeletonState.records).some(record => record?.status === 'running')) ||
    (skeletonReferenceKey !== referenceKey && Object.values(skeletonState.busy).some(Boolean));
  const sourceLabel = analysisSource === source ? '原图' : '背心+紧身裤图';
  const skeletonSourceLabel = useDepthForSkeleton ? '深度图' : sourceLabel;
  const neutralOutfitError = state.neutralOutfitError || state.neutralOutfit?.error;
  const neutralOutfitRetry = neutralOutfitStatus === 'failed' ||
    neutralOutfitStatus === 'outcome_unknown' ||
    neutralOutfitStatus === 'cancelled';

  useEffect(() => {
    const restore = () => {
      void restorePoseReferences(stableTarget, nodeId, source, analysisSource);
      if (skeletonAnalysisSourceRecordId) {
        void restorePoseReferences(stableTarget, nodeId, source, skeletonAnalysisSource, skeletonAnalysisSourceRecordId);
      }
    };
    restore();
    void restorePoseOutfitReference(stableTarget, nodeId, source);
    const timer = setInterval(() => {
      restore();
      void restorePoseOutfitReference(stableTarget, nodeId, source);
    }, running ? 1500 : 15000);
    return () => clearInterval(timer);
  }, [key, running, stableTarget, nodeId, source, analysisSource, skeletonAnalysisSource, skeletonAnalysisSourceRecordId]);

  const generate = (kind: PoseReferenceKind, retry = false) =>
    void generatePoseReference(
      stableTarget,
      nodeId,
      source,
      kind,
      retry,
      kind === 'skeleton' ? skeletonAnalysisSource : analysisSource,
      kind === 'skeleton' ? skeletonAnalysisSourceRecordId : undefined,
    );
  const panels: ComparisonPanel[] = [
    { id: 'original', label: '原图', image: source },
    { id: 'skeleton', label: '骨骼图', image: skeletonState.records.skeleton?.result?.image },
    { id: 'depth', label: '深度图', image: referenceState.records.depth?.result?.image },
  ];
  const neutralOutfitPanel: ComparisonPanel = {
    id: 'neutral-outfit',
    label: '背心+紧身裤参考',
    image: neutralOutfitImage,
  };
  const visiblePanels = zoom === 'neutral-outfit'
    ? [neutralOutfitPanel]
    : panels.filter((panel) => !zoom || zoom === panel.id);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        aria-describedby="pose-comparison-description"
        finalFocus={triggerRef}
        onKeyDown={(event) => event.stopPropagation()}
        style={{
          width: 'min(1200px, calc(100vw - 48px))',
          maxWidth: 'none',
          maxHeight: 'calc(100vh - 48px)',
          overflowY: 'auto',
        }}
        className="nodrag nopan bg-[var(--gc-panel)] text-[var(--gc-text)]"
      >
        <DialogHeader>
          <DialogTitle>姿势参考对比</DialogTitle>
          <DialogDescription id="pose-comparison-description">
            对比后将所需图片添加到画布，再手动连线至「第一轮 · 场景化定版」的姿势输入。不会自动替换或连线。深度图亮近暗远，仅表示可见表面前后关系。
          </DialogDescription>
        </DialogHeader>

        <div className="my-3 flex flex-wrap items-center gap-3">
          <div role="group" aria-label="骨骼与深度生成来源" className="flex flex-wrap items-center gap-2">
            <span className="text-xs">生成来源</span>
            <Button size="sm" variant={analysisSource===source?'default':'outline'} aria-pressed={analysisSource===source} onClick={()=>{ setSourceChoice('original'); setSkeletonSourceChoice('current'); }}>原图</Button>
            <Button size="sm" variant={analysisSource!==source?'default':'outline'} aria-pressed={analysisSource!==source} disabled={!neutralOutfitImage} onClick={()=>{ setSourceChoice('outfit'); setSkeletonSourceChoice('current'); }}>背心+紧身裤图</Button>
          </div>
          <div role="group" aria-label="DWPose 骨骼图生成来源" className="flex flex-wrap items-center gap-2">
            <span className="text-xs">DWPose 骨骼图来源</span>
            <Button
              size="sm"
              variant={skeletonSourceChoice === 'current' ? 'default' : 'outline'}
              aria-label="DWPose 跟随当前来源"
              aria-pressed={skeletonSourceChoice === 'current'}
              onClick={() => setSkeletonSourceChoice('current')}
            >
              跟随当前来源
            </Button>
            <Button
              size="sm"
              variant={skeletonSourceChoice === 'depth' ? 'default' : 'outline'}
              aria-label="DWPose 使用深度图"
              aria-pressed={skeletonSourceChoice === 'depth'}
              disabled={!depthReady}
              onClick={() => setSkeletonSourceChoice('depth')}
            >
              深度图
            </Button>
          </div>
          {!readOnly && (
            <Button
              size="sm"
              disabled={running || (skeletonSourceChoice === 'depth' && !depthReady)}
              onClick={() => { generate('skeleton'); generate('depth'); }}
            >
              生成两种参考
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void restorePoseReferences(stableTarget, nodeId, source, analysisSource);
              if (skeletonAnalysisSourceRecordId) {
                void restorePoseReferences(stableTarget, nodeId, source, skeletonAnalysisSource, skeletonAnalysisSourceRecordId);
              }
              void restorePoseOutfitReference(stableTarget, nodeId, source);
            }}
          >
            刷新结果
          </Button>
          {zoom && (
            <Button size="sm" variant="outline" onClick={() => setZoom(null)}>
              返回三图对比
            </Button>
          )}
          <p className="text-xs text-[var(--gc-text-muted)]">
            DWPose 骨骼与深度均在本地运行，不调用图像模型 API。深度 Large 仅限许可允许的非商业用途。
          </p>
        </div>

        {state.error && <p role="alert" className="mb-3 text-sm text-red-600">{state.error}</p>}
        {referenceState !== state && referenceState.error && <p role="alert" className="mb-3 text-sm text-red-600">{referenceState.error}</p>}
        {skeletonReferenceKey !== referenceKey && skeletonState.error && <p role="alert" className="mb-3 text-sm text-red-600">{skeletonState.error}</p>}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: zoom ? 'minmax(0, 1fr)' : 'repeat(3, minmax(0, 1fr))',
            gap: 12,
          }}
        >
          {visiblePanels.map((panel) => {
            const kind = panel.id === 'original' || panel.id === 'neutral-outfit'
              ? undefined
              : panel.id as PoseReferenceKind;
            const panelState = panel.id === 'skeleton' ? skeletonState : kind ? referenceState : state;
            const record = panel.id === 'neutral-outfit'
              ? state.neutralOutfit
              : kind
                ? (panel.id === 'skeleton' ? skeletonState.records[kind] : referenceState.records[kind])
                : undefined;
            const pending = panel.id === 'neutral-outfit'
              ? neutralOutfitPending
              : kind
                ? panelState.busy[kind] || record?.status === 'running'
                : false;
            const error = panel.id === 'neutral-outfit'
              ? neutralOutfitError
              : kind
                ? panelState.errors[kind] || record?.error
                : undefined;
            const retry = panel.id === 'neutral-outfit'
              ? neutralOutfitRetry
              : record?.status === 'failed' || record?.status === 'outcome_unknown';
            const statusText = pending
              ? '生成中…'
              : record?.status === 'outcome_unknown'
                ? '结果未知，请先核对调用记录'
                : retry
                  ? '生成失败'
                  : record?.status === 'cancelled'
                    ? '已取消'
                    : '尚未生成';
            const downloadName = panel.id === 'original'
              ? source.split('/').pop() || 'original.png'
              : panel.id === 'neutral-outfit'
                ? 'neutral-outfit.png'
                : `${panel.id}.png`;

            return (
              <Card
                key={panel.id}
                data-pose-panel={panel.id}
                role="region"
                aria-label={panel.label}
                className="min-w-0 gap-0 border border-[var(--gc-border)] bg-[var(--gc-panel)] p-3 text-[var(--gc-text)]"
              >
                <h3 className="mb-2 text-sm font-medium">
                  {panel.label}{panel.id === 'depth' ? ' · 亮近暗远' : ''}
                </h3>
                {kind && <p className="mb-2 text-xs text-[var(--gc-text-muted)]">来源：{panel.id === 'skeleton' ? skeletonSourceLabel : sourceLabel}</p>}
                <div
                  className="flex items-center justify-center overflow-hidden rounded-md bg-[var(--gc-canvas)]"
                  style={{ height: zoom ? 'min(65vh, 700px)' : 'min(48vh, 500px)' }}
                >
                  {panel.image
                    ? <img src={panel.image} alt={panel.label} className="h-full w-full object-contain" />
                    : <span role="status" className="px-3 text-center text-sm text-[var(--gc-text-muted)]">{panel.id === 'original' ? '原图不可用' : statusText}</span>}
                </div>

                {error && <p role="alert" className="mt-2 break-words text-xs text-red-600">{error}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  {panel.image && (
                    <>
                      <Button size="xs" variant="outline" onClick={() => setZoom(panel.id)}>
                        放大{panel.label}
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        render={<a href={panel.image} download={downloadName} />}
                      >
                        下载{panel.label}
                      </Button>
                      {!readOnly && (
                        <Button
                          size="xs"
                          disabled={panelState.adding?.[panel.id]}
                          aria-label={`添加${panel.label}到画布`}
                          onClick={() => void addPoseReferenceToCanvas(
                            stableTarget,
                            nodeId,
                            source,
                            panel.id,
                            panel.id === 'skeleton' ? skeletonAnalysisSource : analysisSource,
                            panel.id === 'skeleton' ? skeletonAnalysisSourceRecordId : undefined,
                          )}
                        >
                          {panelState.adding?.[panel.id] ? '添加中…' : '添加到画布'}
                        </Button>
                      )}
                    </>
                  )}
                  {kind && !readOnly && (retry || !panel.image || (kind === 'skeleton' && record?.result?.model !== 'dwpose-wholebody')) && (
                    <Button size="xs" disabled={pending} onClick={() => generate(kind, retry)}>
                      {pending ? '生成中…' : `${retry ? '重试' : '生成'}${panel.label}（本地）`}
                    </Button>
                  )}
                </div>

                {panelState.addErrors?.[panel.id] && <p role="alert" className="mt-2 text-xs text-red-600">{panelState.addErrors[panel.id]}</p>}
                {panelState.added?.[panel.id] && <p role="status" className="mt-2 text-xs">已添加到画布，请手动连线。</p>}
                {kind === 'skeleton' && record?.result && record.result.model !== 'dwpose-wholebody' && (
                  <p className="mt-2 text-xs">旧版结果仍可查看；可生成本地 DWPose 骨骼图进行替换。</p>
                )}
                {record?.result?.model && <p className="mt-2 break-all text-xs text-[var(--gc-text-muted)]">{record.result.model}</p>}

                {panel.id === 'original' && (
                  <div data-pose-outfit-panel="neutral-outfit" className="mt-3 rounded-md border border-[var(--gc-border)] bg-[var(--gc-canvas)]/40 p-2">
                    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-medium">背心+紧身裤参考</span>
                      <span className="text-xs text-[var(--gc-text-muted)]">保持人物与姿态不变</span>
                    </div>
                    <div className="flex items-center justify-center overflow-hidden rounded-md bg-[var(--gc-canvas)]" style={{ height: 'min(24vh, 260px)' }}>
                      {neutralOutfitImage
                        ? <img src={neutralOutfitImage} alt="背心+紧身裤参考" className="h-full w-full object-contain" />
                        : <span role="status" className="px-3 text-center text-sm text-[var(--gc-text-muted)]">
                          {neutralOutfitPending ? '生成中…' : neutralOutfitStatus === 'outcome_unknown' ? '结果未知，请先核对调用记录' : neutralOutfitRetry ? '生成失败' : '点击“改为背心+紧身裤”生成参考'}
                        </span>}
                    </div>
                    {neutralOutfitError && <p role="alert" className="mt-2 break-words text-xs text-red-600">{neutralOutfitError}</p>}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {!readOnly && (
                        <Button
                          size="xs"
                          disabled={neutralOutfitPending}
                          onClick={() => { setSourceChoice('auto'); void generatePoseOutfitReference(stableTarget, nodeId, source, neutralOutfitRetry); }}
                        >
                          {neutralOutfitPending ? '生成中…' : neutralOutfitRetry ? '重试背心+紧身裤' : '改为背心+紧身裤'}
                        </Button>
                      )}
                      {neutralOutfitImage && (
                        <>
                          <Button size="xs" variant="outline" onClick={() => setZoom('neutral-outfit')}>放大背心+紧身裤参考</Button>
                          <Button size="xs" variant="outline" render={<a href={neutralOutfitImage} download="neutral-outfit.png" />}>下载背心+紧身裤参考</Button>
                          {!readOnly && (
                            <Button
                              size="xs"
                              disabled={state.adding?.['neutral-outfit']}
                              aria-label="添加背心+紧身裤参考到画布"
                              onClick={() => void addPoseReferenceToCanvas(stableTarget, nodeId, source, 'neutral-outfit')}
                            >
                              {state.adding?.['neutral-outfit'] ? '添加中…' : '添加到画布'}
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                    {state.addErrors?.['neutral-outfit'] && <p role="alert" className="mt-2 text-xs text-red-600">{state.addErrors['neutral-outfit']}</p>}
                    {state.added?.['neutral-outfit'] && <p role="status" className="mt-2 text-xs">已添加到画布，请手动连线。</p>}
                    {state.neutralOutfit?.result?.model && <p className="mt-2 break-all text-xs text-[var(--gc-text-muted)]">{state.neutralOutfit.result.model}</p>}
                    {state.legacyOutfit?.result?.image && <div className="mt-3">
                      <p className="text-xs">历史背心+短裤结果（不作为紧身裤来源）</p>
                      <img src={state.legacyOutfit.result.image} alt="历史背心+短裤参考" className="max-h-40 w-full object-contain" />
                      <Button size="xs" variant="outline" render={<a href={state.legacyOutfit.result.image} download="legacy-shorts.png" />}>下载历史短裤图</Button>
                      {!readOnly && <Button size="xs" onClick={()=>useFlowStore.getState().addPoseReferenceImageNode(stableTarget,nodeId,source,state.legacyOutfit!.result!.image,'历史背心+短裤姿势参考','neutral-outfit')}>添加历史短裤图到画布</Button>}
                    </div>}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

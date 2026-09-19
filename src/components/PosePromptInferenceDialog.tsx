import { useEffect, useMemo, useState, type RefObject } from 'react';
import { analyzePosePrompt, EMPTY_POSE_STATE, poseReferenceKey, usePoseReferenceRuntime } from '../store/poseReferenceRuntime';
import { useFlowStore, type DocumentTarget } from '../store/flowStore';
import { posePromptForImage } from '../types/poseReference';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

export default function PosePromptInferenceDialog({ target, nodeId, source, onClose, triggerRef }: {
  target: DocumentTarget;
  nodeId: string;
  source: string;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const stableTarget = useMemo(
    () => target,
    [target.tabId, target.projectId, target.documentEpoch],
  );
  const key = poseReferenceKey(stableTarget, nodeId, source);
  const state = usePoseReferenceRuntime((runtime) => runtime.entries[key] ?? EMPTY_POSE_STATE);
  const savedPrompt = useFlowStore(s => {
    const data = s.tabs.find(t => t.id === target.tabId && t.projectId === target.projectId && t.documentEpoch === target.documentEpoch)?.nodes.find(n => n.id === nodeId)?.data;
    return data?.kind === 'image-input' && data.imageUrl === source ? posePromptForImage(data) : undefined;
  });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    void analyzePosePrompt(stableTarget, nodeId, source, retry > 0);
  }, [key, nodeId, retry, source, stableTarget]);

  const promptState = state.posePrompt;
  const result = promptState?.result;
  const running = promptState?.status === 'running';
  const failed = promptState?.status === 'failed';

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        aria-describedby="pose-prompt-inference-description"
        finalFocus={triggerRef}
        onKeyDown={(event) => event.stopPropagation()}
        data-pose-prompt-dialog="true"
        className="nodrag nopan bg-[var(--gc-panel)] text-[var(--gc-text)] sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>反推人物姿势</DialogTitle>
          <DialogDescription id="pose-prompt-inference-description">
            使用当前人物姿势参考图反推动作描述，默认用于第一轮生图；可在姿势节点下方检查和修改。已有手动编辑不会被覆盖。首次分析可能产生一次模型调用，相同图片优先读取缓存。
          </DialogDescription>
        </DialogHeader>

        {running && (
          <p role="status" className="rounded-md border border-[var(--gc-border)] bg-[var(--gc-canvas)] px-3 py-4 text-sm text-[var(--gc-text-muted)]">
            正在反推人物姿势…
          </p>
        )}

        {failed && (
          <div className="space-y-3">
            <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-3 text-sm text-red-700">
              {promptState.error ?? '姿势反推失败，请重试'}
            </p>
            <Button type="button" size="sm" onClick={() => setRetry((value) => value + 1)}>
              重试反推
            </Button>
          </div>
        )}

        {(result || savedPrompt !== undefined) && (
          <div className="space-y-3">
            <Card className="gap-0 border border-[var(--gc-border)] bg-[var(--gc-canvas)] p-4 text-[var(--gc-text)]">
              <h3 className="mb-2 text-sm font-medium">{savedPrompt !== undefined ? '当前用于生图的姿势提示词' : '模型反推的姿势提示词'}</h3>
              <pre
                data-pose-prompt="result"
                className="whitespace-pre-wrap break-words text-sm leading-6"
              >
                {savedPrompt ?? result?.prompt}
              </pre>
            </Card>
            {result && <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-[var(--gc-text-muted)]">
              <dt>视觉模型</dt>
              <dd className="break-all">{result.model}</dd>
              <dt>缓存状态</dt>
              <dd>{result.cacheHit ? '命中缓存，未重复调用' : '本次新分析'}</dd>
              <dt>本次模型调用</dt>
              <dd>{result.providerRequests} 次</dd>
            </dl>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

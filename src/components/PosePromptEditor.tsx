import { useEffect } from 'react';
import { useCoalescedTextEdit } from '../hooks/useCoalescedTextEdit';
import { useFlowStore, type DocumentTarget } from '../store/flowStore';
import { analyzePosePrompt, EMPTY_POSE_STATE, poseReferenceKey, usePoseReferenceRuntime } from '../store/poseReferenceRuntime';
import { posePromptForImage } from '../types/poseReference';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Textarea } from './ui/textarea';

export default function PosePromptEditor({ target, nodeId, source, connected, readOnly }: {
  target: DocumentTarget; nodeId: string; source: string; connected: boolean; readOnly: boolean;
}) {
  const data = useFlowStore(s => s.tabs.find(t => t.id === target.tabId && t.projectId === target.projectId && t.documentEpoch === target.documentEpoch)?.nodes.find(n => n.id === nodeId)?.data);
  const key = poseReferenceKey(target, nodeId, source);
  const state = usePoseReferenceRuntime(s => s.entries[key] ?? EMPTY_POSE_STATE);
  const prompt = data?.kind === 'image-input' ? posePromptForImage(data) : undefined;
  const edit = useCoalescedTextEdit(readOnly ? null : { kind: 'node-data', nodeId, field: 'posePrompt' }, { multiline: true });
  useEffect(() => {
    if (connected && !readOnly) void analyzePosePrompt(target, nodeId, source);
  }, [key, nodeId, source, connected, readOnly]);
  const running = state.posePrompt?.status === 'running';
  const failed = state.posePrompt?.status === 'failed';
  return (
    <Card data-pose-prompt-editor className="nodrag nopan nowheel absolute left-0 top-[calc(100%+88px)] z-10 w-full gap-2 border-[var(--gc-border)] bg-[var(--gc-panel)] p-3 text-[var(--gc-text)]" onKeyDown={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
      <label htmlFor={`pose-prompt-${nodeId}`} className="text-xs font-medium">姿势提示词</label>
      <Textarea id={`pose-prompt-${nodeId}`} aria-describedby={`pose-prompt-status-${nodeId}`} value={prompt ?? ''} readOnly={readOnly} maxLength={4000} rows={4}
        placeholder="连线后自动反推，也可自行填写姿势描述"
        className="min-h-24 resize-none text-xs" {...edit.bind} />
      <p id={`pose-prompt-status-${nodeId}`} role="status" className="text-xs leading-4 text-[var(--gc-text-muted)]">
        {running ? '正在反推，可先自行填写；不会覆盖你的编辑。' : failed ? (state.posePrompt?.error ?? '反推失败，请重试或自行填写。') : connected ? (prompt?.trim() ? '将使用此文本拼接第一轮【姿势】提示词。' : '请填写姿势提示词后再生成第一轮。') : '连接第一轮后默认使用；首次反推可能产生模型费用。'}
      </p>
      {failed && !readOnly && <Button size="xs" variant="outline" onClick={() => void analyzePosePrompt(target, nodeId, source, true)}>重试反推</Button>}
    </Card>
  );
}

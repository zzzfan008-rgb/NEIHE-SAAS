import { useMemo, useState, type RefObject } from 'react';
import { analyzePosePrompt, EMPTY_POSE_STATE, posePromptRuntimeKey, usePoseReferenceRuntime } from '../store/poseReferenceRuntime';
import { useAuth } from '../auth/AuthContext';
import { readPoseCredential, savePoseCredential } from '../lib/poseCredentials';
import { useFlowStore, type DocumentTarget } from '../store/flowStore';
import { posePromptForImage } from '../types/poseReference';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

export default function PosePromptInferenceDialog({ target, nodeId, source, onClose, triggerRef }: {
  target: DocumentTarget;
  nodeId: string;
  source: string;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const { user } = useAuth();
  const [provider, setProvider] = useState<'gemini'|'deepseek'>('gemini');
  const [credential, setCredential] = useState(() => ({ owner: user?.id, value: user ? readPoseCredential(user.id) : '' }));
  const apiKey = credential.owner === user?.id ? credential.value : '';
  const [showKey, setShowKey] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const stableTarget = useMemo(
    () => target,
    [target.tabId, target.projectId, target.documentEpoch],
  );
  const key = posePromptRuntimeKey(stableTarget, nodeId, source, provider, user?.id);
  const state = usePoseReferenceRuntime((runtime) => runtime.entries[key] ?? EMPTY_POSE_STATE);
  const savedPrompt = useFlowStore(s => {
    const data = s.tabs.find(t => t.id === target.tabId && t.projectId === target.projectId && t.documentEpoch === target.documentEpoch)?.nodes.find(n => n.id === nodeId)?.data;
    return data?.kind === 'image-input' && data.imageUrl === source ? posePromptForImage(data) : undefined;
  });
  const promptState = state.posePrompt;
  const result = promptState?.result;
  const running = promptState?.status === 'running';
  const failed = promptState?.status === 'failed';
  const writable = useFlowStore(s => {
    const tab = s.tabs.find(t => t.id === target.tabId && t.projectId === target.projectId && t.documentEpoch === target.documentEpoch);
    return Boolean(tab && !tab.readOnly && tab.nodes.some(n => n.id === nodeId && n.data.kind === 'image-input' && n.data.imageUrl === source));
  });

  const applyResult = () => {
    const store = useFlowStore.getState();
    const tab = store.tabs.find(t => t.id === target.tabId && t.projectId === target.projectId && t.documentEpoch === target.documentEpoch);
    if (!result || !tab || tab.readOnly || !tab.nodes.some(n => n.id === nodeId && n.data.kind === 'image-input' && n.data.imageUrl === source)) return;
    store.updateNodeDataInTab(target, nodeId, { posePrompt: result.prompt, posePromptImage: source });
  };
  const canAnalyze = writable && Boolean(user) && !running && (provider !== 'deepseek' || /^[\x21-\x7e]{8,512}$/.test(apiKey.trim()));
  const startAnalysis = () => {
    if (!canAnalyze) return;
    void analyzePosePrompt(stableTarget, nodeId, source, true, { provider, apiKey: apiKey.trim(), ownerId: user?.id, candidateOnly: true });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        aria-describedby="pose-prompt-inference-description"
        finalFocus={triggerRef}
        onKeyDown={(event) => event.stopPropagation()}
        data-pose-prompt-dialog="true"
        className="nodrag nopan max-h-[85vh] overflow-y-auto bg-[var(--gc-panel)] text-[var(--gc-text)] sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>反推人物姿势</DialogTitle>
          <DialogDescription id="pose-prompt-inference-description">
            从整体到局部反推姿态与可见神态；深度图或骨骼图无法判断视线与神态。已有文本保留，可检查新版结果后选择替换。首次按新版规则分析可能产生模型费用，同版本相同图片优先读取缓存。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label id="pose-model-label" className="text-sm font-medium">反推模型</label>
          <Select value={provider} disabled={running} onValueChange={(value) => { if (value === 'gemini' || value === 'deepseek') setProvider(value); }}>
            <SelectTrigger aria-labelledby="pose-model-label" className="w-full"><SelectValue>{provider === 'gemini' ? 'Gemini' : 'DeepSeek'}</SelectValue></SelectTrigger>
            <SelectContent>
              <SelectItem value="gemini">Gemini</SelectItem>
              <SelectItem value="deepseek">DeepSeek</SelectItem>
            </SelectContent>
          </Select>
          {provider === 'deepseek' && <div className="space-y-2">
            <label htmlFor="pose-deepseek-key" className="text-sm font-medium">DeepSeek API Key</label>
            <div className="flex gap-2">
              <Input id="pose-deepseek-key" type={showKey ? 'text' : 'password'} value={apiKey} disabled={running || !user}
                autoComplete="off" spellCheck={false} maxLength={512} className="min-w-0 flex-1" aria-describedby="pose-key-help"
                onChange={(event) => {
                  if (!user) return;
                  const value = event.target.value;
                  setCredential({ owner: user.id, value });
                  setStorageError(!savePoseCredential(user.id, value));
                }} />
              <Button type="button" variant="outline" aria-label={showKey ? '隐藏密钥' : '显示密钥'} aria-pressed={showKey} onClick={() => setShowKey(value => !value)}>{showKey ? '隐藏' : '显示'}</Button>
            </div>
            <p id="pose-key-help" className="text-xs text-[var(--gc-text-muted)]">密钥按当前账号保留在本机，刷新后可用，退出登录时清除。调用费用由你的 DeepSeek 账户承担。</p>
            <p className="break-all text-xs text-[var(--gc-text-muted)]">deepseek-v4-flash-vision-exp（官方兼容名称，实际由最新 Flash 模型承接）</p>
            {storageError && <p role="alert" className="text-sm text-red-600">浏览器未能保存密钥，本次页面仍可使用，刷新后需重新填写。</p>}
          </div>}
        </div>
        <Button type="button" size="sm" variant="outline" disabled={!canAnalyze} onClick={startAnalysis}>
          {result ? '重新反推' : '开始反推'}
        </Button>

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
            <Button type="button" size="sm" disabled={!canAnalyze} onClick={startAnalysis}>
              重试反推
            </Button>
          </div>
        )}

        {(result || savedPrompt !== undefined) && (
          <div className="space-y-3">
            {savedPrompt !== undefined && <Card className="gap-0 border border-[var(--gc-border)] bg-[var(--gc-canvas)] p-4 text-[var(--gc-text)]">
              <h3 className="mb-2 text-sm font-medium">当前用于生图的姿势提示词</h3>
              <pre
                data-pose-prompt="result"
                className="whitespace-pre-wrap break-words text-sm leading-6"
              >
                {savedPrompt}
              </pre>
            </Card>}
            {result && result.prompt !== savedPrompt && !running && !failed && (
              <Card className="gap-3 border-[var(--gc-border)] bg-[var(--gc-canvas)] p-4 text-[var(--gc-text)]">
                <h3 className="text-sm font-medium">{provider === 'deepseek' ? 'DeepSeek' : 'Gemini'} 反推结果</h3>
                <pre data-pose-prompt="candidate" className="whitespace-pre-wrap break-words text-sm leading-6">{result.prompt}</pre>
                <Button type="button" size="sm" disabled={!writable} onClick={applyResult}>{savedPrompt === undefined ? '使用此姿势提示词' : '使用新版结果替换当前提示词'}</Button>
              </Card>
            )}
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

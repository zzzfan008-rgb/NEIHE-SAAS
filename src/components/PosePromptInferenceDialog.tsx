import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { analyzePosePrompt, EMPTY_POSE_STATE, posePromptRuntimeKey, poseReferenceKey, restorePoseReferences, usePoseReferenceRuntime } from '../store/poseReferenceRuntime';
import { useAuth } from '../auth/AuthContext';
import { readPoseCredential, savePoseCredential } from '../lib/poseCredentials';
import { useFlowStore, type DocumentTarget } from '../store/flowStore';
import { CALIBRATED_POSE_SUPPLEMENT_HEADER, optimizedPosePromptForImage, posePromptForImage, type PosePromptMode } from '../types/poseReference';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './ui/alert-dialog';

export default function PosePromptInferenceDialog({ target, nodeId, source, onClose, triggerRef }: {
  target: DocumentTarget;
  nodeId: string;
  source: string;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const { user } = useAuth();
  const [provider, setProvider] = useState<'gemini'|'deepseek'>('gemini');
  const [calibrationMode, setCalibrationMode] = useState<PosePromptMode>(() => {
    const data = useFlowStore.getState().tabs.find(t => t.id === target.tabId && t.projectId === target.projectId && t.documentEpoch === target.documentEpoch)?.nodes.find(n => n.id === nodeId)?.data;
    return data?.kind === 'image-input' && data.imageUrl === source && posePromptForImage(data) !== undefined && data.posePromptMode === 'three-view' ? 'three-view' : 'single';
  });
  const [credential, setCredential] = useState(() => ({ owner: user?.id, value: user ? readPoseCredential(user.id) : '' }));
  const apiKey = credential.owner === user?.id ? credential.value : '';
  const [showKey, setShowKey] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const stableTarget = useMemo(
    () => target,
    [target.tabId, target.projectId, target.documentEpoch],
  );
  useEffect(() => { void restorePoseReferences(stableTarget, nodeId, source); }, [stableTarget, nodeId, source]);
  const key = posePromptRuntimeKey(stableTarget, nodeId, source, provider, user?.id, calibrationMode);
  const state = usePoseReferenceRuntime((runtime) => runtime.entries[key] ?? EMPTY_POSE_STATE);
  const referenceKey = poseReferenceKey(stableTarget, nodeId, source);
  const referenceState = usePoseReferenceRuntime((runtime) => runtime.entries[referenceKey] ?? EMPTY_POSE_STATE);
  const depthRecord = referenceState.records.depth;
  const skeletonRecord = referenceState.records.skeleton;
  const depthReady = depthRecord?.source === source && depthRecord.status === 'succeeded' && depthRecord.result?.convention === 'near-white' && typeof depthRecord.result.image === 'string';
  const pose = skeletonRecord?.result?.pose;
  const skeletonReady = skeletonRecord?.source === source && skeletonRecord.status === 'succeeded' && typeof skeletonRecord.result?.image === 'string' && pose?.schemaVersion === 1 && pose.people.some(person => person.keypoints.some(Boolean));
  const threeViewReady = Boolean(depthReady && skeletonReady);
  const savedPrompt = useFlowStore(s => {
    const data = s.tabs.find(t => t.id === target.tabId && t.projectId === target.projectId && t.documentEpoch === target.documentEpoch)?.nodes.find(n => n.id === nodeId)?.data;
    return data?.kind === 'image-input' && data.imageUrl === source ? posePromptForImage(data) : undefined;
  });
  const savedPromptMode = useFlowStore(s => {
    const data = s.tabs.find(t => t.id === target.tabId && t.projectId === target.projectId && t.documentEpoch === target.documentEpoch)?.nodes.find(n => n.id === nodeId)?.data;
    return data?.kind === 'image-input' && data.imageUrl === source ? data.posePromptMode ?? 'single' : undefined;
  });
  const savedOptimizedPrompt = useFlowStore(s => {
    const data = s.tabs.find(t => t.id === target.tabId && t.projectId === target.projectId && t.documentEpoch === target.documentEpoch)?.nodes.find(n => n.id === nodeId)?.data;
    return data?.kind === 'image-input' && data.imageUrl === source ? optimizedPosePromptForImage(data) : undefined;
  });
  const savedOptimizedPromptVerified = useFlowStore(s => {
    const data = s.tabs.find(t => t.id === target.tabId && t.projectId === target.projectId && t.documentEpoch === target.documentEpoch)?.nodes.find(n => n.id === nodeId)?.data;
    return data?.kind === 'image-input' && data.imageUrl === source && data.posePromptOptimizedVerified === true;
  });
  const promptState = state.posePrompt;
  const result = promptState?.result;
  const running = promptState?.status === 'running';
  const failed = promptState?.status === 'failed';
  const writable = useFlowStore(s => {
    const tab = s.tabs.find(t => t.id === target.tabId && t.projectId === target.projectId && t.documentEpoch === target.documentEpoch);
    return Boolean(tab && !tab.readOnly && tab.nodes.some(n => n.id === nodeId && n.data.kind === 'image-input' && n.data.imageUrl === source));
  });
  const revision = JSON.stringify([target, nodeId, source, savedPrompt, savedPromptMode, savedOptimizedPrompt, savedOptimizedPromptVerified]);
  const [draft, setDraft] = useState<{ revision: string; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingSave, setPendingSave] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [saveMessage, setSaveMessage] = useState<string>();
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const optimizedText = draft?.text ?? savedOptimizedPrompt ?? '';
  const dirty = draft !== null && draft.text !== (savedOptimizedPrompt ?? '');
  const conflict = dirty && draft.revision !== revision;
  const editorMode = savedPromptMode ?? calibrationMode;
  const unavailableReason = useFlowStore(s => {
    const tab = s.tabs.find(t => t.id === target.tabId && t.projectId === target.projectId && t.documentEpoch === target.documentEpoch);
    if (!tab) return '当前项目已切换，请关闭弹窗后重新打开姿势节点。';
    if (tab.readOnly) return '当前项目为只读，请在自己可编辑的项目中修改提示词。';
    return tab.nodes.some(n => n.id === nodeId && n.data.kind === 'image-input' && n.data.imageUrl === source)
      ? undefined : '姿势图片已变化，请重新打开当前图片的提示词编辑器。';
  });
  const currentData = () => {
    const tab = useFlowStore.getState().tabs.find(t => t.id === target.tabId && t.projectId === target.projectId && t.documentEpoch === target.documentEpoch);
    const data = tab?.nodes.find(n => n.id === nodeId)?.data;
    return tab && !tab.readOnly && data?.kind === 'image-input' && data.imageUrl === source ? data : undefined;
  };
  const saveOptimized = async () => {
    if (!writable || saving || running || conflict || (!dirty && !pendingSave) || !optimizedText.trim() || optimizedText.length > 4000) return;
    const data = currentData();
    if (!data || posePromptForImage(data) !== savedPrompt || optimizedPosePromptForImage(data) !== savedOptimizedPrompt ||
        (data.posePromptMode ?? 'single') !== savedPromptMode || (data.posePromptOptimizedVerified === true) !== savedOptimizedPromptVerified) {
      setSaveError('姿势来源或提示词已变化，请重新打开后编辑');
      return;
    }
    setSaving(true);
    setSaveError(undefined);
    setSaveMessage(undefined);
    const unchanged = () => {
      const latest = currentData();
      return latest && latest.posePrompt === data.posePrompt && latest.posePromptOptimized === data.posePromptOptimized &&
        latest.posePromptMode === data.posePromptMode && latest.posePromptOptimizedVerified === data.posePromptOptimizedVerified;
    };
    try {
      let verified = savedOptimizedPromptVerified;
      let reason: string | undefined;
      if (dirty) {
        verified = false;
        if (editorMode === 'three-view') {
          if (!await useFlowStore.getState().saveProjectInTab(stableTarget)) throw new Error('项目保存失败，编辑稿仍保留，请重试');
          if (!unchanged()) throw new Error('姿势来源或提示词已变化，请重新打开检查');
          const response = await fetch('/api/pose-references/validate-prompt', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000),
            body: JSON.stringify({ projectId: target.projectId, nodeId, source, prompt: optimizedText.trim(), provider,
              ...(provider === 'deepseek' ? { apiKey: apiKey.trim() } : {}) }),
          });
          const validation = await response.json();
          if (!response.ok) throw new Error(typeof validation.error === 'string' ? validation.error : '提示词校验失败，编辑稿仍保留');
          if (typeof validation.verified !== 'boolean' || (validation.reason !== undefined && typeof validation.reason !== 'string')) throw new Error('提示词校验响应无效');
          verified = validation.verified;
          reason = validation.reason;
        }
        if (!unchanged()) throw new Error('姿势来源或提示词已变化，编辑稿未写入其他文档');
        useFlowStore.getState().updateNodeDataInTab(stableTarget, nodeId, {
          posePrompt: savedPrompt?.trim() ? savedPrompt : optimizedText.trim(),
          posePromptImage: source,
          posePromptMode: editorMode,
          posePromptOptimized: optimizedText.trim(),
          posePromptOptimizedVerified: verified ? true : undefined,
        });
        setDraft(null);
      }
      setPendingSave(true);
      const written = currentData();
      if (!await useFlowStore.getState().saveProjectInTab(stableTarget)) throw new Error('优化文本已更新到当前文档，但项目保存失败，请重试保存');
      const latest = currentData();
      if (!latest || latest.posePrompt !== written?.posePrompt || latest.posePromptOptimized !== written?.posePromptOptimized ||
          latest.posePromptMode !== written?.posePromptMode || latest.posePromptOptimizedVerified !== written?.posePromptOptimizedVerified) {
        throw new Error('姿势来源或提示词已变化，请重新打开检查保存结果');
      }
      setPendingSave(false);
      setSaveMessage(editorMode !== 'three-view' ? '优化提示词已保存' : verified
        ? '优化提示词已保存并通过证据校验，将作为原姿势图的补充用于生图。'
        : `编辑稿已保存，尚未通过证据校验，生图不采用此文本。${reason ?? ''}`);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '项目保存失败，请重试保存');
    } finally {
      setSaving(false);
    }
  };
  const close = () => {
    if (saving) return;
    if (dirty || pendingSave) setDiscardOpen(true);
    else onClose();
  };

  const applyResult = () => {
    const store = useFlowStore.getState();
    const tab = store.tabs.find(t => t.id === target.tabId && t.projectId === target.projectId && t.documentEpoch === target.documentEpoch);
    if (!result || dirty || pendingSave || saving || !tab || tab.readOnly || !tab.nodes.some(n => n.id === nodeId && n.data.kind === 'image-input' && n.data.imageUrl === source)) return;
    setDraft(null);
    setSaveMessage(undefined);
    setSaveError(undefined);
    const optimized = result.calibrationMode === 'three-view' && typeof result.optimizedPrompt === 'string' && result.optimizedPrompt.trim()
      ? result.optimizedPrompt : undefined;
    store.updateNodeDataInTab(target, nodeId, {
      posePrompt: result.prompt,
      posePromptImage: source,
      posePromptMode: result.calibrationMode ?? 'single',
      posePromptOptimized: optimized,
      posePromptOptimizedVerified: optimized && result.optimizedPromptVerified === true ? true : undefined,
    });
  };
  const canAnalyze = writable && Boolean(user) && !running && !saving && (provider !== 'deepseek' || /^[\x21-\x7e]{8,512}$/.test(apiKey.trim())) && (calibrationMode !== 'three-view' || threeViewReady);
  const startAnalysis = () => {
    if (!canAnalyze) return;
    void analyzePosePrompt(stableTarget, nodeId, source, true, { provider, apiKey: apiKey.trim(), ownerId: user?.id, candidateOnly: true, calibrationMode });
  };

  return (
    <>
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
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
        <div className="space-y-3">
          <label id="pose-calibration-label" className="text-sm font-medium">分析方式</label>
          <Select value={calibrationMode} disabled={running} onValueChange={(value) => { if (value === 'single' || value === 'three-view') setCalibrationMode(value); }}>
            <SelectTrigger aria-labelledby="pose-calibration-label" className="w-full"><SelectValue>{calibrationMode === 'single' ? '单图反推' : '原图 + 深度图 + DWPose 三图校准'}</SelectValue></SelectTrigger>
            <SelectContent>
              <SelectItem value="single">单图反推</SelectItem>
              <SelectItem value="three-view">原图 + 深度图 + DWPose 三图校准</SelectItem>
            </SelectContent>
          </Select>
          {calibrationMode === 'three-view' && <Card className="space-y-3 border-[var(--gc-border)] bg-[var(--gc-canvas)] p-3 text-[var(--gc-text)]">
            <p className="text-xs text-[var(--gc-text-muted)]">校准仅使用当前原图对应的深度图、DWPose 骨骼图和结构化关节点；任一证据未就绪时不会调用模型。深度约定：近处偏白、远处偏黑。</p>
            <div className="grid grid-cols-3 gap-2">
              <div className="min-w-0 space-y-1">
                <img src={source} alt="当前姿势原图" className="h-24 w-full rounded border border-[var(--gc-border)] object-contain" />
                <p className="text-xs">原图 · 当前来源</p>
              </div>
              <div className="min-w-0 space-y-1">
                {depthReady && depthRecord?.result?.image ? <img src={depthRecord.result.image} alt="当前原图对应的深度图" className="h-24 w-full rounded border border-[var(--gc-border)] object-contain" /> : <div className="flex h-24 items-center justify-center rounded border border-dashed border-[var(--gc-border)] text-xs text-[var(--gc-text-muted)]">深度图未就绪</div>}
                <p className="text-xs">深度图 · {depthReady ? '就绪' : depthRecord?.status === 'running' ? '生成中' : depthRecord?.status === 'failed' ? '生成失败' : '未生成'}</p>
              </div>
              <div className="min-w-0 space-y-1">
                {skeletonReady && skeletonRecord?.result?.image ? <img src={skeletonRecord.result.image} alt="当前原图对应的 DWPose 骨骼图" className="h-24 w-full rounded border border-[var(--gc-border)] object-contain" /> : <div className="flex h-24 items-center justify-center rounded border border-dashed border-[var(--gc-border)] text-xs text-[var(--gc-text-muted)]">DWPose 未就绪</div>}
                <p className="text-xs">DWPose · {skeletonReady ? '含可编辑关节点' : skeletonRecord?.status === 'running' ? '生成中' : skeletonRecord?.status === 'failed' ? '生成失败' : '未生成'}</p>
              </div>
            </div>
            {!threeViewReady && <p role="status" className="text-xs text-[var(--gc-text-muted)]">请先在姿势参考结果中生成当前原图的深度图和 DWPose 骨骼图。</p>}
          </Card>}
        </div>
        <Button type="button" size="sm" variant="outline" disabled={!canAnalyze} onClick={startAnalysis}>
          {result ? '重新反推' : '开始反推'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => { editorRef.current?.focus(); editorRef.current?.scrollIntoView({ block: 'center' }); }}>
          编辑优化提示词
        </Button>
        {result?.calibrationMode === 'three-view' && !result.optimizedPromptVerified && (
          <p role="status" className="rounded-md border border-[var(--gc-border)] p-3 text-sm">
            三图反推已完成，优化文本未通过校验：{result.optimizationError ?? '未获得已校验的姿势补充。'}
            原始结果保留用于对比；新结果需先确认替换，编辑稿保存时会复用已有证据校验，不调用模型。
          </p>
        )}

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
              <h3 className="mb-2 text-sm font-medium">{savedPromptMode === 'three-view' ? '当前校准原始提示词（只读对比）' : savedOptimizedPrompt !== undefined ? '原始反推提示词（只读对比）' : '当前用于生图的姿势提示词（只读对比）'}</h3>
              <pre
                data-pose-prompt="result"
                className="whitespace-pre-wrap break-words text-sm leading-6"
              >
                {savedPrompt}
              </pre>
            </Card>}
            {result && (result.prompt !== savedPrompt || result.optimizedPrompt !== savedOptimizedPrompt || (result.calibrationMode ?? 'single') !== (savedPromptMode ?? 'single')) && !running && !failed && (
              <Card className="gap-3 border-[var(--gc-border)] bg-[var(--gc-canvas)] p-4 text-[var(--gc-text)]">
                <h3 className="text-sm font-medium">{result.calibrationMode === 'three-view' ? '新反推的校准原始结果（用于对比）' : `${provider === 'deepseek' ? 'DeepSeek' : 'Gemini'} 反推结果`}</h3>
                <pre data-pose-prompt="candidate" className="whitespace-pre-wrap break-words text-sm leading-6">{result.prompt}</pre>
                {result.optimizedPrompt !== undefined && <div className="mt-3 space-y-2">
                  <h4 className="text-sm font-medium">优化后提示词（将用于生图）</h4>
                  <pre data-pose-prompt="candidate-optimized" className="whitespace-pre-wrap break-words text-sm leading-6">{result.optimizedPrompt}</pre>
                </div>}
                <Button type="button" size="sm" disabled={!writable || dirty || pendingSave || saving} onClick={applyResult}>{savedPrompt === undefined ? '使用此姿势提示词' : '确认并替换当前提示词'}</Button>
                {(dirty || pendingSave) && <p className="text-xs text-[var(--gc-text-muted)]">请先保存或恢复下方优化文本，再替换反推结果。</p>}
              </Card>
            )}
            {result && <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-[var(--gc-text-muted)]">
              <dt>视觉模型</dt>
              <dd className="break-all">{result.model}</dd>
              {result.calibrationMode === 'three-view' && <><dt>校准方式</dt><dd>原图 + 深度图 + DWPose</dd></>}
              <dt>缓存状态</dt>
              <dd>{result.cacheHit ? '命中缓存，未重复调用' : '本次新分析'}</dd>
              <dt>本次模型调用</dt>
              <dd>{result.providerRequests} 次</dd>
            </dl>}
          </div>
        )}
        <Card className="gap-3 border-[var(--gc-border)] bg-[var(--gc-panel)] p-4 text-[var(--gc-text)]">
          <label htmlFor="pose-optimized-prompt" className="text-sm font-medium">优化后姿势提示词</label>
          <p id="pose-optimized-help" className="text-xs text-[var(--gc-text-muted)]">
            {savedOptimizedPrompt === undefined
              ? '下方是可编辑区域。三图校准通过证据校验后才会产生可用于生图的优化文本；也可手动填写。'
              : '下方为当前已保存的文本，可自行编辑；原始反推结果保留用于对比。'}
            单图文本保存后用于生图；三图文本保存时复用已有证据校验，通过后作为原图的补充，否则只保存为草稿。手动保存不会调用模型。
          </p>
          {unavailableReason && <p role="status" className="text-sm text-[var(--gc-text-muted)]">{unavailableReason}</p>}
          {editorMode === 'three-view' && <>
            <p className="text-xs text-[var(--gc-text-muted)]">{savedOptimizedPromptVerified ? '当前保存文本已通过证据校验，生图将采用。' : '当前保存文本未通过证据校验，生图仅按原姿势图约束。'} 修改后需重新保存校验；新增而无证据支持的描述会保留为草稿。</p>
            <Button type="button" variant="outline" size="sm" disabled={!writable || saving || Boolean(optimizedText)} onClick={() => {
              setDraft({ revision, text: `${CALIBRATED_POSE_SUPPLEMENT_HEADER}\n视线方向：\n面部神态：` });
              editorRef.current?.focus();
            }}>填写三图补充格式</Button>
          </>}
          <Textarea ref={editorRef} id="pose-optimized-prompt" data-pose-prompt="saved-optimized" aria-describedby="pose-optimized-help"
            value={optimizedText} maxLength={4000} disabled={!writable || saving} placeholder="填写或编辑最终用于生图的姿势提示词"
            className="min-h-40 max-h-64 resize-y overflow-y-auto"
            onChange={event => {
              setDraft(previous => ({ revision: previous?.revision ?? revision, text: event.target.value }));
              setSaveMessage(undefined);
            }} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={!writable || saving || running || conflict || (!dirty && !pendingSave) || !optimizedText.trim() || optimizedText.length > 4000}
              onClick={() => void saveOptimized()}>{saving ? '正在保存…' : '保存优化提示词'}</Button>
            <Button type="button" size="sm" variant="outline" disabled={!draft || saving}
              onClick={() => { setDraft(null); setSaveMessage(undefined); setSaveError(undefined); }}>恢复当前保存内容</Button>
            <span className="ml-auto text-xs text-[var(--gc-text-muted)]">{optimizedText.length} / 4000</span>
          </div>
          {conflict && <p role="alert" className="text-sm text-destructive">姿势来源或提示词已变化，请恢复当前保存内容后再编辑，避免覆盖新结果。</p>}
          {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
          {saveMessage && <p role="status" className="text-sm text-[var(--gc-text-muted)]">{saveMessage}</p>}
        </Card>
      </DialogContent>
    </Dialog>
    <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>放弃未保存的优化提示词？</AlertDialogTitle>
          <AlertDialogDescription>{pendingSave ? '项目尚未保存成功，关闭不会撤销已更新到当前文档的文本，但刷新可能丢失。' : '关闭后将丢弃本次尚未保存的编辑，当前已保存的提示词不会改变。'}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>继续编辑</AlertDialogCancel>
          <AlertDialogAction onClick={onClose}>放弃修改</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}

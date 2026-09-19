import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useCoalescedTextEdit } from '@/hooks/useCoalescedTextEdit';
import { effectiveIncomingSources } from '@/lib/maskRepair';
import { nodeOutputImages, selectActiveEdges, selectActiveNodes, selectActiveReadOnly, useFlowStore } from '@/store/flowStore';
import { SCENE_STABILIZE_MODEL_IDS, getImageModelContract, imageModelLabel, isSceneStabilizeModelId, type ImageModelOptions } from '@/types/imageModels';
import { validPoseReferenceSource, type PoseReferenceCanvasKind } from '@/types/poseReference';
import { isNodeRunActive, type VirtualTryOnNodeData } from '@/types/workflow';

const RATIOS = ['1:1', '4:5', '3:4', '2:3', '9:16', '16:9'] as const;
const POSE_TYPE_LABELS: Record<PoseReferenceCanvasKind, string> = {
  original: '原始人物照片', 'neutral-outfit': '服饰简化人物照片', skeleton: '骨架图', depth: '深度图',
};

/** One document-backed editor shared by the canvas node and Inspector. */
export function SceneStabilizeControls({ nodeId, data }: { nodeId: string; data: VirtualTryOnNodeData }) {
  const update = useFlowStore(s => s.updateNodeData);
  const readOnly = useFlowStore(selectActiveReadOnly);
  const nodes = useFlowStore(selectActiveNodes);
  const edges = useFlowStore(selectActiveEdges);
  const poseEdge = edges.find(edge => edge.target === nodeId && edge.targetHandle === 'pose');
  const poseSource = effectiveIncomingSources(nodes, edges, nodeId).find(source => source.targetHandle === 'pose');
  const poseNode = nodes.find(node => node.id === poseSource?.node.id);
  const poseImages = poseNode ? nodeOutputImages(poseNode.data, poseSource?.sourceHandle) : [];
  const poseType = poseNode?.data.kind === 'image-input' &&
    validPoseReferenceSource(poseNode.data.poseReferenceSource, poseNode.data.imageUrl)
    ? POSE_TYPE_LABELS[poseNode.data.poseReferenceSource.kind] : '类型未标注';
  const edit = useCoalescedTextEdit({ kind: 'node-data', nodeId, field: 'prompt' }, { multiline: true });
  const disabled = readOnly || isNodeRunActive(data.status);
  const gemini = data.modelId.startsWith('gemini-');
  const qualities = getImageModelContract(data.modelId).qualities ?? [];
  const change = (patch: Partial<VirtualTryOnNodeData>) => {
    const state = useFlowStore.getState();
    const current = selectActiveNodes(state).find(node => node.id === nodeId)?.data;
    if (!current || current.kind !== 'virtual-try-on' || selectActiveReadOnly(state) || isNodeRunActive(current.status)) return;
    // Dependent Selects can echo an already-applied value during a model switch.
    // Do not create a second undo entry or invalidate approval for that echo.
    if (Object.entries(patch).every(([key, value]) => JSON.stringify(current[key]) === JSON.stringify(value))) return;
    update(nodeId, { ...patch, error: undefined });
  };
  const dimensions = (imageSize: VirtualTryOnNodeData['imageSize'], ratio = data.aspectRatio): ImageModelOptions => (
    gemini ? { aspectRatio: ratio, imageSize } : { quality: data.modelOptions.quality ?? 'medium' }
  );

  return <div className="nodrag nopan nowheel min-w-0 space-y-2" aria-label="第一轮生成设置">
    <div role="group" aria-label="当前姿势参考" className="min-w-0 space-y-0.5 text-[10px] leading-relaxed text-[var(--gc-text-muted)]">
      <p className="break-words">姿势来源：{poseNode?.data.label ?? (poseEdge ? '来源不可用' : '未连接')}</p>
      {poseNode && <p>{poseImages.length === 0 ? '待提供图片' : poseImages.length === 1 ? poseType : '图片数量异常，请保留 1 张姿势参考'}</p>}
    </div>
    <label className="block space-y-1">
      <span className="text-[10px] text-[var(--gc-text-muted)]">创作想法（可选）</span>
      <Textarea aria-label="创作想法" value={data.prompt} {...edit.bind} disabled={disabled} rows={4}
        placeholder="例如：整体呈现简洁的时装画册质感，减少过度磨皮。"
        className="min-h-20 resize-none text-xs [field-sizing:fixed]" />
    </label>
    <p className="text-[9px] leading-relaxed text-[var(--gc-text-muted)]">左右按画面方向；动作描述应与姿势参考一致，不猜测不可见的关节或视线。身份、服装与场景由对应参考图决定。</p>
    <p className="text-[9px] leading-relaxed text-[var(--gc-text-muted)]">第一轮不执行通用提示词增强，保留原始要求；审核拒绝时不自动改写重试。</p>
    <Option label="图像模型" value={data.modelId} disabled={disabled}
      items={SCENE_STABILIZE_MODEL_IDS.map(id => [id, imageModelLabel(id) + (id === 'gemini-3.1-flash-image' ? '（旧配置兼容）' : '')])}
      onChange={value => {
        if (!isSceneStabilizeModelId(value)) return;
        const nextGemini = value.startsWith('gemini-');
        const imageSize = data.imageSize === '1K' && !nextGemini ? '2K' : data.imageSize;
        const quality = data.modelOptions.quality;
        change({ modelId: value, imageSize, modelOptions: nextGemini
          ? { aspectRatio: data.aspectRatio, imageSize }
          : { quality: quality && getImageModelContract(value).qualities?.includes(quality) ? quality : 'medium' } });
      }} />
    <div className="grid min-w-0 grid-cols-2 gap-2">
      <Option label="画幅比例" value={data.sceneFraming === 'custom' ? data.aspectRatio : 'scene'} disabled={disabled}
        items={[["scene", "跟随场景"], ...RATIOS.map(ratio => [ratio, ratio])]}
        onChange={value => {
          if (value === 'scene') change({ sceneFraming: 'scene' });
          else if (RATIOS.includes(value as typeof RATIOS[number])) change({ sceneFraming: 'custom', aspectRatio: value as typeof RATIOS[number], modelOptions: dimensions(data.imageSize, value as typeof RATIOS[number]) });
        }} />
      <Option label="输出尺寸" value={data.imageSize} disabled={disabled}
        items={(gemini ? ['1K', '2K', '4K'] : ['2K', '4K']).map(size => [size, size])}
        onChange={value => { if (['1K', '2K', '4K'].includes(value)) change({ imageSize: value as VirtualTryOnNodeData['imageSize'], modelOptions: dimensions(value as VirtualTryOnNodeData['imageSize']) }); }} />
    </div>
    {!gemini && <Option label="图片质量" value={data.modelOptions.quality ?? 'medium'} disabled={disabled}
      items={qualities.map(q => [q, q])}
      onChange={value => { if (qualities.includes(value as NonNullable<ImageModelOptions['quality']>)) change({ modelOptions: { ...data.modelOptions, quality: value as ImageModelOptions['quality'] } }); }} />}
    {data.modelId === 'gpt-image-2.5-flare' && <p className="text-[9px] leading-relaxed text-[var(--gc-text-muted)]">本轮直接使用 Flare 多图编辑；xhigh / max 费用更高、等待更久。</p>}
  </div>;
}

function Option({ label, value, items, disabled, onChange }: {
  label: string; value: string; items: string[][]; disabled: boolean; onChange: (value: string) => void;
}) {
  return <div className="min-w-0 space-y-1">
    <span className="text-[10px] text-[var(--gc-text-muted)]">{label}</span>
    <Select value={value} disabled={disabled} onValueChange={next => { if (next) onChange(next); }}>
      <SelectTrigger aria-label={label} className="h-8 w-full min-w-0 text-xs"><SelectValue>{items.find(([key]) => key === value)?.[1] ?? value}</SelectValue></SelectTrigger>
      <SelectContent>{items.map(([key, text]) => <SelectItem key={key} value={key}>{text}</SelectItem>)}</SelectContent>
    </Select>
  </div>;
}

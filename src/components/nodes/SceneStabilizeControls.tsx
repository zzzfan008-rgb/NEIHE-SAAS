import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useCoalescedTextEdit } from '@/hooks/useCoalescedTextEdit';
import { selectActiveNodes, selectActiveReadOnly, useFlowStore } from '@/store/flowStore';
import { SCENE_STABILIZE_MODEL_IDS, getImageModelContract, imageModelLabel, isSceneStabilizeModelId, type ImageModelOptions } from '@/types/imageModels';
import { isNodeRunActive, type VirtualTryOnNodeData } from '@/types/workflow';

const RATIOS = ['1:1', '4:5', '3:4', '2:3', '9:16', '16:9'] as const;

/** One document-backed editor shared by the canvas node and Inspector. */
export function SceneStabilizeControls({ nodeId, data }: { nodeId: string; data: VirtualTryOnNodeData }) {
  const update = useFlowStore(s => s.updateNodeData);
  const readOnly = useFlowStore(selectActiveReadOnly);
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
    <label className="block space-y-1">
      <span className="text-[10px] text-[var(--gc-text-muted)]">创作想法（可选）</span>
      <Textarea aria-label="创作想法" value={data.prompt} {...edit.bind} disabled={disabled} rows={4}
        placeholder="例如：整体呈现简洁的时装画册质感，减少过度磨皮。"
        className="min-h-20 resize-none text-xs [field-sizing:fixed]" />
    </label>
    <p className="text-[9px] leading-relaxed text-[var(--gc-text-muted)]">{data.sceneInputMode === 'multi-reference-edit'
      ? '姿势、人物、场景分别作为前三张原始参考图，一次生成成片。多图编辑换装固定使用 Gemini 3.1 Flash Image，该模型对人物换装审核宽松、成功率高。姿势图仅提供动作参考，其人物外貌不进入成片；成片人物外貌只来自人物图。TiAngel 关闭时，姿势图控制动作与取景；开启后，TiAngel 控制拍摄视角，姿势图仍控制肢体动作。'
      : data.sceneInputMode === 'composed-person'
      ? '人物基准图已完成人物身份、姿势与场景定版。本轮保留基准图，只替换主穿搭及指定配饰。'
      : '身份、服装与场景由对应参考图决定。需要指定动作时，可从左侧“添加节点”添加人物姿势参考图并连接；未连接时依据创作想法自然安排动作。'}</p>
    <p className="text-[9px] leading-relaxed text-[var(--gc-text-muted)]">第一轮不执行通用提示词增强，保留原始要求；审核拒绝时不自动改写重试。</p>
    <Option label="图像模型" value={data.modelId} disabled={disabled}
      items={SCENE_STABILIZE_MODEL_IDS
        .filter(id => data.sceneInputMode !== 'multi-reference-edit' || id === 'gemini-3.1-flash-image')
        .map(id => [id, imageModelLabel(id) + (id === 'gemini-3.1-flash-image' && data.sceneInputMode !== 'multi-reference-edit' ? '（旧配置兼容）' : '')])}
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
        items={[["scene", data.sceneInputMode === 'composed-person' ? "跟随人物基准" : "跟随场景"], ...RATIOS.map(ratio => [ratio, ratio])]}
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

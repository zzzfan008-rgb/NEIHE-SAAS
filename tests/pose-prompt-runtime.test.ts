import assert from 'node:assert/strict';
import { useFlowStore, selectActiveDocumentTarget, updateCoalescedTextEdit, flushActiveTextEdit } from '../src/store/flowStore';
import { analyzePosePrompt, poseReferenceKey, usePoseReferenceRuntime } from '../src/store/poseReferenceRuntime';

const source = '/api/files/pose.png';
const nodes = [{
  id: 'pose',
  type: 'image-input',
  position: { x: 0, y: 0 },
  data: {
    kind: 'image-input',
    label: '人物姿势参考图（必需）',
    poseReference: true,
    imageRole: 'reference',
    status: 'idle',
    imageUrl: source,
  },
}];

useFlowStore.getState().loadFlow({ projectId: 'pose-prompt-project', projectName: '姿势反推', nodes: nodes as never, edges: [] });
const target = selectActiveDocumentTarget(useFlowStore.getState());
const key = poseReferenceKey(target, 'pose', source);
const originalFetch = globalThis.fetch;
const originalSave = useFlowStore.getState().saveProjectInTab;
let calls = 0;
let requestBody: Record<string, unknown> | undefined;
let resolve: ((value: Response) => void) | undefined;

useFlowStore.setState({ saveProjectInTab: async () => true });

try {
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Promise<Response>((complete) => { resolve = complete; });
  };
  const pending = analyzePosePrompt(target, 'pose', source);
  while (!resolve) await new Promise((complete) => setTimeout(complete, 0));
  await analyzePosePrompt(target, 'pose', source);
  assert.equal(calls, 1, '重复点击不能产生第二次姿势反推调用');
  assert.deepEqual(requestBody, { projectId: target.projectId, nodeId: 'pose', source });

  useFlowStore.getState().updateNodeDataInTab(target, 'pose', { imageUrl: '/api/files/replaced.png' });
  resolve!(new Response(JSON.stringify({
    prompt: '身体姿势：延迟结果',
    model: 'test-pose-analysis',
    providerRequests: 1,
    cacheHit: false,
  })));
  await pending;
  assert.equal(usePoseReferenceRuntime.getState().entries[key]?.posePrompt?.result, undefined, '图片替换后不能接收旧反推结果');
  assert.notEqual(usePoseReferenceRuntime.getState().entries[key]?.posePrompt?.status, 'running', '过期请求必须释放进行中状态，避免换回原图后无法反推');

  useFlowStore.getState().loadFlow({ projectId: 'pose-prompt-project-2', projectName: '姿势反推成功', nodes: nodes as never, edges: [] });
  const nextTarget = selectActiveDocumentTarget(useFlowStore.getState());
  const nextKey = poseReferenceKey(nextTarget, 'pose', source);
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      prompt: '身体姿势：肩线左高右低；手部姿势：手靠近髋部；头部姿势：头部向右转；视线方向：朝向右上方。',
      model: 'test-pose-analysis',
      providerRequests: 0,
      cacheHit: true,
    }));
  };
  await analyzePosePrompt(nextTarget, 'pose', source);
  const promptState = usePoseReferenceRuntime.getState().entries[nextKey]?.posePrompt;
  assert.equal(promptState?.status, 'succeeded');
  assert.equal(promptState?.result?.cacheHit, true);
  assert.match(promptState?.result?.prompt ?? '', /视线方向/);
  const savedPose = useFlowStore.getState().tabs.find(t => t.id === nextTarget.tabId)!.nodes[0].data;
  assert.equal(savedPose.posePrompt, promptState?.result?.prompt, '反推结果必须写入可保存的节点字段');
  assert.equal(savedPose.posePromptImage, source);
  useFlowStore.getState().updateNodeDataInTab(nextTarget, 'pose', { posePrompt: '用户修订：画面左腿交叉' });
  await analyzePosePrompt(nextTarget, 'pose', source);
  assert.equal(useFlowStore.getState().tabs.find(t => t.id === nextTarget.tabId)!.nodes[0].data.posePrompt, '用户修订：画面左腿交叉', '缓存不能覆盖用户修改');

  useFlowStore.getState().loadFlow({ projectId: 'late-edits', projectName: '迟到反推', nodes: nodes as never, edges: [] });
  const editTarget = selectActiveDocumentTarget(useFlowStore.getState());
  resolve = undefined;
  globalThis.fetch = async () => new Promise<Response>(complete => { resolve = complete; });
  const editing = analyzePosePrompt(editTarget, 'pose', source);
  while (!resolve) await new Promise(complete => setTimeout(complete, 0));
  const token = updateCoalescedTextEdit({ kind: 'node-data', nodeId: 'pose', field: 'posePrompt' }, '手动修正');
  flushActiveTextEdit(token!);
  resolve!(Response.json({ prompt: '迟到文本', model: 'test', providerRequests: 0, cacheHit: true }));
  await editing;
  const edited = () => useFlowStore.getState().tabs.find(t => t.id === editTarget.tabId)!.nodes[0].data;
  assert.equal(edited().posePrompt, '手动修正');
  assert.equal(edited().posePromptImage, source);
  useFlowStore.getState().undo();
  assert.equal(edited().posePrompt, undefined, '手动编辑支持撤销');
  useFlowStore.getState().redo();
  assert.equal(edited().posePrompt, '手动修正');

  globalThis.fetch = async () => Response.json({ prompt: '重试结果', model: 'test', providerRequests: 0, cacheHit: true });
  await analyzePosePrompt(editTarget, 'pose', source, true);
  assert.equal(edited().posePrompt, '手动修正', '重试不能覆盖已编辑文本');

  // No runtime cache is required to reuse the saved, edited prompt after reopening.
  usePoseReferenceRuntime.setState({ entries: {} });
  globalThis.fetch = async () => { throw new Error('已有持久化文本不应调用模型'); };
  await analyzePosePrompt(editTarget, 'pose', source);
  assert.equal(edited().posePrompt, '手动修正');

  // A response from the replaced document must not populate its replacement.
  useFlowStore.getState().loadFlow({ projectId: 'old-document', projectName: '旧文档', nodes: nodes as never, edges: [] });
  const oldTarget = selectActiveDocumentTarget(useFlowStore.getState());
  resolve = undefined;
  globalThis.fetch = async () => new Promise<Response>(complete => { resolve = complete; });
  const oldRequest = analyzePosePrompt(oldTarget, 'pose', source);
  while (!resolve) await new Promise(complete => setTimeout(complete, 0));
  useFlowStore.getState().loadFlow({ projectId: 'replacement-document', projectName: '新文档', nodes: nodes as never, edges: [] });
  resolve!(Response.json({ prompt: '旧文档文本', model: 'test', providerRequests: 0, cacheHit: true }));
  await oldRequest;
  assert.equal(useFlowStore.getState().tabs.find(t => t.id === oldTarget.tabId)!.nodes[0].data.posePrompt, undefined);

  useFlowStore.getState().loadFlow({ projectId: 'pose-basis', projectName: '基准失效', nodes: [...nodes,
    { id: 'first', type: 'virtual-try-on', position: { x: 500, y: 0 }, data: { kind: 'virtual-try-on', label: '第一轮', status: 'idle', workflowStage: 'scene-stabilize', basisRevision: 5, modelId: 'gemini-3.1-flash-image' } },
  ] as never, edges: [{ id: 'pose-edge', source: 'pose', sourceHandle: 'image', target: 'first', targetHandle: 'pose' }] });
  const basisTarget = selectActiveDocumentTarget(useFlowStore.getState());
  const basis = () => useFlowStore.getState().tabs.find(t => t.id === basisTarget.tabId)!.nodes.find(n => n.id === 'first')!.data.basisRevision;
  const basisEdit = updateCoalescedTextEdit({ kind: 'node-data', nodeId: 'pose', field: 'posePrompt' }, '姿势修正');
  flushActiveTextEdit(basisEdit!);
  assert.equal(basis(), 6, '姿势文字改变后旧定版确认必须失效');
  useFlowStore.getState().undo();
  assert.equal(basis(), 5);
  globalThis.fetch = async () => Response.json({ prompt: '新反推', model: 'test', providerRequests: 0, cacheHit: true });
  await analyzePosePrompt(basisTarget, 'pose', source);
  assert.equal(basis(), 6, '默认反推文本也必须更新第一轮基准');

  useFlowStore.getState().loadFlow({ projectId: 'rename-during-analysis', projectName: '改名不丢反推', nodes: nodes as never, edges: [] });
  const renameTarget = selectActiveDocumentTarget(useFlowStore.getState());
  resolve = undefined;
  globalThis.fetch = async () => new Promise<Response>(complete => { resolve = complete; });
  const renameRequest = analyzePosePrompt(renameTarget, 'pose', source);
  while (!resolve) await new Promise(complete => setTimeout(complete, 0));
  useFlowStore.getState().updateNodeDataInTab(renameTarget, 'pose', { label: '自定义名称' });
  resolve!(Response.json({ prompt: '改名后仍接收', model: 'test', providerRequests: 0, cacheHit: true }));
  await renameRequest;
  assert.equal(useFlowStore.getState().tabs.find(t => t.id === renameTarget.tabId)!.nodes[0].data.posePrompt, '改名后仍接收');
} finally {
  globalThis.fetch = originalFetch;
  useFlowStore.setState({ saveProjectInTab: originalSave });
  usePoseReferenceRuntime.setState({ entries: {} });
}

console.log('Pose prompt runtime: duplicate, source-boundary and cached result behavior passed');

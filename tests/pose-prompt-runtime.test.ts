import assert from 'node:assert/strict';
import { useFlowStore, selectActiveDocumentTarget } from '../src/store/flowStore';
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
} finally {
  globalThis.fetch = originalFetch;
  useFlowStore.setState({ saveProjectInTab: originalSave });
  usePoseReferenceRuntime.setState({ entries: {} });
}

console.log('Pose prompt runtime: duplicate, source-boundary and cached result behavior passed');

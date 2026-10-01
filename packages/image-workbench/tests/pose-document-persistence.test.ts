import assert from 'node:assert/strict';
import { createDocumentSnapshot, documentSnapshotToPersistedWorkflow } from '../src/lib/documentSnapshot';
import { createEmptyPoseDocument, setPosePoint } from '../src/lib/poseEditorModel';
import { useFlowStore, selectActiveDocumentTarget, nodeOutputImages, selectNodeInputImages } from '../src/store/flowStore';
import { validateAndMigrateFlow } from '../server/lib/workflowSchema';

const source = '/api/files/source.png';
const skeletonImage = '/api/files/edited-skeleton.png';
const poseDocument = createEmptyPoseDocument({
  image: source,
  width: 256,
  height: 512,
  idFactory: () => '00000000-0000-4000-8000-000000000001',
});
const boundPoseDocument = { ...poseDocument, imageBinding: skeletonImage };
const nodes = [
  {
    id: 'pose-source',
    type: 'image-input',
    position: { x: 0, y: 0 },
    data: {
      kind: 'image-input',
      label: '姿势原图',
      status: 'success',
      imageRole: 'reference',
      imageUrl: source,
      posePrompt: '旧姿势描述',
      posePromptImage: source,
    },
  },
  {
    id: 'try-on',
    type: 'virtual-try-on',
    position: { x: 400, y: 0 },
    data: { kind: 'virtual-try-on', workflowStage: 'scene-stabilize', label: '试穿', status: 'idle', prompt: '', modelId: 'gemini-3.1-flash-image', modelOptions: {}, imageSize: '2K', aspectRatio: '3:4', basisRevision: 0, promptEnhancement: false, qualityMode: 'fast', safetyFallback: false, stylePresetId: 'faithful', outputImages: [] },
  },
];
const edges = [{ id: 'pose-edge', source: 'pose-source', target: 'try-on', targetHandle: 'pose' }];
const originalSave = useFlowStore.getState().saveProjectInTab;
useFlowStore.setState({ saveProjectInTab: async () => true });

try {
  useFlowStore.getState().loadFlow({ projectName: 'Pose document persistence', nodes, edges });
  const target = selectActiveDocumentTarget(useFlowStore.getState());
  const store = useFlowStore.getState() as any;

  assert.equal(typeof store.applyPoseDocumentToImageInput, 'function', '应用当前姿势必须使用受 document target 保护的 store action');
  assert.equal(store.applyPoseDocumentToImageInput(target, 'pose-source', source, skeletonImage, boundPoseDocument, 'null'), true);
  assert.equal(store.applyPoseDocumentToImageInput(target, 'pose-source', source, skeletonImage, boundPoseDocument, 'null'), false, '旧编辑会话不能覆盖已更新的姿势文档');
  const tab = () => useFlowStore.getState().tabs.find((item) => item.id === target.tabId)!;
  const appliedNode = () => tab().nodes.find((node) => node.id === 'pose-source')!;
  assert.equal(appliedNode().data.imageUrl, skeletonImage, '骨骼图像和坐标必须在同一次节点更新中应用');
  assert.deepEqual((appliedNode().data as any).poseDocument, boundPoseDocument);
  assert.deepEqual((appliedNode().data as any).poseReferenceSource, { kind: 'skeleton', image: skeletonImage, neutralSource: source });
  assert.deepEqual(nodeOutputImages(appliedNode().data), [skeletonImage], 'DAG downstream pose input must read the newly applied skeleton image');
  assert.equal((appliedNode().data as any).posePrompt, undefined, '旧图片绑定的 posePrompt 不得跟随新骨骼图');
  assert.deepEqual(tab().edges, edges, '应用姿势不得改变现有连接');

  const persisted = documentSnapshotToPersistedWorkflow(createDocumentSnapshot(tab()));
  const restored = validateAndMigrateFlow(persisted).nodes.find((node) => node.id === 'pose-source')!.data as any;
  assert.deepEqual(restored.poseDocument, boundPoseDocument, 'poseDocument 必须穿过 DocumentSnapshot 和服务端工作流 schema');
  assert.deepEqual(restored.poseReferenceSource, { kind: 'skeleton', image: skeletonImage, neutralSource: source });
  assert.equal(restored.posePrompt, undefined);

  useFlowStore.getState().undo();
  assert.equal(appliedNode().data.imageUrl, source, '应用当前姿势作为一个历史事务可整体撤销');
  assert.equal((appliedNode().data as any).poseDocument, undefined);
  assert.deepEqual(tab().edges, edges);
  useFlowStore.getState().redo();
  assert.equal(appliedNode().data.imageUrl, skeletonImage);
  assert.deepEqual((appliedNode().data as any).poseDocument, boundPoseDocument);

  useFlowStore.getState().updateNodeDataInTab(target, 'pose-source', { imageUrl: '/api/files/replacement.png' });
  assert.equal((appliedNode().data as any).poseDocument, undefined, '替换图像时必须清除旧图像绑定的姿势文档');
  assert.equal((appliedNode().data as any).posePrompt, undefined);

  const reloadedFlow = validateAndMigrateFlow(persisted);
  useFlowStore.getState().loadFlow({ projectName: 'Pose document reload', nodes: reloadedFlow.nodes, edges: reloadedFlow.edges });
  const reloadedTarget = selectActiveDocumentTarget(useFlowStore.getState());
  const reloadedNode = useFlowStore.getState().tabs.find((item) => item.id === reloadedTarget.tabId)!.nodes.find((node) => node.id === 'pose-source')!;
  const reloadedTab = useFlowStore.getState().tabs.find((item) => item.id === reloadedTarget.tabId)!;
  assert.deepEqual(reloadedTab.edges, edges, '刷新后下游 pose 连接必须保持');
  assert.deepEqual(selectNodeInputImages(reloadedTab, 'try-on'), [skeletonImage], '真实 DAG 下游输入必须读取刷新后的手绘骨骼图');
  assert.deepEqual(nodeOutputImages(reloadedNode.data), [skeletonImage], '下游图像解析必须读取重新加载后的手绘骨骼图');
  const reloadedDocument = (reloadedNode.data as any).poseDocument;
  const reeditedDocument = setPosePoint(reloadedDocument, { personId: poseDocument.people[0].id, group: 'body', index: 0 }, { x: 32, y: 64, confidence: 1, origin: 'manual' });
  assert.equal(useFlowStore.getState().applyPoseDocumentToImageInput(reloadedTarget, 'pose-source', skeletonImage, skeletonImage, reeditedDocument, JSON.stringify(reloadedDocument)), true, '刷新恢复后的姿势文档必须仍可编辑并应用');
  const reeditedNode = useFlowStore.getState().tabs.find((item) => item.id === reloadedTarget.tabId)!.nodes.find((node) => node.id === 'pose-source')!;
  assert.deepEqual((reeditedNode.data as any).poseDocument.people[0].body[0], { x: 32, y: 64, confidence: 1, origin: 'manual' });

  useFlowStore.getState().loadFlow({ projectName: 'Pose document save-as', nodes, edges });
  const saveAsTarget = selectActiveDocumentTarget(useFlowStore.getState());
  const addPoseReferenceImageNode = useFlowStore.getState().addPoseReferenceImageNode as any;
  const savedId = addPoseReferenceImageNode(saveAsTarget, 'pose-source', source, skeletonImage, '手绘骨骼图', 'skeleton', undefined, boundPoseDocument, 'null');
  assert.equal(addPoseReferenceImageNode(saveAsTarget, 'pose-source', source, skeletonImage, '旧会话骨骼图', 'skeleton', undefined, boundPoseDocument, '{}'), null, '另存为必须拒绝过时姿势编辑会话');
  assert.ok(savedId);
  const savedNode = useFlowStore.getState().tabs.find((item) => item.id === saveAsTarget.tabId)!.nodes.find((node) => node.id === savedId)!;
  assert.deepEqual((savedNode.data as any).poseDocument, boundPoseDocument, '另存为骨骼节点时必须一并保存结构化姿势');

  const invalidBinding = { ...boundPoseDocument, imageBinding: source };
  assert.equal((useFlowStore.getState() as any).applyPoseDocumentToImageInput(saveAsTarget, 'pose-source', source, skeletonImage, invalidBinding), false);
} finally {
  useFlowStore.setState({ saveProjectInTab: originalSave });
}

console.log('Pose document persistence: apply/save-as, snapshot roundtrip, prompt invalidation, history and image binding passed');

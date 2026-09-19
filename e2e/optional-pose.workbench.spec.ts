import sharp from 'sharp';
import { expect, test } from './fixtures';

test('从添加节点创建姿势参考，通用入口连接并保留旧连线', async ({ page }, testInfo) => {
  const png = await sharp({ create: { width: 240, height: 320, channels: 3, background: '#aaa' } }).png().toBuffer();
  await page.route('**/api/pose-references/analyze', route => route.fulfill({ json: {
    prompt: '人物自然站立，双手下垂。', model: 'mock', providerRequests: 0, cacheHit: true,
  } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: '打开项目中心' })).toBeVisible();
  await page.evaluate(async () => {
    const path = '/src/store/flowStore.ts';
    const { useFlowStore } = await import(path);
    useFlowStore.getState().createBlankTab();
  });
  await page.getByRole('button', { name: '添加节点', exact: true }).click();
  const item = page.getByRole('menuitem', { name: /人物姿势参考图/ });
  await expect(item).toBeVisible();
  const box = await item.boundingBox();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await item.click();
  const poseNode = page.locator('.react-flow__node').filter({ hasText: '人物姿势参考图' });
  await poseNode.locator('input[type="file"]').setInputFiles({ name: 'pose.png', mimeType: 'image/png', buffer: png });
  await expect(poseNode.getByRole('textbox', { name: '姿势提示词', exact: true })).toBeVisible();
  await expect.poll(async () => page.evaluate(async () => {
    const path = '/src/store/flowStore.ts';
    const { useFlowStore, selectActiveNodes } = await import(path);
    return Boolean(selectActiveNodes(useFlowStore.getState()).find((node: { data: { poseReference?: boolean } }) => node.data.poseReference)?.data.imageUrl);
  })).toBe(true);
  await page.evaluate(async () => {
    const path = '/src/store/flowStore.ts';
    const { useFlowStore, selectActiveNodes, selectActiveDocument } = await import(path);
    const pose = selectActiveNodes(useFlowStore.getState()).find((node: { data: { poseReference?: boolean } }) => node.data.poseReference);
    useFlowStore.getState().loadFlow({ projectId: selectActiveDocument(useFlowStore.getState()).projectId, projectName: '可选姿势', nodes: [pose,
      { id: 'first', type: 'virtual-try-on', position: { x: 600, y: 0 }, data: {
        kind: 'virtual-try-on', label: '第一轮 · 场景化定版', workflowStage: 'scene-stabilize', status: 'idle',
        modelId: 'gemini-3.1-flash-image', modelOptions: {}, prompt: '', outputImages: [], imageSize: '2K', aspectRatio: '3:4',
        promptEnhancement: false, qualityMode: 'fast', safetyFallback: false, stylePresetId: 'faithful', basisRevision: 0,
      } },
      ...['person', 'scene', 'outfit'].map((role, index) => ({
        id: role, type: 'image-input', position: { x: 0, y: 500 + index * 350 },
        data: { kind: 'image-input', label: role, status: 'success', imageRole: 'reference', imageUrl: pose.data.imageUrl },
      })),
    ], edges: ['person', 'scene', 'outfit'].map(role => ({
      id: role, source: role, sourceHandle: 'image', target: 'first', targetHandle: role,
    })) });
  });
  await expect(page.locator('.react-flow__node[data-id="first"]').getByRole('button', { name: '生成第一轮基准', exact: true })).toBeEnabled();
  await page.evaluate(async () => {
    const path = '/src/store/flowStore.ts';
    const { useFlowStore, selectActiveNodes } = await import(path);
    const pose = selectActiveNodes(useFlowStore.getState()).find((node: { data: { poseReference?: boolean } }) => node.data.poseReference);
    useFlowStore.getState().onConnect({ source: pose.id, sourceHandle: 'image', target: 'first', targetHandle: null });
  });
  const dialog = page.getByRole('dialog', { name: '确认连接角色' });
  await dialog.getByRole('radio', { name: /人物姿势参考图/ }).click();
  await dialog.getByRole('button', { name: '确认连接' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => page.evaluate(async () => {
    const path = '/src/store/flowStore.ts';
    const { useFlowStore, selectActiveNodes } = await import(path);
    return selectActiveNodes(useFlowStore.getState()).find((node: { data: { poseReference?: boolean } }) => node.data.poseReference)?.data.posePrompt;
  })).toBe('人物自然站立，双手下垂。');
  const saved = await page.evaluate(async () => {
    const path = '/src/store/flowStore.ts';
    const snapshotPath = '/src/lib/documentSnapshot.ts';
    const landingPath = '/src/lib/canvasLanding.ts';
    const { useFlowStore, selectActiveDocument } = await import(path);
    const { createDocumentSnapshot, documentSnapshotToPersistedWorkflow } = await import(snapshotPath);
    const { requestCanvasLanding } = await import(landingPath);
    const flow = documentSnapshotToPersistedWorkflow(createDocumentSnapshot(selectActiveDocument(useFlowStore.getState())));
    useFlowStore.getState().loadFlow({ ...flow, projectId: selectActiveDocument(useFlowStore.getState()).projectId, projectName: '重新打开' });
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, nodeId: 'first', fitView: true });
    return flow.edges;
  });
  expect(saved).toHaveLength(4);
  expect(saved.filter((edge: { targetHandle?: string | null }) => edge.targetHandle === 'pose')).toHaveLength(1);
  const first = page.locator('.react-flow__node[data-id="first"]');
  await expect(first.locator('[data-port-row="pose"]')).toHaveCount(0);
  await expect(first.getByRole('group', { name: '当前姿势参考' })).toHaveCount(0);
  await expect(first.locator('[data-port-row]')).toHaveCount(11);
  await expect(page.locator('.react-flow__edge-path')).toHaveCount(4);
  const bounds = await first.boundingBox();
  expect(bounds!.width).toBeGreaterThan(0);
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: testInfo.outputPath('optional-pose.png') });
});

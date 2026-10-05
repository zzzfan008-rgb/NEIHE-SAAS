import sharp from 'sharp';
import { expect, test } from './fixtures';

test.use({ storageState: { cookies: [], origins: [] } });

test('pose prompt stays off canvas while auto inference and dialog editing persist', async ({ page }, testInfo) => {
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: { id: 'pose-test-user', accountId: 'pose-test-user', displayName: '姿势测试', role: 'user', mustChangePassword: false } } }));
  const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#869ca7' } }).png().toBuffer();
  await page.route('**/api/files/pose-*.png', route => route.fulfill({ contentType: 'image/png', body: png }));
  let calls = 0;
  await page.route('**/api/pose-references/analyze', async route => {
    calls++;
    await route.fulfill({ json: { prompt: '画面左腿交叉，肩线倾斜。', model: 'mock-vision', providerRequests: 0, cacheHit: true } });
  });
  await page.goto('/e2e/fixtures/node-geometry.html?auth=1');
  await expect(page.getByText('拖动图片内部四角体验等比缩放 · 隔离演示，不写入正式项目')).toBeVisible();
  await page.evaluate(async () => {
    const module = '/src/store/flowStore.ts';
    const { useFlowStore } = await import(module);
    useFlowStore.getState().loadFlow({ projectName: '姿势提示词', nodes: [
      { id: 'pose', type: 'image-input', position: { x: 180, y: 60 }, width: 300, height: 300, data: { kind: 'image-input', label: '人物姿势参考图（必需）', poseReference: true, imageRole: 'reference', status: 'success', imageUrl: '/api/files/pose-source.png' } },
      { id: 'first', type: 'virtual-try-on', position: { x: 1600, y: 60 }, data: { kind: 'virtual-try-on', label: '第一轮', workflowStage: 'scene-stabilize', modelId: 'gemini-3.1-flash-image', status: 'idle', outputImages: [] } },
    ], edges: [] });
    useFlowStore.setState({ saveProjectInTab: async () => true });
  });
  const poseNode = page.locator('.react-flow__node[data-id="pose"]');
  const poseText = async () => page.evaluate(async () => {
    const module = '/src/store/flowStore.ts';
    const { useFlowStore, selectActiveNodes } = await import(module);
    return selectActiveNodes(useFlowStore.getState()).find((node: { id: string }) => node.id === 'pose')?.data.posePrompt;
  });
  await expect(page.locator('[data-pose-prompt-editor]')).toHaveCount(0);
  await expect(poseNode.getByRole('textbox', { name: '姿势提示词', exact: true })).toHaveCount(0);
  expect(calls).toBe(0);

  await page.evaluate(async () => {
    const module = '/src/store/flowStore.ts';
    const { useFlowStore } = await import(module);
    useFlowStore.getState().onConnect({ source: 'pose', sourceHandle: 'image', target: 'first', targetHandle: 'pose' });
    if (!useFlowStore.getState().confirmPendingConnection('pose')) throw new Error('姿势连线确认失败');
  });
  await expect.poll(poseText).toBe('画面左腿交叉，肩线倾斜。');
  expect(calls).toBe(1);
  await expect(poseNode).not.toContainText('画面左腿交叉，肩线倾斜。');
  const originalViewport = page.viewportSize()!;
  for (const width of [1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: originalViewport.height });
    await expect(page.locator('[data-pose-prompt-editor]')).toHaveCount(0);
    const box = await poseNode.boundingBox();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  }
  await page.setViewportSize(originalViewport);

  const reload = async () => page.evaluate(async () => {
    const storeModule = '/src/store/flowStore.ts';
    const snapshotModule = '/src/lib/documentSnapshot.ts';
    const { useFlowStore, selectActiveDocument } = await import(storeModule);
    const { createDocumentSnapshot, documentSnapshotToPersistedWorkflow } = await import(snapshotModule);
    const flow = documentSnapshotToPersistedWorkflow(createDocumentSnapshot(selectActiveDocument(useFlowStore.getState())));
    useFlowStore.getState().loadFlow({ ...flow, projectName: '重新打开' });
    useFlowStore.getState().setSelectedNodeIds(['pose']);
  });
  await reload();
  await expect.poll(poseText).toBe('画面左腿交叉，肩线倾斜。');
  expect(calls).toBe(1);
  const inference = page.getByRole('button', { name: '反推人物姿势', exact: true });
  await inference.click();
  const dialog = page.getByRole('dialog', { name: '反推人物姿势', exact: true });
  const optimized = dialog.getByRole('textbox', { name: '优化后姿势提示词', exact: true });
  await expect(dialog.locator('[data-pose-prompt="result"]')).toHaveText('画面左腿交叉，肩线倾斜。');
  await optimized.fill('用户修订：画面右手贴近髋部。');
  await dialog.getByRole('button', { name: '保存优化提示词', exact: true }).click();
  await expect(dialog.getByText('优化提示词已保存', { exact: true })).toBeVisible();
  await expect(poseNode).not.toContainText('用户修订：画面右手贴近髋部。');
  await page.screenshot({ path: testInfo.outputPath('pose-prompt-dialog-only.png') });
  await page.keyboard.press('Escape');
  await expect(inference).toBeFocused();
  await reload();
  await inference.click();
  await expect(optimized).toHaveValue('用户修订：画面右手贴近髋部。');
  await expect(dialog.locator('[data-pose-prompt="result"]')).toHaveText('画面左腿交叉，肩线倾斜。');
  expect(calls).toBe(1);
  await dialog.getByRole('button', { name: '开始反推', exact: true }).click();
  await expect(dialog.locator('[data-pose-prompt="candidate"]')).toHaveText('画面左腿交叉，肩线倾斜。');
  expect(calls).toBe(2);
  await dialog.getByRole('button', { name: '确认并替换当前提示词', exact: true }).click();
  await expect(optimized).toHaveValue('');
  const analysisMode = dialog.getByRole('combobox', { name: '分析方式' });
  await analysisMode.click();
  await page.getByRole('option', { name: '原图 + 深度图 + DWPose 三图校准' }).click();
  await expect(dialog.getByRole('status')).toContainText('请先在姿势参考结果中生成当前原图的深度图和 DWPose 骨骼图。');
  await expect(dialog.getByRole('button', { name: '开始反推', exact: true })).toBeDisabled();
  await analysisMode.click();
  await page.getByRole('option', { name: '单图反推', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(inference).toBeFocused();

  const blockedError = await page.evaluate(async () => {
    const module = '/src/store/flowStore.ts';
    const safetyModule = '/src/store/generationSafety.ts';
    const { setGenerationSafetyBlockReason, getGenerationSafetyBlockReason } = await import(safetyModule);
    const { useFlowStore, selectActiveNodes, selectActiveDocumentTarget } = await import(module);
    const previous = getGenerationSafetyBlockReason();
    useFlowStore.getState().updateNodeDataInTab(selectActiveDocumentTarget(useFlowStore.getState()), 'pose', { posePrompt: '', posePromptOptimized: undefined });
    setGenerationSafetyBlockReason(null);
    try { await useFlowStore.getState().runNode('first'); }
    finally { setGenerationSafetyBlockReason(previous); }
    return selectActiveNodes(useFlowStore.getState()).find((node: { id: string }) => node.id === 'first')?.data.error;
  });
  expect(blockedError).toBe('请先在人物姿势参考图中完成反推或填写姿势提示词，再生成第一轮');
  await page.evaluate(async () => {
    const module = '/src/store/flowStore.ts';
    const { useFlowStore, selectActiveDocumentTarget } = await import(module);
    useFlowStore.getState().assignImageInputInTab(selectActiveDocumentTarget(useFlowStore.getState()), 'pose', '/api/files/pose-new.png');
  });
  await expect.poll(poseText).toBe('画面左腿交叉，肩线倾斜。');
  expect(calls).toBe(3);
  await expect(poseNode).not.toContainText('画面左腿交叉，肩线倾斜。');
});

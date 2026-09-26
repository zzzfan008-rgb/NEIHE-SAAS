import sharp from 'sharp';
import { expect, test } from './fixtures';

test.use({ storageState: { cookies: [], origins: [] } });

test('connected pose text is editable, source-bound and preserved through save/load', async ({ page }, testInfo) => {
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: { id: 'pose-test-user', accountId: 'pose-test-user', displayName: '姿势测试', role: 'user', mustChangePassword: false } } }));
  const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#869ca7' } }).png().toBuffer();
  await page.route('**/api/files/pose-*.png', r => r.fulfill({ contentType: 'image/png', body: png }));
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
  const text = page.getByRole('textbox', { name: '姿势提示词', exact: true });
  await expect(text).toBeVisible();
  expect(calls).toBe(0);
  await page.evaluate(async () => {
    const module = '/src/store/flowStore.ts';
    const { useFlowStore } = await import(module);
    useFlowStore.getState().onConnect({ source: 'pose', sourceHandle: 'image', target: 'first', targetHandle: 'pose' });
    if (!useFlowStore.getState().confirmPendingConnection('pose')) throw new Error('姿势连线确认失败');
  });
  await expect(text).toHaveValue('画面左腿交叉，肩线倾斜。');
  expect(calls).toBe(1);
  const box = await text.boundingBox();
  expect(box!.width).toBeGreaterThan(180);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await text.fill('用户修订：画面右手贴近髋部。');
  await page.mouse.click(80, 80);
  await page.evaluate(async () => {
    const storeModule = '/src/store/flowStore.ts';
    const snapshotModule = '/src/lib/documentSnapshot.ts';
    const { useFlowStore, selectActiveDocument } = await import(storeModule);
    const { createDocumentSnapshot, documentSnapshotToPersistedWorkflow } = await import(snapshotModule);
    const document = selectActiveDocument(useFlowStore.getState());
    const flow = documentSnapshotToPersistedWorkflow(createDocumentSnapshot(document));
    useFlowStore.getState().loadFlow({ ...flow, projectName: '重新打开' });
  });
  await expect(text).toHaveValue('用户修订：画面右手贴近髋部。');
  expect(calls).toBe(1);
  await page.evaluate(async () => {
    const module = '/src/store/flowStore.ts';
    const { useFlowStore } = await import(module);
    useFlowStore.getState().setSelectedNodeIds(['pose']);
  });
  const inference = page.getByRole('button', { name: '反推人物姿势', exact: true });
  await inference.click();
  const dialog = page.getByRole('dialog', { name: '反推人物姿势', exact: true });
  await expect(dialog.locator('[data-pose-prompt="result"]')).toHaveText('用户修订：画面右手贴近髋部。');
  await dialog.getByRole('button', { name: '开始反推', exact: true }).click();
  await expect(dialog.locator('[data-pose-prompt="candidate"]')).toHaveText('画面左腿交叉，肩线倾斜。');
  await expect(page.locator('#pose-prompt-pose')).toHaveValue('用户修订：画面右手贴近髋部。');
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await dialog.getByRole('button', { name: '使用新版结果替换当前提示词', exact: true }).click();
  await expect(page.locator('#pose-prompt-pose')).toHaveValue('画面左腿交叉，肩线倾斜。');
  await expect(dialog.locator('[data-pose-prompt="candidate"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(inference).toBeFocused();
  expect(calls).toBe(2);
  await text.focus();
  await page.screenshot({ path: testInfo.outputPath('pose-prompt-editor.png') });
  await text.fill('');
  await page.mouse.click(80, 80);
  const blockedError = await page.evaluate(async () => {
    const module = '/src/store/flowStore.ts';
    const safetyModule = '/src/store/generationSafety.ts';
    const { setGenerationSafetyBlockReason, getGenerationSafetyBlockReason } = await import(safetyModule);
    const { useFlowStore, selectActiveNodes } = await import(module);
    const previous = getGenerationSafetyBlockReason();
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
  await expect(text).toHaveValue('画面左腿交叉，肩线倾斜。');
  expect(calls).toBe(3);
});

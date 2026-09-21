import sharp from 'sharp';
import { expect, test } from './fixtures';

test('前置人物合成固定参考顺序，第一轮保留基准换装并支持保存恢复', async ({ page }, testInfo) => {
  const requests: Array<Record<string, unknown>> = [];
  await page.route('**/api/run-plan', async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 400, json: { error: '测试拦截：未调用 AI' } });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '打开项目中心' })).toBeVisible();
  const template = await page.evaluate(async () => {
    const response = await fetch('/api/templates/builtin-tool-one-click-try-on');
    if (!response.ok) throw new Error('无法加载模板');
    return response.json();
  });
  expect(template.flow.nodes.find((node: { id: string }) => node.id === 'stabilize').data.sceneInputMode).toBe('composed-person');
  expect(template.flow.edges.filter((edge: { target: string }) => edge.target === 'compose-person').map((edge: { source: string }) => edge.source)).toEqual(['person', 'pose']);
  await page.evaluate(async flow => {
    const storePath = '/src/store/flowStore.ts';
    const landingPath = '/src/lib/canvasLanding.ts';
    const { useFlowStore } = await import(storePath);
    const { requestCanvasLanding } = await import(landingPath);
    useFlowStore.getState().createBlankTab();
    useFlowStore.getState().loadFlow({ projectName: '前置合成回归',
      nodes: flow.nodes.filter((node: { id: string }) => ['person', 'pose', 'compose-person'].includes(node.id)),
      edges: flow.edges.filter((edge: { target: string }) => edge.target === 'compose-person'),
    });
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, fitView: true });
  }, template.flow);
  const png = await sharp({ create: { width: 240, height: 320, channels: 3, background: '#aaa' } }).png().toBuffer();
  const compose = page.locator('.react-flow__node[data-id="compose-person"]');
  await compose.getByRole('button', { name: '前置 · AI 换脸与换姿势', exact: true }).click();
  await expect(compose).toContainText('请分别上传图 1 人物身份与图 2 目标姿势照片');
  expect(requests).toHaveLength(0);
  for (const id of ['pose', 'person']) {
    await page.locator(`.react-flow__node[data-id="${id}"] input[type="file"]`).setInputFiles({ name: `${id}.png`, mimeType: 'image/png', buffer: png });
    await expect.poll(() => page.evaluate(async nodeId => {
      const path = '/src/store/flowStore.ts';
      const { useFlowStore, selectActiveNodes } = await import(path);
      return Boolean(selectActiveNodes(useFlowStore.getState()).find((node: { id: string }) => node.id === nodeId)?.data.imageUrl);
    }, id)).toBe(true);
  }
  const identityBounds = await page.locator('.react-flow__node[data-id="person"]').boundingBox();
  const poseBounds = await page.locator('.react-flow__node[data-id="pose"]').boundingBox();
  const composeBounds = await compose.boundingBox();
  expect(identityBounds!.x + identityBounds!.width).toBeLessThan(composeBounds!.x);
  expect(identityBounds!.y + identityBounds!.height).toBeLessThan(poseBounds!.y);
  await page.screenshot({ path: testInfo.outputPath('precompose.png') });
  const restored = await page.evaluate(async flow => {
    const storePath = '/src/store/flowStore.ts';
    const snapshotPath = '/src/lib/documentSnapshot.ts';
    const landingPath = '/src/lib/canvasLanding.ts';
    const { useFlowStore, selectActiveDocument } = await import(storePath);
    const { createDocumentSnapshot, documentSnapshotToPersistedWorkflow } = await import(snapshotPath);
    const { requestCanvasLanding } = await import(landingPath);
    const current = selectActiveDocument(useFlowStore.getState());
    const image = current.nodes.find((node: { id: string }) => node.id === 'person').data.imageUrl;
    const compose = current.nodes.find((node: { id: string }) => node.id === 'compose-person');
    const first = flow.nodes.find((node: { id: string }) => node.id === 'stabilize');
    const outfit = flow.nodes.find((node: { id: string }) => node.id === 'outfit');
    // The provider result is mocked; persistence and downstream controls are real.
    useFlowStore.getState().loadFlow({ projectName: '人物基准换装回归', nodes: [
      { ...compose, position: { x: 0, y: 0 }, data: { ...compose.data, outputImages: [image] } },
      { ...outfit, position: { x: 0, y: 750 }, data: { ...outfit.data, imageUrl: image } },
      { ...first, position: { x: 500, y: 0 } },
    ], edges: [
      flow.edges.find((edge: { id: string }) => edge.id === 'compose-stabilize'),
      { id: 'outfit-first', source: 'outfit', sourceHandle: 'image', target: 'stabilize', targetHandle: 'outfit' },
    ] });
    const saved = documentSnapshotToPersistedWorkflow(createDocumentSnapshot(selectActiveDocument(useFlowStore.getState())));
    useFlowStore.getState().loadFlow({ ...saved, projectName: '保存后恢复' });
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, fitView: true });
    return saved;
  }, template.flow);
  expect(restored.nodes.find((node: { id: string }) => node.id === 'stabilize').data.sceneInputMode).toBe('composed-person');
  expect(restored.nodes.find((node: { id: string }) => node.id === 'compose-person').data.referenceMode).toBe('identity-pose');
  const first = page.locator('.react-flow__node[data-id="stabilize"]');
  await expect(first.locator('[data-port-row="person"]')).toContainText('人物基准图');
  await expect(first.locator('[data-port-row="scene"], [data-port-row="pose"]')).toHaveCount(0);
  await expect(first.getByRole('combobox', { name: '画幅比例' })).toContainText('跟随人物基准');
  const prompt = first.getByRole('textbox', { name: '创作想法' });
  await prompt.fill('保持服装细节清晰');
  await prompt.press('Tab');
  await first.getByRole('button', { name: '生成第一轮基准', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  const bounds = await first.boundingBox();
  expect(bounds!.width).toBeGreaterThan(100);
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: testInfo.outputPath('composed-baseline.png') });
});

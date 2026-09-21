import sharp from 'sharp';
import { expect, test } from './fixtures';

test('第二轮服装属性全部选填且留空可提交', async ({ page }, testInfo) => {
  const requests: Array<Record<string, unknown>> = [];
  await page.route('**/api/run-plan', async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 400, json: { error: '测试拦截：未调用 AI' } });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '打开项目中心' })).toBeVisible();
  await page.getByRole('button', { name: '打开项目中心' }).click();
  const center = page.getByRole('dialog', { name: '项目中心' });
  await expect(center).toBeVisible();
  await center.getByRole('button', { name: '新建项目' }).click();
  await expect(page.getByRole('region', { name: '开始第一个创作任务' })).toBeVisible();
  const png = await sharp({ create: { width: 240, height: 320, channels: 3, background: '#aaa' } }).png().toBuffer();
  const image = `data:image/png;base64,${png.toString('base64')}`;
  await page.evaluate(async source => {
    const storePath = '/src/store/flowStore.ts';
    const landingPath = '/src/lib/canvasLanding.ts';
    const { useFlowStore } = await import(storePath);
    const { requestCanvasLanding } = await import(landingPath);
    useFlowStore.getState().loadFlow({ projectName: '第二轮选填属性', nodes: [
      { id: 'first', type: 'virtual-try-on', position: { x: 0, y: 0 }, data: {
        kind: 'virtual-try-on', label: '第一轮', status: 'success', workflowStage: 'scene-stabilize',
        modelId: 'gemini-3-pro-image-preview', modelOptions: { aspectRatio: '3:4', imageSize: '2K' },
        imageSize: '2K', aspectRatio: '3:4', prompt: '', outputImages: [source], basisRevision: 0,
        promptEnhancement: false, qualityMode: 'fast', safetyFallback: false, stylePresetId: 'faithful',
      } },
      { id: 'approval', type: 'stage-approval', position: { x: 360, y: 0 }, data: {
        kind: 'stage-approval', label: '确认第一轮基准', status: 'success', approvalKind: 'scene-baseline',
        approvedSourceNodeId: 'first', approvedBaselineRef: source, approvedBasisRevision: 0,
        approvedAt: '2026-09-21T00:00:00.000Z',
      } },
      { id: 'outfit', type: 'image-input', position: { x: 360, y: 500 }, data: {
        kind: 'image-input', label: '主穿搭图', status: 'success', imageRole: 'garment', imageUrl: source,
      } },
      { id: 'refine', type: 'virtual-try-on', position: { x: 720, y: 0 }, data: {
        kind: 'virtual-try-on', label: '第二轮 · GPT 服装还原与精修', status: 'idle', workflowStage: 'garment-refine',
        modelId: 'gpt-image-2', modelOptions: { quality: 'medium' }, imageSize: '2K', aspectRatio: '3:4',
        prompt: '', materialSpec: '', constructionSpec: '', outputImages: [],
        promptEnhancement: false, qualityMode: 'fast', safetyFallback: false, stylePresetId: 'faithful',
      } },
    ], edges: [
      { id: 'first-approval', source: 'first', sourceHandle: 'image', target: 'approval', targetHandle: 'baseline-candidate' },
      { id: 'approval-refine', source: 'approval', sourceHandle: 'image', target: 'refine', targetHandle: 'baseline' },
      { id: 'outfit-refine', source: 'outfit', sourceHandle: 'image', target: 'refine', targetHandle: 'outfit' },
    ] });
    useFlowStore.getState().setSelectedNodeIds(['refine']);
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, nodeId: 'refine', fitView: true });
  }, image);

  await page.getByRole('button', { name: '属性', exact: true }).click();
  const inspector = page.locator('#workbench-inspector-panel');
  await expect(inspector).toBeVisible();
  for (const text of ['服装品类（选填）', '材料/面料规格（选填）', '结构/制作工艺（选填）']) {
    await expect(inspector.getByText(text, { exact: true })).toBeVisible();
  }
  const auto = inspector.getByRole('button', { name: '自动判断', exact: true });
  await expect(auto).toHaveAttribute('aria-pressed', 'true');
  await inspector.getByRole('button', { name: '针织', exact: true }).click();
  await expect(auto).toHaveAttribute('aria-pressed', 'false');
  await auto.click();
  await expect(auto).toHaveAttribute('aria-pressed', 'true');
  await expect(inspector.getByRole('textbox', { name: '材料/面料规格（选填）' })).toHaveValue('');
  await expect(inspector.getByRole('textbox', { name: '结构/制作工艺（选填）' })).toHaveValue('');
  const run = inspector.getByRole('button', { name: '运行此节点', exact: true });
  await expect(run).toBeEnabled();
  const panelBox = await inspector.boundingBox();
  expect(panelBox).not.toBeNull();
  expect(panelBox!.x).toBeGreaterThanOrEqual(0);
  expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: testInfo.outputPath('optional-refine-specs.png') });
  await run.click();
  await expect.poll(() => requests.length).toBe(1);
  const submitted = requests[0] as { nodes?: Array<{ id?: string; data?: Record<string, unknown> }> };
  const refine = submitted.nodes?.find(node => node.id === 'refine')?.data;
  expect(refine?.garmentCategory).toBeUndefined();
  expect(refine?.materialSpec).toBe('');
  expect(refine?.constructionSpec).toBe('');
});

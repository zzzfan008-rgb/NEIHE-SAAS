import sharp from 'sharp';
import { expect, test } from './fixtures';

test('删除确认节点后，手动连接第二张候选作为第二轮基准', async ({ page }, testInfo) => {
  const requests: Array<{ edges: Array<{ sourceHandle?: string; targetHandle?: string }> }> = [];
  await page.route('**/api/run-plan', async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 400, json: { error: '测试拦截：未调用 AI' } });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '打开项目中心' })).toBeVisible();
  const images = await Promise.all(['#ccaabb', '#336699'].map(async background => {
    const png = await sharp({ create: { width: 120, height: 160, channels: 3, background } }).png().toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  }));
  await page.evaluate(async sources => {
    const response = await fetch('/api/templates/builtin-tool-one-click-try-on');
    const template = await response.json();
    if (template.flow.nodes.some((node: { type: string }) => node.type === 'stage-approval')) throw new Error('确认节点仍存在');
    if (template.flow.edges.some((edge: { targetHandle: string }) => edge.targetHandle === 'baseline')) throw new Error('基准不应自动连线');
    const storePath = '/src/store/flowStore.ts';
    const landingPath = '/src/lib/canvasLanding.ts';
    const { useFlowStore } = await import(storePath);
    const { requestCanvasLanding } = await import(landingPath);
    useFlowStore.getState().createBlankTab();
    const refine = template.flow.nodes.find((node: { id: string }) => node.id === 'refine');
    useFlowStore.getState().loadFlow({ projectName: '手选第一轮候选', nodes: [
      { id: 'candidates', type: 'result', position: { x: 0, y: 0 }, data: {
        kind: 'result', label: '第一轮候选', status: 'success', images: sources,
      } },
      { id: 'outfit', type: 'image-input', position: { x: 0, y: 650 }, data: {
        kind: 'image-input', label: '主穿搭', status: 'success', imageRole: 'garment', imageUrl: sources[0],
      } },
      { ...refine, position: { x: 500, y: 0 } },
    ], edges: [
      { id: 'outfit-refine', source: 'outfit', sourceHandle: 'image', target: 'refine', targetHandle: 'outfit' },
    ] });
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, fitView: true });
  }, images);
  const result = page.locator('.react-flow__node[data-id="candidates"]');
  const refine = page.locator('.react-flow__node[data-id="refine"]');
  await expect(result).toBeVisible();
  const source = result.locator('[data-handleid="image:1"].source');
  const target = refine.locator('[data-handleid="baseline"].target');
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  expect(from).not.toBeNull();
  expect(to).not.toBeNull();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 15 });
  await page.mouse.up();
  const dialog = page.getByRole('dialog', { name: '确认连接角色' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '确认连接', exact: true }).click();
  await expect(dialog).toBeHidden();
  await result.getByRole('button', { name: '选择生成结果 2', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    const path = '/src/store/flowStore.ts';
    const { useFlowStore, selectActiveDocument } = await import(path);
    return selectActiveDocument(useFlowStore.getState()).edges.find(
      (edge: { targetHandle: string }) => edge.targetHandle === 'baseline',
    )?.sourceHandle;
  })).toBe('image:1');
  for (const node of [result, refine]) {
    const box = await node.boundingBox();
    expect(box!.width).toBeGreaterThan(100);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  await page.screenshot({ path: testInfo.outputPath('manual-baseline.png') });
  await page.evaluate(async () => {
    const path = '/src/store/flowStore.ts';
    const { useFlowStore } = await import(path);
    useFlowStore.getState().setSelectedNodeIds(['refine']);
  });
  await page.getByRole('button', { name: '属性', exact: true }).click();
  await page.locator('#workbench-inspector-panel').getByRole('button', { name: '运行此节点', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].edges.find(edge => edge.targetHandle === 'baseline')?.sourceHandle).toBe('image:1');
});

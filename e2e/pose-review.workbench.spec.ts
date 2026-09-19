import { expect, test } from './fixtures';

test('独立姿势评审不把旧评分、未知或质量失败当作自动推荐', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '打开项目中心' })).toBeVisible();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(async () => {
    const path = '/src/store/flowStore.ts';
    const { useFlowStore } = await import(path);
    useFlowStore.getState().loadFlow({ projectName: '姿势评审验收', nodes: [], edges: [], markDirty: true });
  });
  const toggle = page.getByRole('button', { name: '结果 / 记录', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  for (const mode of ['legacy', 'malformed', 'indeterminate', 'mismatch', 'quality-fail', 'match']) {
    await page.evaluate(async (state) => {
      const path = '/src/store/flowStore.ts';
      const { useFlowStore } = await import(path);
      const fields = ['headAndTorso', 'screenLeftArm', 'screenRightArm', 'screenLeftHand', 'screenRightHand', 'screenLeftLeg', 'screenRightLeg', 'weightAndCrossing', 'notMirrored', 'gaze'];
      const review = { version: 1, referenceType: 'depth', candidates: [{ index: 0, status: 'match', checks: Object.fromEntries(fields.map(field => [field, {
        status: field === 'gaze' ? 'not-observable' : field === 'screenRightLeg' && ['mismatch', 'indeterminate'].includes(state) ? state : 'match',
        reference: '右膝弯曲，保留交叉关系', candidate: state === 'mismatch' ? '双脚分开，没有交叉' : '可见右膝和踝部位置',
      }])) }] };
      useFlowStore.setState({ recentResults: [{ id: 'pose-review-record', nodeId: 'stabilize', nodeLabel: '姿势评审记录', kind: 'virtual-try-on',
        status: 'success', image: `${location.origin}/assets/try-on-styles/soft-editorial.webp`, startedAt: Date.now(),
        parameters: { workflowStage: 'scene-stabilize' }, executionMeta: { tryOn: { stage: 'scene-stabilize', candidateSelection: {
          selectedIndex: state === 'match' || state === 'legacy' || state === 'malformed' ? 0 : null,
          scores: [{ index: 0, total: 100, hardFail: state === 'quality-fail', poseMatches: true }],
          ...(state === 'legacy' ? {} : { poseReview: state === 'malformed' ? { ...review, candidates: [{ index: 0, status: 'match' }] } : review }),
        } } },
      }] });
    }, mode);
    const trigger = page.getByRole('button', { name: '查看生成记录：姿势评审记录' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '姿势评审记录' });
    const review = dialog.getByRole('region', { name: '独立姿势评审' });
    await expect(review).toBeVisible();
    await expect(review.getByRole('status')).toContainText(mode === 'match' ? '自动推荐' : mode === 'mismatch' || mode === 'quality-fail' ? '存在偏差' : '无法判断');
    await review.getByRole('status').scrollIntoViewIfNeeded();
    await expect(review.getByRole('status')).toBeInViewport();
    await expect(review).toContainText('仍需人工确认');
    if (!['legacy', 'malformed'].includes(mode)) {
      await expect(review).toContainText('画面右腿');
      await expect(review).toContainText('该参考类型不提供可靠视线信息');
    }
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    if (mode === 'match') await dialog.screenshot({ path: testInfo.outputPath('pose-review.png') });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  }
  const card = page.getByRole('region', { name: '最近生成' }).locator('article').filter({ has: page.getByRole('button', { name: '查看生成记录：姿势评审记录' }) });
  await card.hover();
  await expect(card.locator('button[title="查看图片"]')).toBeVisible();
  await expect(card.locator('button[title="加入对比"]')).toBeVisible();
  await expect(card.locator('a[title="下载"]')).toHaveAttribute('download', '');
  await expect(card.locator('button[title="设为输入"]')).toBeVisible();
  expect(await page.evaluate(async () => {
    const path = '/src/store/flowStore.ts';
    const { useFlowStore } = await import(path);
    return JSON.stringify(useFlowStore.getState().tabs).includes('poseReview');
  })).toBe(false);
  expect(errors).toEqual([]);
});

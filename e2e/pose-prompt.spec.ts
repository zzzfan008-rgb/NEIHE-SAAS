import sharp from 'sharp';
import type { PoseReferenceRecord } from '../src/types/poseReference';
import { expect, test } from './fixtures';

test.use({ storageState: { cookies: [], origins: [] } });

test('pose model selection, credential persistence, candidate application and logout', async ({ page }) => {
  let owner = 'pose-owner-a';
  let calls = 0;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: owner, accountId: owner, displayName: owner, role: 'user', mustChangePassword: false } } });
    if (path === '/api/auth/logout') return route.fulfill({ json: { ok: true } });
    if (path === '/api/pose-references/analyze') {
      calls++;
      const body = route.request().postDataJSON();
      expect(body.provider).toBe('deepseek');
      expect(body.apiKey).toBe('test-only-pose-key');
      return route.fulfill({ json: { prompt: 'DeepSeek：左腿交叉，右肘弯曲', model: 'deepseek-v4-flash-vision-exp', providerRequests: 1, cacheHit: false } });
    }
    return route.fulfill({ json: {} });
  });
  const visit = async () => {
    await page.goto('/e2e/fixtures/pose-prompt.html');
    await page.getByRole('button', { name: '反推人物姿势', exact: true }).click();
    await page.getByRole('combobox', { name: '反推模型' }).click();
    await page.getByRole('option', { name: 'DeepSeek', exact: true }).click();
  };
  await visit();
  const dialog = page.getByRole('dialog', { name: '反推人物姿势' });
  const key = page.getByLabel('DeepSeek API Key', { exact: true });
  await expect(page.getByRole('button', { name: '开始反推' })).toBeDisabled();
  await key.fill('test-only-pose-key');
  await expect(key).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: '显示密钥' }).click();
  await expect(key).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: '隐藏密钥' }).click();
  for (const locator of [dialog, key, page.getByRole('combobox', { name: '反推模型' })]) {
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  await page.getByRole('button', { name: '开始反推' }).click();
  await expect(dialog.locator('[data-pose-prompt="candidate"]')).toContainText('DeepSeek：');
  await expect(dialog.locator('[data-pose-prompt="result"]')).toHaveText('原有用户编辑');
  await page.getByRole('button', { name: '确认并替换当前提示词' }).click();
  await expect(dialog.locator('[data-pose-prompt="result"]')).toContainText('DeepSeek：');
  await page.getByRole('combobox', { name: '反推模型' }).click();
  await page.getByRole('option', { name: 'Gemini', exact: true }).click();
  await expect(dialog.locator('[data-pose-prompt="candidate"]')).toHaveCount(0);
  expect(calls).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '反推人物姿势', exact: true })).toBeFocused();
  await visit();
  await expect(key).toHaveValue('test-only-pose-key');
  owner = 'pose-owner-b';
  await visit();
  await expect(key).toHaveValue('');
  owner = 'pose-owner-a';
  await visit();
  await expect(key).toHaveValue('test-only-pose-key');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('gc:pose-deepseek-key:pose-owner-a'))).toBeNull();
});

test('three-view calibration preserves user text on failure and applies a retried candidate explicitly', async ({ page }) => {
  const source = '/api/files/pose-e2e.png';
  const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#869ca7' } }).png().toBuffer();
  const image = `data:image/png;base64,${png.toString('base64')}`;
  const records: PoseReferenceRecord[] = [
    { id: 'depth', kind: 'depth', source, status: 'succeeded', result: { image, model: 'test-depth', convention: 'near-white' } },
    { id: 'skeleton', kind: 'skeleton', source, status: 'succeeded', result: { image, model: 'test-dwpose', pose: {
      schemaVersion: 1, canvas: { width: 300, height: 300 }, people: [{ keypoints: Array.from({ length: 133 }, (_, index) => index === 0 ? { x: 0.5, y: 0.2, confidence: 0.9 } : null) }],
    } } },
  ];
  const calls = { gemini: 0, deepseek: 0 };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 'calibration-owner', accountId: 'calibration-owner', displayName: '校准测试', role: 'user', mustChangePassword: false } } });
    if (path === source) return route.fulfill({ contentType: 'image/png', body: png });
    if (path === '/api/pose-references') return route.fulfill({ json: { records } });
    if (path === '/api/pose-references/analyze') {
      const body = route.request().postDataJSON();
      expect(body.calibrationMode).toBe('three-view');
      expect(body.source).toBe(source);
      const provider = body.provider === 'deepseek' ? 'deepseek' : 'gemini';
      if (provider === 'deepseek') expect(body.apiKey).toBe('test-only-calibration-key');
      if (++calls[provider] === 1) return route.fulfill({ status: 502, json: { error: '三图校准缺少来源证据' } });
      return route.fulfill({ json: { prompt: `${provider}：三图校准结果：左腿交叉，头部偏向画面左侧。`, model: `test-${provider}`, providerRequests: 1, cacheHit: false, calibrationMode: 'three-view' } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto('/e2e/fixtures/pose-prompt.html');
  const trigger = page.getByRole('button', { name: '反推人物姿势', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '反推人物姿势' });
  await dialog.getByRole('combobox', { name: '分析方式' }).click();
  await page.getByRole('option', { name: '原图 + 深度图 + DWPose 三图校准' }).click();
  for (const name of ['当前姿势原图', '当前原图对应的深度图', '当前原图对应的 DWPose 骨骼图']) {
    const preview = dialog.getByRole('img', { name, exact: true });
    await expect(preview).toBeVisible();
    const box = await preview.boundingBox();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  let savedPrompt = '原有用户编辑';
  for (const provider of ['gemini', 'deepseek'] as const) {
    if (provider === 'deepseek') {
      await dialog.getByRole('combobox', { name: '反推模型' }).click();
      await page.getByRole('option', { name: 'DeepSeek', exact: true }).click();
      await dialog.getByLabel('DeepSeek API Key', { exact: true }).fill('test-only-calibration-key');
    }
    await dialog.getByRole('button', { name: '开始反推', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('三图校准缺少来源证据');
    await expect(dialog.locator('[data-pose-prompt="result"]')).toHaveText(savedPrompt);
    await expect(dialog.locator('[data-pose-prompt="candidate"]')).toHaveCount(0);
    expect(calls[provider]).toBe(1);
    await dialog.getByRole('button', { name: '重试反推', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(dialog.locator('[data-pose-prompt="candidate"]')).toContainText(`${provider}：三图校准结果`);
    await expect(dialog.locator('[data-pose-prompt="result"]')).toHaveText(savedPrompt);
    await dialog.getByRole('button', { name: '确认并替换当前提示词' }).click();
    savedPrompt = `${provider}：三图校准结果：左腿交叉，头部偏向画面左侧。`;
    await expect(dialog.locator('[data-pose-prompt="result"]')).toHaveText(savedPrompt);
    expect(calls[provider]).toBe(2);
  }
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  const persisted = await page.evaluate(async () => {
    const storeModule = '/src/store/flowStore.ts';
    const snapshotModule = '/src/lib/documentSnapshot.ts';
    const { useFlowStore, selectActiveDocument } = await import(storeModule);
    const { createDocumentSnapshot, documentSnapshotToPersistedWorkflow } = await import(snapshotModule);
    const flow = documentSnapshotToPersistedWorkflow(createDocumentSnapshot(selectActiveDocument(useFlowStore.getState())));
    useFlowStore.getState().loadFlow({ ...flow, projectId: 'pose-e2e' });
    return selectActiveDocument(useFlowStore.getState()).nodes.find((node: { id: string }) => node.id === 'pose')?.data;
  });
  expect(persisted).toMatchObject({ posePrompt: savedPrompt, posePromptImage: source, posePromptMode: 'three-view' });
  expect(calls).toEqual({ gemini: 2, deepseek: 2 });
});

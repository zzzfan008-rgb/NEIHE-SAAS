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
  await page.getByRole('button', { name: '使用新版结果替换当前提示词' }).click();
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

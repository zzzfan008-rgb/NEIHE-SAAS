import sharp from 'sharp';
import type { PoseReferenceRecord } from '../src/types/poseReference';
import { expect, test } from './fixtures';

test.use({ storageState: { cookies: [], origins: [] } });

test('普通账号可编辑三图草稿，校验结果决定是否用于生图', async ({ page }) => {
  const source = '/api/files/pose-e2e.png';
  const png = await sharp({ create: { width: 30, height: 50, channels: 3, background: '#777' } }).png().toBuffer();
  const image = `data:image/png;base64,${png.toString('base64')}`;
  let analysisCalls = 0;
  let validationCalls = 0;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id:'ordinary-pose-user',accountId:'ordinary-pose-user',displayName:'普通用户',role:'user',mustChangePassword:false } } });
    if (path === source) return route.fulfill({contentType:'image/png',body:png});
    if (path === '/api/pose-references') return route.fulfill({json:{records:[
      {id:'depth',kind:'depth',source,status:'succeeded',result:{image,model:'mock',convention:'near-white'}},
      {id:'skeleton',kind:'skeleton',source,status:'succeeded',result:{image,model:'mock',pose:{schemaVersion:1,canvas:{width:30,height:50},people:[{keypoints:[{x:0.5,y:0.5,confidence:1}]}]}}},
    ]}});
    if (path === '/api/pose-references/analyze') {
      analysisCalls++;
      return route.fulfill({json:{prompt:'原始校准结果',calibrationMode:'three-view',optimizationError:'文字交叉结论与DWPose骨骼不一致',model:'mock',providerRequests:0,cacheHit:true}});
    }
    if (path === '/api/pose-references/validate-prompt') {
      validationCalls++;
      const verified = !route.request().postDataJSON().prompt.includes('画面左侧');
      return route.fulfill({json:{verified,...(!verified?{reason:'视线方向中有现有三图证据无法确认的内容'}:{})}});
    }
    return route.fulfill({json:{}});
  });
  await page.goto('/e2e/fixtures/pose-prompt.html');
  await page.getByRole('button',{name:'反推人物姿势',exact:true}).click();
  const dialog = page.getByRole('dialog',{name:'反推人物姿势',exact:true});
  await dialog.getByRole('combobox',{name:'分析方式'}).click();
  await page.getByRole('option',{name:'原图 + 深度图 + DWPose 三图校准'}).click();
  await dialog.getByRole('button',{name:'开始反推',exact:true}).click();
  await expect(dialog.getByText(/三图反推已完成，优化文本未通过校验/)).toContainText('文字交叉结论与DWPose骨骼不一致');
  await dialog.getByRole('button',{name:'确认并替换当前提示词'}).click();
  await dialog.getByRole('button',{name:'编辑优化提示词',exact:true}).click();
  const editor = dialog.getByRole('textbox',{name:'优化后姿势提示词',exact:true});
  await expect(editor).toBeFocused();
  await expect(editor).toBeEditable();
  const box = await editor.boundingBox();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  const text = '三图校准补充（仅补充图1不可见关系）\n视线方向：视线朝画面右侧';
  await editor.fill(text);
  await dialog.getByRole('button',{name:'保存优化提示词',exact:true}).click();
  await expect(dialog.getByText('优化提示词已保存并通过证据校验，将作为原姿势图的补充用于生图。',{exact:true})).toBeVisible();
  const stored = () => page.evaluate(async () => {
    const module = '/src/store/flowStore.ts';
    const {useFlowStore,selectActiveNodes} = await import(module);
    return selectActiveNodes(useFlowStore.getState()).find((n:{id:string})=>n.id==='pose')?.data;
  });
  expect(await stored()).toMatchObject({posePromptMode:'three-view',posePromptOptimized:text,posePromptOptimizedVerified:true});
  await editor.fill(text.replace('画面右侧','画面左侧'));
  await dialog.getByRole('button',{name:'保存优化提示词',exact:true}).click();
  await expect(dialog.getByText(/编辑稿已保存，尚未通过证据校验/)).toBeVisible();
  expect((await stored()).posePromptOptimizedVerified).toBeUndefined();
  await expect(editor).toBeEditable();
  expect(analysisCalls).toBe(1);
  expect(validationCalls).toBe(2);
  let releaseValidation!: () => void;
  const pendingValidation = new Promise<void>(resolve => { releaseValidation = resolve; });
  await page.route('**/api/pose-references/validate-prompt', async route => {
    await pendingValidation;
    await route.fulfill({json:{verified:true}});
  });
  await editor.fill(text);
  const request = page.waitForRequest('**/api/pose-references/validate-prompt');
  await dialog.getByRole('button',{name:'保存优化提示词',exact:true}).click();
  await request;
  await page.evaluate(async () => {
    const module = '/src/store/flowStore.ts';
    const {useFlowStore} = await import(module);
    useFlowStore.getState().loadFlow({projectId:'replacement-project',projectName:'新文档',nodes:[{
      id:'pose',type:'image-input',position:{x:0,y:0},data:{kind:'image-input',label:'新节点',imageUrl:'/api/files/pose-e2e.png',status:'idle',poseReference:true},
    }],edges:[]});
  });
  releaseValidation();
  await expect(dialog.getByText('姿势来源或提示词已变化，编辑稿未写入其他文档',{exact:true})).toBeVisible();
  expect((await stored()).posePromptOptimized).toBeUndefined();
});

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
      return route.fulfill({ json: { prompt: `${provider}：三图校准结果：左腿交叉，头部偏向画面左侧。`, optimizedPrompt: '下肢姿态：左腿交叉\n头部姿态：向画面左侧倾斜', model: `test-${provider}`, providerRequests: 1, cacheHit: false, calibrationMode: 'three-view' } });
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
    await expect(dialog.locator('[data-pose-prompt="saved-optimized"]')).toHaveValue('下肢姿态：左腿交叉\n头部姿态：向画面左侧倾斜');
    const optimizedBox = await dialog.locator('[data-pose-prompt="saved-optimized"]').boundingBox();
    expect(optimizedBox!.width).toBeGreaterThan(0);
    expect(optimizedBox!.x + optimizedBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
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
  expect(persisted).toMatchObject({ posePrompt: savedPrompt, posePromptOptimized: '下肢姿态：左腿交叉\n头部姿态：向画面左侧倾斜', posePromptImage: source, posePromptMode: 'three-view' });
  await trigger.click();
  await expect(dialog.locator('[data-pose-prompt="result"]')).toHaveText(savedPrompt);
  await expect(dialog.locator('[data-pose-prompt="saved-optimized"]')).toHaveValue(persisted.posePromptOptimized);
  await expect(dialog.getByRole('combobox', { name: '分析方式' })).toContainText('原图 + 深度图 + DWPose 三图校准');
  await page.keyboard.press('Escape');
  const replaced = await page.evaluate(async () => {
    const modulePath = '/src/store/flowStore.ts';
    const { useFlowStore, selectActiveDocument, selectActiveDocumentTarget } = await import(modulePath);
    const store = useFlowStore.getState();
    store.updateNodeDataInTab(selectActiveDocumentTarget(store), 'pose', { imageUrl: '/api/files/replaced.png' });
    return selectActiveDocument(useFlowStore.getState()).nodes.find((node: { id: string }) => node.id === 'pose')?.data;
  });
  expect(replaced.posePrompt).toBeUndefined();
  expect(replaced.posePromptOptimized).toBeUndefined();
  expect(calls).toEqual({ gemini: 2, deepseek: 2 });
});

test('optimization stays visible and manual edits persist without a model call', async ({ page }, testInfo) => {
  let analyses = 0;
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 'editor', accountId: 'editor', displayName: '编辑测试', role: 'user', mustChangePassword: false } } });
    if (path === '/api/pose-references/analyze') analyses++;
    return route.fulfill({ json: {} });
  });
  await page.goto('/e2e/fixtures/pose-prompt.html');
  const trigger = page.getByRole('button', { name: '反推人物姿势', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '反推人物姿势', exact: true });
  const editor = dialog.getByRole('textbox', { name: '优化后姿势提示词', exact: true });
  const save = dialog.getByRole('button', { name: '保存优化提示词', exact: true });
  await expect(editor).toBeVisible();
  await expect(editor).toBeEditable();
  await expect(save).toBeDisabled();
  await expect(editor).toHaveAttribute('maxlength', '4000');
  await editor.fill('用户手动修订：右手贴近髋部，左膝弯曲。');
  const box = await editor.boundingBox();
  expect(box!.width).toBeGreaterThan(200);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  const contrast = await editor.evaluate(element => {
    const background = getComputedStyle(element.closest('[data-slot="card"]')!).backgroundColor;
    const luminance = (color: string) => {
      const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => value / 255)
        .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const foreground = luminance(getComputedStyle(element).color), surface = luminance(background);
    return (Math.max(foreground, surface) + 0.05) / (Math.min(foreground, surface) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  await expect(dialog.locator('[data-pose-prompt="result"]')).toHaveText('原有用户编辑');
  await page.keyboard.press('Escape');
  const discard = page.getByRole('alertdialog');
  await expect(discard).toContainText('放弃未保存的优化提示词');
  await discard.getByRole('button', { name: '继续编辑' }).click();
  await expect(editor).toHaveValue('用户手动修订：右手贴近髋部，左膝弯曲。');
  await save.click();
  await expect(dialog.getByText('优化提示词已保存', { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('pose-optimized-editor.png') });
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  const persisted = await page.evaluate(async () => {
    const storeModule = '/src/store/flowStore.ts';
    const snapshotModule = '/src/lib/documentSnapshot.ts';
    const { useFlowStore, selectActiveDocument } = await import(storeModule);
    const { createDocumentSnapshot, documentSnapshotToPersistedWorkflow } = await import(snapshotModule);
    const flow = documentSnapshotToPersistedWorkflow(createDocumentSnapshot(selectActiveDocument(useFlowStore.getState())));
    useFlowStore.getState().loadFlow({ ...flow, projectId: 'pose-e2e' });
    return selectActiveDocument(useFlowStore.getState()).nodes[0].data;
  });
  expect(persisted.posePromptOptimized).toBe('用户手动修订：右手贴近髋部，左膝弯曲。');
  expect(persisted.posePrompt).toBe('原有用户编辑');
  expect(persisted.posePromptMode ?? 'single').toBe('single');
  await trigger.click();
  await expect(editor).toHaveValue(persisted.posePromptOptimized);
  await expect(dialog.getByRole('combobox', { name: '分析方式' })).toContainText('单图反推');
  await editor.fill('   ');
  await expect(save).toBeDisabled();
  await editor.fill('未保存的新草稿');
  await page.keyboard.press('Escape');
  await discard.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(editor).toHaveValue(persisted.posePromptOptimized);
  expect(analyses).toBe(0);
});

test('optimization draft rejects concurrent source changes and read-only documents', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname === '/api/auth/me'
    ? { user: { id: 'editor', accountId: 'editor', displayName: '编辑测试', role: 'user', mustChangePassword: false } } : {} }));
  await page.goto('/e2e/fixtures/pose-prompt.html');
  await page.getByRole('button', { name: '反推人物姿势', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '优化后姿势提示词', exact: true });
  const save = page.getByRole('button', { name: '保存优化提示词', exact: true });
  await editor.fill('旧稿不得覆盖新稿');
  await page.evaluate(async () => {
    const module = '/src/store/flowStore.ts';
    const { useFlowStore, selectActiveDocumentTarget } = await import(module);
    const store = useFlowStore.getState();
    store.updateNodeDataInTab(selectActiveDocumentTarget(store), 'pose', { posePromptOptimized: '另一处保存的新稿' });
  });
  await expect(page.getByRole('alert')).toContainText('姿势来源或提示词已变化');
  await expect(save).toBeDisabled();
  await page.getByRole('button', { name: '恢复当前保存内容' }).click();
  await expect(editor).toHaveValue('另一处保存的新稿');
  await page.evaluate(async () => {
    const module = '/src/store/flowStore.ts';
    const { useFlowStore } = await import(module);
    useFlowStore.setState((state: import('../src/store/flowStore').FlowState) => ({ tabs: state.tabs.map(tab => ({ ...tab, readOnly: true })) }));
  });
  await expect(editor).toBeDisabled();
  await expect(save).toBeDisabled();
});

test('manual optimization also supplies an initially empty pose prompt', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname === '/api/auth/me'
    ? { user: { id: 'editor', accountId: 'editor', displayName: '编辑测试', role: 'user', mustChangePassword: false } } : {} }));
  await page.goto('/e2e/fixtures/pose-prompt.html');
  const trigger = page.getByRole('button', { name: '反推人物姿势', exact: true });
  await expect(trigger).toBeVisible();
  await page.evaluate(async () => {
    const module = '/src/store/flowStore.ts';
    const { useFlowStore, selectActiveDocumentTarget } = await import(module);
    useFlowStore.getState().updateNodeDataInTab(selectActiveDocumentTarget(useFlowStore.getState()), 'pose', { posePrompt: '   ' });
  });
  await trigger.click();
  await page.getByRole('textbox', { name: '优化后姿势提示词', exact: true }).fill('手工姿势：抬起右臂');
  await page.getByRole('button', { name: '保存优化提示词', exact: true }).click();
  await expect(page.getByText('优化提示词已保存', { exact: true })).toBeVisible();
  const data = await page.evaluate(async () => {
    const module = '/src/store/flowStore.ts';
    const { useFlowStore, selectActiveDocument } = await import(module);
    return selectActiveDocument(useFlowStore.getState()).nodes[0].data;
  });
  expect(data.posePrompt).toBe('手工姿势：抬起右臂');
  expect(data.posePromptOptimized).toBe(data.posePrompt);
});

test('optimization save can retry without losing text and late saves cannot target a new document', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname === '/api/auth/me'
    ? { user: { id: 'editor', accountId: 'editor', displayName: '编辑测试', role: 'user', mustChangePassword: false } } : {} }));
  await page.goto('/e2e/fixtures/pose-prompt.html');
  await expect(page.getByRole('button', { name: '反推人物姿势', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const module = '/src/store/flowStore.ts';
    const { useFlowStore } = await import(module);
    let calls = 0;
    useFlowStore.setState({ saveProjectInTab: async () => ++calls > 1 });
  });
  await page.getByRole('button', { name: '反推人物姿势', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '优化后姿势提示词', exact: true });
  const save = page.getByRole('button', { name: '保存优化提示词', exact: true });
  await editor.fill('失败后保留的优化文本');
  await save.click();
  await expect(page.getByRole('alert')).toContainText('项目保存失败');
  await expect(editor).toHaveValue('失败后保留的优化文本');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText('优化提示词已保存', { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const module = '/src/store/flowStore.ts';
    const { useFlowStore } = await import(module);
    useFlowStore.setState({ saveProjectInTab: () => new Promise<boolean>(resolve => {
      (window as Window & { finishPoseSave?: () => void }).finishPoseSave = () => resolve(true);
    }) });
  });
  await editor.fill('不得污染后来打开的项目');
  await save.click();
  await expect(page.getByRole('button', { name: '正在保存…', exact: true })).toBeDisabled();
  await page.evaluate(async () => {
    const module = '/src/store/flowStore.ts';
    const { useFlowStore } = await import(module);
    useFlowStore.getState().loadFlow({ projectId: 'new-document', projectName: '后来打开的项目', nodes: [{
      id: 'pose', type: 'image-input', position: { x: 0, y: 0 },
      data: { kind: 'image-input', label: '新图', imageRole: 'reference', status: 'idle', imageUrl: '/api/files/new.png' },
    }], edges: [] });
    (window as Window & { finishPoseSave?: () => void }).finishPoseSave?.();
  });
  await expect(page.getByText('优化提示词已保存', { exact: true })).toHaveCount(0);
  const data = await page.evaluate(async () => {
    const module = '/src/store/flowStore.ts';
    const { useFlowStore, selectActiveDocument } = await import(module);
    return selectActiveDocument(useFlowStore.getState()).nodes[0].data;
  });
  expect(data.imageUrl).toBe('/api/files/new.png');
  expect(data.posePromptOptimized).toBeUndefined();
});

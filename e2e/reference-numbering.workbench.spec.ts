import sharp from "sharp";
import { expect, test } from "./fixtures";

test("第一轮参考编号随连线和实际图片更新且不溢出角色框", async ({ page }, testInfo) => {
  const image = `data:image/png;base64,${(await sharp({ create: { width: 24, height: 32, channels: 3, background: "#aaa" } }).png().toBuffer()).toString("base64")}`;
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开项目中心" })).toBeVisible();
  await page.evaluate(async image => {
    const path = "/src/store/flowStore.ts";
    const landingPath = "/src/lib/canvasLanding.ts";
    const { useFlowStore } = await import(path);
    const { requestCanvasLanding } = await import(landingPath);
    const roles = ["scene", "hat", "person", "socks", "pose", "shoes", "outfit"];
    useFlowStore.getState().createBlankTab();
    useFlowStore.getState().loadFlow({ projectName: "动态参考编号", markDirty: true,
      nodes: [{ id: "stabilize", type: "virtual-try-on", position: { x: 0, y: 0 }, data: {
        kind: "virtual-try-on", label: "第一轮", status: "idle", workflowStage: "scene-stabilize",
        modelId: "gemini-3.1-flash-image", imageSize: "2K", aspectRatio: "3:4", prompt: "",
      } }, ...roles.map((role, index) => ({ id: role, type: "image-input", position: { x: -400, y: index * 5 },
        data: { kind: "image-input", label: role, imageUrl: image, status: "success" } }))],
      edges: roles.map(role => ({ id: role, source: role, target: "stabilize", sourceHandle: "image", targetHandle: role })),
    });
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, nodeId: "stabilize", fitView: true });
  }, image);
  const node = page.locator('.react-flow__node[data-id="stabilize"]');
  const labels = (role: string) => node.locator(`[data-reference-numbers="${role}"]`);
  await expect(labels("pose")).toHaveCount(0);
  for (const [role, number] of Object.entries({ person: 2, outfit: 3, shoes: 4, socks: 5, hat: 6, scene: 7 })) {
    await expect(labels(role)).toHaveText(`(参考图 ${number})`);
  }
  await expect(labels("bag")).toBeEmpty();
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    useFlowStore.getState().onEdgesChange([{ id: "shoes", type: "remove" }]);
    useFlowStore.getState().updateNodeData("hat", { imageUrl: undefined });
  });
  await expect(labels("shoes")).toBeEmpty();
  await expect(labels("hat")).toHaveText("待提供图片");
  await expect(labels("socks")).toHaveText("(参考图 4)");
  await expect(labels("scene")).toHaveText("(参考图 5)");
  await page.evaluate(async image => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    const store = useFlowStore.getState();
    store.updateNodeData("hat", { imageUrl: image });
    store.onConnect({ source: "shoes", sourceHandle: "image", target: "stabilize", targetHandle: "shoes" });
  }, image);
  await page.getByRole("dialog").getByRole("button", { name: "确认连接" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(labels("scene")).toHaveText("(参考图 7)");
  await expect(labels("shoes")).toHaveText("(参考图 4)");
  const geometry = await node.locator("[data-port-row]").evaluateAll(rows => rows.map(row => {
    const box = row.getBoundingClientRect();
    const number = row.querySelector("[data-reference-numbers]")!;
    const label = number.getBoundingClientRect();
    return { width: box.width, inside: label.left >= box.left && label.right <= box.right + 1 && label.bottom <= box.bottom + 1,
      overflow: number.scrollWidth > number.clientWidth + 1 };
  }));
  expect(geometry).toHaveLength(12);
  expect(geometry.every(row => row.width > 0 && row.inside && !row.overflow)).toBe(true);
  // Two additional identity references must receive their own model indices.
  await page.evaluate(async image => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    for (let index = 0; index < 2; index++) {
      const store = useFlowStore.getState();
      const id = store.addNode("image-input", { x: -400, y: 0 });
      store.updateNodeData(id, { imageUrl: image });
      store.onConnect({ source: id, sourceHandle: "image", target: "stabilize", targetHandle: "person" });
      if (!useFlowStore.getState().confirmPendingConnection("person")) throw new Error("identity connection rejected");
    }
  }, image);
  await expect(labels("person")).toHaveText("(参考图 2) (参考图 3) (参考图 4)");
  await expect(labels("outfit")).toHaveText("(参考图 5)");
  await expect(labels("scene")).toHaveText("(参考图 9)");
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(await labels("person").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("reference-numbering.png") });
});

test('第一轮不再展示姿势行与来源，第二轮保留增强开关', async ({ page }, testInfo) => {
  const image = `data:image/png;base64,${(await sharp({ create: { width: 24, height: 32, channels: 3, background: '#aaa' } }).png().toBuffer()).toString('base64')}`;
  await page.goto('/');
  await expect(page.getByRole('button', { name: '打开项目中心' })).toBeVisible();
  await page.evaluate(async image => {
    const storePath = '/src/store/flowStore.ts';
    const landingPath = '/src/lib/canvasLanding.ts';
    const { useFlowStore } = await import(storePath);
    const { requestCanvasLanding } = await import(landingPath);
    useFlowStore.getState().createBlankTab();
    useFlowStore.getState().loadFlow({ projectName: '姿势来源说明', nodes: [
      { id: 'first', type: 'virtual-try-on', position: { x: 0, y: 0 }, data: {
        kind: 'virtual-try-on', label: '第一轮', workflowStage: 'scene-stabilize', status: 'idle',
        modelId: 'gemini-3.1-flash-image', prompt: '画面左腿较直', promptEnhancement: true, safetyFallback: true,
      } },
      { id: 'pose', type: 'image-input', position: { x: -400, y: 0 }, data: {
        kind: 'image-input', label: '名为原图的深度来源', status: 'success', imageUrl: image,
        poseReferenceSource: { kind: 'depth', image },
      } },
      { id: 'second', type: 'virtual-try-on', position: { x: 500, y: 0 }, data: {
        kind: 'virtual-try-on', label: '第二轮', workflowStage: 'garment-refine', status: 'idle',
        modelId: 'gpt-image-2', promptEnhancement: true, safetyFallback: true,
      } },
    ], edges: [{ id: 'pose-first', source: 'pose', sourceHandle: 'image', target: 'first', targetHandle: 'pose' }] });
    useFlowStore.getState().setSelectedNodeIds(['first']);
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, nodeId: 'first', fitView: true });
  }, image);
  await page.getByRole('button', { name: '属性', exact: true }).click();
  await expect(page.getByLabel('第一轮生成设置', { exact: true })).toHaveCount(2);
  const node = page.locator('.react-flow__node[data-id="first"]');
  const settings = node.getByLabel('第一轮生成设置', { exact: true });
  const pose = settings.getByRole('group', { name: '当前姿势参考' });
  await expect(pose).toHaveCount(0);
  await expect(node.locator('[data-port-row="pose"]')).toHaveCount(0);
  await page.evaluate(async () => {
    const path = '/src/store/flowStore.ts';
    const { useFlowStore, selectActiveNodes } = await import(path);
    const bypassId = useFlowStore.getState().addNode('mask-redraw', { x: -300, y: 300 });
    useFlowStore.getState().updateNodeData(bypassId, { label: '旁路修复', executionMode: 'bypass', outputImages: [] });
    const state = useFlowStore.getState();
    state.loadFlow({ projectName: '旁路姿势来源', nodes: selectActiveNodes(state), edges: [
      { id: 'pose-bypass', source: 'pose', sourceHandle: 'image', target: bypassId, targetHandle: 'repair-source' },
      { id: 'pose-first', source: bypassId, sourceHandle: 'image', target: 'first', targetHandle: 'pose' },
    ] });
    useFlowStore.getState().setSelectedNodeIds(['first']);
  });
  await expect(pose).toHaveCount(0);
  await expect(settings).toContainText('未连接时依据创作想法自然安排动作');
  await expect(settings).toContainText('第一轮不执行通用提示词增强');
  await expect(page.getByRole('switch', { name: /提示词增强/ })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: '审核失败安全降级一次' })).toHaveCount(0);
  await settings.getByRole('textbox', { name: '创作想法' }).fill('画面右膝弯曲，不改左右');
  await page.keyboard.press('Tab');
  const data = await page.evaluate(async () => {
    const path = '/src/store/flowStore.ts';
    const { useFlowStore, selectActiveNodes } = await import(path);
    return selectActiveNodes(useFlowStore.getState()).find((n: { id: string; data: unknown }) => n.id === 'first')!.data;
  });
  expect(data).toMatchObject({ prompt: '画面右膝弯曲，不改左右', promptEnhancement: true, safetyFallback: true });
  expect(await settings.evaluate(el => {
    const parent = el.getBoundingClientRect();
    return [...el.querySelectorAll('p, textarea, [role="group"]')].every(child => {
      const box = child.getBoundingClientRect();
      return box.width > 0 && box.left >= parent.left - 1 && box.right <= parent.right + 1 && child.scrollWidth <= child.clientWidth + 1;
    });
  })).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('scene-original-prompt-policy.png') });
  await page.evaluate(async () => {
    const path = '/src/store/flowStore.ts';
    const { useFlowStore } = await import(path);
    useFlowStore.getState().updateNodeData('pose', { imageUrl: undefined });
  });
  await expect(pose).toHaveCount(0);
  await page.evaluate(async image => {
    const path = '/src/store/flowStore.ts';
    const { useFlowStore } = await import(path);
    useFlowStore.getState().updateNodeData('pose', { imageUrl: image, poseReferenceSource: { kind: 'depth', image: '/api/files/stale.png' } });
  }, image);
  await expect(pose).toHaveCount(0);
  await page.evaluate(async () => {
    const path = '/src/store/flowStore.ts';
    const { useFlowStore } = await import(path);
    useFlowStore.getState().onEdgesChange([{ id: 'pose-first', type: 'remove' }]);
  });
  await expect(pose).toHaveCount(0);
  await page.evaluate(async () => {
    const path = '/src/store/flowStore.ts';
    const { useFlowStore } = await import(path);
    useFlowStore.getState().setSelectedNodeIds(['second']);
  });
  const enhancement = page.getByRole('switch', { name: /提示词增强/ });
  await expect(enhancement).toBeChecked();
  await enhancement.focus();
  await page.keyboard.press('Space');
  await expect(enhancement).not.toBeChecked();
  await expect(page.getByRole('switch', { name: '审核失败安全降级一次' })).toBeChecked();
});

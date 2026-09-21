import { expect, test } from "./fixtures";

test("TiAngle 从添加菜单创建，手动连线并随模型适配，模板保持独立", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开项目中心" })).toBeVisible();
  const template = await page.evaluate(async () => {
    const response = await fetch("/api/templates/builtin-tool-one-click-try-on");
    return response.json();
  });
  expect(template.flow.nodes.some((node: { type: string }) => node.type === "ti-angle")).toBe(false);
  expect(template.flow.edges.some((edge: { targetHandle: string }) => edge.targetHandle === "angle-direction")).toBe(false);
  await page.evaluate(async flow => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    useFlowStore.getState().createBlankTab();
    const first = flow.nodes.find((node: { id: string }) => node.id === "stabilize");
    useFlowStore.getState().loadFlow({ projectName: "TiAngle 手动连接", nodes: [
      { ...first, position: { x: 450, y: 0 } },
    ], edges: [] });
  }, template.flow);
  const rail = page.getByRole("navigation", { name: "工作台左侧工具" });
  await rail.getByRole("button", { name: "添加节点", exact: true }).click();
  await page.getByRole("menu", { name: "添加节点" }).getByRole("menuitem", { name: /3D 视角/ }).click();
  const angleId = await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveDocument } = await import(path);
    const doc = selectActiveDocument(useFlowStore.getState());
    const angle = doc.nodes.find((node: { type: string }) => node.type === "ti-angle");
    if (!angle) throw new Error("Missing angle");
    if (doc.edges.length) throw new Error("Adding TiAngle must not auto-connect");
    useFlowStore.getState().loadFlow({ projectName: "TiAngle 手动连接", nodes: doc.nodes.map(
      (node: { id: string }) => node.id === angle.id ? { ...node, position: { x: 0, y: 0 } } : node,
    ), edges: [] });
    const landingPath = "/src/lib/canvasLanding.ts";
    const { requestCanvasLanding } = await import(landingPath);
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, fitView: true });
    return angle.id;
  });
  const angle = page.locator(`.react-flow__node[data-id="${angleId}"]`);
  const first = page.locator('.react-flow__node[data-id="stabilize"]');
  const toggle = angle.getByRole("button", { name: "查看输出文本", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await angle.getByRole("switch", { name: "启用 3D 视角" }).click();
  await angle.getByRole("button", { name: "左前方 +45°", exact: true }).click();
  const source = angle.locator('[data-handleid="text"].source');
  const target = first.locator('[data-handleid="angle-direction"].target');
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("Missing angle connection handles");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  await page.mouse.up();
  const roleDialog = page.getByRole("dialog", { name: "确认连接角色" });
  await expect(roleDialog).toBeVisible();
  await roleDialog.getByRole("button", { name: "确认连接", exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveDocument } = await import(path);
    return selectActiveDocument(useFlowStore.getState()).edges.filter(
      (edge: { targetHandle: string }) => edge.targetHandle === "angle-direction",
    ).length;
  })).toBe(1);
  await toggle.click();
  await expect(angle).toContainText("环绕角 45°");
  await expect(angle).toContainText("镜头约束");
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    useFlowStore.getState().updateNodeData("stabilize", { modelId: "gpt-image-2" });
  });
  await expect(angle).toContainText("只改变相机观察视角");
  const geometry = await angle.boundingBox();
  expect(geometry!.width).toBeGreaterThan(100);
  expect(geometry!.x).toBeGreaterThanOrEqual(0);
  expect(geometry!.x + geometry!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const snapshotPath = "/src/lib/documentSnapshot.ts";
    const { useFlowStore, selectActiveDocument } = await import(storePath);
    const { createDocumentSnapshot, documentSnapshotToPersistedWorkflow } = await import(snapshotPath);
    const snapshot = documentSnapshotToPersistedWorkflow(createDocumentSnapshot(selectActiveDocument(useFlowStore.getState())));
    useFlowStore.getState().createBlankTab();
    useFlowStore.getState().loadFlow({ ...snapshot, projectName: "TiAngle 恢复" });
  });
  await expect(angle.getByRole("button", { name: "查看输出文本", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(angle.getByRole("spinbutton", { name: "环绕角数值" })).toHaveValue("45");
});

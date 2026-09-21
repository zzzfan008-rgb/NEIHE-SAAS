import { expect, test } from "./fixtures";

test("TiAngle 从添加菜单创建，手动连线并随模型适配，模板保持独立", async ({ page }, testInfo) => {
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
  const angleToggle = angle.getByRole("button", { name: /^输出视角约束/ });
  const cameraToggle = angle.getByRole("button", { name: /^相机参数/ });
  const outputToggle = angle.getByRole("button", { name: /^查看输出文本/ });
  await expect(angleToggle).toHaveAttribute("aria-expanded", "false");
  await expect(cameraToggle).toHaveAttribute("aria-expanded", "false");
  await expect(outputToggle).toHaveAttribute("aria-expanded", "false");
  await angleToggle.click();
  await angle.getByRole("switch", { name: "启用 3D 视角" }).click();
  const activePreset = angle.getByRole("button", { name: "左前方 +45°", exact: true });
  const inactivePreset = angle.getByRole("button", { name: "右前方 -45°", exact: true });
  await activePreset.click();
  await page.mouse.move(0, 0);
  await expect(activePreset).toHaveAttribute("aria-pressed", "true");
  expect(await activePreset.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color, border: style.borderColor };
  })).toEqual({
    background: "rgb(185, 141, 69)",
    color: "rgb(24, 24, 24)",
    border: "rgb(185, 141, 69)",
  });
  expect(await inactivePreset.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color, border: style.borderColor };
  })).toEqual({
    background: "rgb(24, 24, 24)",
    color: "rgb(185, 141, 69)",
    border: "rgb(185, 141, 69)",
  });
  await angleToggle.click();
  await cameraToggle.focus();
  await cameraToggle.press("Enter");
  await expect(cameraToggle).toHaveAttribute("aria-expanded", "true");
  await angle.getByRole("combobox", { name: "品牌相机" }).click();
  await page.getByRole("option", { name: "Sony α7R V", exact: true }).click();
  await angle.getByRole("combobox", { name: "焦距" }).click();
  await page.getByRole("option", { name: "85 mm", exact: true }).click();
  await angle.getByRole("combobox", { name: "ISO" }).click();
  await page.getByRole("option", { name: "ISO 200", exact: true }).click();
  await angle.getByRole("combobox", { name: "快门速度" }).click();
  await page.getByRole("option", { name: "1/250 s", exact: true }).click();
  await angle.getByRole("combobox", { name: "光圈大小" }).click();
  await page.getByRole("option", { name: "f/2.8", exact: true }).click();
  await expect(angle.getByRole("combobox", { name: "品牌相机" })).toContainText("Sony α7R V");
  await expect(angle.getByRole("combobox", { name: "焦距" })).toContainText("85 mm");
  await expect(angle.getByRole("combobox", { name: "ISO" })).toContainText("ISO 200");
  await expect(angle.getByRole("combobox", { name: "快门速度" })).toContainText("1/250 s");
  await expect(cameraToggle).toContainText("Sony α7R V · 85 mm · ISO 200 · 快门 1/250 s · 光圈 f/2.8");
  await testInfo.attach("ti-angle-camera-controls", {
    body: await angle.screenshot(),
    contentType: "image/png",
  });
  await cameraToggle.press("Enter");
  await expect(cameraToggle).toHaveAttribute("aria-expanded", "false");
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
  await outputToggle.click();
  await expect(angle).toContainText("环绕角 45°");
  await expect(angle).toContainText("镜头约束");
  await expect(angle).toContainText("摄影参数：Sony α7R V · 85 mm · ISO 200 · 快门 1/250 s · 光圈 f/2.8");
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    useFlowStore.getState().updateNodeData("stabilize", { modelId: "gpt-image-2" });
  });
  await expect(angle).toContainText("相机约束");
  const geometry = await angle.boundingBox();
  expect(geometry!.width).toBeGreaterThan(100);
  expect(geometry!.x).toBeGreaterThanOrEqual(0);
  expect(geometry!.x + geometry!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  for (const sectionToggle of [angleToggle, cameraToggle, outputToggle]) {
    const sectionBox = await sectionToggle.boundingBox();
    expect(sectionBox).not.toBeNull();
    expect(sectionBox!.x).toBeGreaterThanOrEqual(geometry!.x);
    expect(sectionBox!.x + sectionBox!.width).toBeLessThanOrEqual(geometry!.x + geometry!.width + 1);
  }
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
  await expect(angle.getByRole("button", { name: /^输出视角约束/ })).toHaveAttribute("aria-expanded", "false");
  await expect(angle.getByRole("button", { name: /^相机参数/ })).toHaveAttribute("aria-expanded", "false");
  await expect(angle.getByRole("button", { name: /^查看输出文本/ })).toHaveAttribute("aria-expanded", "false");
  await expect(angle.getByRole("button", { name: /^相机参数/ })).toContainText("Sony α7R V · 85 mm · ISO 200");
  await angle.getByRole("button", { name: /^输出视角约束/ }).click();
  await expect(angle.getByRole("spinbutton", { name: "环绕角数值" })).toHaveValue("45");
  expect(await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveDocument } = await import(path);
    const data = selectActiveDocument(useFlowStore.getState()).nodes.find(
      (node: { type?: string }) => node.type === "ti-angle",
    )?.data;
    return data?.kind === "ti-angle" ? data.angle.camera : null;
  })).toEqual({
    cameraModel: "sony-a7r-v",
    focalLengthMm: 85,
    iso: 200,
    shutterSpeed: "1/250",
    aperture: "f/2.8",
  });
});

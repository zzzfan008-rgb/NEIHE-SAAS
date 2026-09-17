import sharp from "sharp";
import { expect, test } from "./fixtures";

test("背景板生成：移除图片后切换上游，运行中禁止移除", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开项目中心" })).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    useFlowStore.getState().createBlankTab();
  });
  await page.getByRole("button", { name: "添加节点", exact: true }).click();
  await page.getByRole("menuitem", { name: /背景板生成/ }).click();
  const node = page.locator(".react-flow__node-background-extract");
  const image = await sharp({ create: { width: 240, height: 160, channels: 3, background: "navy" } }).png().toBuffer();
  await node.getByLabel("上传图片").setInputFiles({ name: "source.png", mimeType: "image/png", buffer: image });
  await expect(node.getByAltText("待处理图片")).toBeVisible();
  await node.getByLabel("背景板提示词").fill("保留墙面纹理");
  const source = await node.getByAltText("待处理图片").getAttribute("src");
  for (const status of ["queued", "running", "retry_wait", "cancel_requested", "idle"]) {
    await page.evaluate(async (status) => {
      const path = "/src/store/flowStore.ts";
      const m = await import(path);
      const state = m.useFlowStore.getState();
      const node = m.selectActiveNodes(state).find((n: { data: { kind: string } }) => n.data.kind === "background-extract");
      state.setNodeStatus(node.id, status);
    }, status);
    if (status !== "idle") await expect(node.getByRole("button", { name: "移除图片" })).toBeDisabled();
  }
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const m = await import(path);
    const state = m.useFlowStore.getState();
    const target = m.selectActiveNodes(state).find((n: { data: { kind: string } }) => n.data.kind === "background-extract");
    const sourceId = state.addNode("image-input", { x: target.position.x - 400, y: target.position.y });
    m.useFlowStore.getState().updateNodeData(sourceId, { imageUrl: target.data.imageUrl });
    m.useFlowStore.getState().onConnect({ source: sourceId, sourceHandle: "image", target: target.id, targetHandle: "references" });
  });
  await expect(node.getByRole("button", { name: "生成背景板", exact: true })).toBeDisabled();
  await node.getByRole("button", { name: "移除图片" }).click();
  await expect(node.getByAltText("待处理图片")).toHaveCount(0);
  await expect(node.getByRole("button", { name: "生成背景板", exact: true })).toBeEnabled();
  expect((await page.request.get(source!)).ok()).toBe(true);
  for (const width of [1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "适应画布", exact: true }).click();
    await expect(node).toBeVisible();
    await expect.poll(() => node.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
    })).toBe(true);
  }
});

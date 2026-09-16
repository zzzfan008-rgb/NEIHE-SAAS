import sharp from "sharp";
import { expect, test } from "./fixtures";

test("人物板：侧栏创建、上传、生成、失败保留及图像输出", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开项目中心" })).toBeVisible();
  await page.evaluate(async () => { const path = "/src/store/flowStore.ts"; const { useFlowStore } = await import(path); useFlowStore.getState().createBlankTab(); });
  await page.getByRole("button", { name: "添加节点", exact: true }).click();
  await page.getByRole("menu", { name: "添加节点" }).getByRole("menuitem", { name: /人物板生成/ }).click();
  const node = page.locator(".react-flow__node-character-board");
  await expect(node).toBeVisible();
  const generate = node.getByRole("button", { name: "生成人物板", exact: true });
  await expect(generate).toBeDisabled();
  const image = await sharp({ create: { width: 240, height: 320, channels: 3, background: "#ddd" } }).png().toBuffer();
  await node.getByLabel("上传人物板模特图").setInputFiles({ name: "model.png", mimeType: "image/png", buffer: image });
  await expect(node.getByAltText("人物板原始模特图")).toBeVisible();
  await expect(generate).toBeEnabled();
  let calls = 0;
  let nodeId = "";
  let output = "";
  await page.route(/\/api\/run-plan(?:\/|$)/, async (route) => {
    if (route.request().method() === "POST") {
      calls++;
      const body = route.request().postDataJSON();
      const source = body.nodes.find((item: { data: { kind: string } }) => item.data.kind === "character-board");
      nodeId = source.id;
      expect(body.onlyNodeId).toBe(nodeId);
      expect(source.data.sourceImage).toMatch(/^\/api\/files\//);
      expect(source.data.prompt).toBeUndefined();
      output = source.data.sourceImage;
      await route.fulfill({ json: { runId: `mock-board-${calls}` } }); return;
    }
    if (route.request().url().endsWith("/events")) {
      const events = [{ type: "node-status", nodeId, status: "running" },
        { type: "node-status", nodeId, status: calls === 1 ? "success" : "error", ...(calls === 1 ? { images: [output] } : { error: "模拟生成失败" }) }, { type: "done" }];
      await route.fulfill({ contentType: "text/event-stream", body: events.map((event, index) => `id: ${index + 1}\ndata: ${JSON.stringify({ ...event, seq: index + 1 })}\n\n`).join("") }); return;
    }
    await route.fulfill({ json: { status: "running" } });
  });
  await generate.focus();
  await page.keyboard.press("Enter");
  await expect(node.getByRole("button", { name: "查看生成结果 1" })).toBeVisible();
  await expect(page.locator(".react-flow__node-result")).toHaveCount(0);
  await expect(node.getByRole("link", { name: "下载人物板" })).toHaveAttribute("href", output);
  const downloaded = page.waitForEvent("download");
  await node.getByRole("link", { name: "下载人物板" }).click();
  expect((await downloaded).suggestedFilename()).toBe("人物板.png");
  await generate.click();
  await expect(node.getByText("模拟生成失败", { exact: true })).toBeVisible();
  await expect(node.getByRole("button", { name: "查看生成结果 1" })).toBeVisible();
  expect(calls).toBe(2);
  await page.getByRole("button", { name: "适应画布", exact: true }).click();
  const geometry = await node.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const buttons = Array.from(element.querySelectorAll("button")).map((button) => button.getBoundingClientRect());
    return { width: box.width, fits: buttons.every((button) => button.left >= box.left - 1 && button.right <= box.right + 1), overflow: document.documentElement.scrollWidth > innerWidth };
  });
  expect(geometry.width).toBeGreaterThan(100);
  expect(geometry.fits).toBe(true);
  expect(geometry.overflow).toBe(false);
  const contrast = await node.getByRole("button", { name: "替换模特图" }).evaluate((element) => {
    const style = getComputedStyle(element);
    const luminance = (color: string) => {
      const values = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((value) => value / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
    };
    const a = luminance(style.color), b = luminance(style.backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  await node.getByRole("button", { name: "查看生成结果 1" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: testInfo.outputPath("character-board.png") });
});

import sharp from "sharp";
import { expect, test } from "./fixtures";

test("three sketch templates contain connected optimization nodes and accessible controls", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开项目中心" })).toBeVisible();
  const templates = await (await page.request.get("/api/templates")).json();
  for (const id of ["builtin-sketch-recolor", "builtin-sketch-upscale", "builtin-tool-sketch-render"]) {
    const template = templates.find((item: { id: string }) => item.id === id);
    expect(template).toBeTruthy();
    await page.evaluate(async (template) => {
      const path = "/src/lib/templateLaunch.ts";
      const landing = "/src/lib/canvasLanding.ts";
      const { launchTemplateInNewTab } = await import(path);
      const { requestCanvasLanding } = await import(landing);
      const { tabId } = launchTemplateInNewTab(template);
      requestCanvasLanding({ tabId, nodeId: "sketch-optimization", fitView: false });
    }, template);
    const node = page.locator('.react-flow__node[data-id="sketch-optimization"]');
    await expect(node.getByRole("textbox", { name: "设计理念与修改要求" })).toBeVisible();
    await expect(node.getByRole("button", { name: "生成优化线稿" })).toBeDisabled();
    const card = (await node.locator(".gc-node-card").boundingBox())!;
    expect(card.width).toBeGreaterThan(100);
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await node.getByRole("textbox", { name: "设计理念与修改要求" }).fill("保留落肩，缩短衣长，袖口改为罗纹");
    await node.getByRole("textbox", { name: "设计理念与修改要求" }).press("Tab");
    await node.getByRole("combobox", { name: "线稿画幅比例" }).click();
    await page.getByRole("listbox").getByRole("option", { name: "4:3", exact: true }).click();
    await expect(node.getByRole("combobox", { name: "线稿画幅比例" })).toContainText("4:3");
  }
});

test("uploaded sketch generates only the optimizer and retains result after failure", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开项目中心" })).toBeVisible();
  const templates = await (await page.request.get("/api/templates")).json();
  const template = templates.find((item: { id: string }) => item.id === "builtin-tool-sketch-render");
  await page.evaluate(async (template) => {
    const path = "/src/lib/templateLaunch.ts";
    const { launchTemplateInNewTab } = await import(path);
    launchTemplateInNewTab(template);
  }, template);
  const input = page.locator('.react-flow__node[data-id="sketch"]');
  const buffer = await sharp({ create: { width: 120, height: 160, channels: 3, background: "#eeeeee" } }).png().toBuffer();
  await input.getByLabel("本地上传", { exact: true }).setInputFiles({ name: "sketch.png", mimeType: "image/png", buffer });
  await expect(input.getByAltText("已上传图片")).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/lib/canvasLanding.ts";
    const store = "/src/store/flowStore.ts";
    const { requestCanvasLanding } = await import(path);
    const { useFlowStore } = await import(store);
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, nodeId: "sketch-optimization", fitView: false });
  });
  const node = page.locator('.react-flow__node[data-id="sketch-optimization"]');
  await node.getByRole("textbox", { name: "设计理念与修改要求" }).fill("衣身用羊毛，袖口改为罗纹");
  let count = 0;
  let output = "";
  await page.route(/\/api\/run-plan(?:\/|$)/, async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      expect(body.onlyNodeId).toBe("sketch-optimization");
      expect(body.includeDownstream).not.toBe(true);
      expect(body.nodes.find((node: {id: string}) => node.id === "sketch-optimization").data.prompt).toContain("罗纹");
      output = body.nodes.find((node: {id: string}) => node.id === "sketch").data.imageUrl;
      await route.fulfill({ json: { runId: "sketch-test-" + (++count) } });
    } else if (route.request().url().endsWith("/events")) {
      const events = [{ type: "node-status", nodeId: "sketch-optimization", status: count === 1 ? "success" : "error", ...(count === 1 ? { images: [output] } : { error: "测试生成失败" }) }, { type: "done" }];
      await route.fulfill({ contentType: "text/event-stream", body: events.map((event, index) => `id: ${index + 1}\ndata: ${JSON.stringify({ ...event, seq: index + 1 })}\n\n`).join("") });
    } else await route.fulfill({ json: { status: "running" } });
  });
  await node.getByRole("button", { name: "生成优化线稿" }).click();
  await expect(node.locator("img")).toHaveCount(1);
  expect(count).toBe(1);
  await node.getByRole("button", { name: "生成优化线稿" }).click();
  await expect(node).toContainText("测试生成失败");
  await expect(node.locator("img")).toHaveCount(1);
  expect(count).toBe(2);
  await page.screenshot({ path: `/tmp/neihe-sketch-optimize-${page.viewportSize()!.width}.png` });
});

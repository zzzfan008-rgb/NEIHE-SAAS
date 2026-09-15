import sharp from "sharp";
import { expect, test } from "./fixtures";

test("crop shapes export real pixels, preserve identity and undo", async ({ page }) => {
  await page.goto("/e2e/fixtures/node-geometry.html");
  const node = page.locator('.react-flow__node[data-id="preview-input"]');
  const original = await node.getByAltText("已上传图片").getAttribute("src");
  await node.getByRole("button", { name: "裁切", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "裁切图片" });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await dialog.getByRole("button", { name: "圆形", exact: true }).click();
  const selection = dialog.getByTestId("crop-selection");
  const before = await selection.boundingBox();
  expect(Math.abs(before!.width - before!.height)).toBeLessThan(1);
  const corner = dialog.getByRole("button", { name: "调整裁切右下角" });
  const handle = await corner.boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle!.x - 30, handle!.y - 30, { steps: 5 });
  await page.mouse.up();
  expect((await selection.boundingBox())!.width).toBeLessThan(before!.width);
  let cropped = "";
  await page.route("**/api/assets", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    cropped = route.request().postDataJSON().image;
    const meta = await sharp(Buffer.from(cropped.split(",")[1], "base64")).metadata();
    await route.fulfill({ json: { normalized: true, url: cropped, id: "crop", width: meta.width, height: meta.height, mimeType: "image/png", byteLength: 1000 } });
  });
  await dialog.getByRole("button", { name: "确认裁切" }).click();
  await expect(dialog).toBeHidden();
  expect(cropped).toMatch(/^data:image\/png;base64,/);
  const { data, info } = await sharp(Buffer.from(cropped.split(",")[1], "base64")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(info.width).toBe(info.height);
  expect(data[3]).toBe(0);
  expect(data[(Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4 + 3]).toBe(255);
  await expect(node.getByAltText("已上传图片")).toHaveAttribute("src", cropped);
  await expect(node).toContainText("主穿搭图（必需）");
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    useFlowStore.temporal.getState().undo();
  });
  await expect(node.getByAltText("已上传图片")).toHaveAttribute("src", original!);
});

test("crop supports free rectangle, ellipse, keyboard, reset and cancel", async ({ page }) => {
  await page.goto("/e2e/fixtures/node-geometry.html");
  const node = page.locator('.react-flow__node[data-id="preview-input"]');
  const trigger = node.getByRole("button", { name: "裁切", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "裁切图片" });
  await dialog.evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished)); });
  const selection = dialog.getByTestId("crop-selection");
  const initial = await selection.boundingBox();
  await dialog.getByRole("button", { name: "1:1", exact: true }).click();
  const square = await selection.boundingBox();
  expect(Math.abs(square!.width - square!.height)).toBeLessThan(1);
  await dialog.getByRole("button", { name: "椭圆", exact: true }).click();
  await dialog.getByRole("spinbutton", { name: "裁切宽度" }).fill("180");
  await dialog.getByRole("spinbutton", { name: "裁切高度" }).fill("100");
  await selection.focus();
  const before = await selection.boundingBox();
  await page.keyboard.press("ArrowRight");
  expect((await selection.boundingBox())!.x).toBeGreaterThan(before!.x);
  await dialog.getByRole("button", { name: "重置", exact: true }).click();
  const reset = await selection.boundingBox();
  expect(reset!.width).toBeCloseTo(initial!.width, 0);
  await page.screenshot({ path: `/tmp/neihe-image-crop-${page.viewportSize()!.width}.png` });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("real asset save retains ellipse transparency and rectangle pixels", async ({ page }) => {
  await page.goto("/e2e/fixtures/node-geometry.html");
  const node = page.locator('.react-flow__node[data-id="preview-input"]');
  for (const shape of ["矩形", "椭圆"]) {
    const source = await node.getByAltText("已上传图片").getAttribute("src");
    const original = await (await page.request.get(source!)).body();
    await node.getByRole("button", { name: "裁切", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "裁切图片" });
    await dialog.getByRole("button", { name: shape, exact: true }).click();
    await dialog.getByRole("spinbutton", { name: "裁切左边距" }).fill("10");
    await dialog.getByRole("spinbutton", { name: "裁切上边距" }).fill("10");
    await dialog.getByRole("spinbutton", { name: "裁切宽度" }).fill(shape === "矩形" ? "200" : "100");
    await dialog.getByRole("spinbutton", { name: "裁切高度" }).fill(shape === "矩形" ? "150" : "70");
    const request = page.waitForRequest((req) => req.url().endsWith("/api/assets") && req.method() === "POST");
    await dialog.getByRole("button", { name: "确认裁切" }).click();
    const exported = Buffer.from((await request).postDataJSON().image.split(",")[1], "base64");
    const { data, info } = await sharp(exported).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (shape === "矩形") {
      expect(info.width).toBe(200); expect(info.height).toBe(150);
      const expected = await sharp(original).extract({ left: 10, top: 10, width: 200, height: 150 }).ensureAlpha().raw().toBuffer();
      // Browser/WebP decoding may differ by one channel value from sharp.
      expect(data.every((value, index) => Math.abs(value - expected[index]) <= 2)).toBe(true);
    } else {
      expect(info.width).toBe(100); expect(info.height).toBe(70); expect(data[3]).toBe(0);
    }
    await expect(dialog).toBeHidden();
    const url = await node.getByAltText("已上传图片").getAttribute("src");
    expect(url).toMatch(/^\/api\/files\//);
    const saved = await sharp(await (await page.request.get(url!)).body()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(saved.info.width).toBe(info.width);
    expect(saved.info.height).toBe(info.height);
    if (shape === "椭圆") expect(saved.data[3]).toBe(0);
  }
});

test("failed save retries; cancelled response cannot close a new crop session", async ({ page }) => {
  await page.goto("/e2e/fixtures/node-geometry.html");
  const node = page.locator('.react-flow__node[data-id="preview-input"]');
  const original = await node.getByAltText("已上传图片").getAttribute("src");
  let fail = true;
  let release: (() => void) | undefined;
  await page.route("**/api/assets", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    if (fail) return route.fulfill({ status: 500, json: { error: "测试保存失败" } });
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ json: { normalized: true, id: "late", url: "/api/files/late.png", mimeType: "image/png", width: 100, height: 100, byteLength: 100 } });
  });
  const trigger = node.getByRole("button", { name: "裁切", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "裁切图片" });
  await dialog.getByRole("button", { name: "确认裁切" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("测试保存失败");
  await expect(node.getByAltText("已上传图片")).toHaveAttribute("src", original!);
  fail = false;
  await dialog.getByRole("button", { name: "确认裁切" }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await trigger.click();
  const response = page.waitForResponse((response) => response.url().endsWith("/api/assets") && response.status() === 200);
  release!();
  await response;
  await expect(dialog).toBeVisible();
  await expect(node.getByAltText("已上传图片")).toHaveAttribute("src", original!);
});

test("late crop export never applies to a newly opened editor", async ({ page }) => {
  await page.goto("/e2e/fixtures/node-geometry.html");
  const node = page.locator('.react-flow__node[data-id="preview-input"]');
  const original = await node.getByAltText("已上传图片").getAttribute("src");
  await page.evaluate(() => {
    const real = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function(callback, ...args) {
      real.call(this, (blob) => { (window as unknown as { releaseCrop: () => void }).releaseCrop = () => callback(blob); }, ...args);
    };
  });
  let writes = 0;
  await page.route("**/api/assets", async (route) => { writes++; await route.fulfill({ status: 500, json: { error: "unexpected" } }); });
  const trigger = node.getByRole("button", { name: "裁切", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "裁切图片" });
  await dialog.getByRole("button", { name: "确认裁切" }).click();
  await page.waitForFunction(() => "releaseCrop" in window);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await trigger.click();
  await page.evaluate(() => (window as unknown as { releaseCrop: () => void }).releaseCrop());
  await page.waitForTimeout(250);
  expect(writes).toBe(0);
  await expect(dialog).toBeVisible();
  await expect(node.getByAltText("已上传图片")).toHaveAttribute("src", original!);
});

test("replaced document rejects pending crop without changing the replacement", async ({ page }) => {
  await page.goto("/e2e/fixtures/node-geometry.html");
  const node = page.locator('.react-flow__node[data-id="preview-input"]');
  let release: (() => void) | undefined;
  await page.route("**/api/assets", async (route) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ json: { normalized: true, id: "late", url: "/api/files/late.png", mimeType: "image/png", width: 100, height: 100, byteLength: 100 } });
  });
  await node.getByRole("button", { name: "裁切", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "裁切图片" });
  await dialog.getByRole("button", { name: "确认裁切" }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveNodes } = await import(path);
    const nodes = selectActiveNodes(useFlowStore.getState()).map((node: { data: object }) => ({ ...node, data: { ...node.data, label: "新文档图片" } }));
    useFlowStore.getState().loadFlow({ projectName: "替换后的项目", nodes, edges: [] });
  });
  await expect(dialog).toBeHidden();
  const response = page.waitForResponse((response) => response.url().endsWith("/api/assets"));
  release!();
  await response;
  await expect(node.getByAltText("已上传图片")).toHaveAttribute("src", "/assets/try-on-styles/soft-editorial.webp");
  await expect(node).toContainText("新文档图片");
});

test("drawing and all corner handles stay within original image; original ratio is preserved", async ({ page }) => {
  await page.goto("/e2e/fixtures/node-geometry.html");
  await page.locator('.react-flow__node[data-id="preview-input"]').getByRole("button", { name: "裁切", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "裁切图片" });
  const image = dialog.getByAltText("裁切原图");
  const bounds = (await image.boundingBox())!;
  await dialog.getByRole("button", { name: "原图比例", exact: true }).click();
  await page.mouse.move(bounds.x + 5, bounds.y + 5);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .7, bounds.y + bounds.height * .7, { steps: 5 });
  await page.mouse.up();
  const selection = dialog.getByTestId("crop-selection");
  let rect = (await selection.boundingBox())!;
  expect(rect.x).toBeCloseTo(bounds.x + 5, 0);
  expect(rect.width / rect.height).toBeCloseTo(bounds.width / bounds.height, 2);
  for (const corner of ["左上", "右上", "右下", "左下"]) {
    const handle = dialog.getByRole("button", { name: `调整裁切${corner}角` });
    await handle.focus();
    await page.keyboard.press("Shift+ArrowRight");
    rect = (await selection.boundingBox())!;
    expect(rect.width / rect.height).toBeCloseTo(bounds.width / bounds.height, 2);
    expect(rect.x).toBeGreaterThanOrEqual(bounds.x - 1);
    expect(rect.y).toBeGreaterThanOrEqual(bounds.y - 1);
    expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    expect(rect.y + rect.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
  }
});

test("workbench crop blocks canvas shortcuts and updates node geometry without losing connections", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开项目中心" })).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const landing = "/src/lib/canvasLanding.ts";
    const { useFlowStore } = await import(path);
    const { requestCanvasLanding } = await import(landing);
    useFlowStore.getState().loadFlow({ projectName: "裁切工作台验收", nodes: [
      { id: "crop-input", type: "image-input", position: { x: 0, y: 0 }, data: { kind: "image-input", label: "裁切参考图", imageUrl: "/assets/try-on-styles/soft-editorial.webp", status: "success" } },
      { id: "crop-target", type: "ai-modify", position: { x: 480, y: 0 }, data: { kind: "ai-modify", label: "下游节点", prompt: "", status: "idle" } },
    ], edges: [{ id: "crop-connection", source: "crop-input", sourceHandle: "image", target: "crop-target", targetHandle: "references" }] });
    useFlowStore.getState().setSelectedNodeIds(["crop-input"]);
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, fitView: true });
  });
  const node = page.locator('.react-flow__node[data-id="crop-input"]');
  await node.getByRole("button", { name: "裁切", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "裁切图片" });
  await dialog.getByRole("button", { name: "圆形", exact: true }).click();
  await dialog.getByTestId("crop-selection").focus();
  await page.keyboard.press("Backspace");
  await expect(node).toHaveCount(1);
  await dialog.getByRole("button", { name: "确认裁切" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => {
    const box = await node.locator(".gc-node-card").boundingBox();
    return Math.abs(box!.width - box!.height);
  }).toBeLessThan(1);
  await expect(node).toContainText("裁切参考图");
  const edges = await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveEdges } = await import(path);
    return selectActiveEdges(useFlowStore.getState());
  });
  expect(edges.map((edge: { id: string }) => edge.id)).toContain("crop-connection");
});

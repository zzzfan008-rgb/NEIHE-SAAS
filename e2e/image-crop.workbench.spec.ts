import sharp from "sharp";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const fixture = "/e2e/fixtures/node-geometry.html";
const source = "/assets/try-on-styles/soft-editorial.webp";
const inputNode = (page: Page) => page.locator('.react-flow__node[data-id="preview-input"]');

async function openFixture(page: Page) {
  await page.goto(fixture);
  await expect(inputNode(page)).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveNodes } = await import(path);
    // The geometry demo's lower empty node overlaps the upload action bar.
    const nodes = selectActiveNodes(useFlowStore.getState()).filter((node: { id: string }) => node.id === "preview-input");
    useFlowStore.getState().loadFlow({ projectName: "裁切交互验收", nodes, edges: [] });
    useFlowStore.getState().setSelectedNodeIds(["preview-input"]);
  });
}

async function draw(page: Page, surface: Locator, from = { x: .15, y: .2 }, to = { x: .75, y: .7 }) {
  await expect.poll(() => surface.locator("img").first().evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  const box = (await surface.boundingBox())!;
  await page.mouse.move(box.x + box.width * from.x, box.y + box.height * from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to.x, box.y + box.height * to.y, { steps: 6 });
  await page.mouse.up();
  await expect(surface.getByTestId("crop-selection")).toBeVisible();
}
async function openCrop(page: Page, node = inputNode(page)) {
  await node.getByRole("button", { name: "裁切", exact: true }).click();
  const surface = node.getByTestId("crop-surface");
  await expect(surface).toBeVisible();
  return surface;
}

test("inline crop shows grayscale outside and original color inside across canvas zooms", async ({ page }, testInfo) => {
  const png = await sharp({ create: { width: 400, height: 600, channels: 3, background: "#D07830" } }).png().toBuffer();
  await page.route("**" + source, route => route.fulfill({ contentType: "image/png", body: png }));
  await openFixture(page);
  const node = inputNode(page);
  const upload = (await node.getByLabel("重新上传", { exact: true }).boundingBox())!;
  const trigger = (await node.getByRole("button", { name: "裁切", exact: true }).boundingBox())!;
  const library = (await node.getByRole("button", { name: "素材库", exact: true }).boundingBox())!;
  expect(upload.x).toBeLessThan(trigger.x);
  expect(trigger.x).toBeLessThan(library.x);
  for (const delta of [250, -350]) {
    const previous = (await node.boundingBox())!.width;
    await page.mouse.move(500, 110);
    await page.mouse.wheel(0, delta);
    await expect.poll(async () => Math.abs((await node.boundingBox())!.width - previous)).toBeGreaterThan(5);
    await page.waitForTimeout(350); // Wheel zoom must settle before measuring pointer coordinates.
    const before = (await node.boundingBox())!;
    const surface = await openCrop(page);
    await expect(page.getByRole("dialog", { name: "裁切图片" })).toHaveCount(0);
    await expect(node.locator(".gc-image-resize-corner")).toHaveCount(0);
    await expect(surface.getByRole("button", { name: "确认裁切" })).toBeDisabled();
    await draw(page, surface);
    const box = (await surface.boundingBox())!;
    const rect = (await surface.getByTestId("crop-selection").boundingBox())!;
    expect(rect.x).toBeCloseTo(box.x + box.width * .15, 0);
    expect(rect.y).toBeCloseTo(box.y + box.height * .2, 0);
    expect(rect.width).toBeCloseTo(box.width * .6, 0);
    expect(rect.height).toBeCloseTo(box.height * .5, 0);
    expect((await node.boundingBox())!.x).toBeCloseTo(before.x, 0);
    expect((await node.boundingBox())!.y).toBeCloseTo(before.y, 0);
    const { data, info } = await sharp(await surface.screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
      const index = (Math.floor(y * info.height) * info.width + Math.floor(x * info.width)) * 3;
      return Array.from(data.subarray(index, index + 3));
    };
    const outside = pixel(.85, .5);
    expect(Math.max(...outside) - Math.min(...outside)).toBeLessThanOrEqual(2);
    expect(pixel(.45, .4)).toEqual([208, 120, 48]);
    await page.screenshot({ path: testInfo.outputPath("inline-crop-" + delta + ".png") });
    if (delta > 0) {
      await surface.focus();
      await page.keyboard.press("Escape");
    } else {
      await surface.getByRole("button", { name: "取消裁切" }).focus();
      await page.keyboard.press("Space");
    }
    await expect(surface).toHaveCount(0);
    await expect(node.getByRole("button", { name: "裁切", exact: true })).toBeFocused();
    await expect(node.getByAltText("已上传图片")).toHaveAttribute("src", source);
  }
});

test("rectangle crop saves original pixels through real assets and preserves title and undo", async ({ page }) => {
  const original = await sharp({ create: { width: 400, height: 600, channels: 3, background: "#D07830" } })
    .composite([{ input: await sharp({ create: { width: 200, height: 600, channels: 3, background: "#3258A0" } }).png().toBuffer(), left: 200, top: 0 }]).png().toBuffer();
  await page.route("**" + source, route => route.fulfill({ contentType: "image/png", body: original }));
  await openFixture(page);
  const node = inputNode(page), surface = await openCrop(page);
  await draw(page, surface);
  const request = page.waitForRequest(req => req.url().endsWith("/api/assets") && req.method() === "POST");
  await surface.getByRole("button", { name: "确认裁切" }).click();
  const exported = Buffer.from((await request).postDataJSON().image.split(",")[1], "base64");
  const { data, info } = await sharp(exported).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(Math.abs(info.width - 240)).toBeLessThanOrEqual(2);
  expect(Math.abs(info.height - 300)).toBeLessThanOrEqual(2);
  const leftPixel = (Math.floor(info.height / 2) * info.width + 10) * 3;
  const rightPixel = (Math.floor(info.height / 2) * info.width + info.width - 10) * 3;
  expect(Array.from(data.subarray(leftPixel, leftPixel + 3))).toEqual([208, 120, 48]);
  expect(Array.from(data.subarray(rightPixel, rightPixel + 3))).toEqual([50, 88, 160]);
  await expect(surface).toHaveCount(0);
  const url = await node.getByAltText("已上传图片").getAttribute("src");
  expect(url).toMatch(/^\/api\/files\//);
  const saved = await sharp(await (await page.request.get(url!)).body()).metadata();
  expect(saved.width).toBe(info.width); expect(saved.height).toBe(info.height);
  await expect(node).toContainText("主穿搭图（必需）");
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    useFlowStore.temporal.getState().undo();
  });
  await expect(node.getByAltText("已上传图片")).toHaveAttribute("src", source);
});

test("reverse drawing, dragging and eight keyboard resize handles stay in bounds", async ({ page }, testInfo) => {
  await openFixture(page);
  const surface = await openCrop(page);
  await draw(page, surface, { x: .8, y: .8 }, { x: .2, y: .2 });
  await page.screenshot({ path: testInfo.outputPath("image-node-inline-crop.png") });
  const box = (await surface.boundingBox())!, selection = surface.getByTestId("crop-selection");
  expect((await selection.boundingBox())!.x).toBeCloseTo(box.x + box.width * .2, 0);
  const right = (await surface.getByRole("button", { name: "调整裁切右边", exact: true }).boundingBox())!;
  await page.mouse.move(right.x + right.width / 2, right.y + right.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 80, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  let rect = (await selection.boundingBox())!;
  expect(rect.x + rect.width).toBeCloseTo(box.x + box.width, 0);
  for (const label of ["左上角", "上边", "右上角", "右边", "右下角", "下边", "左下角", "左边"]) {
    await surface.getByRole("button", { name: "调整裁切" + label, exact: true }).focus();
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    rect = (await selection.boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(rect.y).toBeGreaterThanOrEqual(box.y - 1);
    expect(rect.x + rect.width).toBeLessThanOrEqual(box.x + box.width + 1);
    expect(rect.y + rect.height).toBeLessThanOrEqual(box.y + box.height + 1);
  }
  await selection.focus();
  const before = (await selection.boundingBox())!;
  await page.keyboard.press("ArrowLeft");
  expect((await selection.boundingBox())!.x).toBeLessThan(before.x);
  const center = (await selection.boundingBox())!;
  await page.mouse.move(center.x + center.width / 2, center.y + center.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 100, box.y - 100, { steps: 6 });
  await page.mouse.up();
  rect = (await selection.boundingBox())!;
  expect(rect.x).toBeCloseTo(box.x, 0); expect(rect.y).toBeCloseTo(box.y, 0);
  const beforeRightClick = await selection.boundingBox();
  await page.mouse.click(box.x + box.width * .9, box.y + box.height * .9, { button: "right" });
  expect(await selection.boundingBox()).toEqual(beforeRightClick);
});

test("failed save retries; cancelled response cannot close a new crop session", async ({ page }) => {
  await openFixture(page);
  let fail = true, release: (() => void) | undefined;
  await page.route("**/api/assets", async route => {
    if (route.request().method() !== "POST") return route.continue();
    if (fail) return route.fulfill({ status: 500, json: { error: "测试保存失败" } });
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: { normalized: true, id: "late", url: "/api/files/late.png", mimeType: "image/png", width: 100, height: 100, byteLength: 100 } });
  });
  let surface = await openCrop(page);
  await draw(page, surface);
  await surface.getByRole("button", { name: "确认裁切" }).click();
  await expect(inputNode(page).getByRole("alert")).toHaveText("测试保存失败");
  fail = false;
  await surface.getByRole("button", { name: "确认裁切" }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await surface.getByRole("button", { name: "取消裁切" }).click();
  surface = await openCrop(page);
  const response = page.waitForResponse(res => res.url().endsWith("/api/assets") && res.status() === 200);
  release!(); await response;
  await expect(surface).toBeVisible();
  await expect(inputNode(page).getByAltText("已上传图片")).toHaveAttribute("src", source);
});

test("late crop export never applies to a newly opened editor", async ({ page }) => {
  await openFixture(page);
  await page.evaluate(() => {
    const real = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function(callback, ...args) {
      real.call(this, blob => { (window as unknown as { releaseCrop: () => void }).releaseCrop = () => callback(blob); }, ...args);
    };
  });
  let writes = 0;
  await page.route("**/api/assets", async route => { writes++; await route.fulfill({ status: 500, json: { error: "unexpected" } }); });
  let surface = await openCrop(page);
  await draw(page, surface);
  await surface.getByRole("button", { name: "确认裁切" }).click();
  await page.waitForFunction(() => "releaseCrop" in window);
  await surface.getByRole("button", { name: "取消裁切" }).click();
  surface = await openCrop(page);
  await page.evaluate(() => (window as unknown as { releaseCrop: () => void }).releaseCrop());
  await page.waitForTimeout(250);
  expect(writes).toBe(0); await expect(surface).toBeVisible();
  await expect(inputNode(page).getByAltText("已上传图片")).toHaveAttribute("src", source);
});

test("replaced document rejects pending crop without changing the replacement", async ({ page }) => {
  await openFixture(page);
  let release: (() => void) | undefined;
  await page.route("**/api/assets", async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: { normalized: true, id: "late", url: "/api/files/late.png", mimeType: "image/png", width: 100, height: 100, byteLength: 100 } });
  });
  const surface = await openCrop(page);
  await draw(page, surface);
  await surface.getByRole("button", { name: "确认裁切" }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveNodes } = await import(path);
    const nodes = selectActiveNodes(useFlowStore.getState()).map((node: { data: object }) => ({ ...node, data: { ...node.data, label: "新文档图片" } }));
    useFlowStore.getState().loadFlow({ projectName: "替换后的项目", nodes, edges: [] });
  });
  await expect(surface).toHaveCount(0);
  const response = page.waitForResponse(res => res.url().endsWith("/api/assets"));
  release!(); await response;
  await expect(inputNode(page).getByAltText("已上传图片")).toHaveAttribute("src", source);
  await expect(inputNode(page)).toContainText("新文档图片");
});

test("workbench crop blocks canvas shortcuts, saves with Enter and preserves connections", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开项目中心" })).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts", landing = "/src/lib/canvasLanding.ts";
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
  const surface = await openCrop(page, node);
  await draw(page, surface);
  await surface.getByTestId("crop-selection").focus();
  await page.keyboard.press("Backspace");
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+d");
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(surface).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(surface).toHaveCount(0);
  await expect(node.getByAltText("已上传图片")).not.toHaveAttribute("src", source);
  await expect(node).toContainText("裁切参考图");
  const edges = await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveEdges } = await import(path);
    return selectActiveEdges(useFlowStore.getState());
  });
  expect(edges.map((edge: { id: string }) => edge.id)).toContain("crop-connection");
});

import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function openResults(page: Page, propertiesFirst = false) {
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n7sAAAAASUVORK5CYII=";
  const records = [1, 2].map((index) => ({
    id: `escape-result-${index}`, runId: `escape-run-${index}`, nodeId: `escape-node-${index}`,
    nodeLabel: `Esc 方案 ${index}`, kind: "text-to-image", status: "success", image,
    startedAt: 1760000000000, finishedAt: 1760000001000,
  }));
  await page.route("**/api/history*", (route) => route.fulfill({ json: {
    records: new URL(route.request().url()).pathname.endsWith("/active") ? [] : records,
    nextCursor: null, hasMore: false,
  } }));
  await page.goto("/");
  if (propertiesFirst) await page.getByRole("button", { name: "属性", exact: true }).click();
  const trigger = page.getByRole("button", { name: "结果 / 记录", exact: true });
  await trigger.click();
  const results = page.getByRole("region", { name: "最近生成", exact: true });
  await expect(results.getByRole("article")).toHaveCount(2);
  return { trigger, results };
}

test("Escape closes comparison and results without changing desktop geometry or document", async ({ page }) => {
  const { trigger, results } = await openResults(page);
  const canvas = page.getByRole("application", { name: "工作流画布" });
  const canvasBefore = await canvas.boundingBox();
  const readDocument = () => page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveDocument } = await import(path);
    const snapshotPath = "/src/lib/documentSnapshot.ts";
    const { createDocumentSnapshot } = await import(snapshotPath);
    const document = selectActiveDocument(useFlowStore.getState());
    return createDocumentSnapshot(document);
  });
  const documentBefore = await readDocument();
  for (const card of await results.getByRole("article").all()) {
    await card.hover();
    await card.getByRole("button", { name: /^加入对比 / }).click();
  }
  await results.getByRole("button", { name: "对比 2 张" }).click();
  const comparison = page.getByRole("dialog", { name: "结果对比" });
  await expect(comparison).toBeVisible();
  const viewport = page.viewportSize()!;
  expect(await comparison.boundingBox()).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
  await page.keyboard.press("Escape");
  await expect(comparison).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
  expect(await canvas.boundingBox()).toEqual(canvasBefore);
  expect(await readDocument()).toEqual(documentBefore);
  await trigger.click();
  await expect(results.getByRole("button", { name: /^加入对比 / })).toHaveCount(2);
  await expect(results.getByRole("button", { name: "对比 2 张" })).toHaveCount(0);
});

for (const propertiesFirst of [false, true]) {
  test(`Escape restores the results trigger and leaves properties open (${propertiesFirst ? "properties first" : "results first"})`, async ({ page }) => {
    const { trigger, results } = await openResults(page, propertiesFirst);
    const properties = page.getByRole("button", { name: "属性", exact: true });
    if (!propertiesFirst) await properties.click();
    await expect(properties).toHaveAttribute("aria-expanded", "true");
    const dock = page.locator("#workbench-inspector-panel");
    const expectedWidth = Math.max(360, Math.min(440, page.viewportSize()!.width * 0.3125));
    await expect.poll(async () => (await dock.boundingBox())?.width).toBe(expectedWidth);
    const dockBefore = await dock.boundingBox();
    await results.getByRole("button", { name: "查看生成记录：Esc 方案 1" }).focus();
    await page.keyboard.press("Escape");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();
    await expect(properties).toHaveAttribute("aria-expanded", "true");
    expect(await dock.boundingBox()).toEqual(dockBefore);
  });
}

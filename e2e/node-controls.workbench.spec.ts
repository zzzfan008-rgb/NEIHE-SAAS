import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";

declare global {
  interface Window {
    nodeControls: {
      viewport: (value: { x: number; y: number; zoom: number }) => Promise<boolean>;
      keys: string[];
      data: () => { label: string; prompt: string; modelId: string };
      undo: () => void;
      redo: () => void;
    };
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto("/e2e/fixtures/node-controls.html");
  await expect(page.getByRole("textbox", { name: "创作想法", exact: true })).toBeVisible();
  await page.waitForFunction(() => Boolean(window.nodeControls.viewport));
});

async function anchored(trigger: Locator, popup: Locator, side: "top" | "bottom" = "bottom") {
  await expect.poll(async () => {
    const t = await trigger.boundingBox();
    const p = await popup.boundingBox();
    if (!t || !p) return 1000;
    const gap = side === "bottom" ? p.y - t.y - t.height : t.y - p.y - p.height;
    return Math.max(Math.abs(p.x - t.x), Math.abs(gap - 4));
  }).toBeLessThan(2);
}

for (const zoom of [0.54, 0.68, 1]) {
  test(`dropdown stays anchored at ${zoom * 100}% and tracks canvas transforms`, async ({ page }, testInfo) => {
    await page.evaluate(zoom => window.nodeControls.viewport({ x: 140, y: 100, zoom }), zoom);
    const trigger = page.getByRole("combobox", { name: "图像模型", exact: true });
    await trigger.click();
    const popup = page.locator('[data-slot="select-content"]');
    await anchored(trigger, popup);
    // At low zoom the trigger is narrower than the unscaled option labels.
    for (const option of await popup.getByRole("option").all()) {
      expect(await option.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    }
    await testInfo.attach(`dropdown-${zoom}`, { body: await page.screenshot(), contentType: "image/png" });
    await page.evaluate(zoom => window.nodeControls.viewport({ x: 220, y: 130, zoom: zoom * 0.9 }), zoom);
    await anchored(trigger, popup);
    await page.getByRole("option", { name: "Gemini 3 Pro Image", exact: true }).click();
    await expect(trigger).toContainText("Gemini 3 Pro Image");
    await expect(trigger).toBeFocused();
    await page.evaluate(() => window.nodeControls.undo());
    await expect(trigger).toContainText("Gemini 3.1 Flash Image");
  });
}

test("dropdown flips above its trigger near the viewport bottom and supports keyboard selection", async ({ page }) => {
  const trigger = page.getByRole("combobox", { name: "输出尺寸", exact: true });
  const box = (await trigger.boundingBox())!;
  await page.evaluate(y => window.nodeControls.viewport({ x: 140, y, zoom: 1 }),
    100 + page.viewportSize()!.height - box.y - box.height - 12);
  await trigger.focus();
  await trigger.press("ArrowDown");
  const popup = page.locator('[data-slot="select-content"]');
  await anchored(trigger, popup, "top");
  await page.keyboard.press("Escape");
  await expect(popup).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

async function composingKey(input: Locator, key: string, isComposing = true, keyCode = 229) {
  await input.dispatchEvent("keydown", { key, code: key, keyCode, isComposing, bubbles: true });
}

test("Chinese composition retains text, shields candidate keys and preserves undo/redo", async ({ page }) => {
  const input = page.getByRole("textbox", { name: "创作想法", exact: true });
  await input.focus();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "zhongwen", selectionStart: 8, selectionEnd: 8 });
  await expect(input).toHaveValue("zhongwen");
  for (const key of [" ", "Enter", "Escape", "ArrowDown"]) await composingKey(input, key);
  expect(await page.evaluate(() => window.nodeControls.keys)).toEqual([]);
  await cdp.send("Input.insertText", { text: "中文" });
  await input.dispatchEvent("keyup", { key: "Enter", bubbles: true });
  await expect(input).toHaveValue("中文");
  await input.press("End");
  await input.press("Enter");
  await input.pressSequentially("test");
  await input.blur();
  await expect(input).toHaveValue("中文\ntest");
  expect(await page.evaluate(() => window.nodeControls.data().prompt)).toBe("中文\ntest");
  await page.evaluate(() => window.nodeControls.undo());
  await expect(input).toHaveValue("中文\n");
  await page.evaluate(() => window.nodeControls.redo());
  await expect(input).toHaveValue("中文\ntest");
  await cdp.detach();
});

test("node rename does not cancel or commit an active IME candidate", async ({ page }) => {
  await page.getByTitle("双击改名", { exact: true }).dblclick();
  const input = page.getByRole("textbox", { name: "节点名称", exact: true });
  await input.fill("");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "mingcheng", selectionStart: 8, selectionEnd: 8 });
  // Some browsers report false isComposing with keyCode 229 at confirmation.
  await composingKey(input, "Enter", false);
  await expect(input).toBeVisible();
  await composingKey(input, "Escape");
  await expect(input).toBeVisible();
  await cdp.send("Input.insertText", { text: "中文节点" });
  await composingKey(input, "Enter", false);
  await expect(input).toBeVisible();
  await input.press("Enter");
  await expect(input).not.toBeVisible();
  await expect(page.getByTitle("双击改名", { exact: true })).toHaveText("中文节点");
  await page.evaluate(() => window.nodeControls.undo());
  await expect(page.getByTitle("双击改名", { exact: true })).toHaveText("多图编辑换装");
  await cdp.detach();
});

test("renaming still trims and commits as one undo step, and Escape cancels ordinary input", async ({ page }) => {
  const title = page.getByTitle("双击改名", { exact: true });
  await title.dblclick();
  const input = page.getByRole("textbox", { name: "节点名称", exact: true });
  await input.fill("  中文名称  ");
  await input.press("Enter");
  await expect(title).toHaveText("中文名称");
  await page.evaluate(() => window.nodeControls.undo());
  await expect(title).toHaveText("多图编辑换装");
  await title.dblclick();
  await input.fill("不要保留");
  await input.press("Escape");
  await expect(title).toHaveText("多图编辑换装");
});

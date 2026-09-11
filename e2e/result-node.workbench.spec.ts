import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function seedResult(page: Page, multiple = false) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开项目中心" })).toBeVisible();
  await page.evaluate(async (multi) => {
    const storePath = "/src/store/flowStore.ts";
    const landingPath = "/src/lib/canvasLanding.ts";
    const { useFlowStore } = await import(storePath);
    const { requestCanvasLanding } = await import(landingPath);
    const image = `${location.origin}/assets/try-on-styles/soft-editorial.webp`;
    const second = `${location.origin}/assets/try-on-styles/commerce.webp`;
    useFlowStore.getState().loadFlow({ projectName: "结果备注验收", markDirty: true, nodes: [
      { id: "result-note", type: "result", position: { x: 0, y: 0 }, data: {
        kind: "result", label: "图3 · 生成结果", status: "idle", images: multi ? [image, second] : [image], note: "原备注",
      } },
    ], edges: [] });
    useFlowStore.setState({ recentResults: [image, second].map((url, index) => ({
      id: `note-record-${index}`, nodeId: "result-note", nodeLabel: `方案 ${index + 1}`, kind: "result", status: "success", image: url, startedAt: Date.now(),
    })) });
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, fitView: true });
  }, multiple);
  return page.locator('.react-flow__node[data-id="result-note"]');
}

async function noteValue(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveNodes } = await import(path);
    return selectActiveNodes(useFlowStore.getState()).find((n: { id: string }) => n.id === "result-note")?.data.note;
  });
}

test("result title stays centered when production CSS folds the translate reset", async ({ page }) => {
  const node = await seedResult(page);
  await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSStyleRule && rule.selectorText === ".gc-result-node .gc-node-floating-title" && rule.style.translate === "none") {
          rule.style.removeProperty("translate");
          rule.style.transform = "translate(0)";
        }
      }
    }
  });
  const offset = await node.evaluate((element) => {
    const title = element.querySelector(".gc-node-floating-title")!.getBoundingClientRect();
    const card = element.querySelector(".gc-node-card")!.getBoundingClientRect();
    return Math.abs((title.left + title.right - card.left - card.right) / 2);
  });
  expect(offset).toBeLessThan(1);
});

test("result node reference layout and explicit note save persist after reload", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const node = await seedResult(page);
  await expect(node.getByAltText("图3 · 生成结果")).toBeVisible();
  await expect(node.getByRole("textbox")).toHaveCount(0);
  const footer = node.locator(".gc-result-footer");
  await expect(footer.getByRole("button")).toHaveText(["查看", "对比", "下载", "备注"]);
  const frame = await node.boundingBox();
  expect(frame!.x).toBeGreaterThanOrEqual(0);
  expect(frame!.x + frame!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  const geometry = await node.evaluate((element) => {
    const image = element.querySelector(".gc-result-image img") as HTMLImageElement;
    const title = element.querySelector(".gc-node-floating-title")!.getBoundingClientRect();
    const card = element.querySelector(".gc-node-card")!.getBoundingClientRect();
    const body = element.querySelector(".gc-node-body")!;
    const media = element.querySelector(".gc-result-image")!.getBoundingClientRect();
    return { fit: getComputedStyle(image).objectFit, titleAbove: title.bottom <= card.top,
      centerOffset: Math.abs((title.left + title.right - card.left - card.right) / 2),
      topPadding: getComputedStyle(body).paddingTop,
      mediaGap: media.top - body.getBoundingClientRect().top,
      buttons: [...element.querySelectorAll(".gc-result-footer button")].map((button) => ({ width: button.getBoundingClientRect().width, top: button.getBoundingClientRect().top })),
    };
  });
  expect(geometry.fit).toBe("contain");
  expect(geometry.titleAbove).toBe(true);
  expect(geometry.centerOffset).toBeLessThan(1);
  expect(geometry.topPadding).toBe("8px");
  expect(geometry.mediaGap).toBeCloseTo(8, 0);
  await expect(node.locator(".gc-result-status")).toHaveCount(0);
  await expect(node.locator(".gc-node-body .gc-result-more")).toHaveCount(0);
  expect(Math.max(...geometry.buttons.map((b) => b.width)) - Math.min(...geometry.buttons.map((b) => b.width))).toBeLessThan(1);
  expect(new Set(geometry.buttons.map((b) => b.top)).size).toBe(1);
  await page.mouse.move(0, 0);
  await node.screenshot({ path: testInfo.outputPath("result-node.png") });

  const trigger = node.getByRole("button", { name: "备注", exact: true });
  await trigger.focus();
  await trigger.press("Enter");
  const dialog = page.getByRole("dialog", { name: "结果备注" });
  const input = dialog.getByRole("textbox", { name: "备注内容" });
  await expect(input).toHaveValue("原备注");
  await input.fill("未保存草稿");
  expect(await noteValue(page)).toBe("原备注");
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(input).toHaveValue("原备注");
  await input.fill("面料确认\n第二版待调整袖口");
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await expect(dialog).toHaveCSS("opacity", "1");
  await page.screenshot({ path: testInfo.outputPath("result-note-dialog.png") });
  await dialog.getByRole("button", { name: "确定保存" }).click();
  await expect(dialog).toBeHidden();
  expect(await noteValue(page)).toBe("面料确认\n第二版待调整袖口");
  await page.reload();
  await node.getByRole("button", { name: "备注", exact: true }).click();
  await expect(input).toHaveValue("面料确认\n第二版待调整袖口");
  await input.fill("");
  await dialog.getByRole("button", { name: "确定保存" }).click();
  await expect(dialog).toBeHidden();
  await trigger.click();
  await expect(input).toHaveValue("");
  await input.press("Escape");
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});

test("result node preserves media actions and discards note on document replacement", async ({ page }) => {
  const node = await seedResult(page, true);
  await node.getByRole("button", { name: "选择生成结果 2", exact: true }).click();
  await expect(node.getByAltText("图3 · 生成结果")).toHaveAttribute("src", /commerce/);
  await node.getByRole("button", { name: "查看", exact: true }).click();
  expect(await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    const viewer = useFlowStore.getState().viewer;
    useFlowStore.getState().closeViewer();
    return viewer?.url;
  })).toContain("commerce");
  const download = page.waitForEvent("download");
  await node.getByRole("button", { name: "下载", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/garment-result-2/);
  await node.getByRole("button", { name: "对比", exact: true }).click();
  const chooser = page.getByRole("dialog", { name: "选择对比结果" });
  await chooser.getByRole("button", { name: "对比 方案 1", exact: true }).click();
  await chooser.getByRole("button", { name: "对比 2 张", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "结果对比", exact: true })).toBeVisible();
  await page.getByTitle("关闭（Esc）").click();
  await node.locator(".gc-node-floating-title").click();
  await node.getByRole("button", { name: "结果保存选项" }).click();
  await expect(page.getByRole("button", { name: "下载图片 2" })).toBeVisible();
  await page.keyboard.press("Escape");
  await node.locator(".gc-node-floating-title").click();
  await node.getByRole("button", { name: "风格转绘", exact: true }).click();
  expect(await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveEdges } = await import(path);
    return selectActiveEdges(useFlowStore.getState()).some((edge: { source: string; sourceHandle?: string }) => edge.source === "result-note" && edge.sourceHandle === "image:1");
  })).toBe(true);
  await node.getByRole("button", { name: "备注", exact: true }).click();
  await page.getByRole("textbox", { name: "备注内容" }).fill("不允许写入替换文档");
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveNodes } = await import(path);
    const nodes = selectActiveNodes(useFlowStore.getState()).map((n: { data: object }) => ({ ...n, data: { ...n.data, note: "新文档备注" } }));
    useFlowStore.getState().loadFlow({ projectName: "替换文档", nodes, edges: [], markDirty: true });
  });
  await expect(page.getByRole("dialog", { name: "结果备注" })).toBeHidden();
  expect(await noteValue(page)).toBe("新文档备注");
});

test("result node note save failure is retryable and read-only notes cannot change", async ({ page }) => {
  const node = await seedResult(page);
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() === "POST") await route.fulfill({ status: 503, json: { error: "模拟保存失败" } });
    else await route.continue();
  });
  await node.getByRole("button", { name: "备注", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "结果备注" });
  await dialog.getByRole("textbox", { name: "备注内容" }).fill("可重试的备注");
  await dialog.getByRole("button", { name: "确定保存" }).click();
  await expect(dialog.getByRole("alert")).toContainText("项目保存失败");
  await expect(dialog.getByRole("textbox")).toHaveValue("可重试的备注");
  await page.unroute("**/api/projects");
  await dialog.getByRole("button", { name: "确定保存" }).click();
  await expect(dialog).toBeHidden();
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    useFlowStore.setState((s: { tabs: Array<{ id: string }>; activeTabId: string }) => ({
      tabs: s.tabs.map((t) => t.id === s.activeTabId ? { ...t, readOnly: true } : t),
    }));
  });
  await node.getByRole("button", { name: "备注", exact: true }).click();
  await expect(dialog.getByRole("textbox")).toHaveValue("可重试的备注");
  await expect(dialog.getByRole("textbox")).toHaveAttribute("readonly", "");
  await expect(dialog.getByRole("button", { name: "确定保存" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
});

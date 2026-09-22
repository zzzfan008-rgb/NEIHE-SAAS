import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import axe from "axe-core";

async function runAccessibilityAudit(page: Page) {
  await page.addScriptTag({ content: axe.source });
  return page.evaluate(async () => {
    const axeRuntime = (window as unknown as Window & { axe: typeof axe }).axe;
    const result = await axeRuntime.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    });
    const serialize = ({ id, impact, help, helpUrl, nodes }: (typeof result.violations)[number]) => ({
      id,
      impact,
      help,
      helpUrl,
      nodes: nodes.map(({ html, target }) => ({ html, target })),
    });
    return {
      violations: result.violations.map(serialize),
      passes: result.passes.length,
      incomplete: result.incomplete.map(serialize),
    };
  });
}

async function openFreshBlankProject(page: Page) {
  await page.getByRole("button", { name: "打开项目中心" }).click();
  const center = page.getByRole("dialog", { name: "项目中心" });
  await expect(center).toBeVisible();
  await center.getByRole("button", { name: "新建项目" }).click();
  await expect(center).toBeHidden();
  await expect(page.getByRole("region", { name: "开始第一个创作任务" })).toBeVisible();
}

test("desktop workbench captures visual and accessibility audit evidence", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "工作台左侧工具" })).toBeVisible();
  await expect(page.getByRole("application", { name: "工作流画布" })).toBeVisible();
  await openFreshBlankProject(page);

  const accessibility = await runAccessibilityAudit(page);

  const metrics = await page.evaluate(() => {
    const count = (selector: string) => document.querySelectorAll(selector).length;
    const values = (selector: string, property: keyof CSSStyleDeclaration) => [...document.querySelectorAll<HTMLElement>(selector)]
      .map((element) => getComputedStyle(element)[property] as string)
      .filter(Boolean);
    const histogram = (items: string[]) => Object.fromEntries(
      [...new Set(items)].sort().map((value) => [value, items.filter((item) => item === value).length]),
    );
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      fontSizes: histogram(values("body *", "fontSize")),
      lineHeights: histogram(values("body *", "lineHeight")),
      buttons: count("button"),
      visibleButtons: [...document.querySelectorAll<HTMLButtonElement>("button")].filter((button) => {
        const style = getComputedStyle(button);
        return style.display !== "none" && style.visibility !== "hidden";
      }).length,
      panels: count('[role="region"], [role="dialog"], .gc-panel'),
      tables: count("table"),
      focused: document.activeElement?.tagName ?? "BODY",
    };
  });

  await page.screenshot({
    path: testInfo.outputPath(`ui-audit-${testInfo.project.name}.png`),
    fullPage: false,
  });
  await testInfo.attach("accessibility.json", {
    body: Buffer.from(JSON.stringify(accessibility, null, 2)),
    contentType: "application/json",
  });
  await testInfo.attach("layout-metrics.json", {
    body: Buffer.from(JSON.stringify(metrics, null, 2)),
    contentType: "application/json",
  });

  const dockToggle = page.getByRole("button", { name: "属性", exact: true });
  const dock = page.locator("#workbench-inspector-panel");
  await dockToggle.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  const focusMetrics = await dockToggle.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      matchesFocusVisible: element.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
    };
  });
  await expect(dockToggle).toBeFocused();
  expect(focusMetrics.matchesFocusVisible).toBe(true);
  expect(focusMetrics.outlineStyle !== "none" || focusMetrics.boxShadow !== "none").toBe(true);

  await dockToggle.click();
  await expect(dockToggle).toHaveAttribute("aria-expanded", "true");
  await expect(dock).toHaveAttribute("aria-hidden", "false");
  await expect(dock).toBeVisible();
  const openDockMetrics = await page.evaluate(() => {
    const dock = document.querySelector<HTMLElement>("#workbench-inspector-panel");
    const canvas = document.querySelector<HTMLElement>('[role="application"][aria-label="工作流画布"]');
    if (!dock || !canvas) throw new Error("Dock or canvas is missing");
    const dockRect = dock.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    return {
      expectedDockWidth: window.innerWidth <= 1100 ? 360 : window.innerWidth < 1360 ? 400 : 440,
      dock: { left: dockRect.left, width: dockRect.width, right: dockRect.right },
      canvas: { left: canvasRect.left, width: canvasRect.width, right: canvasRect.right },
      focus: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? "BODY",
    };
  });
  expect(openDockMetrics.dock.width).toBe(openDockMetrics.expectedDockWidth);
  expect(Math.abs(openDockMetrics.dock.left - openDockMetrics.canvas.right)).toBeLessThanOrEqual(1);
  expect(openDockMetrics.canvas.width).toBeCloseTo(
    page.viewportSize()!.width - openDockMetrics.expectedDockWidth,
    0,
  );

  const nodes = page.locator(".react-flow__node");
  const nodeCount = await nodes.count();
  const rail = page.getByRole("navigation", { name: "工作台左侧工具" });
  await rail.getByRole("button", { name: "添加节点", exact: true }).click();
  await page.getByRole("menu", { name: "添加节点" }).getByRole("menuitem", { name: /文本节点/ }).click();
  await expect(nodes).toHaveCount(nodeCount + 1);
  const textNode = nodes.filter({ hasText: "文本节点" }).last();
  const textNodeId = await textNode.getAttribute("data-id");
  if (!textNodeId) throw new Error("Text node id is missing");
  const stableTextNode = page.locator(`.react-flow__node[data-id="${textNodeId}"]`);
  const title = stableTextNode.locator(".gc-node-floating-title span");
  await title.dblclick();
  const titleInput = stableTextNode.getByRole("textbox", { name: "节点名称" });
  await expect(titleInput).toBeFocused();
  const titleFocus = await titleInput.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      matchesFocusVisible: element.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      boxShadow: style.boxShadow,
    };
  });
  expect(titleFocus.matchesFocusVisible).toBe(true);
  expect(titleFocus.outlineStyle !== "none" || titleFocus.boxShadow !== "none").toBe(true);
  await expect(stableTextNode.getByRole("toolbar", { name: "文本节点操作" })).toBeVisible();
  const interactiveAccessibility = await runAccessibilityAudit(page);
  await page.screenshot({
    path: testInfo.outputPath(`ui-audit-${testInfo.project.name}-interactive.png`),
    fullPage: false,
  });
  await testInfo.attach("interactive-accessibility.json", {
    body: Buffer.from(JSON.stringify(interactiveAccessibility, null, 2)),
    contentType: "application/json",
  });
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: testInfo.outputPath(`ui-audit-${testInfo.project.name}-dock-open.png`),
    fullPage: false,
  });
  await testInfo.attach("dock-open-metrics.json", {
    body: Buffer.from(JSON.stringify({ focusMetrics, ...openDockMetrics }, null, 2)),
    contentType: "application/json",
  });

  console.log(JSON.stringify({ project: testInfo.project.name, accessibility, interactiveAccessibility, metrics }));
  expect(accessibility.violations).toEqual([]);
  expect(interactiveAccessibility.violations).toEqual([]);
});

test("CSS analyzer report is available for the current source tree", async () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  expect(packageJson.scripts["audit:css"]).toBe("node scripts/ui-audit-css.mjs");
});

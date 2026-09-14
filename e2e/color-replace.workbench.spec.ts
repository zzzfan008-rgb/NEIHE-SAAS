import { expect, test } from "./fixtures";

test("配色替换可从已连接色板增删颜色", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开项目中心" })).toBeVisible();
  const templates = await (await page.request.get("/api/templates")).json();
  const template = templates.find((item: { id: string }) => item.id === "builtin-tool-color-replace");
  expect(template).toBeTruthy();
  await page.evaluate(async (templateToLaunch) => {
    const path = "/src/lib/templateLaunch.ts";
    const { launchTemplateInNewTab } = await import(path);
    launchTemplateInNewTab(templateToLaunch, "default");
  }, template);

  const recolorNode = page.locator('.react-flow__node[data-id="generate"]');
  const connectedPalette = page.locator('.react-flow__node[data-id="palette"]');
  const beigeSwatch = recolorNode.locator('button[title="米白 #F5F0E6"]');

  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    useFlowStore.getState().updateNodeData("generate", { status: "queued" });
  });
  await expect(beigeSwatch).toBeDisabled();
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    useFlowStore.getState().updateNodeData("generate", { status: "running", error: "旧配色错误" });
  });
  await expect(recolorNode.getByText("旧配色错误", { exact: true })).toBeVisible();
  await expect(beigeSwatch).toBeEnabled();
  await beigeSwatch.click();
  await expect(recolorNode.getByText("旧配色错误", { exact: true })).toHaveCount(0);
  await expect(beigeSwatch).toHaveAttribute("aria-pressed", "true");
  await expect(connectedPalette.getByText("#F5F0E6", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { selectActiveNodes, useFlowStore } = await import(path);
    const palette = selectActiveNodes(useFlowStore.getState()).find((item: { id: string }) => item.id === "palette");
    return palette?.data.kind === "color-palette" ? palette.data.swatches.map((swatch: { value: string }) => swatch.value) : [];
  })).toEqual(["#000000", "#F5F0E6"]);

  await recolorNode.getByRole("button", { name: "#000000", exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { selectActiveNodes, useFlowStore } = await import(path);
    const palette = selectActiveNodes(useFlowStore.getState()).find((item: { id: string }) => item.id === "palette");
    return palette?.data.kind === "color-palette" ? palette.data.swatches.map((swatch: { value: string }) => swatch.value) : [];
  })).toEqual(["#F5F0E6"]);
  await expect(recolorNode.locator('button[title="米白 #F5F0E6 · 至少保留一个颜色"]').last()).toBeDisabled();
});

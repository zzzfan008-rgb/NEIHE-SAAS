import { expect, test } from "./fixtures";

test("面料配色替换节点支持仅配色模式和直接选色", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开项目中心" })).toBeVisible();
  const templates = await (await page.request.get("/api/templates")).json();
  expect(templates.some((item: { id: string }) => item.id === "builtin-tool-color-replace")).toBe(false);
  const template = templates.find((item: { id: string }) => item.id === "builtin-tool-fabric-replace");
  expect(template).toBeTruthy();
  expect(template.name).toBe("面料配色替换");
  await page.evaluate(async (templateToLaunch) => {
    const path = "/src/lib/templateLaunch.ts";
    const { launchTemplateInNewTab } = await import(path);
    launchTemplateInNewTab(templateToLaunch, "default");
  }, template);

  const recolorId = await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { selectActiveNodes, useFlowStore } = await import(path);
    return selectActiveNodes(useFlowStore.getState()).find((item: { data: { label?: string } }) => item.data.label === "面料配色替换")?.id;
  });
  expect(recolorId).toBeTruthy();
  const recolorNode = page.locator(`.react-flow__node[data-id="${recolorId}"]`);
  const beigeSwatch = recolorNode.locator('button[title="米白 #F5F0E6"]');
  const colorMode = recolorNode.getByRole("button", { name: "仅配色", exact: true });

  await expect(colorMode).toHaveAttribute("aria-pressed", "false");
  await colorMode.click();
  await expect(colorMode).toHaveAttribute("aria-pressed", "true");
  await expect(recolorNode.getByRole("button", { name: "替换配色", exact: true })).toBeVisible();
  await page.evaluate(async (recolorId) => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    useFlowStore.getState().updateNodeData(recolorId, { status: "queued" });
  }, recolorId);
  await expect(beigeSwatch).toBeDisabled();
  await page.evaluate(async (recolorId) => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    useFlowStore.getState().updateNodeData(recolorId, { status: "running", error: "旧配色错误" });
  }, recolorId);
  await expect(recolorNode.getByText("旧配色错误", { exact: true })).toBeVisible();
  await expect(beigeSwatch).toBeEnabled();
  await beigeSwatch.click();
  await expect(recolorNode.getByText("旧配色错误", { exact: true })).toHaveCount(0);
  await expect(beigeSwatch).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(async (recolorId) => {
    const path = "/src/store/flowStore.ts";
    const { selectActiveNodes, useFlowStore } = await import(path);
    const recolor = selectActiveNodes(useFlowStore.getState()).find((item: { id: string }) => item.id === recolorId);
    return recolor?.data.kind === "fabric-recolor" ? recolor.data.colors : [];
  }, recolorId)).toEqual(["#F5F0E6"]);
});

import sharp from "sharp";
import type { Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures";
import type { MaterialAnalysisRecord } from "../src/types/materialAnalysis";

const draft = (revision: number, status: "draft" | "analyzed" | "saved" | "outcome_unknown"): MaterialAnalysisRecord => ({
  id: "material01", status, revision,
  sourceImage: "/api/files/source-private.png", cropImage: "/api/files/crop-private.png",
  crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, modelId: status === "draft" ? null : "gemini-default",
  suggestion: status === "draft" ? null : {
    materialDescription: "模型识别：细密斜纹，哑光表面",
    observedAttributes: ["斜纹", "低光泽"], uncertainAttributes: ["纤维成分待确认"],
    colors: [{ hex: "#AABBCC", name: "灰蓝" }],
  }, calibration: status === "saved" ? { name: "团队斜纹面料", materialDescription: "无法确定成分；可见细密斜纹", colors: [{ hex: "#AABBCC", name: "灰蓝" }] } : null,
  assetId: status === "saved" ? "material-asset-1" : null,
  error: null, createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z",
});

async function installMaterialApi(page: Page) {
  let assets: Array<Record<string, unknown>> = [];
  let current = draft(1, "draft");
  let analyzeCount = 0;
  let lastCrop: unknown;
  let deleteCount = 0;
  let savedCalibration: unknown;
  let materialPatch: unknown;
  await page.route("**/api/assets?**", async (route: Route) => route.fulfill({ json: assets }));
  await page.route(/\/api\/assets\/[^/?]+$/, async (route: Route) => {
    if (route.request().method() !== "PATCH") { await route.fallback(); return; }
    materialPatch = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true } });
  });
  await page.route(/\/api\/material-analyses(?:\/.*)?(?:\?.*)?$/, async (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname.endsWith("/models") && method === "GET") {
      await route.fulfill({ json: { revision: 1, models: [{ id: "gemini-default", label: "Gemini 默认", protocol: "gemini-generate-content", enabled: true, isDefault: true, revision: 1 }] } });
      return;
    }
    if (url.pathname.endsWith("/analyze")) {
      analyzeCount += 1; current = draft(current.revision + 1, "analyzed");
      await route.fulfill({ json: current }); return;
    }
    if (url.pathname.endsWith("/save")) {
      savedCalibration = (route.request().postDataJSON() as { calibration: unknown }).calibration;
      current = draft(current.revision + 1, "saved");
      assets = [
        { id: "material-asset-1", name: "团队斜纹面料", image: "/api/files/crop-private.png", category: "fabric", scope: "shared", ownerId: "admin", canManage: true, createdAt: "2026-09-15T00:00:00.000Z", material: { analysisId: "material01", modelId: "gemini-default", crop: current.crop, materialDescription: current.calibration?.materialDescription, colors: current.calibration?.colors, analyzedAt: current.updatedAt, confirmedAt: current.updatedAt } },
        { id: "legacy-fabric", name: "历史面料", image: "/api/files/legacy.png", category: "fabric", scope: "shared", ownerId: "other", canManage: false, createdAt: "2026-09-14T00:00:00.000Z" },
      ];
      await route.fulfill({ status: 201, json: { assetId: "material-asset-1", analysis: current } }); return;
    }
    if (method === "POST" && url.pathname === "/api/material-analyses") {
      lastCrop = (route.request().postDataJSON() as { crop: unknown }).crop;
      current = draft(1, "draft"); await route.fulfill({ status: 201, json: current }); return;
    }
    if (method === "DELETE") { deleteCount += 1; await route.fulfill({ status: 204 }); return; }
    await route.fulfill({ json: current });
  });
  return {
    get analyzeCount() { return analyzeCount; },
    get deleteCount() { return deleteCount; },
    get lastCrop() { return lastCrop; },
    get savedCalibration() { return savedCalibration; },
    get materialPatch() { return materialPatch; },
    setCurrent(value: typeof current) { current = value; },
  };
}

async function openAssetLibrary(page: Page) {
  await page.goto("/");
  const rail = page.getByRole("navigation", { name: "工作台左侧工具" });
  await rail.getByRole("button", { name: "资产库", exact: true }).click();
  return page.getByRole("dialog", { name: "资产库", exact: true });
}

test("fabric upload is cropped, reanalyzed, calibrated and saved as a shared asset", async ({ page }) => {
  const api = await installMaterialApi(page);
  const library = await openAssetLibrary(page);
  await library.getByRole("button", { name: "上传并分析" }).click();
  const dialog = page.getByRole("dialog", { name: "上传并分析面料" });
  await expect(dialog).toBeVisible();
  const png = await sharp({ create: { width: 100, height: 80, channels: 3, background: "#AABBCC" } }).png().toBuffer();
  await dialog.getByLabel("选择面料图片").setInputFiles({ name: "team-twill.png", mimeType: "image/png", buffer: png });
  await dialog.getByRole("button", { name: "开始分析" }).click();
  await expect(dialog.getByText("模型识别：细密斜纹，哑光表面")).toBeVisible();
  await expect(dialog.getByLabel("素材名称")).toHaveValue("team-twill");
  await expect(dialog.getByLabel("颜色 1", { exact: true })).toHaveValue("#AABBCC");
  await dialog.getByLabel("裁切x").fill("0.15");
  await expect(dialog.getByText("裁切已改变，请重新分析后再入库。")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "保存为共享面料" })).toBeDisabled();
  await dialog.getByRole("button", { name: "重新分析" }).click();
  await expect.poll(() => api.analyzeCount).toBe(2);
  expect(api.lastCrop).toMatchObject({ x: 0.15 });
  await dialog.getByLabel("材质描述").fill("无法确定成分；可见细密斜纹");
  await dialog.getByLabel("素材名称").fill("团队斜纹面料");
  await dialog.getByRole("button", { name: "保存为共享面料" }).click();
  await expect(dialog.getByRole("button", { name: "已保存到面料库" })).toBeVisible();
  expect(api.savedCalibration).toMatchObject({ name: "团队斜纹面料", colors: [{ hex: "#AABBCC", name: "灰蓝" }] });
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(page.getByRole("dialog", { name: "资产库", exact: true }).getByText("团队斜纹面料")).toBeVisible();
  const reopenedLibrary = page.getByRole("dialog", { name: "资产库", exact: true });
  await reopenedLibrary.getByRole("button", { name: "查看面料校准信息 团队斜纹面料" }).click();
  const details = page.getByRole("dialog", { name: "面料校准信息", exact: true });
  await expect(details.getByLabel("面料材质描述")).toHaveValue("无法确定成分；可见细密斜纹");
  await expect(details.getByLabel("面料颜色 1")).toHaveValue("#AABBCC");
  await details.getByLabel("面料材质描述").fill("人工复核：细密斜纹");
  await details.getByRole("button", { name: "关闭", exact: true }).click();
  const detailsDiscard = page.getByRole("alertdialog", { name: "放弃未保存的面料校准修改？" });
  await detailsDiscard.getByRole("button", { name: "继续编辑" }).click();
  await expect(details.getByLabel("面料材质描述")).toHaveValue("人工复核：细密斜纹");
  await details.getByRole("button", { name: "保存校准信息" }).click();
  await expect.poll(() => api.materialPatch).toMatchObject({
    name: "团队斜纹面料", material: { materialDescription: "人工复核：细密斜纹", colors: [{ hex: "#AABBCC" }] },
  });
  const libraryAfterEdit = page.getByRole("dialog", { name: "资产库", exact: true });
  await libraryAfterEdit.getByRole("button", { name: "查看面料校准信息 历史面料" }).click();
  const legacyDetails = page.getByRole("dialog", { name: "面料校准信息", exact: true });
  await expect(legacyDetails.getByText("该历史面料暂无分析校准信息。")).toBeVisible();
  await expect(legacyDetails.getByRole("button", { name: "保存校准信息" })).toHaveCount(0);
  await legacyDetails.getByRole("button", { name: "关闭" }).click();
});

test("refresh preserves human calibration and unknown analysis requires confirmed retry", async ({ page }) => {
  const api = await installMaterialApi(page);
  const library = await openAssetLibrary(page);
  await library.getByRole("button", { name: "上传并分析" }).click();
  const dialog = page.getByRole("dialog", { name: "上传并分析面料" });
  const png = await sharp({ create: { width: 30, height: 30, channels: 3, background: "#778899" } }).png().toBuffer();
  await dialog.getByLabel("选择面料图片").setInputFiles({ name: "manual.png", mimeType: "image/png", buffer: png });
  await dialog.getByRole("button", { name: "开始分析" }).click();
  await dialog.getByLabel("材质描述").fill("人工校准描述");
  await dialog.getByLabel("颜色 1", { exact: true }).fill("#112233");
  api.setCurrent({ ...draft(3, "analyzed"), suggestion: { ...draft(3, "analyzed").suggestion!, materialDescription: "刷新后的模型描述", colors: [{ hex: "#FFFFFF" }] } });
  await dialog.getByRole("button", { name: "刷新记录" }).click();
  await expect(dialog.getByLabel("材质描述")).toHaveValue("人工校准描述");
  await expect(dialog.getByLabel("颜色 1", { exact: true })).toHaveValue("#112233");
  api.setCurrent({ ...draft(4, "outcome_unknown"), suggestion: null, error: "结果可能未知" });
  await dialog.getByRole("button", { name: "刷新记录" }).click();
  await dialog.getByRole("button", { name: "确认重试分析" }).click();
  const retry = page.getByRole("alertdialog", { name: "确认重新发起材质分析？" });
  await expect(retry).toContainText("可能产生第二次调用和费用");
  await retry.getByRole("button", { name: "确认重试", exact: true }).click();
  await expect.poll(() => api.analyzeCount).toBe(2);
  await expect(dialog.getByText("状态：analyzed")).toBeVisible();
});


test("changing or closing an unsaved analysis requires explicit server-draft deletion", async ({ page }) => {
  const api = await installMaterialApi(page);
  const library = await openAssetLibrary(page);
  await library.getByRole("button", { name: "上传并分析" }).click();
  const dialog = page.getByRole("dialog", { name: "上传并分析面料" });
  const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#8899AA" } }).png().toBuffer();
  const input = dialog.getByLabel("选择面料图片");
  await input.setInputFiles({ name: "first.png", mimeType: "image/png", buffer: png });
  await dialog.getByRole("button", { name: "开始分析" }).click();
  await expect(dialog.getByLabel("素材名称")).toHaveValue("first");
  await input.setInputFiles({ name: "second.png", mimeType: "image/png", buffer: png });
  const discard = page.getByRole("alertdialog", { name: "放弃尚未入库的面料分析？" });
  await discard.getByRole("button", { name: "继续编辑" }).click();
  await expect(dialog.getByLabel("素材名称")).toHaveValue("first");
  await input.setInputFiles({ name: "second.png", mimeType: "image/png", buffer: png });
  await discard.getByRole("button", { name: "放弃并删除" }).click();
  await expect(dialog.getByLabel("素材名称")).toHaveValue("second");
  expect(api.deleteCount).toBe(1);
  await dialog.getByRole("button", { name: "关闭" }).click();
  await discard.getByRole("button", { name: "放弃并删除" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "资产库", exact: true })).toBeVisible();
  expect(api.deleteCount).toBe(1);
});
test("admin can revise the model allowlist with optimistic revision", async ({ page }) => {
  let savedBody: unknown;
  await page.route("**/api/material-analyses/models", async (route: Route) => {
    if (route.request().method() === "PUT") {
      savedBody = route.request().postDataJSON();
      await route.fulfill({ json: { revision: 3, models: [{ id: "gemini-default", label: "Gemini 织物", protocol: "gemini-generate-content", enabled: true, isDefault: true, revision: 3 }] } });
      return;
    }
    await route.fulfill({ json: { revision: 2, models: [{ id: "gemini-default", label: "Gemini 默认", protocol: "gemini-generate-content", enabled: true, isDefault: true, revision: 2 }] } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /^账户菜单：/ }).click();
  await page.getByRole("menuitem", { name: "色彩管理", exact: true }).click();
  const account = page.getByRole("dialog", { name: "账户面板", exact: true });
  await account.getByRole("button", { name: "分析模型" }).click();
  const dialog = page.getByRole("dialog", { name: "材质分析模型", exact: true });
  await dialog.getByLabel("模型名称 1").fill("Gemini 织物");
  await page.keyboard.press("Escape");
  const discardModels = page.getByRole("alertdialog", { name: "放弃未保存的色彩管理修改？" });
  await discardModels.getByRole("button", { name: "继续编辑" }).click();
  await expect(dialog.getByLabel("模型名称 1")).toHaveValue("Gemini 织物");
  await dialog.getByRole("button", { name: "保存模型配置" }).click();
  await expect.poll(() => savedBody).toMatchObject({ expectedRevision: 2, models: [{ id: "gemini-default", label: "Gemini 织物", enabled: true, isDefault: true }] });
  await expect(dialog.getByText("模型配置尚未保存。")).toHaveCount(0);
  await expect(dialog.getByText("网关密钥不会返回浏览器")).toBeVisible();
});

test("unknown model writes lock editing and closing until server reconciliation", async ({ page }) => {
  await page.route("**/api/material-analyses/models", async (route: Route) => {
    if (route.request().method() === "PUT") { await route.abort("failed"); return; }
    await route.fulfill({ json: { revision: 5, models: [{ id: "gemini-default", label: "Gemini 默认", protocol: "gemini-generate-content", enabled: true, isDefault: true, revision: 5 }] } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /^账户菜单：/ }).click();
  await page.getByRole("menuitem", { name: "色彩管理", exact: true }).click();
  const account = page.getByRole("dialog", { name: "账户面板", exact: true });
  await account.getByRole("button", { name: "分析模型" }).click();
  const dialog = page.getByRole("dialog", { name: "材质分析模型", exact: true });
  await dialog.getByLabel("模型名称 1").fill("结果未知名称");
  await dialog.getByRole("button", { name: "保存模型配置" }).click();
  await expect(dialog.getByText("模型配置保存结果可能未知。请刷新核对服务端配置后再编辑或关闭。", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "保存模型配置" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(dialog.getByLabel("模型名称 1")).toHaveValue("Gemini 默认");
  await expect(dialog.getByText("保存结果可能未知")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

import type { Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures";

const releaseId = "d".repeat(64);
const catalogA = "a".repeat(64);
const catalogB = "b".repeat(64);
const catalogColor = (id: string, code: string, hex: `#${string}` = "#AABBCC") => ({
  id,
  libraryKey: "pantone-tcx",
  code,
  status: "ready",
  hex,
  hue: "neutral",
  outOfGamut: false,
});

async function installPantoneApi(
  page: Page,
  catalogColors = [
    catalogColor(catalogA, "11-1000 TCX"),
    catalogColor(catalogB, "11-1001 TCX"),
  ],
) {
  const catalogQueries: string[] = [];
  let pantoneFavorites: Array<Record<string, string>> = [];
  await page.route("**/api/auth/color-preferences", async (route: Route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as {
        pantone?: Record<string, string>;
        favorite?: boolean;
      };
      if (body.pantone) {
        pantoneFavorites = body.favorite
          ? [
              ...pantoneFavorites.filter(
                (item) => item.catalogId !== body.pantone!.catalogId,
              ),
              body.pantone,
            ]
          : pantoneFavorites.filter(
              (item) => item.catalogId !== body.pantone!.catalogId,
            );
      }
    }
    await route.fulfill({
      json: {
        ownerId: "pantone-user",
        initialized: true,
        favorites: [],
        pantoneFavorites,
      },
    });
  });
  await page.route("**/api/colors/**", async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/catalog/state")) {
      await route.fulfill({ json: { releaseId, revision: 1 } });
      return;
    }
    if (url.pathname.endsWith("/catalog/libraries")) {
      await route.fulfill({
        json: {
          releaseId,
          libraries: [{
            libraryKey: "pantone-tcx",
            ready: catalogColors.length,
            total: catalogColors.length,
          }],
        },
      });
      return;
    }
    if (url.pathname.endsWith("/catalog")) {
      catalogQueries.push(url.search);
      await route.fulfill({
        json: {
          releaseId,
          activeReleaseId: releaseId,
          colors: catalogColors,
          nextOffset: null,
        },
      });
      return;
    }
    if (url.pathname.endsWith("/brands")) {
      await route.fulfill({
        json: {
          items: [
            {
              id: "brand-neihe",
              kind: "neihe",
              name: "NEIHE Color",
              revision: 1,
            },
            {
              id: "brand-chloe",
              kind: "reference",
              name: "Chloé Spring",
              revision: 1,
            },
          ],
          nextOffset: null,
        },
      });
      return;
    }
    if (url.pathname.endsWith("/series")) {
      const brandId = url.searchParams.get("brandId");
      await route.fulfill({
        json: {
          items:
            brandId === "brand-chloe"
              ? [
                  {
                    id: "series-chloe-spring",
                    brandId,
                    name: "Spring",
                    year: 2026,
                    season: "Spring",
                    revision: 1,
                  },
                ]
              : [],
          nextOffset: null,
        },
      });
      return;
    }
    if (url.pathname.endsWith("/groups")) {
      const brandId = url.searchParams.get("brandId");
      await route.fulfill({
        json: {
          items: [
            {
              id: brandId === "brand-neihe" ? "group-neihe" : "group-chloe",
              brandId,
              seriesId: null,
              name:
                brandId === "brand-neihe" ? "NEIHE 基础" : "Chloé Spring 主题",
              revision: 1,
            },
          ],
          nextOffset: null,
        },
      });
      return;
    }
    const groupId = url.pathname.split("/").at(-1)!;
    const members = Array.from(
      { length: groupId === "group-chloe" ? 9 : 2 },
      (_, index) => ({
        catalogId:
          index === 0
            ? catalogA
            : index === 1
              ? catalogB
              : `${index}`.repeat(64).slice(0, 64),
        releaseId,
        libraryKey: "pantone-tcx",
        code: `11-${String(1000 + index)} TCX`,
        hex: index < 2 ? "#AABBCC" : "#CCDDEE",
        originalHex: null,
        ratio: null,
      }),
    );
    await route.fulfill({
      json: {
        id: groupId,
        brandId: groupId === "group-neihe" ? "brand-neihe" : "brand-chloe",
        seriesId: null,
        name: groupId === "group-neihe" ? "NEIHE 基础" : "Chloé Spring 主题",
        revision: 1,
        members,
      },
    });
  });
  return { catalogQueries };
}

test("Pantone identities survive same-HEX selection, favorites and palette creation", async ({
  page,
}) => {
  const api = await installPantoneApi(page);
  await page.goto("/e2e/fixtures/color-tool.html?picker=native");
  await page.evaluate(async () => {
    const path = "/src/store/customColors.ts";
    const { useCustomColors } = await import(path);
    useCustomColors.getState().bindOwner("pantone-user");
  });
  await page.getByRole("button", { name: "开始取色测试" }).click();
  const dialog = page.getByRole("dialog", { name: "色彩工具" });
  await dialog.getByRole("tab", { name: "Pantone", exact: true }).click();
  await expect(dialog.getByRole("tab", { name: "全系列" })).toBeVisible();
  await dialog
    .getByLabel("搜索 Pantone 色号或来源名称")
    .fill("legacy-source-name");
  await dialog.getByLabel("色相筛选").click();
  await page.getByRole("option", { name: "中性色" }).click();
  await dialog.getByLabel("搜索 Pantone 色号或来源名称").press("Enter");
  await expect
    .poll(() =>
      api.catalogQueries.some(
        (query) =>
          query.includes("q=legacy-source-name") &&
          query.includes("hue=neutral"),
      ),
    )
    .toBe(true);
  await dialog
    .getByRole("button", { name: /11-1000 TCX.*pantone-tcx.*#AABBCC/ })
    .click();
  await dialog
    .getByRole("button", { name: /11-1001 TCX.*pantone-tcx.*#AABBCC/ })
    .click();
  await expect(dialog.getByText("已选 2/8")).toBeVisible();

  await dialog.getByRole("button", { name: /收藏 11-1000 TCX/ }).click();
  await dialog.getByRole("button", { name: /收藏 11-1001 TCX/ }).click();
  await dialog.getByRole("button", { name: "创建新色板节点" }).click();
  const output = page.getByLabel("创建结果");
  await expect(output).toContainText('"catalogId"');
  const intent = JSON.parse((await output.textContent()) || "{}") as {
    swatches: Array<{ value: string; pantone: { catalogId: string } }>;
  };
  expect(intent.swatches.map((swatch) => swatch.value)).toEqual([
    "#AABBCC",
    "#AABBCC",
  ]);
  expect(intent.swatches.map((swatch) => swatch.pantone.catalogId)).toEqual([
    catalogA,
    catalogB,
  ]);

  await page.getByRole("button", { name: "开始取色测试" }).click();
  const reopened = page.getByRole("dialog", { name: "色彩工具" });
  await reopened.getByRole("tab", { name: "我的收藏" }).click();
  await expect(
    reopened.getByText("11-1000 TCX", { exact: true }),
  ).toBeVisible();
  await expect(
    reopened.getByText("11-1001 TCX", { exact: true }),
  ).toBeVisible();
});

test("Pantone swatches and preview stay in two columns across desktop widths", async ({
  page,
}) => {
  const palette = [
    "#AABBCC", "#AABBCC", "#84CCDD", "#6BBFC2", "#EBDC9F",
    "#DDC385", "#D8C599", "#C9B27C", "#C1A87E", "#B89F74",
    "#A87D58", "#95654A", "#7C4E3C", "#6D3D2F", "#E7C7C7",
    "#DCA5A5", "#CB8282", "#B76262", "#A84B4B", "#8E3A3A",
    "#9AB89A", "#729B7C", "#527F68", "#386553", "#244B3F",
  ] as const;
  const colors = palette.map((hex, index) => catalogColor(
    index === 0 ? catalogA : index === 1 ? catalogB : (index + 1).toString(16).padStart(64, "0"),
    `11-${String(1000 + index)} TCX`,
    hex,
  ));
  await installPantoneApi(page, colors);
  await page.goto("/e2e/fixtures/color-tool.html?picker=native");
  await page.getByRole("button", { name: "开始取色测试" }).click();
  const dialog = page.getByRole("dialog", { name: "色彩工具" });
  await dialog.getByRole("tab", { name: "Pantone", exact: true }).click();

  const columns = dialog.getByLabel("潘通双栏选色");
  const grid = dialog.getByLabel("潘通颜色网格");
  const preview = dialog.getByLabel("潘通色卡预览");
  const first = dialog.getByRole("button", {
    name: /11-1000 TCX.*pantone-tcx.*#AABBCC/,
  });
  const second = dialog.getByRole("button", {
    name: /11-1001 TCX.*pantone-tcx.*#AABBCC/,
  });
  const firstCode = grid.getByText("11-1000 TCX", { exact: true });

  await expect(columns).toBeVisible();
  await expect(dialog.getByLabel("色号搜索结果").getByRole("button")).toHaveCount(25);
  await expect(firstCode).toBeVisible();
  await expect(preview).toContainText("11-1000 TCX");
  const [columnsBox, gridBox, previewBox, swatchBox, codeBox] = await Promise.all([
    columns.boundingBox(),
    grid.boundingBox(),
    preview.boundingBox(),
    first.boundingBox(),
    firstCode.boundingBox(),
  ]);
  expect(columnsBox).not.toBeNull();
  expect(gridBox).not.toBeNull();
  expect(previewBox).not.toBeNull();
  expect(swatchBox).not.toBeNull();
  expect(codeBox).not.toBeNull();
  expect(gridBox!.x + gridBox!.width).toBeLessThan(previewBox!.x);
  expect(Math.abs(swatchBox!.width - swatchBox!.height)).toBeLessThanOrEqual(1);
  expect(codeBox!.y).toBeGreaterThanOrEqual(swatchBox!.y + swatchBox!.height);
  expect(codeBox!.x).toBeLessThan(swatchBox!.x + swatchBox!.width);
  expect(codeBox!.x + codeBox!.width).toBeGreaterThan(swatchBox!.x);
  expect(columnsBox!.x).toBeGreaterThanOrEqual(0);
  expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );

  await second.hover();
  await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveText("#AABBCC");
  await expect(preview).toContainText("11-1001 TCX");
  await first.focus();
  await expect(preview).toContainText("11-1000 TCX");
  await first.click();
  await expect(dialog.getByText("已选 1/8")).toBeVisible();
  await expect(preview.getByText("已选择", { exact: true })).toBeVisible();
  await second.hover();
  await first.hover();
  await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveText("#AABBCC");
});

test("legacy preference responses cannot erase locally migrated Pantone favorites", async ({
  page,
}) => {
  const favorite = {
    catalogId: catalogA,
    releaseId,
    libraryKey: "pantone-tcx",
    code: "11-1000 TCX",
    hex: "#AABBCC",
  };
  await page.addInitScript(
    ({ value }) => {
      localStorage.setItem(
        "garment-canvas-color-preferences:v1:pantone-user",
        JSON.stringify({ favorites: [], pantoneFavorites: [value] }),
      );
    },
    { value: favorite },
  );
  await page.route("**/api/auth/color-preferences", async (route) => {
    await route.fulfill({
      json: { ownerId: "pantone-user", initialized: true, favorites: [] },
    });
  });
  await page.goto("/e2e/fixtures/color-tool.html?picker=native");
  await page.evaluate(async () => {
    const path = "/src/store/customColors.ts";
    const { useCustomColors } = await import(path);
    useCustomColors.getState().bindOwner("pantone-user");
    await useCustomColors.getState().refreshFavorites();
  });
  await page.getByRole("button", { name: "开始取色测试" }).click();
  const dialog = page.getByRole("dialog", { name: "色彩工具" });
  await dialog.getByRole("tab", { name: "我的收藏" }).click();
  await expect(dialog.getByText("11-1000 TCX", { exact: true })).toBeVisible();
});
test("brand themes reject oversized whole-group addition and keep footer visible", async ({
  page,
}) => {
  await installPantoneApi(page);
  await page.goto("/e2e/fixtures/color-tool.html?picker=native");
  await page.evaluate(async () => {
    const path = "/src/store/customColors.ts";
    const { useCustomColors } = await import(path);
    useCustomColors.getState().bindOwner("pantone-user");
  });
  await page.getByRole("button", { name: "开始取色测试" }).click();
  const dialog = page.getByRole("dialog", { name: "色彩工具" });
  await dialog.getByRole("tab", { name: "Pantone", exact: true }).click();
  await dialog.getByRole("tab", { name: "参考品牌", exact: true }).click();
  await dialog.getByLabel("系列与季节").click();
  await page.getByRole("option", { name: "2026 · Spring · Spring" }).click();
  await dialog.getByRole("button", { name: "Chloé Spring 主题" }).click();
  await dialog.getByRole("button", { name: "整组加入" }).click();
  await expect(dialog.getByRole("alert")).toContainText("请单独选择");
  await expect(dialog.getByText("已选 0/8")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "创建新色板节点" }),
  ).toBeVisible();
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.width).toBeGreaterThanOrEqual(
    Math.min(1024, viewport.width - 32) - 1,
  );
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
});

test("TCX defaults, library guidance and live counts follow the selected catalog", async ({ page }) => {
  const tcx = "pantone-f-h-cotton-tcx";
  const libraries = [
    { libraryKey: tcx, ready: 2310, total: 2310 },
    { libraryKey: "pantone-f-h-paper-tpx", ready: 2100, total: 2100 },
    { libraryKey: "pantone-solid-coated", ready: 2138, total: 2140 },
    { libraryKey: "pantone-solid-uncoated", ready: 2135, total: 2140 },
    { libraryKey: "pantone-color-bridge-coated", ready: 297, total: 2135 },
    { libraryKey: "pantone-color-bridge-uncoated", ready: 295, total: 2135 },
  ];
  const queries: URL[] = [];
  await page.route("**/api/colors/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/catalog/state")) {
      await route.fulfill({ json: { releaseId, revision: 1 } });
    } else if (url.pathname.endsWith("/catalog/libraries")) {
      await route.fulfill({ json: { releaseId, activeReleaseId: releaseId, revision: 1, libraries } });
    } else if (url.pathname.endsWith("/catalog")) {
      queries.push(url);
      await route.fulfill({ json: { releaseId, activeReleaseId: releaseId, revision: 1, total: 1,
        colors: [{ ...catalogColor(catalogA, "11-1000 TCX"), libraryKey: url.searchParams.get("libraryKey") ?? tcx }],
        nextOffset: null } });
    } else {
      await route.fulfill({ json: { items: [], nextOffset: null } });
    }
  });
  await page.goto("/e2e/fixtures/color-tool.html?picker=native");
  await page.getByRole("button", { name: "开始取色测试" }).click();
  const dialog = page.getByRole("dialog", { name: "色彩工具" });
  await dialog.getByRole("tab", { name: "Pantone", exact: true }).click();
  const picker = dialog.getByLabel("色库系列", { exact: true });
  const guidance = dialog.getByLabel("色库用途说明");
  await expect(picker).toContainText("TCX（棉布色卡）");
  await expect(guidance).toContainText("最适合服装面料选色、设计沟通和染厂对色");
  await expect(guidance).toContainText("2,310 色，均无冲突");
  await expect.poll(() => queries.length).toBeGreaterThan(0);
  expect(queries[0].searchParams.get("libraryKey")).toBe(tcx);
  for (const label of ["TPX（纸质色卡）", "Solid Coated", "Solid Uncoated", "Color Bridge Coated", "Color Bridge Uncoated"]) {
    await picker.click();
    await expect(page.getByRole("option")).toHaveCount(7);
    await page.getByRole("option", { name: new RegExp(label.replace(/[（）]/g, ".") + " ·") }).click();
    await expect(guidance).toContainText(label.startsWith("TPX")
      ? "与面料实物存在差异，不宜替代布卡验色"
      : "主要面向印刷，更适合吊牌、包装、宣传物料");
    const box = await guidance.boundingBox();
    const footer = await dialog.getByRole("button", { name: "创建新色板节点" }).boundingBox();
    expect(box).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThan(footer!.y);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  }
  await picker.click();
  await page.getByRole("option", { name: "全部色库", exact: true }).click();
  await expect(guidance).toBeHidden();
  await expect.poll(() => queries.at(-1)?.searchParams.has("libraryKey")).toBe(false);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  libraries[0] = { libraryKey: tcx, ready: 17, total: 18 };
  await page.getByRole("button", { name: "开始取色测试" }).click();
  await dialog.getByRole("tab", { name: "Pantone", exact: true }).click();
  await expect(picker).toContainText("TCX（棉布色卡）");
  await expect(guidance).toContainText("18 色，其中 17 色可选");
  await expect(guidance).not.toContainText("均无冲突");
});

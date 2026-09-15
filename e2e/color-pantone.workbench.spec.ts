import type { Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures";

const releaseId = "d".repeat(64);
const catalogA = "a".repeat(64);
const catalogB = "b".repeat(64);
const catalogColor = (id: string, code: string) => ({
  id,
  libraryKey: "pantone-tcx",
  code,
  status: "ready",
  hex: "#AABBCC",
  hue: "neutral",
  outOfGamut: false,
});

async function installPantoneApi(page: Page) {
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
          libraries: [{ libraryKey: "pantone-tcx", ready: 2, total: 2 }],
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
          colors: [
            catalogColor(catalogA, "11-1000 TCX"),
            catalogColor(catalogB, "11-1001 TCX"),
          ],
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

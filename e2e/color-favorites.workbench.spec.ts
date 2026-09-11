import { expect, test } from "./fixtures";

test("color favorites float transparently above full swatches", async ({ page }) => {
  let favorites = ["#161616"];
  await page.route("**/api/auth/color-preferences", async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { color: string; favorite: boolean };
      favorites = body.favorite ? [...favorites, body.color] : favorites.filter((value) => value !== body.color);
    }
    await route.fulfill({ json: { ownerId: "color-star-test", initialized: true, favorites } });
  });
  await page.goto("/e2e/fixtures/color-tool.html?picker=native");
  await page.evaluate(async () => {
    const path = "/src/store/customColors.ts";
    const { useCustomColors } = await import(path);
    useCustomColors.setState({ ownerId: "color-star-test", colors: ["#123456"], recent: ["#ABCDEF"], favorites: ["#161616"] });
  });
  await page.getByRole("button", { name: "开始取色测试" }).click();
  const dialog = page.getByRole("dialog", { name: "色彩工具" });
  for (const category of ["中性基础色", "暖色系", "冷色系", "我的收藏"]) {
    await dialog.getByRole("tab", { name: category, exact: true }).click();
    await expect(dialog.getByRole("tab", { name: category, exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByRole("tabpanel", { name: category, exact: true })).toBeVisible();
    const swatches = dialog.locator(".gc-color-swatch:visible");
    await expect(async () => {
    const shapes = await swatches.evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      const selection = element.querySelector(".gc-color-swatch-select")!;
      const favorite = element.querySelector(".gc-color-swatch-favorite")!;
      const colorRect = selection.getBoundingClientRect();
      const starRect = favorite.getBoundingClientRect();
      const style = getComputedStyle(favorite);
      const icon = favorite.querySelector("svg")!;
      const iconRect = icon.getBoundingClientRect();
      return { widthGap: rect.width - colorRect.width, heightGap: rect.height - colorRect.height,
        iconWidth: iconRect.width, iconHeight: iconRect.height,
        iconRight: colorRect.right - iconRect.right, iconTop: iconRect.top - colorRect.top,
        right: colorRect.right - starRect.right, top: starRect.top - colorRect.top,
        background: style.backgroundColor, border: style.borderWidth,
        fullColor: getComputedStyle(selection).backgroundColor !== "rgba(0, 0, 0, 0)" };
    }));
    expect(shapes.length).toBeGreaterThan(2); // Includes custom and recently used colors.
    for (const shape of shapes) {
      expect(shape.widthGap).toBeCloseTo(2, 1);
      expect(shape.heightGap).toBeCloseTo(2, 1);
      expect(shape.right).toBeCloseTo(2, 1);
      expect(shape.top).toBeCloseTo(2, 1);
      expect(shape.iconWidth).toBe(10);
      expect(shape.iconHeight).toBe(10);
      expect(shape.iconRight).toBeCloseTo(4, 1);
      expect(shape.iconTop).toBeCloseTo(4, 1);
      expect(shape.background).toBe("rgba(0, 0, 0, 0)");
      expect(shape.border).toBe("0px");
      expect(shape.fullColor).toBe(true);
    }
    }).toPass();
  }
  await dialog.getByRole("tab", { name: "中性基础色", exact: true }).click();
  const star = dialog.getByRole("button", { name: "收藏 #2B1D16", exact: true });
  await star.hover();
  await expect(star).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await star.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(star).toBeFocused();
  await expect(star).toHaveCSS("outline-style", "solid");
  await expect(star).toHaveCSS("outline-width", "2px");
  await star.press("Enter");
  await expect(dialog.getByRole("button", { name: "取消收藏 #2B1D16", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("button", { name: "创建新色板节点" })).toBeDisabled();
  await dialog.getByRole("button", { name: "选择 #2B1D16", exact: true }).click({ position: { x: 5, y: 30 } });
  await expect(dialog.getByText("已选 1/8")).toBeVisible();
  await dialog.getByRole("tabpanel", { name: "中性基础色" }).getByRole("button", { name: "取消收藏 #2B1D16", exact: true }).click();
  await expect(dialog.getByText("已选 1/8")).toBeVisible();
});

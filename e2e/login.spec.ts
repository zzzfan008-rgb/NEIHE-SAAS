import { expect, test } from "./fixtures";

test("login form exposes its validation and errors", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "登录服装设计工作台" })).toBeVisible();
  const account = page.getByRole("textbox", { name: "账号" });
  const password = page.getByLabel("密码");
  const submit = page.getByRole("button", { name: "登录" });

  await expect(account).toBeFocused();
  await expect(submit).toBeDisabled();
  await account.fill(process.env.E2E_ACCOUNT_ID ?? "e2e-admin");
  await password.fill("not-the-e2e-password");
  await expect(password).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "显示输入内容" }).click();
  await expect(password).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "隐藏输入内容" }).click();
  await expect(password).toHaveAttribute("type", "password");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole("alert")).toHaveText("账号或密码错误");
});

test("login composition stays inside the right-side safe area at desktop widths", async ({ page }) => {
  const viewports = [
    { width: 1024, height: 768 },
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
  ];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto("/");

    const brand = page.getByTestId("login-brand");
    const card = page.getByTestId("login-card");
    const background = page.locator('img[src="/assets/login/coin-ai-canvas-studio.webp"]');

    await expect(brand).toBeVisible();
    await expect(card).toBeVisible();
    await expect(background).toBeVisible();
    await expect(page.getByRole("heading", { name: "COIN AI CANVAS" })).toBeVisible();
    await expect(brand).toContainText("回到你的设计画布，继续这一季的创作吧！");

    const brandBox = await brand.boundingBox();
    const cardBox = await card.boundingBox();
    const backgroundBox = await background.boundingBox();
    expect(brandBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    expect(backgroundBox).not.toBeNull();
    if (!brandBox || !cardBox || !backgroundBox) throw new Error("login geometry is unavailable");

    expect(brandBox.x).toBeGreaterThan(viewport.width * 0.52);
    expect(cardBox.x).toBeGreaterThan(viewport.width * 0.52);
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(viewport.width - 24);
    expect(cardBox.width).toBeGreaterThanOrEqual(340);
    expect(cardBox.width).toBeLessThanOrEqual(viewport.width >= 1440 ? 500 : 440);
    if (viewport.width >= 1440) expect(cardBox.width).toBeGreaterThanOrEqual(480);
    expect(Math.abs((brandBox.x + brandBox.width / 2) - (cardBox.x + cardBox.width / 2))).toBeLessThanOrEqual(1);
    expect(brandBox.y + brandBox.height).toBeLessThan(cardBox.y);
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(viewport.height - 24);
    expect(backgroundBox.x).toBeCloseTo(0, 0);
    expect(backgroundBox.y).toBeCloseTo(0, 0);
    expect(backgroundBox.width).toBeCloseTo(viewport.width, 0);
    expect(backgroundBox.height).toBeCloseTo(viewport.height, 0);

    const cardStyle = await card.evaluate((element) => {
      const style = getComputedStyle(element);
      return { backgroundColor: style.backgroundColor, backdropFilter: style.backdropFilter };
    });
    expect(
      cardStyle.backgroundColor.includes("/ 0.72") || cardStyle.backgroundColor.endsWith(", 0.72)"),
    ).toBe(true);
    expect(cardStyle.backdropFilter).toContain("blur(");

    const documentMetrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    expect(documentMetrics.scrollWidth).toBeLessThanOrEqual(documentMetrics.viewportWidth);

    const imageMetrics = await background.evaluate((image: HTMLImageElement) => ({
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    }));
    expect(imageMetrics).toEqual({ complete: true, naturalWidth: 3840, naturalHeight: 2143 });
  }
});

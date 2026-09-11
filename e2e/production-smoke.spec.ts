import { expect, test } from "./fixtures";

function parseBundledAssets(html: string) {
  const jsMatch = /<script[^>]+src=\"(\/assets\/[^\"]+\.js)\"/i.exec(html)?.[1] ?? null;
  const cssMatch = /<link[^>]+href=\"(\/assets\/[^\"]+\.css)\"/i.exec(html)?.[1] ?? null;
  return { js: jsMatch, css: cssMatch };
}

test("production bundle serves hashed assets and the authenticated desktop shell", async ({ page, request }) => {
  const failedScriptResponses: string[] = [];
  page.on("response", (assetResponse) => {
    if (assetResponse.request().resourceType() === "script" && assetResponse.status() >= 400) {
      failedScriptResponses.push(`${assetResponse.status()} ${assetResponse.url()}`);
    }
  });

  const health = await request.get("/api/health");
  expect(health.ok()).toBeTruthy();
  expect(await health.json()).toEqual({ ok: true, status: "alive" });

  const ready = await request.get("/api/ready");
  expect(ready.ok()).toBeTruthy();
  expect((await ready.json()).mode).toBe("full");

  const response = await request.get("/", { headers: { accept: "text/html" } });
  expect(response.ok()).toBeTruthy();
  const html = await response.text();
  const assets = parseBundledAssets(html);
  expect(assets.js, "production html should expose hashed js bundle").toMatch(/\/assets\/[^"]+-[A-Za-z0-9_-]{8,}\.js$/);
  expect(assets.css, "production html should expose hashed css bundle").toMatch(/\/assets\/[^"]+-[A-Za-z0-9_-]{8,}\.css$/);

  const jsResponse = await request.get(assets.js!);
  const cssResponse = await request.get(assets.css!);
  expect(jsResponse.status()).toBe(200);
  expect(cssResponse.status()).toBe(200);
  expect(jsResponse.headers()["cache-control"]).toContain("immutable");
  expect(cssResponse.headers()["cache-control"]).toContain("immutable");

  const missingAsset = await request.get("/assets/production-smoke-missing.js");
  expect(missingAsset.status()).toBe(404);

  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "工作台左侧工具" })).toBeVisible();
  await page.getByRole("button", { name: "打开项目中心" }).click();
  const center = page.getByRole("dialog", { name: "项目中心" });
  await expect(center).toBeVisible();
  await center.getByRole("tab", { name: "内置模板" }).click();
  await expect(center.getByRole("button", { name: /一键换装/ })).toBeVisible();
  await center.getByRole("button", { name: "关闭项目中心" }).click();
  expect(failedScriptResponses, "lazy production chunks should load without HTTP errors").toEqual([]);
});

test("production smoke covers static fallback route", async ({ page, request }) => {
  const fallback = await request.get("/project-center", { headers: { accept: "text/html" } });
  expect(fallback.status()).toBe(200);
  expect(await fallback.text()).toContain("/assets/");

  await page.goto("/static/not-found-route");
  await expect(page).toHaveURL("/static/not-found-route");
  await expect(page.getByRole("navigation", { name: "工作台左侧工具" })).toBeVisible();
});

test("built node styles keep result titles centered and image corners anchored", async ({ page, request }) => {
  const name = "生产节点几何验收";
  const created = await request.post("/api/projects", { data: { name, flow: {
    schemaVersion: 3,
    nodes: [
      { id: "production-result", type: "result", position: { x: 100, y: 100 }, data: { kind: "result", label: "结果 2", status: "idle", images: [] } },
      { id: "production-input", type: "image-input", position: { x: 450, y: 100 }, data: { kind: "image-input", label: "参考图", status: "idle" } },
    ], edges: [],
  } } });
  expect(created.ok(), await created.text()).toBeTruthy();
  await page.goto("/");
  await page.getByRole("button", { name: "打开项目中心" }).click();
  const center = page.getByRole("dialog", { name: "项目中心" });
  await center.getByRole("tab", { name: "最近项目" }).click();
  await center.getByRole("button").filter({ hasText: name }).click();
  const result = page.locator('.react-flow__node[data-id="production-result"]');
  const input = page.locator('.react-flow__node[data-id="production-input"]');
  await expect(result).toBeVisible();
  await input.locator(".gc-node-floating-title").click();
  for (const width of [1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const offset = await result.evaluate((element) => {
      const title = element.querySelector(".gc-node-floating-title")!.getBoundingClientRect();
      const card = element.querySelector(".gc-node-card")!.getBoundingClientRect();
      return Math.abs((title.left + title.right - card.left - card.right) / 2);
    });
    expect(offset).toBeLessThan(1);
    await expect(input.locator(".gc-image-resize-corner")).toHaveCount(4);
    const gaps = await input.evaluate((element) => {
      const card = element.querySelector(".gc-node-card")!;
      const rect = card.getBoundingClientRect();
      const scale = rect.width / parseFloat(getComputedStyle(card).width);
      return [...element.querySelectorAll(".gc-image-resize-corner")].flatMap((corner) => {
        const box = corner.getBoundingClientRect();
        return [
          (corner.classList.contains("left") ? box.left - rect.left : rect.right - box.right) / scale,
          (corner.classList.contains("top") ? box.top - rect.top : rect.bottom - box.bottom) / scale,
        ];
      });
    });
    for (const gap of gaps) expect(gap).toBeCloseTo(4, 0);
    await expect(input.locator(".gc-image-node-actions")).toHaveCount(0);
  }
});

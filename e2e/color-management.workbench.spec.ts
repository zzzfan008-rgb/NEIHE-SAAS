import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

test("admin color entry fits desktop and restores nested focus", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: /^账户菜单：/ });
  await trigger.click();
  await page.getByRole("menuitem", { name: "色彩管理", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "账户面板", exact: true });
  await expect(
    dialog.evaluate((el) => {
      const toMs = (value: string) =>
        Number.parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1_000);
      return getComputedStyle(el)
        .animationDuration.split(",")
        .every((value) => toMs(value) <= 1);
    }),
  ).resolves.toBe(true);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    await expect
      .poll(() => dialog.evaluate((el) => el.contains(document.activeElement)))
      .toBe(true);
  }
  await expect(
    dialog.getByRole("tab", { name: "色彩管理", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    dialog.getByRole("button", { name: "NEIHE Color", exact: true }),
  ).toBeVisible();
  await expect(async () => {
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
  }).toPass();
  await dialog.getByRole("button", { name: "新建品牌", exact: true }).click();
  const nested = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: /新建品牌/ }) });
  await expect(nested).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(nested).not.toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "新建品牌", exact: true }),
  ).toBeFocused();
  await dialog
    .getByRole("button", { name: "NEIHE Color", exact: true })
    .click();
  await expect(
    dialog.getByText("主库尚未初始化，请联系运维。此处不能上传主库。"),
  ).toBeVisible();
  const save = dialog.getByRole("button", { name: "保存色组", exact: true });
  await expect(save).toBeInViewport();
  const saveBox = await save.boundingBox();
  const dialogBox = await dialog.boundingBox();
  expect(saveBox!.y + saveBox!.height).toBeLessThanOrEqual(
    dialogBox!.y + dialogBox!.height,
  );
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  const colors = dialog.getByRole("tab", { name: "色彩管理", exact: true });
  await colors.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(
    dialog.getByRole("tab", { name: "AI 服务诊断", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    dialog.getByRole("tabpanel", { name: "AI 服务诊断", exact: true }),
  ).toBeVisible();
  for (const name of ["消耗记录", "用户管理", "AI 服务诊断", "色彩管理"]) {
    await dialog.getByRole("tab", { name, exact: true }).click();
    await expect(
      dialog.getByRole("tabpanel", { name, exact: true }),
    ).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test("non-admin has no color administration entry", async ({ page }) => {
  await page.route("**/api/auth/me", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      json: { ...body, user: { ...body.user, role: "user" } },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /^账户菜单：/ }).click();
  await expect(
    page.getByRole("menuitem", { name: "色彩管理", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("menuitem", { name: "消耗记录", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "色彩管理", exact: true }),
  ).toHaveCount(0);
});

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("refresh ignores the previous query and cancels its request", async ({
  page,
}) => {
  const gate = latch();
  const finished = latch();
  let calls = 0;
  let aborted = false;
  let holding = true;
  page.on("requestfailed", (request) => {
    if (request.url().includes("/api/colors/brands")) aborted = true;
  });
  await page.route("**/api/colors/brands**", async (route) => {
    calls++;
    if (!holding) {
      await route.continue();
      return;
    }
    await gate.promise;
    try {
      await route.fulfill({
        json: {
          items: [
            { id: "late", name: "STALE_BRAND", kind: "reference", revision: 1 },
          ],
          nextOffset: null,
        },
      });
    } catch {
      /* The request was cancelled when the query revision changed. */
    } finally {
      finished.release();
    }
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: /^账户菜单：/ }).click();
    await page.getByRole("menuitem", { name: "色彩管理", exact: true }).click();
    await expect.poll(() => calls).toBeGreaterThanOrEqual(1);
    holding = false;
    aborted = false;
    await page.getByRole("button", { name: "刷新目录", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "NEIHE Color", exact: true }),
    ).toBeVisible();
    await expect.poll(() => aborted).toBe(true);
    gate.release();
    await finished.promise;
    await expect(page.getByText("STALE_BRAND", { exact: true })).toHaveCount(0);
  } finally {
    gate.release();
  }
});

test("role transition unmounts management and cancels a pending write", async ({
  page,
}) => {
  let admin = true;
  let writing = false;
  let aborted = false;
  const gate = latch();
  const finished = latch();
  await page.route("**/api/auth/me", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      json: { ...body, user: { ...body.user, role: admin ? "admin" : "user" } },
    });
  });
  page.on("requestfailed", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/colors/brands")
    )
      aborted = true;
  });
  await page.route("**/api/colors/brands", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    writing = true;
    await gate.promise;
    try {
      await route.fulfill({
        json: {
          id: "late",
          name: "CM02 delayed",
          kind: "reference",
          revision: 1,
        },
      });
    } catch {
      /* Aborting transport does not imply server rollback. This response is synthetic. */
    } finally {
      finished.release();
    }
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: /^账户菜单：/ }).click();
    await page.getByRole("menuitem", { name: "色彩管理", exact: true }).click();
    await page.getByRole("button", { name: "新建品牌", exact: true }).click();
    const nested = page
      .getByRole("dialog")
      .filter({
        has: page.getByRole("heading", { name: "新建品牌", exact: true }),
      });
    await nested.getByLabel("品牌名称").fill("CM02 delayed");
    await nested.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(() => writing).toBe(true);
    admin = false;
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(
      page.getByRole("region", { name: "色彩管理工作区" }),
    ).toHaveCount(0);
    await expect.poll(() => aborted).toBe(true);
    gate.release();
    await finished.promise;
    admin = true;
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(
      page.getByRole("button", { name: "NEIHE Color", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "CM02 delayed", exact: true }),
    ).toHaveCount(0);
  } finally {
    gate.release();
  }
});

async function openColorManagement(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /^账户菜单：/ }).click();
  await page.getByRole("menuitem", { name: "色彩管理", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "色彩管理工作区" }),
  ).toBeVisible();
}

type Cm04Member = {
  catalogId: string;
  releaseId: string;
  ratio: number | null;
  libraryKey: string;
  code: string;
  hex: `#${string}`;
  originalHex: `#${string}` | null;
};
type Cm04Group = {
  id: string;
  brandId: string;
  seriesId: string | null;
  name: string;
  revision: number;
  members: Cm04Member[];
};
type Cm04CatalogColor = {
  id: string;
  libraryKey: string;
  code: string;
  status: "ready";
  hex: `#${string}`;
  hue: string;
  outOfGamut: boolean;
};
const CM04_GROUP_ID = {
  ordered: "00000000-0000-4000-8000-000000000041",
  created: "00000000-0000-4000-8000-000000000042",
  dirty: "00000000-0000-4000-8000-000000000043",
  conflict: "00000000-0000-4000-8000-000000000044",
} as const;

function cm04CatalogId(index: number) {
  return (index + 1).toString(16).padStart(64, "0");
}

function cm04Member(index: number, releaseId: string): Cm04Member {
  return {
    catalogId: cm04CatalogId(index),
    releaseId,
    ratio: null,
    libraryKey: "tcx",
    code: `CM04 ${String(index + 1).padStart(2, "0")}`,
    hex: "#AABBCC",
    originalHex: null,
  };
}

async function installCm04Api(
  page: Page,
  options: { group?: Cm04Group | null; colors?: Cm04CatalogColor[] } = {},
) {
  const releaseId = "4".repeat(64);
  let group = options.group ?? null;
  const colors = options.colors ?? [];
  const writes: Array<{ method: string; body: Record<string, unknown> }> = [];
  await page.route("**/api/colors/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice("/api/colors".length);
    const method = request.method();
    if (method === "GET" && path === "/catalog/state") {
      await route.fulfill({ json: { releaseId, revision: 1 } });
      return;
    }
    if (method === "GET" && path === "/catalog/libraries") {
      await route.fulfill({
        json: {
          releaseId,
          activeReleaseId: releaseId,
          revision: 1,
          libraries: [{ libraryKey: "tcx", total: colors.length, ready: colors.length }],
        },
      });
      return;
    }
    if (method === "GET" && path === "/catalog") {
      const query = (url.searchParams.get("q") ?? "").toUpperCase();
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const pageColors = colors
        .filter((color) => color.code.toUpperCase().includes(query))
        .slice(offset, offset + 25);
      await route.fulfill({
        json: {
          releaseId,
          activeReleaseId: releaseId,
          revision: 1,
          total: colors.length,
          colors: pageColors,
          nextOffset: offset + 25 < colors.length ? offset + 25 : null,
        },
      });
      return;
    }
    if (method === "GET" && path === "/brands") {
      await route.fulfill({
        json: {
          items: [
            { id: "neihe", name: "NEIHE Color", kind: "neihe", revision: 1 },
            { id: "ralph-lauren", name: "Ralph Lauren", kind: "reference", revision: 1 },
          ],
          nextOffset: null,
        },
      });
      return;
    }
    if (method === "GET" && path === "/series") {
      await route.fulfill({
        json: {
          items:
            url.searchParams.get("brandId") === "neihe"
              ? [
                  {
                    id: "cm04-series",
                    brandId: "neihe",
                    name: "CM04 Series",
                    year: null,
                    season: null,
                    revision: 1,
                  },
                ]
              : [],
          nextOffset: null,
        },
      });
      return;
    }
    if (method === "GET" && path === "/groups") {
      const brandId = url.searchParams.get("brandId");
      const filteredSeries = url.searchParams.get("seriesId");
      const visible =
        group &&
        group.brandId === brandId &&
        (filteredSeries === null || group.seriesId === filteredSeries)
          ? [{ ...group, members: undefined }]
          : [];
      await route.fulfill({ json: { items: visible, nextOffset: null } });
      return;
    }
    if (method === "GET" && path.startsWith("/groups/")) {
      if (!group || path !== `/groups/${group.id}`) {
        await route.fulfill({ status: 404, json: { error: "色组不存在" } });
        return;
      }
      await route.fulfill({ json: group });
      return;
    }
    if (["POST", "PUT"].includes(method) && path.startsWith("/groups")) {
      const body = request.postDataJSON() as Record<string, unknown>;
      const references = Array.isArray(body.members)
        ? (body.members as Array<{
            catalogId: string;
            releaseId: string;
            ratio: number | null;
          }>)
        : [];
      const known = new Map(
        [
          ...(group?.members ?? []),
          ...colors.map((color) => ({
            catalogId: color.id,
            releaseId,
            ratio: null,
            libraryKey: color.libraryKey,
            code: color.code,
            hex: color.hex,
            originalHex: null,
          })),
        ].map((member) => [member.catalogId, member]),
      );
      const allowed = new Set(
        method === "POST"
          ? ["brandId", "members", "name", "seriesId"]
          : ["members", "name", "revision", "seriesId"],
      );
      const seen = new Set<string>();
      const validPath =
        method === "POST"
          ? path === "/groups"
          : group !== null && path === `/groups/${group.id}`;
      const validReferences =
        references.length === (body.members as unknown[])?.length &&
        references.length <= 5000 &&
        references.every((reference) => {
          const valid =
            Object.keys(reference).length === 3 &&
            Object.keys(reference).every((key) =>
              ["catalogId", "ratio", "releaseId"].includes(key),
            ) &&
            /^[0-9a-f]{64}$/.test(reference.catalogId) &&
            reference.releaseId === releaseId &&
            known.has(reference.catalogId) &&
            !seen.has(reference.catalogId) &&
            (reference.ratio === null ||
              (typeof reference.ratio === "number" &&
                Number.isFinite(reference.ratio) &&
                reference.ratio >= 0 &&
                reference.ratio <= 1));
          seen.add(reference.catalogId);
          return valid;
        });
      const validBody =
        validPath &&
        Object.keys(body).every((key) => allowed.has(key)) &&
        typeof body.name === "string" &&
        body.name.trim().length > 0 &&
        (body.seriesId === null || typeof body.seriesId === "string") &&
        validReferences &&
        (method === "POST"
          ? typeof body.brandId === "string"
          : body.revision === group?.revision);
      if (!validBody) {
        await route.fulfill({
          status: 400,
          json: { error: "CM04 mock 拒绝了不符合生产契约的请求" },
        });
        return;
      }
      writes.push({ method, body });
      group = {
        id: group?.id ?? CM04_GROUP_ID.created,
        brandId: group?.brandId ?? String(body.brandId),
        seriesId: body.seriesId as string | null,
        name: body.name as string,
        revision: (group?.revision ?? 0) + 1,
        members: references.map((reference) => ({
          ...known.get(reference.catalogId)!,
          ...reference,
        })),
      };
      await route.fulfill({
        status: method === "POST" ? 201 : 200,
        json: group,
      });
      return;
    }
    await route.fulfill({
      status: 501,
      json: { error: `CM04 未模拟 ${method} ${path}` },
    });
  });
  return {
    releaseId,
    writes,
    group: () => group,
    setGroup: (next: Cm04Group) => {
      group = next;
    },
  };
}

test("directory load failures can be retried without closing management", async ({
  page,
}) => {
  let failing = true;
  await page.route("**/api/colors/brands?**", async (route) => {
    if (route.request().method() !== "GET" || !failing) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "CM03 目录暂不可用", code: "CM03_TEST" }),
    });
  });
  await openColorManagement(page);
  await expect(page.getByRole("alert")).toContainText("CM03 目录暂不可用");
  failing = false;
  await page.getByRole("button", { name: "重试品牌", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "NEIHE Color", exact: true }),
  ).toBeVisible();
});

test("deleting the only item on a later brand page returns to the previous page", async ({
  page,
}) => {
  let deleted = false;
  await page.route("**/api/colors/brands/cm03-last", async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.continue();
      return;
    }
    deleted = true;
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/colors/brands?**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const offset = Number(new URL(route.request().url()).searchParams.get("offset"));
    await route.fulfill({
      json:
        offset === 25
          ? {
              items: deleted
                ? []
                : [
                    {
                      id: "cm03-last",
                      name: "ZZ CM03 22",
                      kind: "reference",
                      revision: 1,
                    },
                  ],
              nextOffset: null,
            }
          : {
              items: [
                {
                  id: "cm03-neihe",
                  name: "NEIHE Color",
                  kind: "neihe",
                  revision: 1,
                },
              ],
              nextOffset: 25,
            },
    });
  });
  await openColorManagement(page);
  await page.getByRole("button", { name: "下一页品牌", exact: true }).click();
  const lastBrand = page.getByRole("button", { name: "ZZ CM03 22", exact: true });
  await expect(lastBrand).toBeVisible();
  await lastBrand.click();
  await page.getByRole("button", { name: "删除品牌", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "NEIHE Color", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("暂无品牌", { exact: true })).toHaveCount(0);
});

test("brand series and group directories preserve null metadata and recover from parent conflicts", async ({
  page,
}) => {
  const suffix = page.viewportSize()?.width ?? 0;
  const brandName = `CM03 Reference ${suffix}`;
  const renamedBrandName = `CM03 Reference Renamed ${suffix}`;
  const seriesName = `CM03 Series ${suffix}`;
  const renamedSeriesName = `CM03 Series Renamed ${suffix}`;
  const groupName = `CM03 Group ${suffix}`;
  await openColorManagement(page);
  await page.getByRole("button", { name: "NEIHE Color", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "删除品牌", exact: true }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "新建品牌", exact: true }).click();
  let metadataDialog = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "新建品牌", exact: true }),
  });
  await metadataDialog.getByLabel("品牌名称").fill(brandName);
  await metadataDialog.getByRole("button", { name: "保存", exact: true }).click();
  const brandButton = page.getByRole("button", {
    name: brandName,
    exact: true,
  });
  await expect(brandButton).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "编辑品牌", exact: true }).click();
  metadataDialog = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "编辑品牌", exact: true }),
  });
  await metadataDialog.getByLabel("品牌名称").fill(renamedBrandName);
  await metadataDialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByRole("button", { name: renamedBrandName, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "新建系列", exact: true }).click();
  metadataDialog = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "新建系列", exact: true }),
  });
  await metadataDialog.getByLabel("系列名称").fill(seriesName);
  await expect(metadataDialog.getByLabel("年份")).toHaveValue("");
  await expect(metadataDialog.getByLabel("季节")).toHaveValue("");
  await metadataDialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByText(`${renamedBrandName} / ${seriesName}`, { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "删除品牌", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "请先处理品牌下的系列与色组",
  );
  await page.getByRole("button", { name: "关闭并刷新", exact: true }).click();

  await page
    .getByRole("button", { name: renamedBrandName, exact: true })
    .click();
  await page.getByRole("button", { name: seriesName, exact: true }).click();
  await page.getByRole("button", { name: "编辑系列", exact: true }).click();
  metadataDialog = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "编辑系列", exact: true }),
  });
  await expect(metadataDialog.getByLabel("年份")).toHaveValue("");
  await expect(metadataDialog.getByLabel("季节")).toHaveValue("");
  await metadataDialog.getByLabel("系列名称").fill(renamedSeriesName);
  await metadataDialog.getByLabel("年份").fill("2026");
  await metadataDialog.getByLabel("季节").fill("Spring");
  await metadataDialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByText(
      `${renamedBrandName} / ${renamedSeriesName} · 2026 · Spring`,
      { exact: true },
    ),
  ).toBeVisible();

  await page.getByLabel("主题色组名称").fill(groupName);
  await page.getByRole("button", { name: "保存色组", exact: true }).click();
  const groupButton = page.getByRole("button", { name: groupName, exact: true });
  await expect(groupButton).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "删除系列", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("请先处理系列下的色组");
  await page.getByRole("button", { name: "关闭并刷新", exact: true }).click();

  await page
    .getByRole("button", { name: renamedBrandName, exact: true })
    .click();
  await page
    .getByRole("button", { name: renamedSeriesName, exact: true })
    .click();
  await page.getByRole("button", { name: groupName, exact: true }).click();
  await page.getByRole("button", { name: "删除色组", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(
    page.getByRole("button", { name: groupName, exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "删除系列", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(
    page.getByRole("button", { name: renamedSeriesName, exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "删除品牌", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(
    page.getByRole("button", { name: renamedBrandName, exact: true }),
  ).toHaveCount(0);
});

test("metadata revision conflicts keep the error visible and offer refresh recovery", async ({
  page,
}) => {
  await page.route("**/api/colors/brands/*", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "目录版本已更新", code: "REVISION_CONFLICT" }),
    });
  });
  await openColorManagement(page);
  await page.getByRole("button", { name: "Ralph Lauren", exact: true }).click();
  await page.getByRole("button", { name: "编辑品牌", exact: true }).click();
  const metadataDialog = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "编辑品牌", exact: true }),
  });
  await metadataDialog.getByLabel("品牌名称").fill("Ralph Lauren Updated");
  await metadataDialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(metadataDialog.getByRole("alert")).toContainText("目录版本已更新");
  await metadataDialog
    .getByRole("button", { name: "关闭并刷新目录", exact: true })
    .click();
  await expect(metadataDialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Ralph Lauren", exact: true }),
  ).toBeVisible();
});

test("metadata drafts guard close and unknown create outcomes require directory reconciliation", async ({ page }) => {
  await page.route("**/api/colors/series", async (route) => {
    if (route.request().method() === "POST") { await route.abort("failed"); return; }
    await route.continue();
  });
  await openColorManagement(page);
  await page.getByRole("button", { name: "Ralph Lauren", exact: true }).click();
  await page.getByRole("button", { name: "新建系列", exact: true }).click();
  const metadataDialog = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "新建系列", exact: true }),
  });
  await metadataDialog.getByLabel("系列名称").fill("Unknown Spring");
  await expect.poll(() => page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    return !window.dispatchEvent(event);
  })).toBe(true);
  await metadataDialog.getByRole("button", { name: "取消", exact: true }).click();
  const discard = page.getByRole("alertdialog", { name: "放弃未保存的系列修改？" });
  await discard.getByRole("button", { name: "继续编辑" }).click();
  await expect(metadataDialog.getByLabel("系列名称")).toHaveValue("Unknown Spring");
  await metadataDialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(metadataDialog.getByRole("alert")).toContainText("保存结果可能未知");
  await expect(metadataDialog.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await metadataDialog.getByRole("button", { name: "关闭并刷新目录", exact: true }).click();
  await expect(metadataDialog).toHaveCount(0);
});

test("unknown directory deletions lock resubmission and require directory refresh", async ({ page }) => {
  await page.route("**/api/colors/brands/*", async (route) => {
    if (route.request().method() === "DELETE") { await route.abort("failed"); return; }
    await route.continue();
  });
  await openColorManagement(page);
  await page.getByRole("button", { name: "Ralph Lauren", exact: true }).click();
  await page.getByRole("button", { name: "删除品牌", exact: true }).click();
  const deletion = page.getByRole("alertdialog", { name: /删除 Ralph Lauren/ });
  await deletion.getByRole("button", { name: "确认删除" }).click();
  await expect(deletion.getByRole("alert")).toContainText("保存结果可能未知");
  await expect(deletion.getByRole("button", { name: "确认删除" })).toBeDisabled();
  await expect(deletion.getByRole("button", { name: "取消" })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    return !window.dispatchEvent(event);
  })).toBe(true);
  await deletion.getByRole("button", { name: "关闭并刷新", exact: true }).click();
  await expect(deletion).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ralph Lauren", exact: true })).toBeVisible();
});

test("theme editor saves ordered full members and valid ratios once", async ({
  page,
}) => {
  const releaseId = "4".repeat(64);
  const group: Cm04Group = {
    id: CM04_GROUP_ID.ordered,
    brandId: "neihe",
    seriesId: null,
    name: "CM04 Ordered",
    revision: 1,
    members: Array.from({ length: 30 }, (_, index) =>
      cm04Member(index, releaseId),
    ),
  };
  const api = await installCm04Api(page, { group });
  const gate = latch();
  let attempts = 0;
  await page.route(
    `**/api/colors/groups/${CM04_GROUP_ID.ordered}`,
    async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fallback();
      return;
    }
    attempts++;
    await gate.promise;
    await route.fallback();
  });
  try {
    await openColorManagement(page);
    await page.getByRole("button", { name: "NEIHE Color", exact: true }).click();
    await page.getByRole("button", { name: "CM04 Ordered", exact: true }).click();
    const accountDialog = page.getByRole("dialog", {
      name: "账户面板",
      exact: true,
    });
    await expect(
      accountDialog.evaluate((element) =>
        element.scrollWidth <= element.clientWidth,
      ),
    ).resolves.toBe(true);
    await page.getByLabel("主题色组名称").fill("CM04 Ordered Saved");
    await page.getByLabel("CM04 01 参考比例").fill("0");
    await page.getByLabel("CM04 02 参考比例").fill("0.5");
    await page.getByLabel("CM04 03 参考比例").fill("0x1");
    await page.getByRole("button", { name: "保存色组", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      "参考比例须为 0–1 的数值或空值",
    );
    expect(attempts).toBe(0);
    await page.getByLabel("CM04 03 参考比例").fill("1e-7");
    const moveDown = page.getByRole("button", {
      name: "下移 CM04 01 tcx",
      exact: true,
    });
    await moveDown.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "上移 CM04 02 tcx", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "下移 CM04 25 tcx", exact: true })
      .click();
    await expect(page.getByLabel("CM04 25 参考比例")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "下移 CM04 30 tcx", exact: true }),
    ).toBeDisabled();
    const form = page.getByRole("form", { name: "主题色组编辑" });
    await form.evaluate((element) => {
      const formElement = element as HTMLFormElement;
      formElement.requestSubmit();
      formElement.requestSubmit();
    });
    await expect.poll(() => attempts).toBe(1);
    await expect(
      page.getByRole("button", { name: "保存中…", exact: true }),
    ).toBeDisabled();
    expect(attempts).toBe(1);
    gate.release();
    await expect(
      page.getByRole("button", { name: "CM04 Ordered Saved", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const selected = page.getByRole("region", { name: "已选色组颜色" });
    await expect(selected.getByRole("listitem").nth(0)).toContainText("CM04 02");
    await expect(selected.getByRole("listitem").nth(1)).toContainText("CM04 01");
    await selected
      .getByRole("button", { name: "下一页已选", exact: true })
      .click();
    await expect(page.getByLabel("CM04 25 参考比例")).toBeVisible();
    await expect(page.getByLabel("CM04 26 参考比例")).toHaveCount(0);
    expect(api.writes).toHaveLength(1);
    const body = api.writes[0]!.body;
    const members = body.members as Array<{
      catalogId: string;
      releaseId: string;
      ratio: number | null;
    }>;
    expect(body.seriesId).toBeNull();
    const expectedOrder = [
      1,
      0,
      ...Array.from({ length: 22 }, (_, index) => index + 2),
      25,
      24,
      ...Array.from({ length: 4 }, (_, index) => index + 26),
    ];
    expect(members).toEqual(
      expectedOrder.map((index) => ({
        catalogId: cm04CatalogId(index),
        releaseId,
        ratio: index === 0 ? 0 : index === 1 ? 0.5 : index === 2 ? 1e-7 : null,
      })),
    );
  } finally {
    gate.release();
  }
});

test("theme editor keeps nine identical HEX identities distinct", async ({ page }) => {
  const colors: Cm04CatalogColor[] = Array.from({ length: 9 }, (_, index) => ({
    id: cm04CatalogId(100 + index),
    libraryKey: "tcx",
    code: `NINE ${String(index + 1).padStart(2, "0")}`,
    status: "ready",
    hex: "#AABBCC",
    hue: "blue",
    outOfGamut: false,
  }));
  const api = await installCm04Api(page, { colors });
  await openColorManagement(page);
  await page.getByRole("button", { name: "NEIHE Color", exact: true }).click();
  for (const color of colors)
    await page.getByRole("button", { name: new RegExp(color.code) }).click();
  await expect(page.getByText("9 色 · 参考比例留空不会补齐")).toBeVisible();
  await page
    .getByRole("button", { name: "移除 NINE 09 tcx", exact: true })
    .click();
  await expect(page.getByLabel(/NINE \d{2} 参考比例/)).toHaveCount(8);
  await page
    .getByRole("button", { name: "NINE 09 tcx · #AABBCC", exact: true })
    .click();
  await expect(page.getByLabel(/NINE \d{2} 参考比例/)).toHaveCount(9);
  await page.getByLabel("主题色组名称").fill("CM04 Nine Same HEX");
  await page.getByRole("button", { name: "保存色组", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "CM04 Nine Same HEX", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const members = api.writes[0]!.body.members as Array<{ catalogId: string }>;
  expect(members.map((member) => member.catalogId)).toEqual(
    colors.map((color) => color.id),
  );
  await expect(page.getByText("9 色 · 参考比例留空不会补齐")).toBeVisible();
});

test("dirty theme drafts guard internal navigation, tabs, and account close", async ({
  page,
}) => {
  const releaseId = "4".repeat(64);
  await installCm04Api(page, {
    group: {
      id: CM04_GROUP_ID.dirty,
      brandId: "neihe",
      seriesId: null,
      name: "CM04 Dirty",
      revision: 1,
      members: [cm04Member(0, releaseId)],
    },
  });
  await openColorManagement(page);
  const accountDialog = page.getByRole("dialog", {
    name: "账户面板",
    exact: true,
  });
  const name = page.getByLabel("主题色组名称");
  const discardHeading = page.getByRole("heading", {
    name: "放弃未保存的色彩管理修改？",
  });
  await page.getByRole("button", { name: "NEIHE Color", exact: true }).click();
  await page.getByRole("button", { name: "CM04 Dirty", exact: true }).click();
  await name.fill("CM04 Unsaved");
  await page.getByRole("button", { name: "编辑品牌", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  const metadataDialog = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "编辑品牌", exact: true }),
  });
  await expect(metadataDialog).toBeVisible();
  await metadataDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(metadataDialog).toHaveCount(0);
  await expect(name).toHaveValue("CM04 Dirty");
  await name.fill("CM04 Unsaved");
  await page.getByRole("button", { name: "删除色组", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "删除 CM04 Dirty？", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(name).toHaveValue("CM04 Dirty");
  await name.fill("CM04 Unsaved");
  await page.getByRole("button", { name: "Ralph Lauren", exact: true }).click();
  await expect(discardHeading).toBeVisible();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(name).toHaveValue("CM04 Unsaved");
  await page.getByRole("button", { name: "CM04 Series", exact: true }).click();
  await expect(discardHeading).toBeVisible();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(name).toHaveValue("CM04 Unsaved");
  await page.getByRole("button", { name: "新建色组", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "放弃未保存的色彩管理修改？" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(name).toHaveValue("CM04 Unsaved");
  await page.getByRole("button", { name: "新建色组", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(name).toHaveValue("");
  await name.fill("CM04 Refresh Draft");
  await page.getByRole("button", { name: "刷新目录", exact: true }).click();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(name).toHaveValue("CM04 Refresh Draft");
  await page.getByRole("button", { name: "刷新目录", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(
    page.getByText("选择左侧品牌，维护系列和主题色组。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "NEIHE Color", exact: true }).click();
  await name.fill("CM04 Brand Draft");
  await page.getByRole("button", { name: "Ralph Lauren", exact: true }).click();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(name).toHaveValue("CM04 Brand Draft");
  await page.getByRole("button", { name: "Ralph Lauren", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Ralph Lauren", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await name.fill("CM04 Tab Draft");
  await accountDialog.getByRole("tab", { name: "消耗记录", exact: true }).click();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(
    accountDialog.getByRole("tab", { name: "色彩管理", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await accountDialog.getByRole("tab", { name: "消耗记录", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(
    accountDialog.getByRole("tabpanel", { name: "消耗记录", exact: true }),
  ).toBeVisible();
  await accountDialog.getByRole("tab", { name: "色彩管理", exact: true }).click();
  await page.getByRole("button", { name: "NEIHE Color", exact: true }).click();
  await name.fill("CM04 Close Draft");
  await accountDialog
    .getByRole("button", { name: "关闭账户面板", exact: true })
    .click();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(accountDialog).toBeVisible();
  await expect(name).toHaveValue("CM04 Close Draft");
  await accountDialog
    .getByRole("button", { name: "关闭账户面板", exact: true })
    .click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(accountDialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^账户菜单：/ })).toBeFocused();
});

test("group revision conflicts keep the draft until confirmed reload", async ({
  page,
}) => {
  const releaseId = "4".repeat(64);
  const group: Cm04Group = {
    id: CM04_GROUP_ID.conflict,
    brandId: "neihe",
    seriesId: null,
    name: "CM04 Conflict",
    revision: 1,
    members: [cm04Member(0, releaseId)],
  };
  const api = await installCm04Api(page, { group });
  await page.route(
    `**/api/colors/groups/${CM04_GROUP_ID.conflict}`,
    async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: "色组版本已更新",
        code: "REVISION_CONFLICT",
      }),
    });
  });
  await openColorManagement(page);
  await page.getByRole("button", { name: "NEIHE Color", exact: true }).click();
  await page.getByRole("button", { name: "CM04 Conflict", exact: true }).click();
  const name = page.getByLabel("主题色组名称");
  await name.fill("CM04 Conflict Draft");
  await page.getByLabel("CM04 01 参考比例").fill("0.25");
  await page.getByRole("button", { name: "保存色组", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("色组版本已更新");
  await expect(name).toHaveValue("CM04 Conflict Draft");
  await expect(page.getByLabel("CM04 01 参考比例")).toHaveValue("0.25");
  await page
    .getByRole("button", { name: "重新加载服务器版本", exact: true })
    .click();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(name).toHaveValue("CM04 Conflict Draft");
  api.setGroup({ ...group, name: "CM04 Server Version", revision: 2 });
  await page
    .getByRole("button", { name: "重新加载服务器版本", exact: true })
    .click();
  await page
    .getByRole("button", { name: "放弃草稿并重新加载", exact: true })
    .click();
  await expect(page.getByLabel("主题色组名称")).toHaveValue(
    "CM04 Server Version",
  );
  await expect(page.getByLabel("CM04 01 参考比例")).toHaveValue("");
});

test("unknown new-group writes require explicit directory reconciliation", async ({
  page,
}) => {
  await installCm04Api(page);
  let attempts = 0;
  await page.route("**/api/colors/groups", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    attempts++;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "上游响应丢失", code: "UPSTREAM_LOST" }),
    });
  });
  await openColorManagement(page);
  const accountDialog = page.getByRole("dialog", {
    name: "账户面板",
    exact: true,
  });
  await page.getByRole("button", { name: "NEIHE Color", exact: true }).click();
  const name = page.getByLabel("主题色组名称");
  await name.fill("CM04 Unknown");
  await page.getByRole("button", { name: "保存色组", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("保存结果可能未知");
  await expect(page.getByRole("alert")).toContainText("上游响应丢失");
  expect(attempts).toBe(1);
  await expect(
    page.getByRole("button", { name: "保存色组", exact: true }),
  ).toBeDisabled();
  await name.fill("CM04 Unknown Edited");
  await expect(page.getByRole("alert")).toContainText("保存结果可能未知");
  await accountDialog.getByRole("tab", { name: "消耗记录", exact: true }).click();
  await expect(
    page.getByText(/必须先返回色彩管理并刷新核对服务器状态/),
  ).toBeVisible();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await page
    .getByRole("button", { name: "刷新目录并核对", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "放弃本地草稿并刷新目录？" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(name).toHaveValue("CM04 Unknown Edited");
  await page
    .getByRole("button", { name: "刷新目录并核对", exact: true })
    .click();
  await page
    .getByRole("button", { name: "放弃草稿并刷新目录", exact: true })
    .click();
  await expect(
    page.getByText("选择左侧品牌，维护系列和主题色组。", { exact: true }),
  ).toBeVisible();
  expect(attempts).toBe(1);
});

test("unknown existing-group writes require a fresh server read", async ({ page }) => {
  const releaseId = "4".repeat(64);
  const group: Cm04Group = {
    id: CM04_GROUP_ID.conflict,
    brandId: "neihe",
    seriesId: null,
    name: "CM04 Existing",
    revision: 1,
    members: [cm04Member(0, releaseId)],
  };
  await installCm04Api(page, { group });
  let attempts = 0;
  await page.route(
    `**/api/colors/groups/${CM04_GROUP_ID.conflict}`,
    async (route) => {
      if (route.request().method() !== "PUT") {
        await route.fallback();
        return;
      }
      attempts++;
      await route.fulfill({
        status: 503,
        json: { error: "现有色组响应丢失" },
      });
    },
  );
  await openColorManagement(page);
  await page.getByRole("button", { name: "NEIHE Color", exact: true }).click();
  await page.getByRole("button", { name: "CM04 Existing", exact: true }).click();
  const name = page.getByLabel("主题色组名称");
  await name.fill("CM04 Existing Edited");
  await page.getByRole("button", { name: "保存色组", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("保存结果可能未知");
  await expect(
    page.getByRole("button", { name: "保存色组", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "重新加载服务器版本", exact: true })
    .click();
  await page
    .getByRole("button", { name: "放弃草稿并重新加载", exact: true })
    .click();
  await expect(name).toHaveValue("CM04 Existing");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(attempts).toBe(1);
});

test("catalog picker pins pagination and refreshes its snapshot when filters change", async ({
  page,
}) => {
  const releaseA = "a".repeat(64);
  const releaseB = "b".repeat(64);
  let activeRelease = releaseA;
  const catalogRequests: URL[] = [];
  await page.route("**/api/colors/catalog/state", async (route) => {
    await route.fulfill({ json: { releaseId: activeRelease, revision: 1 } });
  });
  await page.route("**/api/colors/catalog/libraries?**", async (route) => {
    const requested = new URL(route.request().url()).searchParams.get("releaseId");
    await route.fulfill({
      json: {
        releaseId: requested ?? activeRelease,
        activeReleaseId: activeRelease,
        revision: 1,
        libraries: [
          { libraryKey: "tcx", total: 30, ready: 30 },
          { libraryKey: "tpg", total: 20, ready: 20 },
        ],
      },
    });
  });
  await page.route("**/api/colors/catalog?**", async (route) => {
    const url = new URL(route.request().url());
    catalogRequests.push(url);
    const releaseId = url.searchParams.get("releaseId") ?? activeRelease;
    const libraryKey = url.searchParams.get("libraryKey") ?? "tcx";
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const releaseLabel = releaseId === releaseA ? "A" : "B";
    await route.fulfill({
      json: {
        releaseId,
        activeReleaseId: activeRelease,
        revision: 1,
        total: offset === 0 ? 26 : 1,
        colors: [
          {
            id: cm04CatalogId(
              (releaseId === releaseA ? 200 : 400) +
                (libraryKey === "tpg" ? 100 : 0) +
                offset,
            ),
            libraryKey,
            code: `${releaseLabel} ${libraryKey.toUpperCase()} ${offset}`,
            status: "ready",
            hex: "#AABBCC",
            hue: "blue",
            outOfGamut: false,
          },
          {
            id: cm04CatalogId(
              (releaseId === releaseA ? 700 : 900) +
                (libraryKey === "tpg" ? 100 : 0) +
                offset,
            ),
            libraryKey,
            code: `${releaseLabel} CONFLICT ${offset}`,
            status: "conflict",
            hex: null,
            hue: null,
            outOfGamut: null,
          },
        ],
        nextOffset: offset === 0 ? 25 : null,
      },
    });
  });
  await openColorManagement(page);
  await page.getByRole("button", { name: "NEIHE Color", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /A CONFLICT 0/ }),
  ).toBeDisabled();
  await page.getByRole("button", { name: /A TCX 0/ }).click();
  await expect(page.getByText("1 色 · 参考比例留空不会补齐")).toBeVisible();
  activeRelease = releaseB;
  await page.getByRole("button", { name: "下一页色号", exact: true }).click();
  await expect.poll(() =>
    catalogRequests.some(
      (url) =>
        url.searchParams.get("releaseId") === releaseA &&
        url.searchParams.get("offset") === "25",
    ),
  ).toBe(true);
  await expect(
    page.getByText("活动主库已更新；当前结果仍固定在打开时的版本。"),
  ).toBeVisible();
  const librarySelect = page.getByLabel("色库系列", { exact: true });
  await librarySelect.click();
  const tpgOption = page.getByRole("option", { name: /tpg/i });
  await expect(tpgOption).toBeVisible();
  await tpgOption.click();
  await expect.poll(() =>
    catalogRequests.some(
      (url) =>
        url.searchParams.get("releaseId") === releaseB &&
        url.searchParams.get("libraryKey") === "tpg" &&
        url.searchParams.get("offset") === "0",
    ),
  ).toBe(true);
  await page.getByLabel("搜索 Pantone 色号").fill("19-");
  await page.getByLabel("搜索 Pantone 色号").press("Enter");
  await expect.poll(() =>
    catalogRequests.some(
      (url) =>
        url.searchParams.get("releaseId") === releaseB &&
        url.searchParams.get("libraryKey") === "tpg" &&
        url.searchParams.get("q") === "19-" &&
        url.searchParams.get("offset") === "0",
    ),
  ).toBe(true);
  await page.getByRole("button", { name: /B TPG 0/ }).click();
  const selected = page.getByRole("region", { name: "已选色组颜色" });
  await expect(selected).toContainText("A TCX 0");
  await expect(selected).toContainText("B TPG 0");
  await expect(page.getByText("2 色 · 参考比例留空不会补齐")).toBeVisible();
});

test("catalog picker retries a failed snapshot without closing the editor", async ({
  page,
}) => {
  const releaseId = "c".repeat(64);
  let failing = true;
  let catalogFailing = false;
  await page.route("**/api/colors/catalog/state", async (route) => {
    if (failing) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "CM05 主库暂不可用" }),
      });
      return;
    }
    await route.fulfill({ json: { releaseId, revision: 1 } });
  });
  await page.route("**/api/colors/catalog/libraries?**", async (route) => {
    await route.fulfill({
      json: {
        releaseId,
        activeReleaseId: releaseId,
        revision: 1,
        libraries: [{ libraryKey: "tcx", total: 1, ready: 1 }],
      },
    });
  });
  await page.route("**/api/colors/catalog?**", async (route) => {
    if (catalogFailing) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "CM05 色号分页暂不可用" }),
      });
      return;
    }
    await route.fulfill({
      json: {
        releaseId,
        activeReleaseId: releaseId,
        revision: 1,
        total: 1,
        colors: [
          {
            id: cm04CatalogId(1_100),
            libraryKey: "tcx",
            code: "11-0001 TCX",
            status: "ready",
            hex: "#FFFFFF",
            hue: "neutral",
            outOfGamut: false,
          },
        ],
        nextOffset: null,
      },
    });
  });
  await openColorManagement(page);
  await page.getByRole("button", { name: "NEIHE Color", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("CM05 主库暂不可用");
  failing = false;
  await page.getByRole("button", { name: "重试主库", exact: true }).click();
  await expect(page.getByRole("button", { name: /11-0001 TCX/ })).toBeVisible();
  catalogFailing = true;
  await page.getByLabel("搜索 Pantone 色号").fill("11-");
  await page.getByLabel("搜索 Pantone 色号").press("Enter");
  await expect(page.getByRole("alert")).toContainText("CM05 色号分页暂不可用");
  catalogFailing = false;
  await page.getByRole("button", { name: "重试主库", exact: true }).click();
  await expect(page.getByRole("button", { name: /11-0001 TCX/ })).toBeVisible();
});

test("catalog picker rejects a mismatched response and retries the pinned data", async ({
  page,
}) => {
  const releaseId = "d".repeat(64);
  let mismatched = true;
  await page.route("**/api/colors/catalog/state", async (route) => {
    await route.fulfill({ json: { releaseId, revision: 1 } });
  });
  await page.route("**/api/colors/catalog/libraries?**", async (route) => {
    await route.fulfill({
      json: {
        releaseId,
        activeReleaseId: releaseId,
        revision: 1,
        libraries: [{ libraryKey: "tcx", total: 1, ready: 1 }],
      },
    });
  });
  await page.route("**/api/colors/catalog?**", async (route) => {
    await route.fulfill({
      json: {
        releaseId: mismatched ? null : releaseId,
        activeReleaseId: releaseId,
        revision: 1,
        total: 1,
        colors: [
          {
            id: cm04CatalogId(mismatched ? 1_200 : 1_201),
            libraryKey: "tcx",
            code: mismatched ? "WRONG RELEASE" : "VERIFIED RELEASE",
            status: "ready",
            hex: "#123456",
            hue: "blue",
            outOfGamut: false,
          },
        ],
        nextOffset: null,
      },
    });
  });
  await openColorManagement(page);
  await page.getByRole("button", { name: "NEIHE Color", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("主库响应版本不一致");
  await expect(
    page.getByRole("button", { name: /WRONG RELEASE/ }),
  ).toHaveCount(0);
  mismatched = false;
  await page.getByRole("button", { name: "重试主库", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /VERIFIED RELEASE/ }),
  ).toBeVisible();
});

// Optional manual window: the normal runner still owns isolation and cleanup.
test("ego review window", async ({ page, baseURL }, info) => {
  const file = process.env.CM02_EGO_REVIEW;
  test.skip(!file, "Only enabled for an explicit local browser review");
  test.setTimeout(360_000);
  const fs = await import("node:fs/promises");
  const state = info.project.use.storageState;
  if (typeof state !== "string")
    throw new Error("Isolated auth state file required");
  await page.goto("/");
  await fs.writeFile(file!, JSON.stringify({ baseURL, storageState: state }), {
    mode: 0o600,
  });
  await expect
    .poll(
      async () => {
        try {
          await fs.access(`${file}.done`);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 300_000, intervals: [250] },
    )
    .toBe(true);
});

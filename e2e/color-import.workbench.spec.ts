import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import type {
  ColorImportListItem,
  ManagedColorImport,
} from "../src/types/brandColors";
import type { ColorImportPreviewRow } from "../src/types/colorImport";

const RELEASE_ID = "6".repeat(64);
const GROUP_ID = "00000000-0000-4000-8000-000000000061";
const CATALOG_ID = "7".repeat(64);
const CATALOG_IDS = [
  CATALOG_ID,
  "9".repeat(64),
  "a".repeat(64),
  "b".repeat(64),
];

const STATUS: ColorImportPreviewRow["status"][] = [
  "matched",
  "missing-code",
  "unmatched",
  "conflict",
  "duplicate",
  "invalid",
];

function previewRows(count: number): ColorImportPreviewRow[] {
  return Array.from({ length: count }, (_, index) => {
    const status = STATUS[index % STATUS.length]!;
    return {
      rowNumber: index + 2,
      sheetName: "Sheet1",
      rawCode: status === "missing-code" ? "" : `11-${1000 + index}.TCX`,
      rawRatio: index === 1 ? null : index === 2 ? "" : "0.38",
      sourceHex: index === 1 ? "#ECDBA5" : undefined,
      errors: status === "invalid" ? ["测试错误"] : [],
      code: status === "missing-code" ? null : `11-${1000 + index} TCX`,
      ratio: index === 1 || index === 2 ? null : 0.38,
      status,
      matchedCatalogId: status === "matched" ? CATALOG_ID : null,
      matchedColor:
        status === "matched"
          ? {
              catalogId: CATALOG_ID,
              libraryKey: "tcx",
              code: `11-${1000 + index} TCX`,
              hex: "#AA00CC" as const,
            }
          : null,
      candidates:
        status === "missing-code"
          ? [
              {
                catalogId: CATALOG_ID,
                libraryKey: "tcx",
                code: "11-1000 TCX",
                hex: "#AABBCC",
                deltaE: 1.25,
                approximate: true,
                conversionVersion: "test-v1",
              },
            ]
          : [],
    };
  });
}

function managedImport(id: string, count = 30): ManagedColorImport {
  const rows = previewRows(count);
  return {
    id,
    groupId: GROUP_ID,
    releaseId: RELEASE_ID,
    libraryKey: "tcx",
    fileHash: "8".repeat(64),
    revision: 1,
    rows,
    decisions: rows.map(() => ({ action: "pending" })),
    publishedRows: [],
  };
}

function calibrationImport(id: string): ManagedColorImport {
  const rows = previewRows(4).map((row, index) => ({
    ...row,
    status: (index === 1
      ? "missing-code"
      : index === 2
        ? "unmatched"
        : "matched") as ColorImportPreviewRow["status"],
    matchedCatalogId: index === 1 || index === 2 ? null : CATALOG_IDS[index]!,
    matchedColor:
      index === 1 || index === 2
        ? null
        : {
            catalogId: CATALOG_IDS[index]!,
            libraryKey: "tcx",
            code: `11-${1000 + index} TCX`,
            hex: `#AA${String(index).repeat(2)}CC` as `#${string}`,
          },
    candidates:
      index === 1
        ? [
            {
              catalogId: CATALOG_IDS[index]!,
              libraryKey: "tcx",
              code: `11-${1000 + index} TCX`,
              hex: "#AABBCC" as const,
              deltaE: 1.25,
              approximate: true as const,
              conversionVersion: "test-v1",
            },
          ]
        : [],
  }));
  return {
    ...managedImport(id, 1),
    rows,
    decisions: rows.map(() => ({ action: "pending" })),
  };
}

async function installImportApi(
  page: Page,
  options: {
    unknownCreate?: boolean;
    calibration?: boolean;
    delayConfirm?: boolean;
    unknownConfirm?: boolean;
    unknownUpdate?: boolean;
    staleConfirm?: boolean;
  } = {},
) {
  const imports = new Map<string, ManagedColorImport>();
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  const catalogQueries: string[] = [];
  let listReads = 0;
  let createAttempts = 0;
  let updateAttempts = 0;
  let confirmAttempts = 0;
  let groupRevision = 1;
  const publishedCatalogIds = new Set<string>();
  const receipts = new Map<
    number,
    {
      importId: string;
      groupId: string;
      groupRevision: number;
      importRevision: number;
      added: number;
    }
  >();
  let releaseConfirm: (() => void) | null = null;
  const confirmGate = new Promise<void>((resolve) => {
    releaseConfirm = resolve;
  });
  await page.route("**/api/colors/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice("/api/colors".length);
    const method = request.method();
    if (method === "GET" && path === "/catalog/state") {
      await route.fulfill({ json: { releaseId: RELEASE_ID, revision: 1 } });
      return;
    }
    if (method === "GET" && path === "/catalog/libraries") {
      await route.fulfill({
        json: {
          releaseId: RELEASE_ID,
          activeReleaseId: RELEASE_ID,
          revision: 1,
          libraries: [{ libraryKey: "tcx", total: 100, ready: 100 }],
        },
      });
      return;
    }
    if (method === "GET" && path === "/catalog") {
      catalogQueries.push(url.search);
      await route.fulfill({
        json: {
          releaseId: RELEASE_ID,
          activeReleaseId: RELEASE_ID,
          revision: 1,
          total: CATALOG_IDS.length,
          colors: CATALOG_IDS.map((id, index) => ({
            id,
            libraryKey: "tcx",
            code: `11-${1000 + index} TCX`,
            status: "ready",
            hex: `#AA${String(index).repeat(2)}CC`,
            hue: "neutral",
            outOfGamut: false,
          })),
          nextOffset: null,
        },
      });
      return;
    }
    if (method === "GET" && path === "/brands") {
      await route.fulfill({
        json: {
          items: [
            { id: "neihe", name: "NEIHE Color", kind: "neihe", revision: 1 },
          ],
          nextOffset: null,
        },
      });
      return;
    }
    if (method === "GET" && path === "/series") {
      await route.fulfill({ json: { items: [], nextOffset: null } });
      return;
    }
    if (method === "GET" && path === "/groups") {
      await route.fulfill({
        json: {
          items: [
            {
              id: GROUP_ID,
              brandId: "neihe",
              seriesId: null,
              name: "Import Target",
              revision: groupRevision,
            },
          ],
          nextOffset: null,
        },
      });
      return;
    }
    if (method === "GET" && path === `/groups/${GROUP_ID}`) {
      await route.fulfill({
        json: {
          id: GROUP_ID,
          brandId: "neihe",
          seriesId: null,
          name: "Import Target",
          revision: groupRevision,
          members: [...publishedCatalogIds].map((catalogId, index) => ({
            catalogId,
            releaseId: RELEASE_ID,
            libraryKey: "tcx",
            code: `11-${1000 + index} TCX`,
            hex: "#AA00CC",
            originalHex: null,
            ratio: null,
          })),
        },
      });
      return;
    }
    if (method === "GET" && path === "/imports") {
      listReads++;
      const limit = Number(url.searchParams.get("limit") ?? 25);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const groupId = url.searchParams.get("groupId");
      const all: ColorImportListItem[] = [...imports.values()]
        .filter((record) => !groupId || record.groupId === groupId)
        .map((record) => ({
          id: record.id,
          groupId: record.groupId,
          revision: record.revision,
          createdAt: "2026-09-14T12:00:00.000Z",
        }));
      await route.fulfill({
        json: {
          items: all.slice(offset, offset + limit),
          nextOffset: offset + limit < all.length ? offset + limit : null,
        },
      });
      return;
    }
    if (method === "POST" && path === "/imports") {
      createAttempts++;
      const body = request.postDataJSON();
      writes.push({ method, path, body });
      const record = managedImport(`import-${createAttempts}`);
      const base64 = (body as { base64?: unknown }).base64;
      if (typeof base64 === "string")
        record.fileHash = createHash("sha256")
          .update(Buffer.from(base64, "base64"))
          .digest("hex");
      imports.set(record.id, record);
      if (options.unknownCreate && createAttempts === 1) {
        await route.fulfill({ status: 503, json: { error: "上游响应丢失" } });
        return;
      }
      await route.fulfill({ status: 201, json: record });
      return;
    }
    const importMatch = path.match(/^\/imports\/([^/]+)$/);
    if (method === "GET" && importMatch) {
      const record = imports.get(decodeURIComponent(importMatch[1]!));
      await route.fulfill(
        record ? { json: record } : { status: 404, json: { error: "不存在" } },
      );
      return;
    }
    if (method === "PATCH" && importMatch) {
      updateAttempts++;
      const id = decodeURIComponent(importMatch[1]!);
      const record = imports.get(id);
      const body = request.postDataJSON() as {
        revision: number;
        decisions: ManagedColorImport["decisions"];
      };
      writes.push({ method, path, body });
      if (!options.calibration || !record) {
        await route.fulfill({ status: 400, json: { error: "CM-06 不应发布" } });
        return;
      }
      if (body.revision !== record.revision) {
        await route.fulfill({ status: 409, json: { error: "记录已更新" } });
        return;
      }
      record.decisions = structuredClone(body.decisions);
      record.revision++;
      if (options.unknownUpdate && updateAttempts === 1) {
        await route.fulfill({ status: 503, json: { error: "保存响应丢失" } });
        return;
      }
      await route.fulfill({ json: record });
      return;
    }
    const confirmMatch = path.match(/^\/imports\/([^/]+)\/confirm$/);
    if (method === "POST" && confirmMatch) {
      confirmAttempts++;
      const id = decodeURIComponent(confirmMatch[1]!);
      const record = imports.get(id);
      const body = request.postDataJSON() as {
        revision: number;
        groupRevision: number;
      };
      writes.push({ method, path, body });
      if (options.delayConfirm) await confirmGate;
      if (!options.calibration || !record) {
        await route.fulfill({ status: 400, json: { error: "CM-06 不应发布" } });
        return;
      }
      if (options.staleConfirm) {
        await route.fulfill({
          status: 409,
          json: { error: "色库已更新，请重新导入后核对" },
        });
        return;
      }
      const replay = receipts.get(body.revision);
      if (replay) {
        await route.fulfill({ json: replay });
        return;
      }
      if (
        body.revision !== record.revision ||
        body.groupRevision !== groupRevision
      ) {
        await route.fulfill({ status: 409, json: { error: "记录已更新" } });
        return;
      }
      const published = new Set(record.publishedRows);
      let added = 0;
      record.decisions.forEach((decision, index) => {
        if (decision.action !== "confirm" || published.has(index)) return;
        published.add(index);
        publishedCatalogIds.add(decision.catalogId);
        added++;
      });
      if (!added) {
        await route.fulfill({
          status: 400,
          json: { error: "没有待发布的人工确认行" },
        });
        return;
      }
      record.publishedRows = [...published].sort((a, b) => a - b);
      record.revision++;
      groupRevision++;
      const result = {
        importId: id,
        groupId: GROUP_ID,
        groupRevision,
        importRevision: record.revision,
        added,
      };
      receipts.set(body.revision, result);
      if (options.unknownConfirm && confirmAttempts === 1) {
        await route.fulfill({ status: 503, json: { error: "确认响应丢失" } });
        return;
      }
      await route.fulfill({ json: result });
      return;
    }
    await route.fulfill({
      status: 404,
      json: { error: `Unhandled ${method} ${path}` },
    });
  });
  return {
    imports,
    writes,
    catalogQueries,
    releaseConfirm() {
      releaseConfirm?.();
      releaseConfirm = null;
    },
    get listReads() {
      return listReads;
    },
    get createAttempts() {
      return createAttempts;
    },
    get updateAttempts() {
      return updateAttempts;
    },
    get confirmAttempts() {
      return confirmAttempts;
    },
    get groupRevision() {
      return groupRevision;
    },
    get publishedCatalogIds() {
      return [...publishedCatalogIds];
    },
  };
}

async function openImportPanel(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /^账户菜单：/ }).click();
  await page.getByRole("menuitem", { name: "色彩管理", exact: true }).click();
  await page.getByRole("button", { name: "NEIHE Color", exact: true }).click();
  await page
    .getByRole("button", { name: "Import Target", exact: true })
    .click();
  await page.getByRole("tab", { name: "导入校准", exact: true }).click();
}

test("XLSX upload previews every status without publishing", async ({
  page,
}) => {
  const api = await installImportApi(page);
  await openImportPanel(page);
  const input = page.getByLabel("选择 XLSX 或 ASE 文件");
  await input.setInputFiles({
    name: "palette.png",
    mimeType: "image/png",
    buffer: Buffer.from("x"),
  });
  await expect(page.getByRole("alert")).toContainText("仅支持 XLSX 与 ASE");
  await input.setInputFiles({
    name: "palette.acb",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("8BCB"),
  });
  await expect(page.getByRole("alert")).toContainText("仅支持 XLSX 与 ASE");
  await input.setInputFiles({
    name: "palette.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("synthetic-xlsx"),
  });
  await page
    .getByRole("button", { name: "上传并生成预览", exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect(page.getByRole("region", { name: "导入预览" })).toBeVisible();
  await expect(page.getByRole("article", { name: /导入行/ })).toHaveCount(25);
  const rowList = page.getByRole("region", { name: "导入颜色行列表" });
  await expect(rowList).toBeVisible();
  expect(
    await rowList.evaluate((node) => node.scrollHeight > node.clientHeight),
  ).toBe(true);
  const dialogBox = await page.getByRole("dialog").boundingBox();
  const nextPreviewBox = await page
    .getByRole("button", { name: "下一页预览", exact: true })
    .boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(
    await page
      .getByRole("dialog")
      .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
  expect(
    await rowList.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
  expect(nextPreviewBox).not.toBeNull();
  expect(nextPreviewBox!.y + nextPreviewBox!.height).toBeLessThanOrEqual(
    dialogBox!.y + dialogBox!.height,
  );
  for (const label of [
    "已匹配",
    "缺少色号",
    "未匹配",
    "存在冲突",
    "重复",
    "无效",
  ])
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText("原始 HEX：#ECDBA5", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "下一页预览", exact: true }).click();
  await expect(page.getByRole("article", { name: /导入行/ })).toHaveCount(5);
  await page
    .getByRole("button", { name: "返回上传与导入列表", exact: true })
    .click();
  await expect(page.getByLabel("选择 XLSX 或 ASE 文件")).toBeVisible();
  expect(api.createAttempts).toBe(1);
  const body = api.writes[0]!.body as Record<string, unknown>;
  expect(body).toEqual({
    groupId: GROUP_ID,
    libraryKey: "tcx",
    format: "xlsx",
    base64: Buffer.from("synthetic-xlsx").toString("base64"),
  });
  expect(
    api.writes.filter(
      (write) => write.method !== "POST" || write.path !== "/imports",
    ),
  ).toEqual([]);
});

test("upload limits locally and reconciles an unknown create from the private list", async ({
  page,
}) => {
  const api = await installImportApi(page, { unknownCreate: true });
  await openImportPanel(page);
  const input = page.getByLabel("选择 XLSX 或 ASE 文件");
  await input.setInputFiles({
    name: "oversized.ase",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
  });
  await expect(page.getByRole("alert")).toContainText("不得超过 10 MiB");
  expect(api.createAttempts).toBe(0);
  await input.setInputFiles({
    name: "palette.ase",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("ASEF"),
  });
  await page
    .getByRole("button", { name: "上传并生成预览", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("上传结果可能未知");
  await expect(
    page.getByRole("button", { name: "上传并生成预览", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "刷新导入记录并核对", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "上传并生成预览", exact: true }),
  ).toBeDisabled();
  expect(api.createAttempts).toBe(1);
  await page.getByRole("button", { name: /打开导入 import-1/ }).click();
  await expect(page.getByRole("region", { name: "导入预览" })).toBeVisible();
  await expect(page.getByText(/上传结果可能未知/)).toHaveCount(0);
  expect(api.createAttempts).toBe(1);
  expect(api.listReads).toBeGreaterThan(1);
});

test("unknown upload only unlocks after matching its file fingerprint", async ({
  page,
}) => {
  const api = await installImportApi(page, { unknownCreate: true });
  api.imports.set("older-import", managedImport("older-import", 1));
  await openImportPanel(page);
  const input = page.getByLabel("选择 XLSX 或 ASE 文件");
  await input.setInputFiles({
    name: "palette.ase",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("ASEF"),
  });
  await page
    .getByRole("button", { name: "上传并生成预览", exact: true })
    .click();
  await page
    .getByRole("button", { name: "刷新导入记录并核对", exact: true })
    .click();
  await page
    .getByRole("button", { name: "打开导入 older-import", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("与未知上传不匹配");
  await expect(
    page.getByRole("button", { name: "上传并生成预览", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "打开导入 import-1", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "导入预览" })).toContainText(
    "import-1",
  );
  await expect(page.getByText(/上传结果可能未知/)).toHaveCount(0);
  expect(api.createAttempts).toBe(1);
});

test("private import recovery pages beyond the newest 25 records", async ({
  page,
}) => {
  const api = await installImportApi(page);
  for (let index = 1; index <= 30; index++)
    api.imports.set(`history-${index}`, managedImport(`history-${index}`, 1));
  await openImportPanel(page);
  await expect(
    page.getByRole("button", { name: /打开导入 history-/ }),
  ).toHaveCount(25);
  await page
    .getByRole("button", { name: "下一页导入记录", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /打开导入 history-/ }),
  ).toHaveCount(5);
  await page
    .getByRole("button", { name: "打开导入 history-26", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "导入预览" })).toContainText(
    "history-26",
  );
  await page
    .getByRole("button", { name: "上一页导入记录", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /打开导入 history-/ }),
  ).toHaveCount(25);
});

test("five-thousand-row calibration keeps the rendered page bounded", async ({
  page,
}) => {
  const api = await installImportApi(page, { calibration: true });
  api.imports.set("large-import", managedImport("large-import", 5000));
  await openImportPanel(page);
  await page
    .getByRole("button", { name: "打开导入 large-import", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "导入颜色行列表" }).getByRole("article"),
  ).toHaveCount(25);
  await expect(page.getByText("1–25 / 5000", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下一页预览", exact: true }).click();
  await expect(page.getByText("26–50 / 5000", { exact: true })).toBeVisible();
});

test("reopening the same import synchronizes a newer server revision", async ({
  page,
}) => {
  const api = await installImportApi(page, { calibration: true });
  const record = calibrationImport("same-import");
  record.rows = record.rows.slice(0, 1);
  record.decisions = [{ action: "pending" }];
  api.imports.set(record.id, record);
  await openImportPanel(page);
  await page
    .getByRole("button", { name: "打开导入 same-import", exact: true })
    .click();
  record.revision = 2;
  record.decisions = [{ action: "skip" }];
  await page.getByRole("button", { name: "刷新导入记录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "打开导入 same-import", exact: true }),
  ).toContainText("r2");
  await page
    .getByRole("button", { name: "打开导入 same-import", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "跳过导入行 2", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "发布已确认颜色", exact: true }),
  ).toBeDisabled();
});

test("calibration saves aligned decisions and publishes in two partial commits", async ({
  page,
}) => {
  const api = await installImportApi(page, { calibration: true });
  api.imports.set("calibration-1", calibrationImport("calibration-1"));
  await openImportPanel(page);
  await page
    .getByRole("button", { name: "打开导入 calibration-1", exact: true })
    .click();
  await expect(
    page.getByText("精确匹配 · 11-1000 TCX · tcx · #AA00CC", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /使用近似候选 11-1001 TCX.*tcx.*#AABBCC.*ΔE 1.25/,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "确认导入行 2", exact: true }).click();
  await expect(
    page.getByText("已选 11-1000 TCX · tcx · #AA00CC", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("导入行 2 比例")).toHaveValue("0.38");
  await page.getByLabel("导入行 2 比例").fill("2");
  await page.getByRole("button", { name: "保存校准决定", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("0–1");
  expect(api.writes.filter((write) => write.method === "PATCH")).toHaveLength(
    0,
  );
  await page.getByLabel("导入行 2 比例").fill("0.38");
  await expect(page.getByText(/近似 · ΔE 1.25/)).toBeVisible();
  await page
    .getByRole("button", { name: /^使用近似候选 11-1001 TCX 于导入行 3/ })
    .click();
  await expect(page.getByLabel("导入行 3 比例")).toHaveValue("");
  await page.getByRole("button", { name: "跳过导入行 4", exact: true }).click();
  await page.getByRole("tab", { name: "色组编排", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("导入校准");
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await page.getByRole("button", { name: "保存校准决定", exact: true }).click();
  await page
    .getByRole("button", { name: "发布已确认颜色", exact: true })
    .click();
  await expect(
    page.getByText("本次添加 2 色。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "确认导入行 2", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: /^使用近似候选 11-1001 TCX 于导入行 3/,
    }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "保持待处理导入行 4", exact: true })
    .click();
  await page.getByRole("button", { name: "确认导入行 5", exact: true }).click();
  await page.getByRole("button", { name: "保存校准决定", exact: true }).click();
  await page
    .getByRole("button", { name: "发布已确认颜色", exact: true })
    .click();
  await expect(
    page.getByText("本次添加 1 色。", { exact: true }),
  ).toBeVisible();
  expect(api.confirmAttempts).toBe(2);
  expect(api.groupRevision).toBe(3);
  expect(api.publishedCatalogIds).toEqual([
    CATALOG_IDS[0],
    CATALOG_IDS[1],
    CATALOG_IDS[3],
  ]);
  const patches = api.writes.filter((write) => write.method === "PATCH");
  expect(patches).toHaveLength(2);
  expect((patches[1]!.body as { decisions: unknown[] }).decisions).toHaveLength(
    4,
  );
  await expect(
    page.getByRole("button", { name: "保持待处理导入行 4", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("manual master selection stays pinned to the import release and library", async ({
  page,
}) => {
  const api = await installImportApi(page, { calibration: true });
  api.imports.set("manual-1", calibrationImport("manual-1"));
  await openImportPanel(page);
  await page
    .getByRole("button", { name: "打开导入 manual-1", exact: true })
    .click();
  await page
    .getByRole("button", { name: "从主库选择导入行 4", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "色库选色" })).toBeVisible();
  expect(
    await page
      .getByRole("region", { name: "色库选色" })
      .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true);
  await page.getByRole("button", { name: /11-1002 TCX.*#AA22CC/ }).click();
  await expect(
    page.getByText("已选 11-1002 TCX · tcx · #AA22CC", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "保存校准决定", exact: true }).click();
  expect(
    api.catalogQueries.some(
      (query) =>
        query.includes(`releaseId=${RELEASE_ID}`) &&
        query.includes("libraryKey=tcx"),
    ),
  ).toBe(true);
  const patch = api.writes.find((write) => write.method === "PATCH")!;
  expect(
    (patch.body as { decisions: Array<{ catalogId?: string }> }).decisions[2]
      ?.catalogId,
  ).toBe(CATALOG_IDS[2]);
});

test("unknown confirmation replays the exact request without duplicate members", async ({
  page,
}) => {
  const api = await installImportApi(page, {
    calibration: true,
    unknownConfirm: true,
  });
  const record = calibrationImport("unknown-confirm");
  record.rows = record.rows.slice(0, 1);
  record.decisions = [{ action: "pending" }];
  api.imports.set(record.id, record);
  await openImportPanel(page);
  await page
    .getByRole("button", { name: "打开导入 unknown-confirm", exact: true })
    .click();
  await page.getByRole("button", { name: "确认导入行 2", exact: true }).click();
  await page.getByRole("button", { name: "保存校准决定", exact: true }).click();
  await page
    .getByRole("button", { name: "发布已确认颜色", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("确认结果可能未知");
  await page.getByRole("tab", { name: "色组编排", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("结果可能未知");
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await page
    .getByRole("button", { name: "重放相同确认请求", exact: true })
    .click();
  await expect(
    page.getByText("本次添加 1 色。", { exact: true }),
  ).toBeVisible();
  expect(api.confirmAttempts).toBe(2);
  expect(api.publishedCatalogIds).toEqual([CATALOG_IDS[0]]);
  const confirms = api.writes.filter((write) =>
    write.path.endsWith("/confirm"),
  );
  expect(confirms).toHaveLength(2);
  expect(confirms[1]!.body).toEqual(confirms[0]!.body);
});

test("account navigation cannot unload an in-flight confirmation", async ({
  page,
}) => {
  const api = await installImportApi(page, {
    calibration: true,
    delayConfirm: true,
  });
  const record = calibrationImport("busy-confirm");
  record.rows = record.rows.slice(0, 1);
  record.decisions = [{ action: "pending" }];
  api.imports.set(record.id, record);
  await openImportPanel(page);
  await page
    .getByRole("button", { name: "打开导入 busy-confirm", exact: true })
    .click();
  await page.getByRole("button", { name: "确认导入行 2", exact: true }).click();
  await page.getByRole("button", { name: "保存校准决定", exact: true }).click();
  await page
    .getByRole("button", { name: "发布已确认颜色", exact: true })
    .click();
  try {
    await expect(
      page.getByRole("button", { name: "发布已确认颜色", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "关闭账户面板", exact: true })
      .click();
    await expect(page.getByRole("alertdialog")).toContainText("正在提交");
    await expect(
      page.getByRole("button", { name: "放弃修改", exact: true }),
    ).toHaveCount(0);
  } finally {
    api.releaseConfirm();
  }
  await expect(
    page.getByRole("button", { name: "继续离开", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "继续离开", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("unknown calibration save reconciles from the private record before publishing", async ({
  page,
}) => {
  const api = await installImportApi(page, {
    calibration: true,
    unknownUpdate: true,
  });
  const record = calibrationImport("unknown-update");
  record.rows = record.rows.slice(0, 1);
  record.decisions = [{ action: "pending" }];
  api.imports.set(record.id, record);
  await openImportPanel(page);
  await page
    .getByRole("button", { name: "打开导入 unknown-update", exact: true })
    .click();
  await page.getByRole("button", { name: "确认导入行 2", exact: true }).click();
  await page.getByRole("button", { name: "保存校准决定", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("保存结果可能未知");
  await expect(
    page.getByRole("button", { name: "保存校准决定", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "重新读取导入与色组", exact: true })
    .click();
  await expect(
    page.getByText("已重新读取服务器记录。", { exact: true }),
  ).toBeVisible();
  expect(api.updateAttempts).toBe(1);
  await page
    .getByRole("button", { name: "发布已确认颜色", exact: true })
    .click();
  await expect(
    page.getByText("本次添加 1 色。", { exact: true }),
  ).toBeVisible();
});

test("calibration revision conflicts lock editing until explicit reload", async ({
  page,
}) => {
  const api = await installImportApi(page, { calibration: true });
  const record = calibrationImport("revision-conflict");
  record.rows = record.rows.slice(0, 1);
  record.decisions = [{ action: "pending" }];
  api.imports.set(record.id, record);
  await openImportPanel(page);
  await page
    .getByRole("button", { name: "打开导入 revision-conflict", exact: true })
    .click();
  api.imports.get(record.id)!.revision = 2;
  await page.getByRole("button", { name: "确认导入行 2", exact: true }).click();
  await page.getByRole("button", { name: "保存校准决定", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("记录已更新");
  await expect(
    page.getByRole("button", { name: "确认导入行 2", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "重新读取导入与色组", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "保持待处理导入行 2", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "确认导入行 2", exact: true }),
  ).toBeEnabled();
});

test("an old catalog preview remains visible but cannot publish", async ({
  page,
}) => {
  const api = await installImportApi(page, {
    calibration: true,
    staleConfirm: true,
  });
  const record = calibrationImport("stale-release");
  record.rows = record.rows.slice(0, 1);
  record.decisions = [{ action: "pending" }];
  api.imports.set(record.id, record);
  await openImportPanel(page);
  await page
    .getByRole("button", { name: "打开导入 stale-release", exact: true })
    .click();
  await page.getByRole("button", { name: "确认导入行 2", exact: true }).click();
  await page.getByRole("button", { name: "保存校准决定", exact: true }).click();
  await page
    .getByRole("button", { name: "发布已确认颜色", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "色库已更新，请重新导入后核对",
  );
  await expect(
    page.getByRole("button", { name: "发布已确认颜色", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("region", { name: "导入预览" })).toBeVisible();
  expect(api.publishedCatalogIds).toEqual([]);
});

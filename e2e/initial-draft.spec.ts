import { expect, test } from "./fixtures";

interface InitialDraftBody {
  draft: null | {
    id: string;
    name: string;
    revision: number;
  };
}

interface ProjectSummaryBody {
  id: string;
  name: string;
}

test("hard refresh, a second tab, and relogin restore the same initial draft", async ({ page }) => {
  const accountId = process.env.E2E_ACCOUNT_ID;
  const password = process.env.E2E_PASSWORD;
  if (!accountId || !password) throw new Error("Missing E2E login credentials");

  const readDraft = async () => {
    const response = await page.context().request.get("/api/projects/initial-draft");
    expect(response.ok()).toBeTruthy();
    return (await response.json() as InitialDraftBody).draft;
  };

  const beginRename = async (targetPage: typeof page) => {
    const tabName = targetPage.getByTitle(/双击重命名/).first();
    await expect(tabName).toBeVisible();
    await tabName.dblclick();
    const input = targetPage.getByRole("textbox", { name: "项目名称" });
    await expect(input).toBeVisible();
    return input;
  };

  // Earlier desktop/golden-path projects intentionally remain in the isolated
  // database. Seed the draft boundary when the suite has no active draft so
  // this test exercises draft recovery without depending on test ordering.
  const existingBeforeStartup = await readDraft();
  if (!existingBeforeStartup) {
    const bootstrap = await page.request.post("/api/projects/initial-draft/bootstrap", {
      data: { flow: { schemaVersion: 3, nodes: [], edges: [] } },
    });
    expect(bootstrap.ok(), await bootstrap.text()).toBeTruthy();
  }

  await page.goto("/");
  await expect.poll(readDraft, { timeout: 10_000 }).not.toBeNull();
  const initial = await readDraft();
  expect(initial).not.toBeNull();
  if (!initial) throw new Error("Initial draft was not bootstrapped");

  let draftSyncRequests = 0;
  await page.route("**/api/projects/initial-draft/*", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fallback();
      return;
    }
    draftSyncRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 900));
    await route.continue();
  });
  const canvas = page.getByRole("application", { name: "工作流画布" });
  const canvasBeforeSync = await canvas.boundingBox();
  if (!canvasBeforeSync) throw new Error("Initial draft canvas is missing");

  const editedName = `E2E 未保存草稿 ${Date.now()}`;
  const projectName = await beginRename(page);
  await projectName.fill(editedName);
  await projectName.blur();
  await expect(projectName).toBeHidden();
  await expect(page.getByTitle(`${editedName} · 双击重命名`)).toBeVisible();
  await expect.poll(() => draftSyncRequests, { timeout: 5_000 }).toBeGreaterThan(0);
  await expect(page.getByText("正在同步未保存项目…")).toHaveCount(0);
  const canvasDuringSync = await canvas.boundingBox();
  if (!canvasDuringSync) throw new Error("Initial draft canvas disappeared during sync");
  expect(Math.abs(canvasDuringSync.y - canvasBeforeSync.y)).toBeLessThan(1);
  expect(Math.abs(canvasDuringSync.height - canvasBeforeSync.height)).toBeLessThan(1);
  await expect.poll(async () => (await readDraft())?.name).toBe(editedName);
  const synchronized = await readDraft();
  expect(synchronized?.id).toBe(initial.id);

  await page.reload();
  await expect(page.getByTitle(`${editedName} · 双击重命名`)).toBeVisible();
  expect((await readDraft())?.id).toBe(initial.id);

  const secondPage = await page.context().newPage();
  await secondPage.goto("/");
  await expect(secondPage.getByTitle(`${editedName} · 双击重命名`)).toBeVisible();
  const secondTabDraft = await secondPage.context().request.get("/api/projects/initial-draft");
  expect(secondTabDraft.ok()).toBeTruthy();
  expect(((await secondTabDraft.json()) as InitialDraftBody).draft?.id).toBe(initial.id);
  await secondPage.close();

  await page.getByRole("button", { name: /^账户菜单：/ }).click();
  await page.getByRole("menuitem", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "登录服装设计工作台" })).toBeVisible();
  await page.getByRole("textbox", { name: "账号" }).fill(accountId);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();

  await expect(page.getByTitle(`${editedName} · 双击重命名`)).toBeVisible();
  const afterRelogin = await readDraft();
  expect(afterRelogin?.id).toBe(initial.id);
  expect(afterRelogin?.name).toBe(editedName);
});

test("relogin opens the latest saved project instead of bootstrapping a blank page", async ({ page }) => {
  const accountId = process.env.E2E_ACCOUNT_ID;
  const password = process.env.E2E_PASSWORD;
  if (!accountId || !password) throw new Error("Missing E2E login credentials");

  // The preceding recovery test deliberately logs out. Re-authenticate this
  // test's isolated page context instead of relying on a potentially revoked
  // storage-state session token.
  const login = await page.request.post("/api/auth/login", {
    data: { accountId, password },
  });
  expect(login.ok(), await login.text()).toBeTruthy();

  const draftResponse = await page.request.get("/api/projects/initial-draft");
  expect(draftResponse.ok()).toBeTruthy();
  const draft = (await draftResponse.json() as InitialDraftBody).draft;
  if (draft) {
    const discard = await page.request.delete(`/api/projects/initial-draft/${draft.id}`, {
      data: { confirm: true, expectedRevision: draft.revision },
    });
    expect(discard.ok(), await discard.text()).toBeTruthy();
  }

  const projectName = `E2E 最近正式项目 ${Date.now()}`;
  const createProject = await page.request.post("/api/projects", {
    data: {
      name: projectName,
      flow: { schemaVersion: 3, nodes: [], edges: [] },
    },
  });
  expect(createProject.ok(), await createProject.text()).toBeTruthy();

  await page.goto("/");
  const bootstrapRequests: string[] = [];
  await page.route("**/api/projects/initial-draft/bootstrap", async (route) => {
    bootstrapRequests.push(route.request().url());
    await route.fallback();
  });
  await page.getByRole("button", { name: /^账户菜单：/ }).click();
  await page.getByRole("menuitem", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "登录服装设计工作台" })).toBeVisible();
  await page.getByRole("textbox", { name: "账号" }).fill(accountId);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();

  await expect(page.getByTitle(`${projectName} · 双击重命名`)).toBeVisible();
  expect(bootstrapRequests).toHaveLength(0);
  const project = await page.request.get("/api/projects");
  expect(project.ok()).toBeTruthy();
  const projects = await project.json() as ProjectSummaryBody[];
  expect(projects.some((item) => item.name === projectName)).toBeTruthy();
});

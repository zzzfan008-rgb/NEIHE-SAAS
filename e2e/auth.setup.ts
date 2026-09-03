import { expect, test as setup } from "./fixtures";

interface LoginBody {
  error?: string;
  user?: { id?: string; mustChangePassword?: boolean };
}

interface TutorialBody {
  acknowledged?: boolean;
}

setup("create an authenticated desktop session", async ({ page }) => {
  const accountId = process.env.E2E_ACCOUNT_ID;
  const initialPassword = process.env.E2E_INITIAL_PASSWORD;
  const password = process.env.E2E_PASSWORD;
  const authStatePath = process.env.E2E_AUTH_STATE_PATH;
  if (!accountId || !initialPassword || !password || !authStatePath) {
    throw new Error("Missing E2E authentication environment variables");
  }

  const request = page.context().request;
  let currentPassword = password;
  let response = await request.post("/api/auth/login", {
    data: { accountId, password },
  });

  if (response.status() === 401) {
    currentPassword = initialPassword;
    response = await request.post("/api/auth/login", {
      data: { accountId, password: initialPassword },
    });
  }

  const loginBody = await response.json() as LoginBody;
  expect(response.ok(), loginBody.error ?? "E2E login failed").toBeTruthy();
  expect(loginBody.user?.id).toBeTruthy();

  if (loginBody.user?.mustChangePassword) {
    const changeResponse = await request.post("/api/auth/change-password", {
      data: { currentPassword, newPassword: password },
    });
    const changeBody = await changeResponse.json() as LoginBody;
    expect(changeResponse.ok(), changeBody.error ?? "E2E password change failed").toBeTruthy();
  }

  const meResponse = await request.get("/api/auth/me");
  const meBody = await meResponse.json() as LoginBody;
  expect(meResponse.ok(), meBody.error ?? "E2E session verification failed").toBeTruthy();
  expect(meBody.user?.mustChangePassword).toBe(false);

  await page.goto("/");
  const tutorial = page.getByRole("dialog", { name: "欢迎使用服装设计工作台" });
  const tutorialResponse = await request.get("/api/tutorials/workbench-onboarding");
  const tutorialBody = await tutorialResponse.json() as TutorialBody;
  expect(tutorialResponse.ok()).toBeTruthy();
  if (tutorialBody.acknowledged) {
    await expect(tutorial).toBeHidden();
  } else {
    await expect(tutorial).toBeVisible();
    const nextButton = tutorial.getByRole("button", { name: "下一步" });
    const completeButton = tutorial.getByRole("button", { name: "完成教程" });
    for (let step = 0; step < 8 && !await completeButton.isVisible(); step += 1) {
      await nextButton.click();
    }
    await expect(completeButton).toBeVisible();
    await completeButton.click();
  }
  await expect(tutorial).toBeHidden();
  await page.reload();
  await expect(tutorial).toBeHidden();
  await expect(page.getByRole("navigation", { name: "工作台左侧工具" })).toBeVisible();
  await page.context().storageState({ path: authStatePath });
});

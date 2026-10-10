import type { BrowserContext, Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { WORKBENCH_TUTORIAL_KEY, WORKBENCH_TUTORIAL_VERSION } from "../src/tutorials/tutorialContract";

let ordinaryCookies: Awaited<ReturnType<BrowserContext["cookies"]>> | undefined;

async function openWorkbench(page: Page) {
  if (ordinaryCookies) {
    await page.context().clearCookies();
    await page.context().addCookies(ordinaryCookies);
  } else {
    // Real ordinary account; reuse its session within this worker to respect login rate limits.
    const accountId = `ime-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const initialPassword = "Ime-test-initial-2026";
    const password = "Ime-test-changed-2026";
    expect((await page.request.post("/api/auth/users", { data: {
      accountId, displayName: "输入法普通用户", password: initialPassword, role: "user",
    } })).status()).toBe(201);
    expect((await page.request.post("/api/auth/login", { data: { accountId, password: initialPassword } })).status()).toBe(200);
    expect((await page.request.post("/api/auth/change-password", { data: { currentPassword: initialPassword, newPassword: password } })).ok()).toBeTruthy();
    expect((await (await page.request.get("/api/auth/me")).json()).user.role).toBe("user");
    expect((await page.request.post("/api/tutorials/workbench-onboarding/acknowledge", { data: {
      tutorialKey: WORKBENCH_TUTORIAL_KEY, tutorialVersion: WORKBENCH_TUTORIAL_VERSION, outcome: "completed",
    } })).ok()).toBeTruthy();
    ordinaryCookies = await page.context().cookies();
  }
  await page.route("**/api/history*", route => route.fulfill({ json: { records: [], nextCursor: null, hasMore: false } }));
  await page.goto("/");
  await expect(page.getByRole("application", { name: "工作流画布" })).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    useFlowStore.getState().loadFlow({ projectName: "输入法回归", nodes: [], edges: [] });
    useFlowStore.getState().addNode("text-input", { x: 0, y: 0 });
    useFlowStore.getState().setSelectedNodeIds([]);
  });
}

async function candidateKey(input: Locator, key: string, isComposing = false) {
  await input.dispatchEvent("keydown", { key, code: key, keyCode: 229, isComposing, bubbles: true });
}

test("text controls keep modifier keys native without changing desktop geometry", async ({ page }) => {
  await openWorkbench(page);
  const canvas = page.getByRole("application", { name: "工作流画布" });
  const before = await canvas.boundingBox();
  const nodeInput = page.getByRole("textbox", { name: "文本内容", exact: true });
  await expect(nodeInput).toBeVisible();
  await page.evaluate(() => {
    const keys: KeyboardEvent[] = [];
    (window as unknown as { imeKeys: KeyboardEvent[] }).imeKeys = keys;
    document.addEventListener("keydown", event => keys.push(event), true);
  });
  await nodeInput.focus();
  await page.keyboard.press("Shift");
  expect(await page.evaluate(() => (window as unknown as { imeKeys: KeyboardEvent[] }).imeKeys.map(e => e.defaultPrevented))).toEqual([false]);
  expect(await canvas.boundingBox()).toEqual(before);
  await page.getByRole("button", { name: "对话修改", exact: true }).click();
  const prompt = page.getByRole("textbox", { name: "对话修改指令" });
  await prompt.focus();
  await page.evaluate(() => { (window as unknown as { imeKeys: KeyboardEvent[] }).imeKeys.length = 0; });
  await page.keyboard.press("Shift");
  expect(await page.evaluate(() => (window as unknown as { imeKeys: KeyboardEvent[] }).imeKeys.map(e => e.defaultPrevented))).toEqual([false]);
  const dock = page.locator("#workbench-inspector-panel");
  await expect.poll(async () => (await dock.boundingBox())?.width).toBe(Math.max(360, Math.min(440, page.viewportSize()!.width * 0.3125)));
});

test("conversation composition Escape keeps the dock and focus; ordinary Escape still closes", async ({ page }) => {
  await openWorkbench(page);
  await page.getByRole("button", { name: "对话修改", exact: true }).click();
  const prompt = page.getByRole("textbox", { name: "对话修改指令" });
  await prompt.focus();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "nihao", selectionStart: 5, selectionEnd: 5 });
  await candidateKey(prompt, "Escape", true);
  await expect(prompt).toBeVisible();
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue("nihao");
  // Some IMEs report no composing flag; the lifecycle is still authoritative.
  await prompt.dispatchEvent("keydown", { key: "Escape", keyCode: 27, isComposing: false, bubbles: true });
  await expect(prompt).toBeVisible();
  await cdp.send("Input.insertText", { text: "你好" });
  await expect(prompt).toHaveValue("你好");
  await candidateKey(prompt, "Escape");
  await expect(prompt).toBeVisible();
  await prompt.press("Escape");
  await expect(prompt).toBeHidden();
  await cdp.detach();
});

test("project rename ignores the IME-confirming 229 Enter", async ({ page }) => {
  await openWorkbench(page);
  await page.getByRole("button", { name: "输入法回归", exact: true }).dblclick();
  const input = page.getByRole("textbox", { name: "项目名称", exact: true });
  await expect(input).toBeVisible();
  await input.fill("输入法项目");
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    const probe = window as unknown as { imeSaveCalls: number };
    probe.imeSaveCalls = 0;
    useFlowStore.setState({ saveProject: async () => { probe.imeSaveCalls++; return true; } });
  });
  await candidateKey(input, "Enter");
  expect(await page.evaluate(() => (window as unknown as { imeSaveCalls: number }).imeSaveCalls)).toBe(0);
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await input.press("Enter");
  await expect(input).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { imeSaveCalls: number }).imeSaveCalls)).toBe(1);
});

test("text editing retains native undo and ordinary save shortcuts", async ({ page }) => {
  await openWorkbench(page);
  const input = page.getByRole("textbox", { name: "文本内容", exact: true });
  await input.focus();
  await input.pressSequentially("a");
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    const probe = window as unknown as { imeSaveCalls: number };
    probe.imeSaveCalls = 0;
    useFlowStore.setState({ saveProject: async () => { probe.imeSaveCalls++; return true; } });
  });
  await input.dispatchEvent("keydown", { key: "s", keyCode: 229, ctrlKey: true, bubbles: true });
  expect(await page.evaluate(() => (window as unknown as { imeSaveCalls: number }).imeSaveCalls)).toBe(0);
  await input.press("ControlOrMeta+s");
  expect(await page.evaluate(() => (window as unknown as { imeSaveCalls: number }).imeSaveCalls)).toBe(1);
});

test("releasing a canvas modifier after focusing an editor does not leave selection stuck", async ({ page }) => {
  await openWorkbench(page);
  const canvas = page.getByRole("application", { name: "工作流画布" });
  const input = page.getByRole("textbox", { name: "文本内容", exact: true });
  const box = (await canvas.boundingBox())!;
  // The lower-right minimap is visible at larger desktop widths; drag the pane.
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.click(x, y);
  await page.keyboard.down("Shift");
  await input.focus();
  await page.keyboard.up("Shift");
  const before = (await input.boundingBox())!;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(x + 60, y - 20, { steps: 5 });
  await page.mouse.up({ button: "middle" });
  await expect.poll(async () => Math.abs((await input.boundingBox())!.x - before.x - 60)).toBeLessThan(2);
});

test("portaled color input ignores candidate Enter and retains its size", async ({ page }) => {
  await openWorkbench(page);
  await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const toolPath = "/src/lib/colorTool.ts";
    const { useFlowStore, selectActiveDocumentTarget } = await import(storePath);
    const { openColorTool } = await import(toolPath);
    openColorTool(selectActiveDocumentTarget(useFlowStore.getState()));
  });
  const dialog = page.getByRole("dialog", { name: "色彩工具", exact: true });
  const input = dialog.getByRole("textbox", { name: "颜色值", exact: true });
  await input.fill("#123456");
  await expect.poll(async () => (await input.boundingBox())?.height).toBe(36);
  await candidateKey(input, "Enter");
  await expect(input).toHaveValue("#123456");
  await expect(dialog).toContainText("已选 0/8");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(dialog).toContainText("已选 1/8");
});

for (const media of ["audio", "video"] as const) {
  test(`${media} reference only applies on ordinary Enter, not candidate confirmation`, async ({ page }) => {
    await openWorkbench(page);
    await page.evaluate(async media => {
      const path = "/src/store/flowStore.ts";
      const { useFlowStore } = await import(path);
      const kind = `${media}-input`;
      useFlowStore.getState().loadFlow({ projectName: "输入法引用", nodes: [{ id: "ime-media", type: kind,
        position: { x: 0, y: 0 }, data: { kind, label: "引用", status: "idle" } }], edges: [] });
    }, media);
    const input = page.getByRole("textbox", { name: `${media === "audio" ? "音频" : "视频"}公网地址或素材 ID` });
    await input.fill("拼音候选");
    await candidateKey(input, "Enter");
    await expect(page.locator(".gc-node-error")).toHaveCount(0);
    await input.press("Enter");
    await expect(page.locator(".gc-node-error")).toContainText("请输入 HTTPS");
  });
}

import type { Request } from "@playwright/test";
import sharp from "sharp";
import { expect, test } from "./fixtures";

const STUB_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n7sAAAAASUVORK5CYII=";

interface ProjectSaveBody {
  id: string;
  name: string;
  flow: { nodes: unknown[]; edges: unknown[] };
}

interface RunPlanBody {
  onlyNodeId: string;
  nodes: unknown[];
  edges: unknown[];
}

function postBody<T>(request: Request): T | null {
  if (request.method() !== "POST") return null;
  return request.postDataJSON() as T;
}

test("upload and text starters complete the isolated first-generation golden path", async ({ page }) => {
  const uploadImage = await sharp({
    create: { width: 96, height: 64, channels: 3, background: "#735b42" },
  }).png().toBuffer();
  const saves: ProjectSaveBody[] = [];
  const runs: RunPlanBody[] = [];
  let runSequence = 0;
  const nodeIdByRun = new Map<string, string>();

  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/projects") {
      const body = postBody<ProjectSaveBody>(request);
      if (body) saves.push(body);
    }
  });

  // Only the app's durable-run boundary is stubbed. No provider host or real AI key is reachable.
  await page.route("**/api/run-plan**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/run-plan" && request.method() === "POST") {
      const body = postBody<RunPlanBody>(request);
      if (!body) throw new Error("Missing stub run body");
      runs.push(body);
      const runId = `e2e-golden-${++runSequence}`;
      nodeIdByRun.set(runId, body.onlyNodeId);
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ runId, status: "queued" }) });
      return;
    }
    const match = pathname.match(/^\/api\/run-plan\/([^/]+)(\/events)?$/);
    if (!match) {
      await route.abort("blockedbyclient");
      return;
    }
    const runId = decodeURIComponent(match[1]);
    const nodeId = nodeIdByRun.get(runId);
    if (!nodeId) throw new Error(`Unknown stub run ${runId}`);
    if (match[2] === "/events") {
      const now = Date.now();
      const events = [
        { seq: 1, type: "node-status", nodeId, status: "running", startedAt: now },
        {
          seq: 2,
          type: "node-status",
          nodeId,
          status: "success",
          images: [STUB_IMAGE],
          model: "e2e-stub-model",
          prompts: ["isolated golden path"],
          startedAt: now,
          finishedAt: now + 25,
        },
        { seq: 3, type: "done" },
      ];
      const body = events.map((event) => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`).join("");
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
        body,
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: runId, status: "running" }) });
  });

  await page.goto("/");
  await expect(page.getByText(/正在确认运行历史|运行历史同步失败/)).toHaveCount(0);
  const initialDraftResponse = await page.context().request.get("/api/projects/initial-draft");
  expect(initialDraftResponse.ok()).toBeTruthy();
  const initialDraft = await initialDraftResponse.json() as { draft?: { id?: string } };
  expect(initialDraft.draft?.id).toBeTruthy();
  const launcher = page.getByRole("region", { name: "开始第一个创作任务" });
  await expect(launcher).toBeVisible();
  const starterTemplates = launcher.getByRole("button", { name: /使用内置模板：/ });
  const starterTemplateCount = await starterTemplates.count();
  expect(starterTemplateCount).toBeGreaterThanOrEqual(7);
  const coverImages = launcher.locator('img[aria-hidden="true"]');
  await expect(coverImages).toHaveCount(starterTemplateCount);
  await expect.poll(() => coverImages.evaluateAll((images) => images.filter((image) => {
    if (!(image instanceof HTMLImageElement)) return false;
    return image.naturalWidth > 0;
  }).length)).toBe(starterTemplateCount);
  expect(await coverImages.evaluateAll((images) => images.filter((image) => (
    image instanceof HTMLImageElement && image.currentSrc.endsWith(".webp")
  )).length)).toBeGreaterThanOrEqual(6);

  await launcher.getByRole("button", { name: "使用内置模板：草图→效果图→高清放大" }).click();
  const uploadNode = page.locator(".react-flow__node").filter({ hasText: "图片上传" });
  await expect(uploadNode).toBeVisible();
  const uploadFileChooser = page.waitForEvent("filechooser");
  await uploadNode.getByRole("button", { name: "本地上传" }).click();
  const fileChooser = await uploadFileChooser;
  const fileInput = uploadNode.locator('input[type="file"]');
  await expect(fileInput).toBeFocused();
  await fileChooser.setFiles({ name: "starter.png", mimeType: "image/png", buffer: uploadImage });
  await expect(uploadNode.getByAltText("已上传图片")).toBeVisible();

  const uploadGenerateNode = page.locator(".react-flow__node").filter({ hasText: "草图→效果图" });
  await uploadGenerateNode.getByRole("button", { name: "生成效果图" }).click();
  await expect(uploadGenerateNode.getByRole("button", { name: "生成结果 1" })).toBeVisible();
  await expect.poll(() => runs.length).toBe(1);
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].id).toBe(initialDraft.draft?.id);
  expect(runs[0].nodes).toEqual(saves[0].flow.nodes);
  expect(runs[0].edges).toEqual(saves[0].flow.edges);

  await page.getByRole("button", { name: "结果 / 记录", exact: true }).click();
  const results = page.getByRole("region", { name: "最近生成" });
  await expect(results.getByAltText("草图→效果图")).toBeVisible();
  await page.getByRole("button", { name: "收起结果与记录" }).click();

  await page.getByRole("button", { name: "打开项目中心" }).click();
  const projectCenter = page.getByRole("dialog", { name: "项目中心" });
  await expect(projectCenter).toBeVisible();
  await projectCenter.getByRole("button", { name: /新建项目/ }).click();
  await expect(launcher).toBeVisible();
  await expect(launcher.getByRole("button", { name: /使用内置模板：/ })).toHaveCount(starterTemplateCount);
  await launcher.getByRole("button", { name: "使用内置模板：文生图（服装设计）" }).click();
  const textNode = page.locator(".react-flow__node").filter({ hasText: "文生图" });
  const prompt = textNode.locator("textarea").first();
  await expect(prompt).toBeFocused();
  await expect.poll(() => page.evaluate(() => {
    const control = document.activeElement;
    return control instanceof HTMLTextAreaElement &&
      control.value.length > 0 &&
      control.selectionStart === 0 &&
      control.selectionEnd === control.value.length;
  })).toBe(true);
  await prompt.fill("极简黑白通勤女装，写实摄影，浅灰背景");
  await textNode.getByRole("button", { name: "生成效果图" }).click();
  await expect(textNode.getByRole("button", { name: "生成结果 1" })).toBeVisible();
  await expect.poll(() => runs.length).toBe(2);
  await expect.poll(() => saves.length).toBe(2);
  expect(runs[1].nodes).toEqual(saves[1].flow.nodes);
  expect(runs[1].edges).toEqual(saves[1].flow.edges);

  await page.getByRole("button", { name: "结果 / 记录", exact: true }).click();
  const textResult = results.getByAltText("文生图");
  const uploadResult = results.getByAltText("草图→效果图");
  await expect(textResult).toBeVisible();
  await expect(uploadResult).toBeVisible();

  const textResultCard = results.locator('article:has(img[alt="文生图"])');
  const uploadResultCard = results.locator('article:has(img[alt="草图→效果图"])');
  await textResultCard.hover();
  const actionBar = textResultCard.locator('div.absolute.inset-x-0.bottom-0');
  await expect(actionBar).toHaveClass(/grid-cols-2/);
  await expect(textResultCard.locator('button[title="查看"]')).toBeVisible();
  await expect(textResultCard.locator('button[title="加入对比"]')).toBeVisible();
  await expect(textResultCard.locator('a[title="下载"]')).toHaveAttribute("download", "");
  const textInputNodesBefore = await page.locator(".react-flow__node").filter({ hasText: "文生图" }).count();
  await textResultCard.locator('button[title="设为输入"]').click();
  await expect(page.locator(".react-flow__node").filter({ hasText: "文生图" })).toHaveCount(textInputNodesBefore + 1);

  await textResultCard.locator('button[title="查看"]').click();
  await expect(page.getByText(/滚轮缩放 100%/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText(/滚轮缩放 100%/)).toHaveCount(0);

  await textResultCard.locator('button[title="加入对比"]').click();
  await uploadResultCard.hover();
  await uploadResultCard.locator('button[title="加入对比"]').click();
  await results.getByRole("button", { name: "对比 2 张" }).click();
  const compareDialog = page.getByRole("dialog", { name: "结果对比" });
  await expect(compareDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(compareDialog).toHaveCount(0);
  const resultsToggle = page.getByRole("button", { name: "结果 / 记录", exact: true });
  await expect(resultsToggle).toHaveAttribute("aria-expanded", "false");
  await resultsToggle.click();

  expect(await page.locator("html").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      selector: element.getAttribute("data-theme"),
      shell: style.getPropertyValue("--gc-shell").trim(),
      panel: style.getPropertyValue("--gc-panel").trim(),
      text: style.getPropertyValue("--gc-text").trim(),
      accent: style.getPropertyValue("--gc-accent").trim(),
    };
  })).toEqual({
    selector: null,
    shell: "#101214",
    panel: "#17191c",
    text: "#e5e7eb",
    accent: "#b18745",
  });
  await textResultCard.hover();
  const viewColor = await textResultCard.locator('button[title="查看"]').evaluate((element) => getComputedStyle(element).color);
  expect(viewColor).toMatch(/rgb\(244, 244, 244\)/);
  await textResultCard.locator('button[title="查看"]').focus();
  const inputColor = await textResultCard.locator('button[title="设为输入"]').evaluate((element) => getComputedStyle(element).color);
  expect(inputColor).toMatch(/rgb\(244, 244, 244\)/);
  await page.getByRole("button", { name: "收起结果与记录" }).click();

  const canvasNodes = page.locator(".react-flow__node");
  await page.getByRole("navigation", { name: "工作台左侧工具" })
    .getByRole("button", { name: "服装设计", exact: true }).click();
  const apparelMenu = page.getByRole("menu", { name: "服装设计" });
  await apparelMenu.getByRole("menuitem", { name: /AI 改款/ }).click();
  await expect(canvasNodes).toHaveCount(3);
  await expect(page.getByRole("button", { name: "AI 改款 - 副本", exact: true })).toBeVisible();
  expect(await page.evaluate(async () => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    const state = useFlowStore.getState();
    const tab = state.tabs.find((candidate: { id: string }) => candidate.id === state.activeTabId);
    const aiNode = tab?.nodes.find((node: { id: string; data: { kind: string } }) => node.data.kind === "ai-modify");
    return {
      kinds: tab?.nodes.map((node: { data: { kind: string } }) => node.data.kind).sort(),
      incomingEdges: aiNode ? tab?.edges.filter((edge: { target: string }) => edge.target === aiNode.id).length : 0,
    };
  })).toEqual({ kinds: ["ai-modify", "image-input", "text-input"], incomingEdges: 2 });
  const clickedNode = canvasNodes.filter({ hasText: "AI 改款" });
  await expect(clickedNode.locator("textarea").first()).toBeVisible();
});

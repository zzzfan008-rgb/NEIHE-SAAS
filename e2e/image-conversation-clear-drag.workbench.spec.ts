import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * 在图片自身的可见区域内挑一个命中点：节点裁剪或悬浮浮层可能盖住中心，
 * 手势必须从图片本身开始，因此按候选比例找到第一个真正命中该图片的位置。
 */
async function canvasImagePressPoint(page: Page, image: Locator): Promise<{ x: number; y: number }> {
  const box = await image.boundingBox();
  const src = await image.getAttribute("src");
  if (!box || !src) throw new Error("画布图片不可见");
  const ratios: Array<[number, number]> = [[0.5, 0.5], [0.5, 0.35], [0.5, 0.65], [0.35, 0.5], [0.65, 0.5], [0.3, 0.3], [0.7, 0.7]];
  let point: { x: number; y: number } | null = null;
  await expect.poll(async () => {
    point = await page.evaluate(({ rect, candidates, expectedSrc }) => {
      for (const [ratioX, ratioY] of candidates) {
        const x = rect.x + rect.width * ratioX;
        const y = rect.y + rect.height * ratioY;
        const element = document.elementFromPoint(x, y);
        if (element?.tagName === "IMG" && element.getAttribute("src") === expectedSrc) return { x, y };
      }
      return null;
    }, { rect: box, candidates: ratios, expectedSrc: src });
    return point !== null;
  }, { message: "画布图片没有可右键长按的可见区域" }).toBe(true);
  if (!point) throw new Error("画布图片没有可右键长按的可见区域");
  return point;
}

/**
 * 画布图片拖入侧栏改为右键长按手势：按住超过 350ms 阈值后移动到落点再松开。
 * 左键保持给节点移动，因此这里必须使用右键。
 */
async function dragCanvasImageToDropzone(page: Page, image: Locator, dropzone: Locator) {
  const to = await dropzone.boundingBox();
  if (!to) throw new Error("对话输入区不可见");
  const pressPoint = await canvasImagePressPoint(page, image);
  const dropPoint = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  // 落点必须真的是对话输入区：弹窗退场等遮挡会让松手静默取消。
  await expect.poll(async () => page.evaluate(({ x, y }) => Boolean(
    document.elementFromPoint(x, y)?.closest('[data-canvas-image-dropzone="enabled"]'),
  ), dropPoint), { message: "对话输入区不是有效落点" }).toBe(true);
  await page.mouse.move(pressPoint.x, pressPoint.y);
  await page.mouse.down({ button: "right" });
  await page.waitForTimeout(450);
  await page.mouse.move(dropPoint.x, dropPoint.y, { steps: 8 });
  await expect(page.locator('[data-canvas-image-drag-layer="true"]')).toHaveCount(1);
  await page.mouse.up({ button: "right" });
  await expect(page.locator('[data-canvas-image-drag-layer="true"]')).toHaveCount(0);
}

const TEST_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("清空多轮历史并拖动画布图片到侧栏", async ({ page }) => {
  await page.goto("/");
  const projectResponse = await page.request.post("/api/projects", {
    data: { name: `E2E 对话拖放 ${Date.now()}`, flow: { schemaVersion: 3, nodes: [], edges: [] } },
  });
  expect(projectResponse.ok(), await projectResponse.text()).toBeTruthy();
  const project = await projectResponse.json() as { id: string };
  const files: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const response = await page.request.post("/api/files", { data: { dataUrl: TEST_IMAGE } });
    expect(response.ok(), await response.text()).toBeTruthy();
    files.push((await response.json() as { url: string }).url);
  }
  const firstConversationResponse = await page.request.post("/api/image-conversations", {
    data: { projectId: project.id, sourceRef: files[0], sourceKind: "file" },
  });
  expect(firstConversationResponse.ok(), await firstConversationResponse.text()).toBeTruthy();
  const firstConversation = await firstConversationResponse.json() as { id: string };
  const roundResponse = await page.request.post(`/api/image-conversations/${firstConversation.id}/rounds`, {
    data: {
      projectId: project.id,
      clientRequestId: `e2e-clear-${Date.now()}`,
      mode: "single",
      inputManifest: [{ role: "base", ordinal: 0, sourceRef: files[0] }],
      prompt: "历史修改指令",
      parameters: { modelId: "gpt-image-2.5-sunburst", quality: "medium", outputCount: 1, size: "2K", aspectRatio: "1:1", aspectRatioMode: "follow" },
      effectiveRequirements: {},
      incrementalRequirements: {},
    },
  });
  expect(roundResponse.ok(), await roundResponse.text()).toBeTruthy();

  await page.evaluate(async ({ projectId, imageRefs }) => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storePath);
    useFlowStore.getState().loadFlow({
        projectId,
        projectName: "对话拖放",
        markDirty: false,
        nodes: imageRefs.map((imageUrl, index) => ({
          id: `drag-source-${index}`,
          type: "image-input",
          position: { x: index * 300, y: 0 },
          data: { kind: "image-input", label: `图片 ${index + 1}`, status: "success", imageRole: "base", imageUrl },
        })),
        edges: [],
      });
    useFlowStore.getState().setSelectedNodeIds(["drag-source-0"]);
  }, { projectId: project.id, imageRefs: files });
  await expect(page.locator('.react-flow__node[data-id="drag-source-1"]')).toBeVisible();
  const conversationRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/image-conversations")) conversationRequests.push(request.url());
  });
  await page.getByRole("button", { name: "对话修改", exact: true }).click();
  const panel = page.getByTestId("image-conversation-panel");
  const history = panel.getByLabel("对话修改历史");
  const dropzone = panel.getByTestId("conversation-input-dropzone");
  const prompt = panel.getByRole("textbox", { name: "对话修改指令" });
  const clear = panel.getByRole("button", { name: "清空", exact: true });
  const send = panel.getByRole("button", { name: "发送", exact: true });
  await expect(history.getByText("历史修改指令")).toBeVisible();
  const [panelBox, dropBox, clearBox, sendBox] = await Promise.all([
    panel.boundingBox(), dropzone.boundingBox(), clear.boundingBox(), send.boundingBox(),
  ]);
  expect(panelBox && dropBox && clearBox && sendBox).toBeTruthy();
  expect(dropBox!.x).toBeGreaterThanOrEqual(panelBox!.x);
  expect(dropBox!.x + dropBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width + 1);
  expect(clearBox!.x + clearBox!.width).toBeLessThanOrEqual(sendBox!.x + 1);
  expect(sendBox!.x + sendBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);

  await prompt.fill("保留的未发送指令");
  await clear.click();
  const clearDialog = page.getByRole("alertdialog");
  await expect(clearDialog.getByRole("heading", { name: "清空当前对话历史？" })).toBeVisible();
  await clearDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(clearDialog).toHaveCount(0);
  await expect(history.getByText("历史修改指令")).toBeVisible();
  await clear.click();
  await clearDialog.getByRole("button", { name: "清空历史" }).click();
  await expect(clearDialog).toHaveCount(0);
  await expect(history.getByText("历史修改指令")).toHaveCount(0);
  await expect(prompt).toHaveValue("保留的未发送指令");
  const cleared = await page.evaluate(async () => {
    const flowStorePath = "/src/store/flowStore.ts";
    const conversationStorePath = "/src/store/imageConversationStore.ts";
    const { selectActiveDocumentTarget, useFlowStore } = await import(flowStorePath);
    const { getImageConversationTargetState, useImageConversationStore } = await import(conversationStorePath);
    const state = getImageConversationTargetState(useImageConversationStore.getState(), selectActiveDocumentTarget(useFlowStore.getState()));
    return { id: state?.conversation?.id, rounds: state?.conversation?.rounds.length, base: state?.modeDrafts.single.inputs[0]?.sourceRef };
  });
  expect(cleared.id).not.toBe(firstConversation.id);
  expect(cleared).toMatchObject({ rounds: 0, base: files[0] });

  const secondImage = page.locator('.react-flow__node[data-id="drag-source-1"] img[alt="已上传图片"]');
  await dragCanvasImageToDropzone(page, secondImage, dropzone);
  const replaceDialog = page.getByRole("alertdialog");
  await expect(replaceDialog.getByRole("heading", { name: "更换当前模式底图？" })).toBeVisible();
  await replaceDialog.getByRole("button", { name: "取消切换" }).click();
  await expect(replaceDialog).toHaveCount(0);
  await expect(prompt).toHaveValue("保留的未发送指令");
  await dragCanvasImageToDropzone(page, secondImage, dropzone);
  await replaceDialog.getByRole("button", { name: "更换底图并清空当前模式草稿" }).click();
  await expect(prompt).toHaveValue("");
  await expect(dropzone.locator("img")).toHaveAttribute("src", files[1]);

  await panel.getByRole("tab", { name: "多图融合" }).click();
  const firstImage = page.locator('.react-flow__node[data-id="drag-source-0"] img[alt="已上传图片"]');
  await dragCanvasImageToDropzone(page, firstImage, dropzone);
  await dragCanvasImageToDropzone(page, secondImage, dropzone);
  await expect(dropzone.locator("img")).toHaveCount(2);
  await panel.getByRole("tab", { name: "局部重绘" }).click();
  await page.evaluate(async (baseRef) => {
    const flowStorePath = "/src/store/flowStore.ts";
    const conversationStorePath = "/src/store/imageConversationStore.ts";
    const { selectActiveDocumentTarget, useFlowStore } = await import(flowStorePath);
    const { useImageConversationStore } = await import(conversationStorePath);
    useImageConversationStore.getState().updateDraft(selectActiveDocumentTarget(useFlowStore.getState()), "mask", {
      inputs: [{ role: "base", ordinal: 0, sourceRef: baseRef }],
      maskSourceRef: "/api/files/mask-placeholder",
    });
  }, files[0]);
  await expect(panel.getByText("蒙版已绑定当前底图")).toBeVisible();
  await dragCanvasImageToDropzone(page, secondImage, dropzone);
  await replaceDialog.getByRole("button", { name: "更换底图并清空当前模式草稿" }).click();
  await expect(panel.getByText("请在底图上绘制蒙版")).toBeVisible();
  await expect(dropzone.locator("img")).toHaveAttribute("src", files[1]);
  expect(conversationRequests.some((url) => url.includes("/rounds/plan"))).toBe(false);
});

test("生成缩略图和结果节点图片可拖入融合输入", async ({ page }) => {
  await page.goto("/");
  const projectResponse = await page.request.post("/api/projects", {
    data: { name: `E2E 结果拖放 ${Date.now()}`, flow: { schemaVersion: 3, nodes: [], edges: [] } },
  });
  expect(projectResponse.ok(), await projectResponse.text()).toBeTruthy();
  const project = await projectResponse.json() as { id: string };
  const files: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const response = await page.request.post("/api/files", { data: { dataUrl: TEST_IMAGE } });
    expect(response.ok(), await response.text()).toBeTruthy();
    files.push((await response.json() as { url: string }).url);
  }
  const ids = await page.evaluate(async ({ projectId, imageRefs }) => {
    const storePath = "/src/store/flowStore.ts";
    const landingPath = "/src/lib/canvasLanding.ts";
    const { useFlowStore } = await import(storePath);
    const { requestCanvasLanding } = await import(landingPath);
    const store = useFlowStore.getState();
    store.loadFlow({ projectId, projectName: "结果拖放", markDirty: false, nodes: [], edges: [] });
    const outputId = useFlowStore.getState().addNode("upscale", { x: 0, y: 0 });
    const resultId = useFlowStore.getState().addNode("result", { x: 350, y: 0 });
    if (!outputId || !resultId) throw new Error("无法建立测试节点");
    useFlowStore.getState().updateNodeData(outputId, { outputImages: [imageRefs[0]], status: "success" });
    useFlowStore.getState().updateNodeData(resultId, { images: [imageRefs[1]], status: "success" });
    useFlowStore.getState().setSelectedNodeIds([]);
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, fitView: true });
    return { outputId, resultId };
  }, { projectId: project.id, imageRefs: files });
  await page.getByRole("button", { name: "对话修改", exact: true }).click();
  const panel = page.getByTestId("image-conversation-panel");
  await panel.getByRole("tab", { name: "多图融合" }).click();
  await page.getByRole("button", { name: "适应画布" }).click();
  const dropzone = panel.getByTestId("conversation-input-dropzone");
  const outputImage = page.locator(`.react-flow__node[data-id="${ids.outputId}"] img[alt="生成结果 1"]`);
  const resultImage = page.locator(`.react-flow__node[data-id="${ids.resultId}"] .gc-result-image img`);
  await expect(outputImage).toBeVisible();
  await expect(resultImage).toBeVisible();
  await dragCanvasImageToDropzone(page, outputImage, dropzone);
  await expect(dropzone.locator("img")).toHaveCount(1);
  await expect(dropzone.locator("img").first()).toHaveAttribute("src", files[0]);
  await dragCanvasImageToDropzone(page, resultImage, dropzone);
  await expect(dropzone.locator("img")).toHaveCount(2);
  await expect(dropzone.locator("img").nth(1)).toHaveAttribute("src", files[1]);
});

test("左键在画布图片上拖动只移动节点，不进入图片拖拽", async ({ page }) => {
  await page.goto("/");
  const projectResponse = await page.request.post("/api/projects", {
    data: { name: `E2E 左键拖节点 ${Date.now()}`, flow: { schemaVersion: 3, nodes: [], edges: [] } },
  });
  expect(projectResponse.ok(), await projectResponse.text()).toBeTruthy();
  const project = await projectResponse.json() as { id: string };
  const fileResponse = await page.request.post("/api/files", { data: { dataUrl: TEST_IMAGE } });
  expect(fileResponse.ok(), await fileResponse.text()).toBeTruthy();
  const image = (await fileResponse.json() as { url: string }).url;
  await page.evaluate(async ({ projectId, imageUrl }) => {
    const storePath = "/src/store/flowStore.ts";
    const landingPath = "/src/lib/canvasLanding.ts";
    const { useFlowStore } = await import(storePath);
    const { requestCanvasLanding } = await import(landingPath);
    useFlowStore.getState().loadFlow({
      projectId, projectName: "左键拖节点", markDirty: false,
      nodes: [{
        id: "left-drag-image", type: "image-input", position: { x: 0, y: 0 },
        data: { kind: "image-input", label: "主穿搭图（必需）", status: "success", imageRole: "base", imageUrl },
      }],
      edges: [],
    });
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, fitView: true });
  }, { projectId: project.id, imageUrl: image });

  const node = page.locator('.react-flow__node[data-id="left-drag-image"]');
  const canvasImage = node.locator('img[alt="已上传图片"]');
  await expect(canvasImage).toBeVisible();
  const before = await node.boundingBox();
  const from = await canvasImage.boundingBox();
  if (!before || !from) throw new Error("画布节点或图片不可见");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 140, from.y + from.height / 2 + 80, { steps: 10 });
  await expect(page.locator('[data-canvas-image-drag-layer="true"]')).toHaveCount(0);
  await page.mouse.up();
  const after = await node.boundingBox();
  expect(after!.x - before.x).toBeGreaterThan(60);
  expect(after!.y - before.y).toBeGreaterThan(30);
});

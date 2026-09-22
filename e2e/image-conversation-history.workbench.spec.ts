import { expect, test } from "./fixtures";

const TEST_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("persisted conversation history restores snapshots and collapsed parameters", async ({ page }) => {
  await page.goto("/");

  const projectResponse = await page.request.post("/api/projects", {
    data: {
      name: `E2E 对话历史 ${Date.now()}`,
      flow: { schemaVersion: 3, nodes: [], edges: [] },
    },
  });
  expect(projectResponse.ok(), await projectResponse.text()).toBeTruthy();
  const project = await projectResponse.json() as { id: string };

  const fileResponse = await page.request.post("/api/files", {
    data: { dataUrl: TEST_IMAGE },
  });
  expect(fileResponse.ok(), await fileResponse.text()).toBeTruthy();
  const file = await fileResponse.json() as { url: string };

  const conversationResponse = await page.request.post("/api/image-conversations", {
    data: { projectId: project.id, sourceRef: file.url, sourceKind: "file" },
  });
  expect(conversationResponse.ok(), await conversationResponse.text()).toBeTruthy();
  const conversation = await conversationResponse.json() as { id: string };

  const roundResponse = await page.request.post(`/api/image-conversations/${conversation.id}/rounds`, {
    data: {
      projectId: project.id,
      clientRequestId: `e2e-history-${Date.now()}`,
      mode: "mask",
      inputManifest: [{ role: "base", ordinal: 0, sourceRef: file.url }],
      prompt: "保留原始版型，改为深蓝色牛仔面料",
      parameters: {
        modelId: "gpt-image-2.5-sunburst",
        quality: "medium",
        outputCount: 1,
        size: "2K",
        aspectRatio: "1:1",
        aspectRatioMode: "follow",
      },
      effectiveRequirements: {},
      incrementalRequirements: {},
      maskRef: file.url,
    },
  });
  expect(roundResponse.ok(), await roundResponse.text()).toBeTruthy();

  await page.evaluate(async ({ projectId, fileUrl }) => {
    const storePath = "/src/store/flowStore.ts";
    const landingPath = "/src/lib/canvasLanding.ts";
    const { useFlowStore } = await import(storePath);
    const { requestCanvasLanding } = await import(landingPath);
    useFlowStore.getState().loadFlow({
      projectId,
      projectName: "持久化对话历史",
      markDirty: false,
      nodes: [{
        id: "conversation-history-source",
        type: "image-input",
        position: { x: 0, y: 0 },
        data: {
          kind: "image-input",
          label: "持久化对话底图",
          status: "success",
          imageRole: "base",
          imageUrl: fileUrl,
          imageConversationSourceRef: fileUrl,
        },
      }],
      edges: [],
    });
    useFlowStore.getState().setSelectedNodeIds(["conversation-history-source"]);
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, nodeId: "conversation-history-source", fitView: true });
  }, { projectId: project.id, fileUrl: file.url });

  await page.getByRole("button", { name: "对话修改", exact: true }).click();
  const panel = page.getByTestId("image-conversation-panel");
  const history = panel.getByLabel("对话修改历史");
  await expect(panel.getByRole("heading", { name: "对话修改" })).toBeVisible();
  await expect(history.getByText("第 1 轮 · 局部重绘")).toBeVisible();
  await expect(history.getByText("保留原始版型，改为深蓝色牛仔面料")).toBeVisible();
  await expect(history.getByText("草稿")).toBeVisible();

  const snapshot = history.getByTestId("conversation-input-snapshot");
  await expect(snapshot.getByRole("img", { name: "底图" })).toBeVisible();
  await expect(snapshot.getByRole("img", { name: "蒙版" })).toBeVisible();
  await expect(snapshot.getByText("本轮使用的蒙版")).toBeVisible();

  const parameters = history.getByTestId("conversation-round-parameters");
  await expect(parameters.getByText("图片模型")).toHaveCount(0);
  await parameters.getByRole("button", { name: /本轮参数/ }).click();
  await expect(parameters.getByText("GPT-Image 2.5 Sunburst")).toBeVisible();
  await expect(parameters.getByText("medium")).toBeVisible();
  await expect(parameters.getByText("跟随底图（1:1）")).toBeVisible();

  // Re-opening the Dock must resolve the server history again instead of only
  // relying on the in-memory conversation store.
  await page.getByRole("button", { name: "对话修改", exact: true }).click();
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "对话修改", exact: true }).click();
  await expect(history.getByText("第 1 轮 · 局部重绘")).toBeVisible();
  await expect(history.getByText("保留原始版型，改为深蓝色牛仔面料")).toBeVisible();
});

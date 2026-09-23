import { expect, test } from "./fixtures";

const TEST_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("start-new upload creates an independent conversation and preserves the original draft", async ({ page }) => {
  await page.goto("/");

  const projectResponse = await page.request.post("/api/projects", {
    data: {
      name: `E2E 开始新修改 ${Date.now()}`,
      flow: { schemaVersion: 3, nodes: [], edges: [] },
    },
  });
  expect(projectResponse.ok(), await projectResponse.text()).toBeTruthy();
  const project = await projectResponse.json() as { id: string };

  const fileResponse = await page.request.post("/api/files", { data: { dataUrl: TEST_IMAGE } });
  expect(fileResponse.ok(), await fileResponse.text()).toBeTruthy();
  const originalFile = await fileResponse.json() as { url: string };

  const conversationResponse = await page.request.post("/api/image-conversations", {
    data: { projectId: project.id, sourceRef: originalFile.url, sourceKind: "file" },
  });
  expect(conversationResponse.ok(), await conversationResponse.text()).toBeTruthy();
  const originalConversation = await conversationResponse.json() as { id: string };

  await page.evaluate(async ({ projectId, fileUrl }) => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storePath);
    useFlowStore.getState().loadFlow({
      projectId,
      projectName: "开始新修改来源隔离",
      markDirty: false,
      nodes: [{
        id: "original-conversation-source",
        type: "image-input",
        position: { x: 0, y: 0 },
        data: {
          kind: "image-input",
          label: "原对话底图",
          status: "success",
          imageRole: "base",
          imageUrl: fileUrl,
          imageConversationSourceRef: fileUrl,
        },
      }],
      edges: [],
    });
    useFlowStore.getState().setSelectedNodeIds(["original-conversation-source"]);
  }, { projectId: project.id, fileUrl: originalFile.url });

  const conversationRequests: Array<{ method: string; path: string; body: string }> = [];
  page.on("request", (request) => {
    if (!request.url().includes("/api/image-conversations")) return;
    conversationRequests.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      body: request.postData() ?? "",
    });
  });

  await page.getByRole("button", { name: "对话修改", exact: true }).click();
  const panel = page.getByTestId("image-conversation-panel");
  const prompt = panel.getByRole("textbox", { name: "对话修改指令" });
  await expect(prompt).toBeVisible();
  await prompt.fill("原对话未发送草稿");

  await panel.getByRole("button", { name: "开始新修改·上传", exact: true }).click();
  const upload = panel.getByLabel("上传对话修改图片");
  const startNewResponse = page.waitForResponse((response) => (
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/api/image-conversations"
  ));
  await upload.setInputFiles({
    name: "independent-new-base.png",
    mimeType: "image/png",
    buffer: Buffer.from(TEST_IMAGE.split(",")[1], "base64"),
  });
  const createdResponse = await startNewResponse;
  expect(createdResponse.ok(), await createdResponse.text()).toBeTruthy();
  const createdConversation = await createdResponse.json() as { id: string };

  const afterStartNew = await page.evaluate(async () => {
    const flowStorePath = "/src/store/flowStore.ts";
    const conversationStorePath = "/src/store/imageConversationStore.ts";
    const { selectActiveDocumentTarget, useFlowStore } = await import(flowStorePath);
    const { getImageConversationTargetState, useImageConversationStore } = await import(conversationStorePath);
    const target = selectActiveDocumentTarget(useFlowStore.getState());
    const state = getImageConversationTargetState(useImageConversationStore.getState(), target);
    return {
      conversationId: state?.conversation?.id,
      sourceRef: state?.modeDrafts.single.inputs[0]?.sourceRef,
      prompt: state?.modeDrafts.single.prompt,
    };
  });
  expect(createdConversation.id).not.toBe(originalConversation.id);
  expect(afterStartNew).toMatchObject({
    conversationId: createdConversation.id,
    prompt: "",
  });
  expect(afterStartNew.sourceRef).toMatch(/^\/api\/files\/[A-Za-z0-9_-]+\.png$/);

  // 入口按钮在 dock 展开时隐藏，改为先关闭再重开：重开时按所指图片（原底图）恢复原对话草稿。
  await page.getByRole("button", { name: "关闭对话修改" }).click();
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "对话修改", exact: true }).click();
  await expect(prompt).toHaveValue("原对话未发送草稿");

  const restored = await page.evaluate(async () => {
    const flowStorePath = "/src/store/flowStore.ts";
    const conversationStorePath = "/src/store/imageConversationStore.ts";
    const { selectActiveDocumentTarget, useFlowStore } = await import(flowStorePath);
    const { getImageConversationTargetState, useImageConversationStore } = await import(conversationStorePath);
    const target = selectActiveDocumentTarget(useFlowStore.getState());
    const state = getImageConversationTargetState(useImageConversationStore.getState(), target);
    return {
      conversationId: state?.conversation?.id,
      sourceRef: state?.modeDrafts.single.inputs[0]?.sourceRef,
      prompt: state?.modeDrafts.single.prompt,
    };
  });
  expect(restored).toEqual({
    conversationId: originalConversation.id,
    sourceRef: originalFile.url,
    prompt: "原对话未发送草稿",
  });
  expect(conversationRequests.some((request) => request.path.endsWith("/rounds/plan"))).toBe(false);
  expect(conversationRequests.some((request) => request.path === "/api/image-conversations" && JSON.parse(request.body).startNew === true)).toBe(true);
});

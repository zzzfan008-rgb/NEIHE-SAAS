import { expect, test } from "./fixtures";

const TEST_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("conversation result actions continue from a result and add it without auto-generating", async ({ page }) => {
  await page.goto("/");

  const projectResponse = await page.request.post("/api/projects", {
    data: {
      name: `E2E 对话结果操作 ${Date.now()}`,
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
  const conversation = await conversationResponse.json() as {
    id: string;
    ownerId: string;
  };

  await page.evaluate(async ({ projectId, fileUrl }) => {
    const storePath = "/src/store/flowStore.ts";
    const { selectActiveDocumentTarget, useFlowStore } = await import(storePath);
    useFlowStore.getState().loadFlow({
      projectId,
      projectName: "对话结果操作",
      markDirty: false,
      nodes: [{
        id: "conversation-result-source",
        type: "image-input",
        position: { x: 0, y: 0 },
        data: {
          kind: "image-input",
          label: "原始底图",
          status: "success",
          imageRole: "base",
          imageUrl: fileUrl,
          imageConversationSourceRef: fileUrl,
        },
      }],
      edges: [],
    });
    useFlowStore.getState().setSelectedNodeIds(["conversation-result-source"]);
    selectActiveDocumentTarget(useFlowStore.getState());
  }, { projectId: project.id, fileUrl: file.url });

  await page.getByRole("button", { name: "对话修改", exact: true }).click();
  const panel = page.getByTestId("image-conversation-panel");
  await expect(panel).toBeVisible();

  await page.evaluate(async ({ conversationId, ownerId, projectId, fileUrl }) => {
    const storePath = "/src/store/flowStore.ts";
    const conversationStorePath = "/src/store/imageConversationStore.ts";
    const { selectActiveDocumentTarget, useFlowStore } = await import(storePath);
    const { useImageConversationStore } = await import(conversationStorePath);
    const target = selectActiveDocumentTarget(useFlowStore.getState());
    const now = new Date().toISOString();
    const roundId = "e2e-result-round";
    const intentId = "e2e-result-intent";
    useImageConversationStore.getState().setConversation(target, {
      id: conversationId,
      ownerId,
      projectId,
      sourceRef: fileUrl,
      sourceKind: "file",
      status: "active",
      createdAt: now,
      updatedAt: now,
      sourcePreviews: { [fileUrl]: fileUrl },
      rounds: [{
        id: roundId,
        conversationId,
        ownerId,
        projectId,
        ordinal: 1,
        clientRequestId: "e2e-result-request",
        mode: "single",
        sourceResultId: null,
        inputManifest: [{ role: "base", ordinal: 0, sourceRef: fileUrl }],
        prompt: "保留版型，调整面料质感",
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
        maskRef: null,
        status: "succeeded",
        createdAt: now,
        updatedAt: now,
        intents: [{
          id: intentId,
          roundId,
          conversationId,
          ordinal: 1,
          label: "面料质感",
          instruction: "保留版型，调整面料质感",
          requirements: {},
          status: "succeeded",
          createdAt: now,
          updatedAt: now,
          attempts: [],
        }],
        clarification: null,
      }],
      outputs: [{
        id: "e2e-result-output",
        roundId,
        conversationId,
        intentId,
        ownerId,
        projectId,
        generationOutputId: null,
        imageRef: fileUrl,
        status: "ready",
        prompt: "保留版型，调整面料质感",
        error: null,
        createdAt: now,
      }],
    });
    useImageConversationStore.getState().setSourcePreview(target, fileUrl, fileUrl);
  }, {
    conversationId: conversation.id,
    ownerId: conversation.ownerId,
    projectId: project.id,
    fileUrl: file.url,
  });

  const history = panel.getByLabel("对话修改历史");
  await expect(history.getByText("保留版型，调整面料质感").first()).toBeVisible();
  await expect(history.getByRole("button", { name: "继续修改" })).toBeVisible();
  await expect(history.getByRole("button", { name: "加入画布" })).toBeVisible();

  await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const conversationStorePath = "/src/store/imageConversationStore.ts";
    const { selectActiveDocumentTarget, useFlowStore } = await import(storePath);
    const { useImageConversationStore } = await import(conversationStorePath);
    useImageConversationStore.getState().updateDraft(
      selectActiveDocumentTarget(useFlowStore.getState()),
      "single",
      {
        inputs: [{ role: "base", ordinal: 0, sourceRef: "/api/files/unsent-conflicting-base.png" }],
        prompt: "未发送草稿不得丢失",
      },
    );
  });
  await expect(panel.getByRole("textbox", { name: "对话修改指令" })).toHaveValue("未发送草稿不得丢失");
  await history.getByRole("button", { name: "继续修改" }).click();
  const sourceSwitch = page.getByRole("alertdialog");
  await expect(sourceSwitch.getByRole("heading", { name: "更换当前模式底图？" })).toBeVisible();
  await expect(sourceSwitch).toContainText("取消会保留草稿");
  await sourceSwitch.getByRole("button", { name: "取消切换", exact: true }).click();
  await expect(sourceSwitch).toHaveCount(0);
  await expect(panel.getByRole("textbox", { name: "对话修改指令" })).toHaveValue("未发送草稿不得丢失");
  const draftAfterCancel = await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const conversationStorePath = "/src/store/imageConversationStore.ts";
    const { selectActiveDocumentTarget, useFlowStore } = await import(storePath);
    const { getImageConversationTargetState, useImageConversationStore } = await import(conversationStorePath);
    const target = selectActiveDocumentTarget(useFlowStore.getState());
    const draft = getImageConversationTargetState(useImageConversationStore.getState(), target)?.modeDrafts.single;
    return { sourceRef: draft?.inputs[0]?.sourceRef, prompt: draft?.prompt };
  });
  expect(draftAfterCancel).toEqual({
    sourceRef: "/api/files/unsent-conflicting-base.png",
    prompt: "未发送草稿不得丢失",
  });

  await history.getByRole("button", { name: "继续修改" }).click();
  await expect(sourceSwitch.getByRole("button", { name: "更换底图并清空当前模式草稿" })).toBeVisible();
  await sourceSwitch.getByRole("button", { name: "更换底图并清空当前模式草稿" }).click();
  await expect(sourceSwitch).toHaveCount(0);
  await history.getByRole("button", { name: "继续修改" }).click();
  await expect(panel.getByRole("textbox", { name: "对话修改指令" })).toHaveValue("");
  const continuedSource = await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const conversationStorePath = "/src/store/imageConversationStore.ts";
    const { selectActiveDocumentTarget, useFlowStore } = await import(storePath);
    const { getImageConversationTargetState, useImageConversationStore } = await import(conversationStorePath);
    const target = selectActiveDocumentTarget(useFlowStore.getState());
    return getImageConversationTargetState(useImageConversationStore.getState(), target)?.modeDrafts.single.inputs[0]?.sourceRef;
  });
  expect(continuedSource).toBe(file.url);

  await history.getByRole("button", { name: "加入画布" }).click();
  const canvasState = await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { selectActiveNodes, useFlowStore } = await import(storePath);
    const state = useFlowStore.getState();
    const nodes = selectActiveNodes(state) as Array<{
      id: string;
      data: {
        kind: string;
        imageUrl?: string;
        imageConversationId?: string;
        imageConversationSourceRef?: string;
      };
    }>;
    return nodes.map((node) => ({
      id: node.id,
      kind: node.data.kind,
      imageUrl: node.data.kind === "image-input" ? node.data.imageUrl : undefined,
      conversationId: node.data.kind === "image-input" ? node.data.imageConversationId : undefined,
      sourceRef: node.data.kind === "image-input" ? node.data.imageConversationSourceRef : undefined,
    }));
  });
  expect(canvasState).toHaveLength(2);
  expect(canvasState.filter((node) => node.conversationId === conversation.id)).toHaveLength(1);
  expect(canvasState.find((node) => node.conversationId === conversation.id)).toMatchObject({
    kind: "image-input",
    imageUrl: file.url,
    sourceRef: file.url,
  });
});

import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const TEST_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

type StoredFile = { url: string };

async function createConversationProject(page: Page, name: string, files: StoredFile[]) {
  const projectResponse = await page.request.post("/api/projects", {
    data: {
      name: `${name} ${Date.now()}`,
      flow: { schemaVersion: 3, nodes: [], edges: [] },
    },
  });
  expect(projectResponse.ok(), await projectResponse.text()).toBeTruthy();
  const project = await projectResponse.json() as { id: string };

  await page.evaluate(async ({ projectId, fileUrls }) => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storePath);
    useFlowStore.getState().loadFlow({
      projectId,
      projectName: "对话修改契约验收",
      markDirty: false,
      nodes: fileUrls.map((fileUrl, index) => ({
        id: `conversation-contract-source-${index + 1}`,
        type: "image-input" as const,
        position: { x: index * 360, y: 0 },
        data: {
          kind: "image-input" as const,
          label: `契约底图 ${index + 1}`,
          status: "success" as const,
          imageRole: index === 0 ? "base" as const : "reference" as const,
          imageUrl: fileUrl,
          imageConversationSourceRef: fileUrl,
        },
      })),
      edges: [],
    });
    useFlowStore.getState().setSelectedNodeIds(["conversation-contract-source-1"]);
  }, { projectId: project.id, fileUrls: files.map((file) => file.url) });

  return project;
}

async function uploadFiles(page: Page, count: number): Promise<StoredFile[]> {
  const responses = await Promise.all(
    Array.from({ length: count }, () => page.request.post("/api/files", { data: { dataUrl: TEST_IMAGE } })),
  );
  for (const response of responses) expect(response.ok(), await response.text()).toBeTruthy();
  return Promise.all(responses.map((response) => response.json() as Promise<StoredFile>));
}

async function readDraftState(page: Page) {
  return page.evaluate(async () => {
    const flowStorePath = "/src/store/flowStore.ts";
    const conversationStorePath = "/src/store/imageConversationStore.ts";
    const { selectActiveDocumentTarget, useFlowStore } = await import(flowStorePath);
    const { getImageConversationTargetState, useImageConversationStore } = await import(conversationStorePath);
    const target = selectActiveDocumentTarget(useFlowStore.getState());
    const state = getImageConversationTargetState(useImageConversationStore.getState(), target);
    return {
      mode: state?.mode,
      conversationId: state?.conversation?.id,
      single: state?.modeDrafts.single,
      fusion: state?.modeDrafts.fusion,
      mask: state?.modeDrafts.mask,
    };
  });
}

test("conversation composer blocks invalid inputs and preserves ordered mode drafts", async ({ page }) => {
  await page.goto("/");
  const files = await uploadFiles(page, 3);
  const project = await createConversationProject(page, "E2E 对话输入契约", files);
  const planRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/rounds/plan")) planRequests.push(request.method());
  });

  await page.getByRole("button", { name: "对话修改", exact: true }).click();
  const panel = page.getByTestId("image-conversation-panel");
  const prompt = panel.getByRole("textbox", { name: "对话修改指令" });
  const send = panel.getByRole("button", { name: "发送", exact: true });
  await expect(prompt).toBeVisible();
  await expect.poll(async () => (await readDraftState(page)).single?.inputs.length ?? 0).toBe(1);
  await expect(send).toBeDisabled();

  await prompt.fill("   ");
  await expect(send).toBeDisabled();
  await expect(panel.getByText("conversation prompt is required")).toBeVisible();

  await panel.getByRole("tab", { name: "多图融合" }).click();
  await panel.getByRole("button", { name: "添加", exact: true }).click();
  await prompt.fill("按顺序融合三张图片");
  await expect(send).toBeDisabled();

  const selectSource = async (nodeId: string) => {
    await page.evaluate(async (id) => {
      const storePath = "/src/store/flowStore.ts";
      const { useFlowStore } = await import(storePath);
      useFlowStore.getState().setSelectedNodeIds([id]);
    }, nodeId);
    await panel.getByRole("button", { name: "添加", exact: true }).click();
    await expect.poll(async () => (await readDraftState(page)).fusion?.inputs.length ?? 0).toBeGreaterThan(0);
  };
  await selectSource("conversation-contract-source-2");
  await selectSource("conversation-contract-source-3");
  await expect(send).toBeEnabled();

  await panel.getByRole("button", { name: "第 3 张图片上移" }).click();
  const fusionOrder = await readDraftState(page);
  expect(fusionOrder.fusion?.inputs.map((input: { sourceRef: string }) => input.sourceRef)).toEqual([
    files[0]!.url,
    files[2]!.url,
    files[1]!.url,
  ]);

  await panel.getByRole("tab", { name: "局部重绘" }).click();
  await panel.getByRole("button", { name: "添加", exact: true }).click();
  await prompt.fill("只修改局部区域");
  await expect(send).toBeDisabled();
  await expect(panel.getByText("局部重绘需要先绘制并保存蒙版。")).toBeVisible();

  const state = await readDraftState(page);
  expect(state.conversationId).toBeTruthy();
  expect(state.mask?.inputs).toHaveLength(1);
  expect(state.fusion?.inputs).toHaveLength(3);
  expect(planRequests).toEqual([]);
  expect(project.id).toBeTruthy();
});

test("conversation composer sends one ordered request with the selected parameters", async ({ page }) => {
  await page.goto("/");
  const files = await uploadFiles(page, 2);
  const project = await createConversationProject(page, "E2E 对话提交契约", files);

  await page.getByRole("button", { name: "对话修改", exact: true }).click();
  const panel = page.getByTestId("image-conversation-panel");
  const prompt = panel.getByRole("textbox", { name: "对话修改指令" });
  await panel.getByRole("tab", { name: "多图融合" }).click();
  await panel.getByRole("button", { name: "添加", exact: true }).click();
  await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storePath);
    useFlowStore.getState().setSelectedNodeIds(["conversation-contract-source-2"]);
  });
  await panel.getByRole("button", { name: "添加", exact: true }).click();
  await prompt.fill("保留图一版型，参考图二的面料质感");

  await panel.getByRole("button", { name: "参数", exact: true }).click();
  const quality = panel.getByRole("combobox", { name: "图片画质" });
  await quality.click();
  await page.getByRole("option", { name: "高", exact: true }).click();
  const size = panel.getByRole("combobox", { name: "输出分辨率" });
  await size.click();
  await page.getByRole("option", { name: "4K", exact: true }).click();
  const aspectRatio = panel.getByRole("combobox", { name: "输出画幅" });
  await aspectRatio.click();
  await page.getByRole("option", { name: "16:9", exact: true }).click();
  await expect(quality).toContainText("high");
  await expect(size).toContainText("4K");
  await expect(aspectRatio).toContainText("16:9");

  const state = await readDraftState(page);
  const conversationId = state.conversationId;
  if (!conversationId) throw new Error("conversation should be resolved before submitting");
  const baseConversation = await page.evaluate(async () => {
    const flowStorePath = "/src/store/flowStore.ts";
    const conversationStorePath = "/src/store/imageConversationStore.ts";
    const { selectActiveDocumentTarget, useFlowStore } = await import(flowStorePath);
    const { getImageConversationTargetState, useImageConversationStore } = await import(conversationStorePath);
    const target = selectActiveDocumentTarget(useFlowStore.getState());
    return getImageConversationTargetState(useImageConversationStore.getState(), target)?.conversation;
  });
  if (!baseConversation) throw new Error("conversation view should be available before submitting");
  const planPayloads: Array<Record<string, unknown>> = [];
  await page.route(/\/api\/image-conversations\/[^/]+\/rounds\/plan$/, async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith(`/image-conversations/${conversationId}/rounds/plan`)) {
      await route.fallback();
      return;
    }
    const payload = JSON.parse(route.request().postData() ?? "{}") as Record<string, any>;
    planPayloads.push(payload);
    const now = new Date().toISOString();
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        kind: "ready",
        plan: {
          kind: "ready",
          outputCount: 1,
          intents: [{ ordinal: 1, label: "融合结果", instruction: payload.prompt, requirements: {} }],
        },
        replayed: false,
        round: {
          id: "e2e-contract-round",
          conversationId,
          ownerId: "e2e-owner",
          projectId: payload.projectId,
          ordinal: 1,
          clientRequestId: payload.clientRequestId,
          mode: payload.mode,
          sourceResultId: null,
          inputManifest: payload.inputManifest,
          prompt: payload.prompt,
          parameters: payload.parameters,
          effectiveRequirements: {},
          incrementalRequirements: {},
          maskRef: null,
          status: "queued",
          createdAt: now,
          updatedAt: now,
          intents: [],
          clarification: null,
        },
      }),
    });
  });
  await page.route(new RegExp(`/api/image-conversations/${conversationId}(?:\\?.*)?$`), async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const now = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...baseConversation,
        rounds: [{
          id: "e2e-contract-round",
          conversationId,
          ownerId: baseConversation.ownerId,
          projectId: project.id,
          ordinal: 1,
          clientRequestId: "e2e-contract-request",
          mode: "fusion",
          sourceResultId: null,
          inputManifest: [
            { role: "base", ordinal: 0, sourceRef: files[0]!.url },
            { role: "reference", ordinal: 1, sourceRef: files[1]!.url },
          ],
          prompt: "保留图一版型，参考图二的面料质感",
          parameters: {
            modelId: "gpt-image-2.5-sunburst",
            quality: "high",
            outputCount: 1,
            size: "4K",
            aspectRatio: "16:9",
            aspectRatioMode: "fixed",
          },
          effectiveRequirements: {},
          incrementalRequirements: {},
          maskRef: null,
          status: "queued",
          createdAt: now,
          updatedAt: now,
          intents: [{
            id: "e2e-contract-intent",
            roundId: "e2e-contract-round",
            conversationId,
            ordinal: 1,
            label: "融合结果",
            instruction: "保留图一版型，参考图二的面料质感",
            requirements: {},
            status: "queued",
            createdAt: now,
            updatedAt: now,
            attempts: [],
          }],
          clarification: null,
        }],
        outputs: [],
      }),
    });
  });

  const send = panel.getByRole("button", { name: "发送", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => planPayloads.length).toBe(1);
  await expect(send).toBeDisabled();
  await expect.poll(async () => (await readDraftState(page)).conversationId).toBe(conversationId);
  expect(planPayloads[0]).toMatchObject({
    mode: "fusion",
    inputManifest: [
      { role: "base", ordinal: 0, sourceRef: files[0]!.url },
      { role: "reference", ordinal: 1, sourceRef: files[1]!.url },
    ],
    prompt: "保留图一版型，参考图二的面料质感",
    parameters: {
      quality: "high",
      size: "4K",
      aspectRatio: "16:9",
      aspectRatioMode: "fixed",
    },
  });
});

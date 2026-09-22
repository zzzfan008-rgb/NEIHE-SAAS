import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const TEST_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

type ProjectContext = {
  id: string;
  ownerId: string;
  fileUrl: string;
  conversationId: string;
};

async function createRuntimeContext(page: Page): Promise<ProjectContext> {
  const projectResponse = await page.request.post("/api/projects", {
    data: {
      name: `E2E 对话运行态 ${Date.now()}`,
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
  const conversation = await conversationResponse.json() as { id: string; ownerId: string };

  await page.evaluate(async ({ projectId, fileUrl }) => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storePath);
    useFlowStore.getState().loadFlow({
      projectId,
      projectName: "对话运行态验收",
      markDirty: false,
      nodes: [{
        id: "conversation-runtime-source",
        type: "image-input",
        position: { x: 0, y: 0 },
        data: {
          kind: "image-input",
          label: "运行态底图",
          status: "success",
          imageRole: "base",
          imageUrl: fileUrl,
          imageConversationSourceRef: fileUrl,
        },
      }],
      edges: [],
    });
    useFlowStore.getState().setSelectedNodeIds(["conversation-runtime-source"]);
  }, { projectId: project.id, fileUrl: file.url });

  await page.getByRole("button", { name: "对话修改", exact: true }).click();
  await expect(page.getByTestId("image-conversation-panel")).toBeVisible();
  return {
    id: project.id,
    ownerId: conversation.ownerId,
    fileUrl: file.url,
    conversationId: conversation.id,
  };
}

async function seedRuntimeState(
  page: Page,
  context: ProjectContext,
  state: "queued" | "clarification" | "failed" | "unknown",
) {
  await page.evaluate(async ({ context, state }) => {
    const flowStorePath = "/src/store/flowStore.ts";
    const conversationStorePath = "/src/store/imageConversationStore.ts";
    const { selectActiveDocumentTarget, useFlowStore } = await import(flowStorePath);
    const { useImageConversationStore } = await import(conversationStorePath);
    const target = selectActiveDocumentTarget(useFlowStore.getState());
    const now = new Date().toISOString();
    const roundId = `e2e-runtime-${state}-round`;
    const intentId = `e2e-runtime-${state}-intent`;
    const outputStatus = state === "failed" ? "failed" : state === "unknown" ? "unknown" : null;
    const roundStatus = state === "queued"
      ? "queued"
      : state === "clarification"
        ? "clarification_required"
        : state === "failed"
          ? "failed"
          : "outcome_unknown";
    const intentStatus = state === "queued"
      ? "queued"
      : state === "clarification"
        ? "clarification_required"
        : state;
    const round = {
      id: roundId,
      conversationId: context.conversationId,
      ownerId: context.ownerId,
      projectId: context.id,
      ordinal: 1,
      clientRequestId: `e2e-runtime-${state}-request`,
      mode: "single",
      sourceResultId: null,
      inputManifest: [{ role: "base", ordinal: 0, sourceRef: context.fileUrl }],
      prompt: `运行态：${state}`,
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
      status: roundStatus,
      createdAt: now,
      updatedAt: now,
      intents: [{
        id: intentId,
        roundId,
        conversationId: context.conversationId,
        ordinal: 1,
        label: `运行态方案 ${state}`,
        instruction: `运行态：${state}`,
        requirements: {},
        status: intentStatus,
        createdAt: now,
        updatedAt: now,
        attempts: [],
      }],
      clarification: state === "clarification" ? {
        id: "e2e-runtime-clarification",
        roundId,
        question: "请确认需要修改几种效果？",
        reason: "count_mismatch",
        requestedCount: 2,
        specifiedIntentCount: 1,
        status: "open",
        responses: [],
        createdAt: now,
        updatedAt: now,
      } : null,
    };
    useImageConversationStore.getState().setConversation(target, {
      id: context.conversationId,
      ownerId: context.ownerId,
      projectId: context.id,
      sourceRef: context.fileUrl,
      sourceKind: "file",
      status: "active",
      createdAt: now,
      updatedAt: now,
      sourcePreviews: { [context.fileUrl]: context.fileUrl },
      rounds: [round],
      outputs: outputStatus ? [{
        id: `e2e-runtime-${state}-output`,
        roundId,
        conversationId: context.conversationId,
        intentId,
        ownerId: context.ownerId,
        projectId: context.id,
        generationOutputId: null,
        imageRef: null,
        status: outputStatus,
        prompt: `运行态：${state}`,
        error: state === "failed" ? "模拟失败，保留失败项" : null,
        createdAt: now,
      }] : [],
    });
    useImageConversationStore.getState().replaceDraft(target, "single", {
      mode: "single",
      inputs: [{ role: "base", ordinal: 0, sourceRef: context.fileUrl }],
      prompt: "下一轮未发送草稿",
      parameters: {
        modelId: "gpt-image-2.5-sunburst",
        quality: "medium",
        outputCount: 1,
        size: "2K",
        aspectRatio: "1:1",
        aspectRatioMode: "follow",
      },
    }, false);
  }, { context, state });
}

async function blockConversationRefresh(page: Page, conversationId: string): Promise<void> {
  await page.route(new RegExp(`/api/image-conversations/${conversationId}(?:\\?.*)?$`), async (route) => {
    if (route.request().method() === "GET") {
      await route.abort();
      return;
    }
    await route.fallback();
  });
}

test("queued round blocks resend but preserves the editable next-round draft", async ({ page }) => {
  await page.goto("/");
  const context = await createRuntimeContext(page);
  await blockConversationRefresh(page, context.conversationId);
  await seedRuntimeState(page, context, "queued");

  const panel = page.getByTestId("image-conversation-panel");
  const history = panel.getByLabel("对话修改历史");
  const prompt = panel.getByRole("textbox", { name: "对话修改指令" });
  await expect(history.getByText("排队中").first()).toBeVisible();
  await expect(panel.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  await prompt.fill("排队期间继续编辑下一轮");
  await expect(prompt).toHaveValue("排队期间继续编辑下一轮");
  await expect(panel.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
});

test("clarification state requires an answer before submitting the round", async ({ page }) => {
  await page.goto("/");
  const context = await createRuntimeContext(page);
  await blockConversationRefresh(page, context.conversationId);
  await seedRuntimeState(page, context, "clarification");

  const panel = page.getByTestId("image-conversation-panel");
  await expect(panel.getByRole("group", { name: "补充说明" })).toContainText("请确认需要修改几种效果？");
  const answer = panel.getByRole("textbox", { name: "澄清补充回答" });
  const submit = panel.getByRole("button", { name: "提交补充", exact: true });
  await expect(submit).toBeDisabled();
  await answer.fill("需要两种效果，第二种由你安排视角。");
  await expect(submit).toBeEnabled();
});

test("failed intents can be retried while unknown outputs require reconciliation", async ({ page }) => {
  await page.goto("/");
  const context = await createRuntimeContext(page);
  await blockConversationRefresh(page, context.conversationId);
  await seedRuntimeState(page, context, "failed");

  const panel = page.getByTestId("image-conversation-panel");
  const history = panel.getByLabel("对话修改历史");
  const retry = history.getByRole("button", { name: "重试此方案" });
  await expect(history.getByText("失败").first()).toBeVisible();
  await retry.click();
  const retryDialog = page.getByRole("alertdialog");
  await expect(retryDialog).toContainText("本次重试可能产生额外费用");
  await retryDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(retryDialog).toHaveCount(0);

  await seedRuntimeState(page, context, "unknown");
  await expect(history.getByText("结果待确认").first()).toBeVisible();
  await expect(history.getByRole("button", { name: "核对结果" })).toBeVisible();
  await expect(history.getByRole("button", { name: "重试此方案" })).toHaveCount(0);
});

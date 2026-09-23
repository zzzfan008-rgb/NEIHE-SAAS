import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import type { ImageConversationView, ImageConversationRoundView } from "../src/types/imageConversation";

const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const now = "2026-09-22T00:00:00.000Z";
const parameters = { modelId: "gpt-image-2.5-sunburst", quality: "medium", outputCount: 1, size: "2K", aspectRatio: "1:1", aspectRatioMode: "follow" as const };
function conversation(id = "fix-conversation"): ImageConversationView {
  return { id, ownerId: "fix-owner", projectId: "fix-project", sourceRef: "/api/files/fix-base.png", sourceKind: "file", status: "active", createdAt: now, updatedAt: now, sourcePreviews: { "/api/files/fix-base.png": IMAGE, "generation-output/fix-output": IMAGE }, rounds: [], outputs: [] };
}
function round(view: ImageConversationView, requestId: string): ImageConversationRoundView {
  return { id: "fix-round", conversationId: view.id, ownerId: view.ownerId, projectId: view.projectId, ordinal: 1, clientRequestId: requestId, mode: "single", sourceResultId: null, inputManifest: [{ role: "base", ordinal: 0, sourceRef: view.sourceRef }], prompt: "submitted", parameters, effectiveRequirements: {}, incrementalRequirements: {}, maskRef: null, status: "succeeded", createdAt: now, updatedAt: now, intents: [], clarification: null };
}
async function open(page: Page, views: Record<string, ImageConversationView>, selectedRef?: string) {
  const view = Object.values(views)[0];
  await page.route("**/api/image-conversations/resolve?**", (route) => route.fulfill({ json: view }));
  await page.route(/\/api\/image-conversations\/fix-[^/?]+\?/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
    return route.fulfill({ json: views[id] ?? view });
  });
  // Every potentially paid endpoint is intercepted, including requests not expected by a test.
  await page.route("**/api/image-conversations/*/rounds/plan", (route) => route.fulfill({ status: 500, json: { error: "Unexpected plan request" } }));
  await page.route("**/api/image-conversations/*/intents/*/retry", (route) => route.fulfill({ status: 500, json: { error: "Unexpected retry request" } }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "对话修改", exact: true })).toBeVisible();
  await page.route("**/api/files/fix-base.png", (route) => route.fulfill({ contentType: "image/png", body: Buffer.from(IMAGE.split(",")[1], "base64") }));
  await page.evaluate(async ({ view, selectedRef, image }) => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    useFlowStore.getState().loadFlow({ projectId: view.projectId, projectName: "修复回归", markDirty: false, nodes: [{ id: "fix-node", type: "image-input", position: { x: 0, y: 0 }, data: { kind: "image-input", label: "回归底图", status: "success", imageRole: "base", imageUrl: image, imageConversationSourceRef: selectedRef ?? view.sourceRef } }], edges: [] });
    useFlowStore.getState().setSelectedNodeIds(["fix-node"]);
  }, { view, selectedRef, image: "/api/files/fix-base.png" });
  await page.getByRole("button", { name: "对话修改", exact: true }).click();
  const panel = page.getByTestId("image-conversation-panel");
  await expect(panel.getByRole("img", { name: "底图 1", exact: true })).toBeVisible();
  const box = await panel.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  return panel;
}
async function state(page: Page) {
  return page.evaluate(async () => {
    const flowPath = "/src/store/flowStore.ts", conversationPath = "/src/store/imageConversationStore.ts";
    const { useFlowStore, selectActiveDocumentTarget } = await import(flowPath);
    const { useImageConversationStore, getImageConversationTargetState } = await import(conversationPath);
    return getImageConversationTargetState(useImageConversationStore.getState(), selectActiveDocumentTarget(useFlowStore.getState()));
  });
}

test("lost planning response reuses exact request and preserves edits made while waiting", async ({ page }) => {
  const view = conversation(), views = { [view.id]: view };
  const panel = await open(page, views);
  const requests: Array<Record<string, unknown>> = [];
  let release: (() => void) | undefined;
  await page.route("**/api/image-conversations/*/rounds/plan", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    if (requests.length === 1) { await route.abort("failed"); return; }
    await new Promise<void>((resolve) => { release = resolve; });
    view.rounds = [round(view, body.clientRequestId)];
    await route.fulfill({ json: { kind: "replayed", round: view.rounds[0] } });
  });
  const prompt = panel.getByRole("textbox", { name: "对话修改指令" });
  await prompt.fill("submitted");
  await panel.getByRole("button", { name: "发送", exact: true }).click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await panel.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  await prompt.fill("new unsent edit");
  expect(requests[1]).toEqual(requests[0]);
  release!();
  await expect.poll(async () => (await state(page)).sending).toBe(false);
  await expect(prompt).toHaveValue("new unsent edit");
  expect((await state(page)).draftDirty.single).toBe(true);
  expect(Object.keys((await state(page)).pendingSubmissions)).toHaveLength(0);
});

test("late planning completion cannot select its old conversation", async ({ page }) => {
  const view = conversation(), other = conversation("fix-other"), views = { [view.id]: view, [other.id]: other };
  const panel = await open(page, views);
  let release: (() => void) | undefined;
  await page.route("**/api/image-conversations/*/rounds/plan", async (route) => {
    await new Promise<void>((resolve) => { release = resolve; });
    view.rounds = [round(view, route.request().postDataJSON().clientRequestId)];
    await route.fulfill({ json: { kind: "ready", round: view.rounds[0] } });
  });
  await panel.getByRole("textbox", { name: "对话修改指令" }).fill("submitted");
  await panel.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.evaluate(async (other) => {
    const flowPath = "/src/store/flowStore.ts", conversationPath = "/src/store/imageConversationStore.ts";
    const { useFlowStore, selectActiveDocumentTarget } = await import(flowPath);
    const { useImageConversationStore } = await import(conversationPath);
    const target = selectActiveDocumentTarget(useFlowStore.getState());
    useImageConversationStore.getState().setConversation(target, other);
    useImageConversationStore.getState().updateDraft(target, "single", { prompt: "conversation B draft" });
  }, other);
  release!();
  await expect.poll(async () => (await state(page)).sending).toBe(false);
  expect((await state(page)).conversation.id).toBe(other.id);
  await expect(panel.getByRole("textbox", { name: "对话修改指令" })).toHaveValue("conversation B draft");
});

test("accepted round is cached for the initiating tab and resumes polling when returning", async ({ page }) => {
  const view = conversation();
  const panel = await open(page, { [view.id]: view });
  let release: (() => void) | undefined;
  let historyReads = 0;
  await page.route(/\/api\/image-conversations\/fix-conversation\?/, (route) => {
    historyReads += 1;
    return route.fulfill({ json: view });
  });
  await page.route("**/api/image-conversations/*/rounds/plan", async (route) => {
    await new Promise<void>((resolve) => { release = resolve; });
    view.rounds = [{ ...round(view, route.request().postDataJSON().clientRequestId), status: "queued" }];
    await route.fulfill({ status: 202, json: { kind: "ready", round: view.rounds[0] } });
  });
  await panel.getByRole("textbox", { name: "对话修改指令" }).fill("submitted");
  await panel.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  const originalTarget = await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveDocumentTarget } = await import(path);
    const state = useFlowStore.getState(), target = selectActiveDocumentTarget(state);
    const original = state.tabs.find((tab: { id: string }) => tab.id === target.tabId);
    useFlowStore.setState({ tabs: [...state.tabs, { ...original, id: "second-tab", projectId: "second-project", nodes: [], selectedNodeIds: [] }], activeTabId: "second-tab" });
    return target;
  });
  release!();
  await expect.poll(() => page.evaluate(async (target) => {
    const path = "/src/store/imageConversationStore.ts";
    const { useImageConversationStore, getImageConversationTargetState } = await import(path);
    return getImageConversationTargetState(useImageConversationStore.getState(), target)?.conversation?.rounds[0]?.status;
  }, originalTarget)).toBe("queued");
  expect((await state(page)).conversation).toBeNull();
  const readsBefore = historyReads;
  await page.evaluate(async (target) => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    useFlowStore.setState({ activeTabId: target.tabId });
  }, originalTarget);
  await expect.poll(() => historyReads).toBeGreaterThan(readsBefore);
  await expect(panel.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
});

test("late planning acceptance cannot write into a replaced document epoch", async ({ page }) => {
  const view = conversation();
  const panel = await open(page, { [view.id]: view });
  let release: (() => void) | undefined;
  await page.route("**/api/image-conversations/*/rounds/plan", async (route) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ json: { kind: "ready", round: { ...round(view, route.request().postDataJSON().clientRequestId), status: "queued" } } });
  });
  await panel.getByRole("textbox", { name: "对话修改指令" }).fill("submitted");
  await panel.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  const originalTarget = await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveDocumentTarget } = await import(path);
    const target = selectActiveDocumentTarget(useFlowStore.getState());
    useFlowStore.getState().loadFlow({ projectId: "replacement-project", projectName: "替换", nodes: [], edges: [], markDirty: false });
    return target;
  });
  release!();
  await expect.poll(() => page.evaluate(async (target) => {
    const path = "/src/store/imageConversationStore.ts";
    const { useImageConversationStore, getImageConversationTargetState } = await import(path);
    return getImageConversationTargetState(useImageConversationStore.getState(), target)?.sending;
  }, originalTarget)).toBe(false);
  expect((await state(page)).conversation).toBeNull();
});

for (const nextMode of ["single", "mask"] as const) {
  test(`clarification uses original round with an empty ${nextMode} next draft`, async ({ page }) => {
    const view = conversation();
    const panel = await open(page, { [view.id]: view });
    const requests: Array<Record<string, unknown>> = [];
    let release: (() => void) | undefined;
    await page.route("**/api/image-conversations/*/rounds/plan", async (route) => {
      const body = route.request().postDataJSON();
      requests.push(body);
      if (requests.length === 1) {
        await new Promise<void>((resolve) => { release = resolve; });
        const pending = round(view, body.clientRequestId);
        pending.prompt = "original submitted prompt";
        pending.status = "clarification_required";
        pending.clarification = { id: "fix-clarification", roundId: pending.id, question: "保留背景吗？", reason: "ambiguous_requirement", requestedCount: null, specifiedIntentCount: null, status: "open", responses: [], createdAt: now, updatedAt: now };
        view.rounds = [pending];
      } else {
        view.rounds = [{ ...view.rounds[0], status: "succeeded", clarification: { ...view.rounds[0].clarification!, status: "resolved" } }];
      }
      await route.fulfill({ json: { kind: requests.length === 1 ? "clarification" : "ready", round: view.rounds[0] } });
    });
    await panel.getByRole("textbox", { name: "对话修改指令" }).fill("original submitted prompt");
    await panel.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => Boolean(release)).toBe(true);
    await panel.getByRole("textbox", { name: "对话修改指令" }).fill("");
    if (nextMode === "mask") await panel.getByRole("tab", { name: "局部重绘" }).click();
    release!();
    const answer = panel.getByRole("textbox", { name: "澄清补充回答" });
    await expect(answer).toBeVisible();
    await answer.fill("保留");
    await expect(panel.getByRole("button", { name: "提交补充", exact: true })).toBeEnabled();
    await answer.press("Control+Enter");
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1]).toMatchObject({ prompt: "original submitted prompt", mode: "single",
      inputManifest: view.rounds[0].inputManifest, parameters: view.rounds[0].parameters,
      clarificationRoundId: "fix-round", clarificationAnswer: "保留" });
    await expect.poll(async () => (await state(page)).sending).toBe(false);
    expect((await state(page)).mode).toBe(nextMode);
    expect((await state(page)).modeDrafts.single.prompt).toBe("");
    expect((await state(page)).draftDirty.single).toBe(true);
  });
}

test("selected result becomes the next base and appears in global compare immediately", async ({ page }) => {
  const view = conversation();
  const completed = round(view, "completed-request");
  completed.intents = [{ id: "fix-intent", roundId: completed.id, conversationId: view.id, ordinal: 1, label: "结果", instruction: "submitted", requirements: {}, status: "succeeded", createdAt: now, updatedAt: now, attempts: [{ id: "fix-attempt", intentId: "fix-intent", roundId: completed.id, conversationId: view.id, attemptNumber: 1, clientRequestId: "fix-attempt-request", generationRunId: "fix-run", retryOfAttemptId: null, status: "succeeded", error: null, createdAt: now, updatedAt: now }] }];
  view.rounds = [completed];
  view.outputs = [{ id: "fix-conversation-output", roundId: completed.id, conversationId: view.id, intentId: "fix-intent", ownerId: view.ownerId, projectId: view.projectId, generationOutputId: "fix-output", imageRef: IMAGE, status: "ready", prompt: "submitted", error: null, createdAt: now }];
  const panel = await open(page, { [view.id]: view }, "generation-output/fix-output");
  const current = await state(page);
  expect(current.modeDrafts.single.inputs[0].sourceRef).toBe("generation-output/fix-output");
  expect(current.modeDrafts.single.sourceResultId).toBe("fix-output");
  await expect(panel.getByRole("button", { name: "对比", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "对比", exact: true }).click();
  await expect(panel.getByRole("button", { name: "取消对比", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("switching a loaded base back to follow immediately recalculates its aspect ratio", async ({ page }) => {
  const view = conversation();
  const panel = await open(page, { [view.id]: view });
  await panel.getByRole("button", { name: "参数", exact: true }).click();
  await panel.getByRole("combobox", { name: "输出画幅" }).click();
  await page.getByRole("option", { name: "16:9", exact: true }).click();
  expect((await state(page)).modeDrafts.single.parameters.aspectRatio).toBe("16:9");
  await panel.getByRole("combobox", { name: "输出画幅" }).click();
  await page.getByRole("option", { name: /跟随底图/ }).click();
  expect((await state(page)).modeDrafts.single.parameters).toMatchObject({ aspectRatioMode: "follow", aspectRatio: "1:1" });
});

test("accepted conversation run keeps streaming into global results after closing the panel", async ({ page }) => {
  const view = conversation();
  const queued = round(view, "stream-request");
  queued.status = "queued";
  queued.intents = [{ id: "stream-intent", roundId: queued.id, conversationId: view.id, ordinal: 1, label: "运行中", instruction: "修改", requirements: {}, status: "queued", createdAt: now, updatedAt: now,
    attempts: [{ id: "stream-attempt", intentId: "stream-intent", roundId: queued.id, conversationId: view.id, attemptNumber: 1, clientRequestId: "stream-attempt-request", generationRunId: "stream-run", retryOfAttemptId: null, status: "queued", error: null, createdAt: now, updatedAt: now }] }];
  view.rounds = [queued];
  let release: (() => void) | undefined;
  await page.route("**/api/run-plan/stream-run", (route) => route.fulfill({ json: { runId: "stream-run" } }));
  await page.route("**/api/run-plan/stream-run/events", async (route) => {
    await new Promise<void>((resolve) => { release = resolve; });
    const event = { type: "node-status", nodeId: "image-conversation-stream-intent", status: "success", images: ["/api/files/fix-result.png"], seq: 1 };
    await route.fulfill({ contentType: "text/event-stream", body: `id: 1\ndata: ${JSON.stringify(event)}\n\nid: 2\ndata: {"type":"done","seq":2}\n\n` });
  });
  await open(page, { [view.id]: view });
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.getByRole("button", { name: "关闭对话修改" }).click();
  await expect(page.getByTestId("image-conversation-panel")).not.toBeVisible();
  release!();
  await expect.poll(() => page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    const result = useFlowStore.getState().recentResults.find((record: { runId?: string }) => record.runId === "stream-run");
    return { status: result?.status, image: result?.image };
  })).toEqual({ status: "success", image: "/api/files/fix-result.png" });
});

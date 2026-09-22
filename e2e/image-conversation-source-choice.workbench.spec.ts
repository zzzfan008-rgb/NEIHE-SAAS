import { expect, test } from "./fixtures";

test("multi-selected images require an explicit conversation source and cancel preserves selection", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开项目中心" })).toBeVisible();
  await page.getByRole("button", { name: "打开项目中心" }).click();
  const center = page.getByRole("dialog", { name: "项目中心" });
  await expect(center).toBeVisible();
  await center.getByRole("button", { name: "新建项目" }).click();
  await expect(page.getByRole("region", { name: "开始第一个创作任务" })).toBeVisible();

  await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { selectActiveDocumentTarget, useFlowStore } = await import(storePath);
    const conversationStorePath = "/src/store/imageConversationStore.ts";
    const { useImageConversationStore } = await import(conversationStorePath);
    useFlowStore.getState().loadFlow({
      projectName: "多选对话起点",
      markDirty: true,
      nodes: [
        {
          id: "source-a",
          type: "image-input",
          position: { x: 0, y: 0 },
          data: {
            kind: "image-input",
            label: "图片 A",
            status: "success",
            imageRole: "reference",
            imageUrl: "/api/files/conversation-source-a.png",
          },
        },
        {
          id: "source-b",
          type: "image-input",
          position: { x: 360, y: 0 },
          data: {
            kind: "image-input",
            label: "图片 B",
            status: "success",
            imageRole: "reference",
            imageUrl: "/api/files/conversation-source-b.png",
          },
        },
      ],
      edges: [],
    });
    useFlowStore.getState().setSelectedNodeIds(["source-a", "source-b"]);
    const target = selectActiveDocumentTarget(useFlowStore.getState());
    const conversationState = useImageConversationStore.getState();
    conversationState.ensureTarget(target);
    conversationState.updateDraft(target, "single", {
      inputs: [{ role: "base", ordinal: 0, sourceRef: "/api/files/conversation-source-a.png" }],
      prompt: "未发送草稿",
    });
  });

  const conversationRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/image-conversations")) conversationRequests.push(request.method());
  });

  await page.getByRole("button", { name: "对话修改", exact: true }).click();
  const panel = page.getByTestId("image-conversation-panel");
  await expect(panel.getByRole("heading", { name: "选择对话修改的起点" })).toBeVisible();
  await expect(panel.getByText(/不会自动融合或发送生成请求。/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "图片 A", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "图片 B", exact: true })).toBeVisible();
  expect(conversationRequests).toEqual([]);

  await panel.getByRole("button", { name: "图片 B", exact: true }).click();
  const switchDialog = page.getByRole("alertdialog");
  await expect(switchDialog.getByRole("heading", { name: "更换当前模式底图？" })).toBeVisible();
  await switchDialog.getByRole("button", { name: "取消切换", exact: true }).click();
  await expect(switchDialog).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: "选择对话修改的起点" })).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "对话修改指令" })).toHaveValue("未发送草稿");

  await panel.getByRole("button", { name: "取消", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "选择对话修改的起点" })).toHaveCount(0);
  await expect(panel.getByRole("textbox", { name: "对话修改指令" })).toHaveValue("未发送草稿");
  expect(conversationRequests).toEqual([]);

  const selectedIds = await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { selectActiveSelectedNodeIds, useFlowStore } = await import(storePath);
    return selectActiveSelectedNodeIds(useFlowStore.getState());
  });
  expect(selectedIds).toEqual(["source-a", "source-b"]);
});

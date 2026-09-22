import { expect, test } from "./fixtures";

const TEST_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("conversation mode drafts stay isolated while switching modes", async ({ page }) => {
  await page.goto("/");

  const projectResponse = await page.request.post("/api/projects", {
    data: {
      name: `E2E 对话模式草稿 ${Date.now()}`,
      flow: { schemaVersion: 3, nodes: [], edges: [] },
    },
  });
  expect(projectResponse.ok(), await projectResponse.text()).toBeTruthy();
  const project = await projectResponse.json() as { id: string };
  const fileResponses = await Promise.all([
    page.request.post("/api/files", { data: { dataUrl: TEST_IMAGE } }),
    page.request.post("/api/files", { data: { dataUrl: TEST_IMAGE } }),
  ]);
  for (const response of fileResponses) expect(response.ok(), await response.text()).toBeTruthy();
  const [firstFile, secondFile] = await Promise.all(fileResponses.map((response) => response.json() as Promise<{ url: string }>));

  await page.evaluate(async ({ projectId, firstUrl, secondUrl }) => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storePath);
    useFlowStore.getState().loadFlow({
      projectId,
      projectName: "模式草稿隔离",
      markDirty: false,
      nodes: [
        {
          id: "mode-source-a",
          type: "image-input",
          position: { x: 0, y: 0 },
          data: {
            kind: "image-input",
            label: "模式底图 A",
            status: "success",
            imageRole: "base",
            imageUrl: firstUrl,
            imageConversationSourceRef: firstUrl,
          },
        },
        {
          id: "mode-source-b",
          type: "image-input",
          position: { x: 360, y: 0 },
          data: {
            kind: "image-input",
            label: "模式参考图 B",
            status: "success",
            imageRole: "reference",
            imageUrl: secondUrl,
            imageConversationSourceRef: secondUrl,
          },
        },
      ],
      edges: [],
    });
    useFlowStore.getState().setSelectedNodeIds(["mode-source-a"]);
  }, { projectId: project.id, firstUrl: firstFile.url, secondUrl: secondFile.url });

  const conversationRequests: Array<{ method: string; path: string }> = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/image-conversations")) {
      conversationRequests.push({ method: request.method(), path: new URL(request.url()).pathname });
    }
  });

  await page.getByRole("button", { name: "对话修改", exact: true }).click();
  const panel = page.getByTestId("image-conversation-panel");
  const prompt = panel.getByRole("textbox", { name: "对话修改指令" });
  await expect(prompt).toBeVisible();
  await prompt.fill("单图模式草稿");

  await panel.getByRole("tab", { name: "多图融合" }).click();
  await expect(prompt).toHaveValue("");
  await panel.getByRole("button", { name: "添加", exact: true }).click();
  await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storePath);
    useFlowStore.getState().setSelectedNodeIds(["mode-source-b"]);
  });
  await panel.getByRole("button", { name: "添加", exact: true }).click();
  await expect(panel.getByText("图 1")).toBeVisible();
  await expect(panel.getByText("图 2")).toBeVisible();
  await prompt.fill("融合模式草稿");

  await panel.getByRole("tab", { name: "局部重绘" }).click();
  await expect(prompt).toHaveValue("");
  await panel.getByRole("button", { name: "添加", exact: true }).click();
  await expect(prompt).toHaveValue("");
  await prompt.fill("局部重绘草稿");

  await panel.getByRole("tab", { name: "单图修改" }).click();
  await expect(prompt).toHaveValue("单图模式草稿");
  await panel.getByRole("tab", { name: "多图融合" }).click();
  await expect(prompt).toHaveValue("融合模式草稿");
  await expect(panel.getByText("图 1")).toBeVisible();
  await expect(panel.getByText("图 2")).toBeVisible();
  await panel.getByRole("tab", { name: "局部重绘" }).click();
  await expect(prompt).toHaveValue("局部重绘草稿");
  await expect(panel.getByText("图 1")).toBeVisible();
  expect(conversationRequests.filter((request) => request.method === "POST")).toHaveLength(1);
  expect(conversationRequests.some((request) => request.path.endsWith("/rounds/plan"))).toBe(false);
});

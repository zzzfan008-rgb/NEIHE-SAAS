import { expect, test } from "./fixtures";

interface ClipboardNodeSnapshot {
  id: string;
  data: {
    kind: string;
    imageUrl?: string;
    imageConversationSourceRef?: string;
    imageConversationId?: string;
  };
}

interface ClipboardProjectSnapshot {
  id: string;
  projectId: string;
  imageUrl?: string;
  sourceRef?: string;
  conversationId?: string;
}

test("conversation provenance survives same-project copy and is stripped across projects", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开项目中心" })).toBeVisible();

  const conversationRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/image-conversations")) conversationRequests.push(request.method());
  });

  await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storePath);
    useFlowStore.getState().loadFlow({
      projectId: "e2e-conversation-clipboard-source",
      projectName: "对话来源复制源项目",
      markDirty: true,
      nodes: [{
        id: "conversation-source",
        type: "image-input",
        position: { x: 0, y: 0 },
        data: {
          kind: "image-input",
          label: "带对话来源的图片",
          status: "success",
          imageRole: "base",
          imageUrl: "/api/files/conversation-clipboard-source.png",
          imageConversationSourceRef: "generation-output/conversation-clipboard-output",
          imageConversationId: "conversation-clipboard-source",
        },
      }],
      edges: [],
    });
    useFlowStore.getState().setSelectedNodeIds(["conversation-source"]);
  });

  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  const sourceNode = page.locator('.react-flow__node[data-id="conversation-source"]');
  await expect(sourceNode).toBeVisible();

  await page.keyboard.press(`${modifier}+c`);
  await page.keyboard.press(`${modifier}+v`);

  const sameProject = await page.evaluate(async (): Promise<ClipboardProjectSnapshot[]> => {
    const storePath = "/src/store/flowStore.ts";
    const { selectActiveDocument, useFlowStore } = await import(storePath);
    const document = selectActiveDocument(useFlowStore.getState());
    const nodes = document.nodes as ClipboardNodeSnapshot[];
    return nodes.map((node) => ({
      id: node.id,
      projectId: document.projectId,
      imageUrl: node.data.kind === "image-input" ? node.data.imageUrl : undefined,
      sourceRef: node.data.kind === "image-input" ? node.data.imageConversationSourceRef : undefined,
      conversationId: node.data.kind === "image-input" ? node.data.imageConversationId : undefined,
    }));
  });
  const sameProjectClone = sameProject.find((node) => node.id !== "conversation-source");
  expect(sameProject).toHaveLength(2);
  expect(sameProjectClone).toMatchObject({
    projectId: "e2e-conversation-clipboard-source",
    imageUrl: "/api/files/conversation-clipboard-source.png",
    sourceRef: "generation-output/conversation-clipboard-output",
    conversationId: "conversation-clipboard-source",
  });

  await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storePath);
    useFlowStore.getState().setSelectedNodeIds(["conversation-source"]);
  });
  await page.keyboard.press(`${modifier}+c`);

  await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storePath);
    useFlowStore.getState().loadFlow({
      projectId: "e2e-conversation-clipboard-target",
      projectName: "对话来源粘贴目标项目",
      markDirty: true,
      nodes: [{
        id: "target-anchor",
        type: "image-input",
        position: { x: 0, y: 0 },
        data: {
          kind: "image-input",
          label: "目标项目图片",
          status: "idle",
          imageRole: "base",
        },
      }],
      edges: [],
    });
    useFlowStore.getState().setSelectedNodeIds(["target-anchor"]);
  });
  await expect(page.locator('.react-flow__node[data-id="target-anchor"]')).toBeVisible();
  await page.keyboard.press(`${modifier}+v`);

  const crossProject = await page.evaluate(async (): Promise<ClipboardProjectSnapshot[]> => {
    const storePath = "/src/store/flowStore.ts";
    const { selectActiveDocument, useFlowStore } = await import(storePath);
    const document = selectActiveDocument(useFlowStore.getState());
    const nodes = document.nodes as ClipboardNodeSnapshot[];
    return nodes.map((node) => ({
      id: node.id,
      projectId: document.projectId,
      imageUrl: node.data.kind === "image-input" ? node.data.imageUrl : undefined,
      sourceRef: node.data.kind === "image-input" ? node.data.imageConversationSourceRef : undefined,
      conversationId: node.data.kind === "image-input" ? node.data.imageConversationId : undefined,
    }));
  });
  const crossProjectClone = crossProject.find((node) => node.id !== "target-anchor");
  expect(crossProject).toHaveLength(2);
  expect(crossProjectClone).toMatchObject({
    projectId: "e2e-conversation-clipboard-target",
    imageUrl: "/api/files/conversation-clipboard-source.png",
  });
  expect(crossProjectClone?.sourceRef).toBeUndefined();
  expect(crossProjectClone?.conversationId).toBeUndefined();
  expect(conversationRequests).toEqual([]);
});

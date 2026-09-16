import { expect, test } from "./fixtures";

test("自由画布支持图片、已保存画板与文本的类型化全局连线", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开项目中心" })).toBeVisible();

  await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storePath);
    const targetData = {
      kind: "sketch-optimize" as const,
      status: "idle" as const,
      prompt: "",
      aspectRatio: "3:4",
      batchSize: 1 as const,
      outputImages: [],
    };
    useFlowStore.getState().loadFlow({
      projectId: "global-connections-e2e",
      projectName: "全局连线验证",
      nodes: [
        {
          id: "global-image",
          type: "image-input",
          position: { x: 0, y: 0 },
          data: {
            kind: "image-input",
            label: "图片上传",
            status: "idle",
            imageRole: "sketch",
            imageUrl: "/api/files/global-image.png",
          },
        },
        {
          id: "global-text",
          type: "text-input",
          position: { x: 0, y: 240 },
          data: {
            kind: "text-input",
            label: "设计说明",
            status: "idle",
            text: "保留省道结构并强化面料层次",
          },
        },
        {
          id: "global-board",
          type: "drawing-board",
          position: { x: 0, y: 480 },
          data: {
            kind: "drawing-board",
            label: "画板",
            status: "idle",
            boardVersion: 1,
            width: 1200,
            height: 1200,
            background: "#FFFFFF",
            contentRef: "drawing://global/content.json",
            previewImageRef: "/api/files/global-board.png",
          },
        },
        {
          id: "global-image-target",
          type: "sketch-optimize",
          position: { x: 420, y: 0 },
          data: { ...targetData, label: "图片与文本目标" },
        },
        {
          id: "global-board-target",
          type: "sketch-optimize",
          position: { x: 420, y: 420 },
          data: { ...targetData, label: "画板与文本目标" },
        },
      ],
      edges: [],
    });

    for (const connection of [
      { source: "global-image", sourceHandle: "image", target: "global-image-target", targetHandle: "references" },
      { source: "global-text", sourceHandle: "text", target: "global-image-target", targetHandle: "prompt" },
      { source: "global-board", sourceHandle: "image", target: "global-board-target", targetHandle: "references" },
      { source: "global-text", sourceHandle: "text", target: "global-board-target", targetHandle: "prompt" },
    ]) useFlowStore.getState().onConnect(connection);
  });

  await expect(page.locator(".react-flow__edge")).toHaveCount(4);
  const rendered = await page.locator(".react-flow__edge-path").evaluateAll((paths) => paths.map((path) => ({
    d: path.getAttribute("d"),
    box: path.getBoundingClientRect().toJSON(),
  })));
  expect(rendered).toHaveLength(4);
  for (const edge of rendered) {
    expect(edge.d).toBeTruthy();
    expect(Math.max(edge.box.width, edge.box.height)).toBeGreaterThan(0);
  }

  const edges = await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { selectActiveEdges, useFlowStore } = await import(storePath);
    return selectActiveEdges(useFlowStore.getState()).map((edge: {
      source: string;
      sourceHandle?: string | null;
      target: string;
      targetHandle?: string | null;
    }) => ({
      source: edge.source,
      sourceHandle: edge.sourceHandle,
      target: edge.target,
      targetHandle: edge.targetHandle,
    }));
  });
  expect(edges).toEqual([
    { source: "global-image", sourceHandle: "image", target: "global-image-target", targetHandle: "references" },
    { source: "global-text", sourceHandle: "text", target: "global-image-target", targetHandle: "prompt" },
    { source: "global-board", sourceHandle: "image", target: "global-board-target", targetHandle: "references" },
    { source: "global-text", sourceHandle: "text", target: "global-board-target", targetHandle: "prompt" },
  ]);
});

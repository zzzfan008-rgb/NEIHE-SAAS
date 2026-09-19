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

test("背景板与姿势图片可通过第一轮通用图片入口真实拖线", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开项目中心" })).toBeVisible();

  await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storePath);
    useFlowStore.getState().loadFlow({
      projectId: "global-image-drag-e2e",
      projectName: "全局图片拖线验证",
      nodes: [
        {
          id: "global-background",
          type: "background-extract",
          position: { x: 0, y: 0 },
          data: {
            kind: "background-extract",
            label: "背景板生成",
            status: "success",
            prompt: "",
            outputImages: ["/api/files/global-background.png"],
            modelId: "gpt-image-2.5-flare",
            modelOptions: { size: "2048x2048", quality: "medium" },
          },
        },
        {
          id: "global-pose-image",
          type: "image-input",
          position: { x: 0, y: 700 },
          data: {
            kind: "image-input",
            label: "DWPose 骨骼图",
            status: "success",
            imageRole: "reference",
            imageUrl: "/api/files/global-pose.png",
          },
        },
        {
          id: "global-stage",
          type: "virtual-try-on",
          position: { x: 680, y: 80 },
          data: {
            kind: "virtual-try-on",
            workflowStage: "scene-stabilize",
            label: "第一轮 · Gemini 场景化定版",
            status: "idle",
            prompt: "",
            imageSize: "2K",
            aspectRatio: "3:4",
            basisRevision: 0,
            promptEnhancement: false,
            qualityMode: "fast",
            safetyFallback: false,
            stylePresetId: "faithful",
            outputImages: [],
            modelId: "gemini-3.1-flash-image",
            modelOptions: { imageSize: "2K" },
          },
        },
      ],
      edges: [],
    });
  });

  const stage = page.locator('.react-flow__node[data-id="global-stage"]');
  const globalInput = stage.locator(".gc-global-image-input-handle");
  await page.getByRole("button", { name: "适应画布", exact: true }).click();
  await expect(globalInput).toHaveCount(1);
  await expect(globalInput).toBeVisible();

  const backgroundOutput = page.locator('.react-flow__node[data-id="global-background"] [data-handleid="image"].source');
  await backgroundOutput.dragTo(globalInput);
  const roleDialog = page.getByRole("dialog", { name: "确认连接角色" });
  await expect(roleDialog).toBeVisible();
  await roleDialog.getByRole("radio", { name: /场景参考图/ }).check();
  await roleDialog.getByRole("button", { name: "确认连接" }).click();
  await expect(roleDialog).toBeHidden();
  await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);

  const poseOutput = page.locator('.react-flow__node[data-id="global-pose-image"] [data-handleid="image"].source');
  await poseOutput.dragTo(globalInput);
  await expect(roleDialog).toBeVisible();
  await roleDialog.getByRole("radio", { name: /人物姿势参考图/ }).check();
  await roleDialog.getByRole("button", { name: "确认连接" }).click();
  await expect(roleDialog).toBeHidden();

  await expect.poll(() => page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { selectActiveEdges, useFlowStore } = await import(storePath);
    return selectActiveEdges(useFlowStore.getState())
      .map((edge: { source: string; targetHandle?: string | null }) => `${edge.source}:${edge.targetHandle}`)
      .sort();
  })).toEqual(["global-background:scene", "global-pose-image:pose"]);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
});

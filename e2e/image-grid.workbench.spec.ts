import sharp from "sharp";
import { expect, test } from "./fixtures";

test("shared output grids fit original ratios and resize all eight node frames", async ({ page }, testInfo) => {
  const portrait = `data:image/png;base64,${(await sharp({ create: { width: 300, height: 450, channels: 3, background: "#b9aaa1" } }).png().toBuffer()).toString("base64")}`;
  const landscape = `data:image/png;base64,${(await sharp({ create: { width: 600, height: 300, channels: 3, background: "#8B9296" } }).png().toBuffer()).toString("base64")}`;
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开项目中心" })).toBeVisible();
  const kinds = ["virtual-try-on", "ai-modify", "fabric-recolor", "mask-redraw", "print-extract", "print-mutate", "sketch-to-render", "upscale"];
  for (const kind of kinds) {
    const id = await page.evaluate(async (kind) => {
      const path = "/src/store/flowStore.ts";
      const { useFlowStore } = await import(path);
      useFlowStore.getState().loadFlow({ projectName: "图片网格验收", nodes: [], edges: [] });
      const id = useFlowStore.getState().addNode(kind, { x: 100, y: 100 });
      if (kind === "virtual-try-on") useFlowStore.getState().updateNodeData(id, { workflowStage: "scene-stabilize" });
      return id;
    }, kind);
    const node = page.locator(`.react-flow__node[data-id="${id}"]`);
    const heights: number[] = [];
    let baseHeight: number | undefined;
    for (const images of [[portrait], [landscape], [portrait, landscape], [portrait, landscape, portrait], [landscape]]) {
      await page.evaluate(async ({ id, images }) => {
        const path = "/src/store/flowStore.ts";
        const { useFlowStore } = await import(path);
        useFlowStore.getState().updateNodeData(id, { outputImages: images });
      }, { id, images });
      const grid = node.locator(".gc-output-image-grid");
      await expect(grid.locator("img")).toHaveCount(images.length);
      await grid.locator("img").evaluateAll((elements) => Promise.all(elements.map((element) => (element as HTMLImageElement).decode())));
      const shape = await node.evaluate((element) => {
        const grid = element.querySelector(".gc-output-image-grid")!;
        const gridRect = grid.getBoundingClientRect();
        const card = element.querySelector(".gc-node-card")!.getBoundingClientRect();
        const body = element.querySelector(".gc-node-body")!;
        const scale = card.width / (element.querySelector(".gc-node-card") as HTMLElement).offsetWidth;
        return { gridWidth: gridRect.width, cardHeight: card.height, baseHeight: card.height - gridRect.height,
          bottom: (body.getBoundingClientRect().bottom - gridRect.bottom) / scale,
          padding: parseFloat(getComputedStyle(body).paddingBottom),
          images: [...grid.querySelectorAll("img")].map((image) => {
            const rect = image.getBoundingClientRect();
            return { width: rect.width, ratio: rect.width / rect.height, natural: image.naturalWidth / image.naturalHeight, transform: getComputedStyle(image).transform };
          }) };
      });
      expect(shape.images[0].width / shape.gridWidth, kind).toBeCloseTo(images.length === 1 ? 1 : 0.5, 1);
      for (const image of shape.images) {
        expect(image.ratio, kind).toBeCloseTo(image.natural, 2);
        expect(image.transform, kind).toBe("none");
      }
      expect(shape.bottom, kind).toBeCloseTo(shape.padding, 0);
      baseHeight ??= shape.baseHeight;
      expect(shape.baseHeight, kind).toBeCloseTo(baseHeight, 0);
      heights.push(shape.cardHeight);
      await grid.locator("img").first().hover();
      await expect(grid.locator("img").first()).toHaveCSS("transform", "none");
    }
    expect(heights[0], kind).toBeGreaterThan(heights[1]);
    expect(heights[3], kind).toBeGreaterThan(heights[2]);
    expect(heights[4], kind).toBeCloseTo(heights[1], 0);
    await node.getByRole("button", { name: "查看生成结果 1", exact: true }).click();
    await expect(page.getByRole("button", { name: "关闭图片查看器", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "关闭图片查看器", exact: true }).click();
    if (kind === "virtual-try-on") await node.screenshot({ path: testInfo.outputPath("adaptive-image-grid.png") });
  }
});

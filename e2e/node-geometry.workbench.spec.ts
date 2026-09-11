import sharp from "sharp";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

test("every node shares rounded outer and inner frames", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开项目中心" })).toBeVisible();
  const ids = await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const specsPath = "/src/types/workflow.ts";
    const { useFlowStore } = await import(path);
    const { NODE_SPECS } = await import(specsPath);
    useFlowStore.getState().loadFlow({ projectName: "圆角验收", nodes: [], edges: [] });
    return Object.keys(NODE_SPECS).map((kind) => {
      const id = useFlowStore.getState().addNode(kind, { x: 100, y: 100 });
      return { id, kind };
    });
  });
  for (const { id, kind } of ids) {
    const node = page.locator(`.react-flow__node[data-id="${id}"]`);
    await expect(node.locator(".gc-node-card")).toHaveCount(1);
    const shape = await node.evaluate((element) => {
      const outer = element.querySelector(".gc-node-card")!;
      const rect = outer.getBoundingClientRect();
      return {
        width: rect.width, height: rect.height, outer: getComputedStyle(outer).borderRadius,
        inner: Array.from(element.querySelectorAll(".gc-node-body :is(div, section, label, p).border, .gc-node-error, .gc-node-media, .gc-node-body video, .gc-node-body > img")).map((panel) => getComputedStyle(panel).borderRadius),
      };
    });
    expect(shape.width, kind).toBeGreaterThan(0);
    expect(shape.height, kind).toBeGreaterThan(0);
    expect(shape.outer, kind).toBe("20px");
    for (const radius of shape.inner) expect(radius, kind).toBe("14px");
  }
});

async function loadImageNode(page: Page, naturalWidth: number, naturalHeight: number) {
  const image = `data:image/png;base64,${(await sharp({ create: { width: naturalWidth, height: naturalHeight, channels: 3, background: "#b9aaa1" } }).png().toBuffer()).toString("base64")}`;
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开项目中心" })).toBeVisible();
  await page.evaluate(async ({ image }) => {
    const path = "/src/store/flowStore.ts";
    const landingPath = "/src/lib/canvasLanding.ts";
    const { useFlowStore } = await import(path);
    const { requestCanvasLanding } = await import(landingPath);
    useFlowStore.getState().loadFlow({ projectName: "图片比例验收", markDirty: true, nodes: [{
      id: "ratio-image", type: "image-input", position: { x: 0, y: 0 },
      data: { kind: "image-input", label: "主穿搭图（必需）", status: "success", imageUrl: image },
    }], edges: [] });
    // Simulate an old, freely resized image without changing document history.
    useFlowStore.getState().onNodesChange([{ id: "ratio-image", type: "dimensions", dimensions: { width: 240, height: 240 }, setAttributes: true }]);
    useFlowStore.getState().setSelectedNodeIds(["ratio-image"]);
    useFlowStore.temporal.getState().clear();
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, fitView: true });
  }, { image });
  const node = page.locator('.react-flow__node[data-id="ratio-image"]');
  await expect(node.locator(".gc-image-resize-corner")).toHaveCount(4);
  return node;
}

async function assertRatio(node: Locator, ratio: number) {
  const shape = await node.evaluate((element) => {
    const image = element.querySelector("img")!;
    const card = element.querySelector(".gc-node-card")!;
    const media = element.querySelector(".gc-image-input-media")!;
    const rect = image.getBoundingClientRect();
    const inner = media.getBoundingClientRect();
    return { ratio: rect.width / rect.height, naturalRatio: image.naturalWidth / image.naturalHeight,
      widthGap: Math.abs(rect.width - inner.width), heightGap: Math.abs(rect.height - inner.height),
      fit: getComputedStyle(image).objectFit, radius: getComputedStyle(card).borderRadius };
  });
  expect(shape.ratio).toBeCloseTo(ratio, 2);
  expect(shape.naturalRatio).toBe(ratio);
  expect(shape.widthGap).toBeLessThan(1);
  expect(shape.heightGap).toBeLessThan(1);
  expect(shape.fit).toBe("contain");
  expect(shape.radius).toBe("20px");
}

for (const [name, w, h] of [["portrait", 360, 600], ["landscape", 800, 500]] as const) {
  test(`image corners lock original ratio and reverse arrows: ${name}`, async ({ page }, testInfo) => {
    const node = await loadImageNode(page, w, h);
    await assertRatio(node, w / h);
    const stateBefore = await page.evaluate(async () => {
      const path = "/src/store/flowStore.ts";
      const { useFlowStore, selectActiveDocument, persistedWorkflowForProjectTab } = await import(path);
      const doc = selectActiveDocument(useFlowStore.getState());
      return { revision: doc.revision, snapshot: persistedWorkflowForProjectTab(doc) };
    });
    for (const [corner, dx, dy] of [["top.left", -45, -45], ["top.right", 45, -45], ["bottom.right", 45, 45], ["bottom.left", -45, 45]] as const) {
      const handle = node.locator(`.gc-image-resize-corner.${corner}`);
      const box = (await handle.boundingBox())!;
      const outer = (await node.boundingBox())!;
      const handleStyle = await handle.evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, shadow: style.boxShadow, border: style.borderWidth };
      });
      expect(handleStyle).toEqual({ background: "rgba(0, 0, 0, 0)", shadow: "none", border: "0px" });
      const arrowStyle = await handle.locator(".gc-image-resize-arrows").evaluate((element) => {
        const style = getComputedStyle(element);
        const control = getComputedStyle(element.parentElement!);
        return { width: style.width, height: style.height, stroke: style.strokeWidth,
          vertical: element.parentElement!.classList.contains("top") ? control.top : control.bottom,
          horizontal: element.parentElement!.classList.contains("left") ? control.left : control.right };
      });
      expect(arrowStyle).toEqual({ width: "28px", height: "28px", stroke: "1.5px", vertical: "4px", horizontal: "4px" });
      const pair = await handle.evaluate((element) => {
        const large = element.querySelector(".gc-image-resize-arrows")!;
        const small = element.querySelector(".gc-image-resize-arrow-inner")!;
        const largeStyle = getComputedStyle(large);
        const smallStyle = getComputedStyle(small);
        return { smallWidth: smallStyle.width, smallHeight: smallStyle.height,
          centerX: Number(small.getAttribute("x")) + Number(small.getAttribute("width")) / 2,
          centerY: Number(small.getAttribute("y")) + Number(small.getAttribute("height")) / 2,
          renderedStroke: Number(getComputedStyle(small.querySelector("path")!).strokeWidth.replace("px", "")) * Number(small.getAttribute("width")) / 28,
          smallStroke: smallStyle.strokeWidth, distinctColors: largeStyle.color !== smallStyle.color,
          curvedPaths: Array.from(element.querySelectorAll("path")).every((path) => path.getAttribute("d")?.includes("Q")),
          caps: largeStyle.strokeLinecap };
      });
      expect(pair.renderedStroke).toBeCloseTo(1.5, 4);
      expect(pair).toMatchObject({ smallWidth: "9px", smallHeight: "9px", centerX: 14, centerY: 9, smallStroke: "1.5px", distinctColors: true, curvedPaths: true, caps: "round" });
      expect(box.x).toBeGreaterThan(outer.x);
      expect(box.y).toBeGreaterThan(outer.y);
      expect(box.x + box.width).toBeLessThan(outer.x + outer.width);
      expect(box.y + box.height).toBeLessThan(outer.y + outer.height);
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const matrix = await handle.locator(".gc-image-resize-arrows").evaluate((svg) => getComputedStyle(svg).transform);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 8 });
      await expect(node.locator(".gc-image-node")).toHaveAttribute("data-resize-direction", "out");
      expect((await node.boundingBox())!.width).toBeGreaterThan(outer.width);
      await assertRatio(node, w / h);
      await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 8 });
      await expect(node.locator(".gc-image-node")).toHaveAttribute("data-resize-direction", "in");
      expect(await handle.locator(".gc-image-resize-arrows").evaluate((svg) => getComputedStyle(svg).transform)).not.toBe(matrix);
      await page.mouse.up();
      await expect(node.locator(".gc-image-node")).toHaveAttribute("data-resize-direction", "out");
      await assertRatio(node, w / h);
    }
    await page.mouse.move(0, 0);
    await node.screenshot({ path: testInfo.outputPath(`corners-${name}.png`) });
    const after = await page.evaluate(async () => {
      const path = "/src/store/flowStore.ts";
      const { useFlowStore, selectActiveDocument, persistedWorkflowForProjectTab } = await import(path);
      const doc = selectActiveDocument(useFlowStore.getState());
      return { revision: doc.revision, snapshot: persistedWorkflowForProjectTab(doc), undoCount: useFlowStore.temporal.getState().pastStates.length };
    });
    expect(after.revision).toBe(stateBefore.revision);
    expect(after.snapshot).toEqual(stateBefore.snapshot);
    expect(after.undoCount).toBe(0);
    await node.getByRole("button", { name: "放大参考图节点" }).click();
    await node.getByRole("button", { name: "缩小参考图节点" }).click();
    await assertRatio(node, w / h);
    await page.evaluate(async () => {
      const path = "/src/store/flowStore.ts";
      const { useFlowStore } = await import(path);
      useFlowStore.setState((s: { tabs: Array<{ id: string }>; activeTabId: string }) => ({ tabs: s.tabs.map((t) => t.id === s.activeTabId ? { ...t, readOnly: true } : t) }));
    });
    await expect(node.locator(".gc-image-resize-corner")).toHaveCount(0);
  });
}

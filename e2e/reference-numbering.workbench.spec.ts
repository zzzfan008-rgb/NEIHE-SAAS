import sharp from "sharp";
import { expect, test } from "./fixtures";

test("第一轮参考编号随连线和实际图片更新且不溢出角色框", async ({ page }, testInfo) => {
  const image = `data:image/png;base64,${(await sharp({ create: { width: 24, height: 32, channels: 3, background: "#aaa" } }).png().toBuffer()).toString("base64")}`;
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开项目中心" })).toBeVisible();
  await page.evaluate(async image => {
    const path = "/src/store/flowStore.ts";
    const landingPath = "/src/lib/canvasLanding.ts";
    const { useFlowStore } = await import(path);
    const { requestCanvasLanding } = await import(landingPath);
    const roles = ["scene", "hat", "person", "socks", "pose", "shoes", "outfit"];
    useFlowStore.getState().createBlankTab();
    useFlowStore.getState().loadFlow({ projectName: "动态参考编号", markDirty: true,
      nodes: [{ id: "stabilize", type: "virtual-try-on", position: { x: 0, y: 0 }, data: {
        kind: "virtual-try-on", label: "第一轮", status: "idle", workflowStage: "scene-stabilize",
        modelId: "gemini-3.1-flash-image", imageSize: "2K", aspectRatio: "3:4", prompt: "",
      } }, ...roles.map((role, index) => ({ id: role, type: "image-input", position: { x: -400, y: index * 5 },
        data: { kind: "image-input", label: role, imageUrl: image, status: "success" } }))],
      edges: roles.map(role => ({ id: role, source: role, target: "stabilize", sourceHandle: "image", targetHandle: role })),
    });
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, nodeId: "stabilize", fitView: true });
  }, image);
  const node = page.locator('.react-flow__node[data-id="stabilize"]');
  const labels = (role: string) => node.locator(`[data-reference-numbers="${role}"]`);
  for (const [role, number] of Object.entries({ pose: 1, person: 2, outfit: 3, shoes: 4, socks: 5, hat: 6, scene: 7 })) {
    await expect(labels(role)).toHaveText(`(参考图 ${number})`);
  }
  await expect(labels("bag")).toBeEmpty();
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    useFlowStore.getState().onEdgesChange([{ id: "shoes", type: "remove" }]);
    useFlowStore.getState().updateNodeData("hat", { imageUrl: undefined });
  });
  await expect(labels("shoes")).toBeEmpty();
  await expect(labels("hat")).toHaveText("待提供图片");
  await expect(labels("socks")).toHaveText("(参考图 4)");
  await expect(labels("scene")).toHaveText("(参考图 5)");
  await page.evaluate(async image => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    const store = useFlowStore.getState();
    store.updateNodeData("hat", { imageUrl: image });
    store.onConnect({ source: "shoes", sourceHandle: "image", target: "stabilize", targetHandle: "shoes" });
  }, image);
  await page.getByRole("dialog").getByRole("button", { name: "确认连接" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(labels("scene")).toHaveText("(参考图 7)");
  await expect(labels("shoes")).toHaveText("(参考图 4)");
  const geometry = await node.locator("[data-port-row]").evaluateAll(rows => rows.map(row => {
    const box = row.getBoundingClientRect();
    const number = row.querySelector("[data-reference-numbers]")!;
    const label = number.getBoundingClientRect();
    return { width: box.width, inside: label.left >= box.left && label.right <= box.right + 1 && label.bottom <= box.bottom + 1,
      overflow: number.scrollWidth > number.clientWidth + 1 };
  }));
  expect(geometry).toHaveLength(12);
  expect(geometry.every(row => row.width > 0 && row.inside && !row.overflow)).toBe(true);
  // Two additional identity references must receive their own model indices.
  await page.evaluate(async image => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    for (let index = 0; index < 2; index++) {
      const store = useFlowStore.getState();
      const id = store.addNode("image-input", { x: -400, y: 0 });
      store.updateNodeData(id, { imageUrl: image });
      store.onConnect({ source: id, sourceHandle: "image", target: "stabilize", targetHandle: "person" });
      if (!useFlowStore.getState().confirmPendingConnection("person")) throw new Error("identity connection rejected");
    }
  }, image);
  await expect(labels("person")).toHaveText("(参考图 2) (参考图 3) (参考图 4)");
  await expect(labels("outfit")).toHaveText("(参考图 5)");
  await expect(labels("scene")).toHaveText("(参考图 9)");
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(await labels("person").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("reference-numbering.png") });
});

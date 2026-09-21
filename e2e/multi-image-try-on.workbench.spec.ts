import fs from "node:fs";
import sharp from "sharp";
import { test, expect } from "./fixtures";

test("两阶段模板独立保存、角色编号、六图拼接边界和桌面布局", async ({ page }, testInfo) => {
  const poseRequests: string[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && request.url().includes("/api/pose-references")) poseRequests.push(request.url());
  });
  const payload = JSON.parse(fs.readFileSync(new URL("../templates/multi-image-try-on.workflow.json", import.meta.url), "utf8"));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开项目中心" })).toBeVisible();
  const before = await (await page.request.get("/api/templates/builtin-tool-one-click-try-on")).json();
  const saved = await page.request.post("/api/templates", { data: payload });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const { id } = await saved.json();
  const template = await (await page.request.get(`/api/templates/${id}`)).json();
  expect(template.name).toBe("多图编辑换装+修改");
  expect(template.flow.nodes.find((node: { id: string }) => node.id === "stabilize").data.sceneInputMode).toBe("multi-reference-edit");
  expect(await (await page.request.get("/api/templates/builtin-tool-one-click-try-on")).json()).toEqual(before);
  const image = `data:image/png;base64,${(await sharp({ create: { width: 24, height: 32, channels: 3, background: "#bababa" } }).png().toBuffer()).toString("base64")}`;
  await page.evaluate(async ({ template, image }) => {
    const storePath = "/src/store/flowStore.ts";
    const landingPath = "/src/lib/canvasLanding.ts";
    const { useFlowStore } = await import(storePath);
    const { requestCanvasLanding } = await import(landingPath);
    const roles = ["socks", "person", "scene", "hat", "pose", "outfit", "shoes"];
    const generation = template.flow.nodes.find((node: { id: string }) => node.id === "stabilize");
    useFlowStore.getState().createBlankTab();
    useFlowStore.getState().loadFlow({ projectName: template.name, nodes: [
      { ...generation, position: { x: 0, y: 0 } },
      ...roles.map((role, index) => ({ id: role, type: "image-input", position: { x: -400, y: index * 5 },
        data: { kind: "image-input", label: role, imageRole: "reference", imageUrl: image, status: "idle" } })),
    ], edges: roles.map(role => ({ id: role, source: role, sourceHandle: "image", target: "stabilize", targetHandle: role })) });
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, nodeId: "stabilize", fitView: true });
  }, { template, image });
  const node = page.locator('.react-flow__node[data-id="stabilize"]');
  for (const [role, number] of Object.entries({ pose: 1, person: 2, scene: 3, outfit: 4, shoes: 5, socks: 5, hat: 6 })) {
    await expect(node.locator(`[data-reference-numbers="${role}"]`)).toHaveText(`(参考图 ${number})`);
  }
  await expect(node.getByLabel("参考图传递策略")).toContainText("7 张有效参考图 → 6 张传入");
  const geometry = await node.locator("[data-port-row]").evaluateAll(rows => rows.map(row => {
    const box = row.getBoundingClientRect();
    const label = row.querySelector("[data-reference-numbers]")!;
    const bounds = label.getBoundingClientRect();
    return { width: box.width, inside: bounds.left >= box.left && bounds.right <= box.right + 1 && bounds.bottom <= box.bottom + 1,
      overflow: label.scrollWidth > label.clientWidth + 1 };
  }));
  expect(geometry).toHaveLength(17);
  expect(geometry.every(row => row.width > 0 && row.inside && !row.overflow)).toBeTruthy();
  const prompt = node.getByRole("textbox", { name: "创作想法" });
  await prompt.fill("保留衣服纹理与首饰细节");
  await prompt.press("Tab");
  await expect(prompt).toHaveValue("保留衣服纹理与首饰细节");
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    useFlowStore.getState().onEdgesChange([{ id: "hat", type: "remove" }]);
  });
  await expect(node.getByLabel("参考图传递策略")).toContainText("6 张有效参考图 → 6 张传入");
  await expect(node.locator('[data-reference-numbers="shoes"]')).toHaveText("(参考图 5)");
  await expect(node.locator('[data-reference-numbers="socks"]')).toHaveText("(参考图 6)");
  await expect(node.getByRole("button", { name: "生成多图换装", exact: true })).toBeVisible();
  await expect(page.locator("[data-pose-prompt-editor]")).toHaveCount(0);
  expect(poseRequests, "新模式连线不反推姿势或生成中间图").toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("multi-image-try-on.png") });
  await page.evaluate(async image => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    const roles = ["pose", "person", "scene", "outfit", "shoes (拼图第1行第1列)", "socks (拼图第1行第2列)", "hat"];
    const references = roles.map((role, index) => ({ role, image, number: [1, 2, 3, 4, 5, 5, 6][index] }));
    useFlowStore.setState({ recentResults: [{ id: "test-multi-record", nodeId: "stabilize", kind: "virtual-try-on", image: "",
      nodeLabel: "多图换装记录", status: "success", startedAt: 1, finishedAt: 2,
      referenceImages: roles.map(() => image), parameters: { sceneInputMode: "multi-reference-edit", referenceManifest: references },
    }] });
    window.dispatchEvent(new CustomEvent("garment:open-generation-record", { detail: { resultId: "test-multi-record" } }));
  }, image);
  const dialog = page.getByRole("dialog", { name: "多图换装记录" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("原始素材映射到 6 张模型参考图");
  await expect(dialog.getByRole("img", { name: "参考图 5 · socks (拼图第1行第2列)", exact: true })).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

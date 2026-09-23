import fs from "node:fs";
import sharp from "sharp";
import { test, expect } from "./fixtures";

test("两阶段模板独立保存、角色编号、14图直传边界和桌面布局", async ({ page }, testInfo) => {
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
  expect(template.flow.nodes.find((node: { id: string }) => node.id === "stabilize").data.modelId).toBe("gemini-3.1-flash-image");
  expect(template.flow.nodes.find((node: { type: string }) => node.type === "ti-angle").data.angle.enabled).toBe(false);
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
  await expect(node.getByLabel("图像模型", { exact: true })).not.toContainText("旧配置兼容");
  await node.getByLabel("图像模型", { exact: true }).click();
  await expect(page.getByRole("option", { name: /Gemini 3.1 Flash/i })).toBeVisible();
  await expect(page.getByRole("option", { name: /Gemini 3 Pro/i })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(node.getByLabel("参考图传递策略")).toContainText("最多 14 张直接传入");
  for (const [role, number] of Object.entries({ pose: 1, person: 2, scene: 3, outfit: 4, shoes: 5, socks: 6, hat: 7 })) {
    await expect(node.locator(`[data-reference-numbers="${role}"]`)).toHaveText(`(参考图 ${number})`);
  }
  await expect(node.getByLabel("参考图传递策略")).toContainText("7 张有效参考图 → 7 张传入");
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
  for (const code of ["OTHER", "IMAGE_OTHER"]) {
    await page.evaluate(async code => {
      const path = "/src/store/flowStore.ts";
      const { useFlowStore } = await import(path);
      useFlowStore.getState().setNodeStatus("stabilize", "error", `模拟服务方响应（${code}）`);
    }, code);
    await expect(node.getByRole("note")).toHaveCount(code === "OTHER" ? 1 : 0);
  }
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    useFlowStore.getState().setNodeStatus("stabilize", "idle");
  });
  const retry = node.getByRole("button", { name: "使用简化提示词重试", exact: true });
  await expect(retry).toHaveCount(0);
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    // Reloaded documents normalize runtime status to idle; history remains authoritative.
    const state = useFlowStore.getState();
    const projectId = state.tabs.find((tab: { id: string }) => tab.id === state.activeTabId).projectId;
    state.setNodeStatus("stabilize", "idle");
    useFlowStore.setState({ recentResults: [{ id: "restored-failure", runId: "restored-run", projectId,
      nodeId: "stabilize", nodeLabel: "多图换装", kind: "virtual-try-on", image: "", status: "error", startedAt: 1 }] });
  });
  await expect(retry).toBeVisible();
  await expect(node).toContainText("会发起新的生成请求，可能产生费用");
  const retryBounds = await retry.boundingBox();
  const nodeBounds = await node.boundingBox();
  expect(retryBounds!.width).toBeGreaterThan(0);
  expect(retryBounds!.x).toBeGreaterThanOrEqual(nodeBounds!.x);
  expect(retryBounds!.x + retryBounds!.width).toBeLessThanOrEqual(nodeBounds!.x + nodeBounds!.width + 1);
  const submissions: Array<{ multiImagePromptMode?: string; onlyNodeId?: string; includeDownstream?: boolean; nodes: Array<{ data: Record<string, unknown> }> }> = [];
  await page.route("**/api/run-plan", async route => {
    submissions.push(route.request().postDataJSON());
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "模拟失败，不调用模型" }) });
  });
  await retry.click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0].multiImagePromptMode).toBe("concise");
  expect(submissions[0].onlyNodeId).toBe("stabilize");
  expect(submissions[0].includeDownstream).toBe(false);
  expect(submissions[0].nodes.every(item => !("multiImagePromptMode" in item.data))).toBeTruthy();
  await expect(retry).toBeVisible();
  await node.getByRole("button", { name: "生成多图换装", exact: true }).click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1].multiImagePromptMode).toBeUndefined();
  await expect(retry).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    useFlowStore.getState().setNodeStatus("stabilize", "outcome_unknown", "结果待确认");
  });
  await expect(retry).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("multi-image-try-on.png") });
  await page.evaluate(async image => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    const roles = ["pose", "person", "scene", "outfit", "shoes", "socks", "hat"];
    const references = roles.map((role, index) => ({ role, image, number: index + 1 }));
    useFlowStore.setState({ recentResults: [{ id: "test-multi-record", nodeId: "stabilize", kind: "virtual-try-on", image: "",
      nodeLabel: "多图换装记录", status: "success", startedAt: 1, finishedAt: 2,
      referenceImages: roles.map(() => image), parameters: { sceneInputMode: "multi-reference-edit", referenceManifest: references },
    }] });
    window.dispatchEvent(new CustomEvent("garment:open-generation-record", { detail: { resultId: "test-multi-record" } }));
  }, image);
  const dialog = page.getByRole("dialog", { name: "多图换装记录" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("原始素材映射到 7 张模型参考图");
  await expect(dialog.getByRole("img", { name: "参考图 6 · socks", exact: true })).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("多图模板TiAngel默认关闭、手动启用、保存恢复和键盘关闭", async ({ page }, testInfo) => {
  const payload = JSON.parse(fs.readFileSync(new URL("../templates/multi-image-try-on.workflow.json", import.meta.url), "utf8"));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "打开项目中心" })).toBeVisible();
  await page.evaluate(async payload => {
    const path = "/src/store/flowStore.ts";
    const landingPath = "/src/lib/canvasLanding.ts";
    const { useFlowStore } = await import(path);
    const { requestCanvasLanding } = await import(landingPath);
    const nodes = payload.flow.nodes.filter((node: { type: string; id: string }) => node.type === "ti-angle" || node.id === "stabilize");
    const angle = nodes.find((node: { type: string }) => node.type === "ti-angle");
    angle.position = { x: 0, y: 0 };
    nodes.find((node: { id: string }) => node.id === "stabilize").position = { x: 500, y: 0 };
    useFlowStore.getState().createBlankTab();
    useFlowStore.getState().loadFlow({ projectId: crypto.randomUUID(), projectName: "多图TiAngel开关验收", markDirty: true, nodes,
      edges: payload.flow.edges.filter((edge: { targetHandle: string }) => edge.targetHandle === "angle-direction") });
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, nodeId: angle.id, fitView: true });
  }, payload);
  const angle = page.locator('.react-flow__node-ti-angle');
  await angle.getByRole("button", { name: /输出视角约束/ }).click();
  const toggle = angle.getByRole("switch", { name: "启用 3D 视角" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  const bounds = await toggle.boundingBox();
  const frame = await angle.boundingBox();
  expect(bounds!.width).toBeGreaterThan(0);
  expect(bounds!.x).toBeGreaterThanOrEqual(frame!.x);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 1);
  const projectId = await page.evaluate(async () => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveDocument } = await import(path);
    if (!await useFlowStore.getState().saveProject()) throw new Error("保存失败");
    return selectActiveDocument(useFlowStore.getState()).projectId;
  });
  const response = await page.request.get(`/api/projects/${projectId}`);
  expect(response.ok()).toBeTruthy();
  const saved = await response.json();
  expect(saved.flow.nodes.find((node: { type: string }) => node.type === "ti-angle").data.angle.enabled).toBe(true);
  await page.evaluate(async saved => {
    const path = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(path);
    useFlowStore.getState().loadFlow({ projectId: saved.id, projectName: saved.name, ...saved.flow });
  }, saved);
  if (!await toggle.isVisible()) await angle.getByRole("button", { name: /输出视角约束/ }).click();
  await expect(toggle).toBeChecked();
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("multi-image-tiangel.png") });
});

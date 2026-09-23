import type { Locator, Page } from "@playwright/test";
import type { ProjectTab } from "../src/store/flowStore";
import axe from "axe-core";
import {
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowTemplate,
} from "../src/types/workflow";
import { expect, test } from "./fixtures";
import { PerspectiveCamera, Vector3 } from "three";

function tiAngleScreenPoint(box: { x: number; y: number; width: number; height: number }, x: number, y: number, z: number) {
  const camera = new PerspectiveCamera(32, box.width / box.height, 0.1, 40);
  camera.position.set(4, 3, 6);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const point = new Vector3(x, y, z).project(camera);
  return { x: box.x + (point.x + 1) * box.width / 2, y: box.y + (1 - point.y) * box.height / 2 };
}

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

async function nodeIdByLabel(page: Page, label: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const nodeId = await page.evaluate(async (targetLabel) => {
      const storeModulePath = "/src/store/flowStore.ts";
      const { selectActiveDocument, useFlowStore } = await import(storeModulePath);
      return selectActiveDocument(useFlowStore.getState()).nodes.find(
        (node: { data: { label?: unknown } }) => node.data.label === targetLabel,
      )?.id;
    }, label);
    if (nodeId) return nodeId;
    await page.waitForTimeout(50);
  }
  throw new Error(`Missing cloned node with label: ${label}`);
}

test("first-round model and ideas persist with desktop controls", async ({ page }, testInfo) => {
  await openFreshBlankProject(page);
  await page.evaluate(async () => {
    const storePath = '/src/store/flowStore.ts';
    const landingPath = '/src/lib/canvasLanding.ts';
    const { useFlowStore } = await import(storePath);
    const { requestCanvasLanding } = await import(landingPath);
    useFlowStore.getState().loadFlow({ projectName: '第一轮参数', markDirty: true, nodes: [{
      id: 'scene-options', type: 'virtual-try-on', position: { x: 0, y: 0 }, data: {
        kind: 'virtual-try-on', label: '第一轮 · 场景化定版', status: 'idle', workflowStage: 'scene-stabilize',
        prompt: '', modelId: 'gemini-3-pro-image-preview', modelOptions: { aspectRatio: '3:4', imageSize: '2K' },
        imageSize: '2K', aspectRatio: '3:4', sceneFraming: 'scene', basisRevision: 0, outputImages: [],
        promptEnhancement: false, qualityMode: 'fast', safetyFallback: false, stylePresetId: 'faithful',
      },
    }], edges: [] });
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, fitView: true });
  });
  const node = page.locator('.react-flow__node[data-id="scene-options"]');
  const ideas = node.getByRole('textbox', { name: '创作想法' });
  await expect(ideas).toBeVisible();
  await ideas.fill('自然画册质感，减少过度磨皮');
  await ideas.press('Tab');
  const model = node.getByRole('combobox', { name: '图像模型', exact: true });
  await model.click();
  await page.getByRole('option', { name: 'GPT Image 2', exact: true }).click();
  const quality = node.getByRole('combobox', { name: '图片质量', exact: true });
  await quality.click();
  await expect(page.getByRole('option', { name: 'max', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: 'high', exact: true }).click();
  await model.click();
  await page.getByRole('option', { name: 'GPT-Image 2.5 Flare', exact: true }).click();
  await quality.click();
  await page.getByRole('option', { name: 'max', exact: true }).click();
  const framing = node.getByRole('combobox', { name: '画幅比例' });
  await framing.click();
  await page.getByRole('option', { name: '4:5', exact: true }).click();
  await node.getByRole('combobox', { name: '输出尺寸' }).click();
  await page.getByRole('option', { name: '4K', exact: true }).click();
  // Model-dependent controls change the node height; exercise the existing fit control.
  await page.getByRole('button', { name: '适应画布', exact: true }).click();
  await expect.poll(async () => {
    const box = await node.boundingBox();
    return box!.y + box!.height;
  }).toBeLessThanOrEqual(page.viewportSize()!.height - 40);
  for (const control of [ideas, model, quality, framing]) {
    const box = await control.boundingBox();
    const nodeBox = await node.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(nodeBox!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(nodeBox!.x + nodeBox!.width + 1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(box!.y).toBeGreaterThanOrEqual(nodeBox!.y);
    expect(box!.y + box!.height).toBeLessThanOrEqual(nodeBox!.y + nodeBox!.height);
  }
  await framing.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(framing).toBeFocused();
  const saved = await page.evaluate(async () => {
    const storePath = '/src/store/flowStore.ts';
    const snapshotPath = '/src/lib/documentSnapshot.ts';
    const { useFlowStore, selectActiveDocument } = await import(storePath);
    const { createDocumentSnapshot, documentSnapshotToPersistedWorkflow } = await import(snapshotPath);
    const flow = documentSnapshotToPersistedWorkflow(createDocumentSnapshot(selectActiveDocument(useFlowStore.getState())));
    useFlowStore.getState().loadFlow({ ...flow, projectName: '第一轮参数', markDirty: true });
    return flow.nodes[0].data;
  });
  expect(saved).toMatchObject({ modelId: 'gpt-image-2.5-flare', prompt: '自然画册质感，减少过度磨皮', imageSize: '4K', aspectRatio: '4:5', sceneFraming: 'custom', modelOptions: { quality: 'max' } });
  await expect(ideas).toHaveValue('自然画册质感，减少过度磨皮');
  await expect(model).toContainText('Flare');
  await testInfo.attach('first-round-controls', { body: await page.screenshot(), contentType: 'image/png' });

  // Unsupported quality must not survive a model switch, and the switch is undoable.
  await model.click();
  await page.getByRole('option', { name: 'GPT Image 2', exact: true }).click();
  await expect(quality).toContainText('medium');
  await page.evaluate(async () => {
    const path = '/src/store/flowStore.ts';
    const { useFlowStore } = await import(path);
    useFlowStore.getState().undo();
  });
  await expect(model).toContainText('Flare');
  await expect(quality).toContainText('max');
  await page.evaluate(async () => {
    const path = '/src/store/flowStore.ts';
    const { useFlowStore } = await import(path);
    useFlowStore.getState().redo();
  });
  await expect(model).toContainText('GPT Image 2');
  await expect(quality).toContainText('medium');
  await model.click();
  await page.getByRole('option', { name: 'Gemini 3 Pro Image', exact: true }).click();
  const size = node.getByRole('combobox', { name: '输出尺寸' });
  await size.click();
  await page.getByRole('option', { name: '1K', exact: true }).click();
  await model.click();
  await page.getByRole('option', { name: 'GPT Image 2', exact: true }).click();
  await expect(size).toContainText('2K');

  // Test the real browser/session loading path, not just the schema round trip.
  const retained = await page.evaluate(async () => {
    const path = '/src/store/flowStore.ts';
    const { useFlowStore, selectActiveDocument } = await import(path);
    const document = selectActiveDocument(useFlowStore.getState());
    return ['gpt-image-2', 'gemini-3.1-flash-image'].map(modelId => {
      const gemini = modelId.startsWith('gemini');
      const data = { ...document.nodes[0].data, modelId, modelOptions: gemini
        ? { aspectRatio: '4:5', imageSize: '2K' } : { quality: 'medium' } };
      useFlowStore.getState().loadFlow({ projectName: document.projectName, nodes: [{ ...document.nodes[0], data }], edges: [], markDirty: true });
      const restored = selectActiveDocument(useFlowStore.getState()).nodes[0].data;
      return { modelId: restored.modelId, quality: restored.modelOptions.quality };
    });
  });
  expect(retained).toEqual([{ modelId: 'gpt-image-2', quality: 'medium' }, { modelId: 'gemini-3.1-flash-image' }]);
  await expect(model).toContainText('旧配置兼容');

  await page.evaluate(async () => {
    const path = '/src/store/flowStore.ts';
    const { useFlowStore } = await import(path);
    useFlowStore.getState().setSelectedNodeIds(['scene-options']);
  });
  const inspector = page.locator('#workbench-inspector-panel');
  if (!await inspector.isVisible()) await page.getByRole('button', { name: '属性', exact: true }).click();
  const inspectorIdeas = inspector.getByRole('textbox', { name: '创作想法' });
  await expect(inspectorIdeas).toHaveValue('自然画册质感，减少过度磨皮');
  await inspectorIdeas.fill('保留自然光线');
  await inspectorIdeas.press('Tab');
  await expect(ideas).toHaveValue('保留自然光线');
  const inspectorModel = inspector.getByRole('combobox', { name: '图像模型', exact: true });
  await inspectorModel.click();
  await page.getByRole('option', { name: 'GPT Image 2', exact: true }).click();
  await expect(model).toContainText('GPT Image 2');
  await page.getByRole('button', { name: '适应画布', exact: true }).click();
  await testInfo.attach('first-round-inspector', { body: await page.screenshot(), contentType: 'image/png' });

  for (const mode of ['running', 'readOnly']) {
    await page.evaluate(async mode => {
      const path = '/src/store/flowStore.ts';
      const { useFlowStore } = await import(path);
      useFlowStore.setState((state: { tabs: ProjectTab[]; activeTabId: string }) => ({ tabs: state.tabs.map(tab => tab.id === state.activeTabId
        ? { ...tab, readOnly: mode === 'readOnly', nodes: tab.nodes.map(node => ({ ...node, data: { ...node.data, status: mode === 'running' ? 'running' : 'idle' } })) }
        : tab) }));
    }, mode);
    for (const control of [ideas, model, framing, size, quality, inspectorIdeas, inspectorModel]) await expect(control).toBeDisabled();
  }
});

test("GPT Image 2.5 quality selection persists and fits desktop canvas", async ({ page }) => {
  await openFreshBlankProject(page);
  await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const landingPath = "/src/lib/canvasLanding.ts";
    const { useFlowStore } = await import(storePath);
    const { requestCanvasLanding } = await import(landingPath);
    useFlowStore.getState().loadFlow({ projectName: "质量验收", markDirty: true,
      nodes: [{ id: "quality", type: "sketch-to-render", position: { x: 0, y: 0 },
        data: { kind: "sketch-to-render", label: "图片生成", status: "idle", prompt: "shirt",
          modelId: "gpt-image-2.5-flare", modelOptions: { size: "1024x1024", quality: "medium" },
          aspectRatio: "1:1", batchSize: 1, outputImages: [] } }], edges: [] });
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, fitView: true });
  });
  const node = page.locator('.react-flow__node[data-id="quality"]');
  const quality = node.getByRole("combobox", { name: "图片质量" });
  await expect(quality).toContainText("medium");
  await quality.click();
  for (const name of ["low", "medium", "high", "xhigh", "max"]) {
    await expect(page.getByRole("option", { name, exact: true })).toBeVisible();
  }
  await page.getByRole("option", { name: "max", exact: true }).click();
  await expect(quality).toContainText("max");
  const box = await quality.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await expect(node).toContainText("费用更高");
  const savedQuality = await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const snapshotPath = "/src/lib/documentSnapshot.ts";
    const { useFlowStore, selectActiveDocument } = await import(storePath);
    const { createDocumentSnapshot } = await import(snapshotPath);
    return createDocumentSnapshot(selectActiveDocument(useFlowStore.getState())).nodes[0].data.modelOptions.quality;
  });
  expect(savedQuality).toBe("max");
  await quality.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("option", { name: "max", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(quality).toBeFocused();
  const migrated = await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveDocument } = await import(storePath);
    return ["low", "medium", "high"].map((oldQuality) => {
      useFlowStore.getState().loadFlow({ projectName: "旧模型迁移", markDirty: true,
        nodes: [{ id: "legacy", type: "mask-redraw", position: { x: 0, y: 0 }, data: {
          kind: "mask-redraw", label: "旧蒙版", status: "idle", prompt: "", outputImages: ["/api/files/keep.png"],
          modelId: "gpt-image-2", modelOptions: { quality: oldQuality }, repairFocus: "custom", executionMode: "repair",
        } }], edges: [] });
      const data = selectActiveDocument(useFlowStore.getState()).nodes[0].data;
      return { modelId: data.modelId, quality: data.modelOptions.quality, outputImages: data.outputImages };
    });
  });
  expect(migrated).toEqual(["low", "high", "max"].map((quality) => ({
    modelId: "gpt-image-2.5-sunburst", quality, outputImages: ["/api/files/keep.png"],
  })));
});

test("TiAngelNode preview fits desktop widths, folds text and isolates pointer drag", async ({ page }) => {
  await openFreshBlankProject(page);
  await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const landingPath = "/src/lib/canvasLanding.ts";
    const { useFlowStore } = await import(storePath);
    const { requestCanvasLanding } = await import(landingPath);
    useFlowStore.getState().loadFlow({
      projectName: "TiAngelNode 视角验收",
      markDirty: true,
      nodes: [{
        id: "ti-angle-e2e",
        type: "ti-angle",
        position: { x: 0, y: 0 },
        data: {
          kind: "ti-angle",
          label: "3D 视角",
          status: "idle",
          angle: { version: 1, enabled: true, azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 },
        },
      }],
      edges: [],
    });
    useFlowStore.temporal.getState().clear();
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, fitView: true });
  });

  const node = page.locator('.react-flow__node[data-id="ti-angle-e2e"]');
  const preview = node.locator("[data-ti-angle-preview]");
  await expect(node).toBeVisible();
  await expect(preview).toContainText("拖动相机球调整视角");
  await expect(preview.getByRole("button", { name: "重试 3D 预览" })).toHaveCount(0);
  const previewBox = await preview.boundingBox();
  expect(previewBox).not.toBeNull();
  expect(previewBox!.width).toBeGreaterThan(180);
  expect(previewBox!.height).toBeGreaterThan(100);
  expect(previewBox!.x).toBeGreaterThanOrEqual(0);
  expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);

  await node.getByRole("button", { name: "左前方 +45°", exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveDocument } = await import(storePath);
    return selectActiveDocument(useFlowStore.getState()).nodes.find((candidate: { id: string }) => candidate.id === "ti-angle-e2e")?.data.angle;
  })).toMatchObject({ azimuthDeg: 45, elevationDeg: 0, rollDeg: 0, enabled: true });
  await node.getByRole("button", { name: "重置视角", exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveDocument } = await import(storePath);
    return selectActiveDocument(useFlowStore.getState()).nodes.find((candidate: { id: string }) => candidate.id === "ti-angle-e2e")?.data.angle;
  })).toMatchObject({ azimuthDeg: 0, elevationDeg: 0, rollDeg: 0, enabled: true });
  const historyAfterReset = await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storePath);
    return useFlowStore.temporal.getState().pastStates.length;
  });
  await node.getByRole("button", { name: "重置视角", exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storePath);
    return useFlowStore.temporal.getState().pastStates.length;
  })).toBe(historyAfterReset);
  const azimuthInput = node.getByRole("spinbutton", { name: "环绕角数值" });
  await azimuthInput.focus();
  await azimuthInput.press("Shift+ArrowUp");
  await expect(azimuthInput).toHaveValue("5");
  await node.getByRole("button", { name: "重置视角", exact: true }).click();

  const outputToggle = node.getByRole("button", { name: "查看输出文本", exact: true });
  await expect(outputToggle).toHaveAttribute("aria-expanded", "false");
  await outputToggle.click();
  await expect(outputToggle).toHaveAttribute("aria-expanded", "true");
  await expect(node).toContainText("通用视角描述（未绑定模型）");
  const copyButton = node.getByRole("button", { name: "复制视角文本", exact: true });
  await expect(copyButton).toBeVisible();

  const before = await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveDocument } = await import(storePath);
    const document = selectActiveDocument(useFlowStore.getState());
    return document.nodes.find((candidate: { id: string }) => candidate.id === "ti-angle-e2e")?.data.angle;
  });
  const historyBeforeDrag = await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storePath);
    return useFlowStore.temporal.getState().pastStates.length;
  });
  const nodeBeforeDrag = await node.boundingBox();
  const canvas = preview.locator("canvas");
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  const cameraPoint = tiAngleScreenPoint(canvasBox!, 0, 0, 1.35);
  const startX = cameraPoint.x;
  const startY = cameraPoint.y;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 32, startY - 14, { steps: 6 });
  await page.mouse.up();

  const after = await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveDocument } = await import(storePath);
    const document = selectActiveDocument(useFlowStore.getState());
    return document.nodes.find((candidate: { id: string }) => candidate.id === "ti-angle-e2e")?.data.angle;
  });
  expect(after).not.toEqual(before);
  expect(after?.azimuthDeg).not.toBe(0);
  await expect.poll(() => page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storePath);
    return useFlowStore.temporal.getState().pastStates.length;
  })).toBe(historyBeforeDrag + 1);
  await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storePath);
    useFlowStore.getState().undo();
  });
  await expect.poll(() => page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveDocument } = await import(storePath);
    return selectActiveDocument(useFlowStore.getState()).nodes.find((candidate: { id: string }) => candidate.id === "ti-angle-e2e")?.data.angle;
  })).toEqual(before);
  await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storePath);
    useFlowStore.getState().redo();
  });
  await expect.poll(() => page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveDocument } = await import(storePath);
    return selectActiveDocument(useFlowStore.getState()).nodes.find((candidate: { id: string }) => candidate.id === "ti-angle-e2e")?.data.angle;
  })).toEqual(after);
  const nodeAfterDrag = await node.boundingBox();
  expect(nodeAfterDrag).not.toBeNull();
  expect(Math.abs(nodeAfterDrag!.x - nodeBeforeDrag!.x)).toBeLessThan(1);
  expect(Math.abs(nodeAfterDrag!.y - nodeBeforeDrag!.y)).toBeLessThan(1);

  const contextLost = await canvas.evaluate((element) => {
    const gl = (element as HTMLCanvasElement).getContext("webgl2")
      ?? (element as HTMLCanvasElement).getContext("webgl");
    const extension = gl?.getExtension("WEBGL_lose_context");
    if (!extension) return false;
    extension.loseContext();
    return true;
  });
  expect(contextLost).toBe(true);
  await expect(preview).toContainText("WebGL 预览暂时不可用");
  await expect(preview.getByRole("button", { name: "重试 3D 预览" })).toBeVisible();
  const angleAfterContextLoss = await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveDocument } = await import(storePath);
    return selectActiveDocument(useFlowStore.getState()).nodes.find((candidate: { id: string }) => candidate.id === "ti-angle-e2e")?.data.angle;
  });
  await preview.getByRole("button", { name: "重试 3D 预览" }).click();
  await expect.poll(() => page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveDocument } = await import(storePath);
    return selectActiveDocument(useFlowStore.getState()).nodes.find((candidate: { id: string }) => candidate.id === "ti-angle-e2e")?.data.angle;
  })).toEqual(angleAfterContextLoss);
});


test("TiAngelNode raycast handles isolate axes and ignore blank or occluded hits", async ({ page }, testInfo) => {
  await openFreshBlankProject(page);
  await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const landingPath = "/src/lib/canvasLanding.ts";
    const { useFlowStore } = await import(storePath);
    const { requestCanvasLanding } = await import(landingPath);
    useFlowStore.getState().loadFlow({
      projectName: "TiAngelNode 命中验收",
      markDirty: true,
      nodes: [{
        id: "ti-angle-hit-test",
        type: "ti-angle",
        position: { x: 0, y: 0 },
        data: {
          kind: "ti-angle",
          label: "3D 视角命中",
          status: "idle",
          angle: { version: 1, enabled: true, azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 },
        },
      }],
      edges: [],
    });
    useFlowStore.temporal.getState().clear();
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, fitView: true });
  });

  const node = page.locator('.react-flow__node[data-id="ti-angle-hit-test"]');
  const preview = node.locator("[data-ti-angle-preview]");
  const canvas = preview.locator("canvas");
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(200);

  const readAngle = () => page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { selectActiveDocument, useFlowStore } = await import(storePath);
    return selectActiveDocument(useFlowStore.getState()).nodes.find(
      (candidate: { id: string }) => candidate.id === "ti-angle-hit-test",
    )?.data.angle as { azimuthDeg: number; elevationDeg: number; rollDeg: number };
  });
  const setAngle = async (azimuthDeg: number, elevationDeg = 0, rollDeg = 0) => {
    await page.evaluate(async ({ azimuthDeg, elevationDeg, rollDeg }) => {
      const storePath = "/src/store/flowStore.ts";
      const { useFlowStore } = await import(storePath);
      useFlowStore.getState().updateNodeData("ti-angle-hit-test", {
        angle: { version: 1, enabled: true, azimuthDeg, elevationDeg, rollDeg },
      });
    }, { azimuthDeg, elevationDeg, rollDeg });
    await expect.poll(readAngle).toMatchObject({ azimuthDeg, elevationDeg, rollDeg });
  };
  const drag = async (x: number, y: number, dx: number, dy: number) => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 6 });
    await page.mouse.up();
  };

  const box = await canvas.boundingBox();
  if (!box) throw new Error("TiAngelNode canvas is missing");
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;

  const azimuthHandle = tiAngleScreenPoint(box, 0, -0.94, 1.85);
  const azimuthTarget = tiAngleScreenPoint(box, Math.sin(Math.PI / 6) * 1.85, -0.94, Math.cos(Math.PI / 6) * 1.85);
  await drag(azimuthHandle.x, azimuthHandle.y, azimuthTarget.x - azimuthHandle.x, azimuthTarget.y - azimuthHandle.y);
  await expect.poll(readAngle).toMatchObject({ elevationDeg: 0, rollDeg: 0 });
  expect(Math.abs((await readAngle()).azimuthDeg - 30)).toBeLessThanOrEqual(2);

  await setAngle(0);
  const elevationHandle = tiAngleScreenPoint(box, -1.85, 0, 0);
  const elevationTarget = tiAngleScreenPoint(box, -Math.cos(Math.PI / 6) * 1.85, Math.sin(Math.PI / 6) * 1.85, 0);
  await drag(elevationHandle.x, elevationHandle.y, elevationTarget.x - elevationHandle.x, elevationTarget.y - elevationHandle.y);
  await expect.poll(readAngle).toMatchObject({ azimuthDeg: 0, rollDeg: 0 });
  expect(Math.abs((await readAngle()).elevationDeg - 30)).toBeLessThanOrEqual(2);

  await setAngle(0);
  await drag(box.x + 8, box.y + box.height - 8, 32, -18);
  await expect.poll(readAngle).toEqual({
    version: 1,
    enabled: true,
    azimuthDeg: 0,
    elevationDeg: 0,
    rollDeg: 0,
  });

  await setAngle(-180);
  await drag(centerX, centerY, 32, -18);
  await expect.poll(readAngle).toEqual({
    version: 1,
    enabled: true,
    azimuthDeg: -180,
    elevationDeg: 0,
    rollDeg: 0,
  });

  await setAngle(0);
  await testInfo.attach("ti-angle-raycast-handles", {
    body: await preview.screenshot({ path: testInfo.outputPath("ti-angle-preview.png") }),
    contentType: "image/png",
  });
});


test("TiAngelNode ignores late reference-image callbacks after document, tab and node changes", async ({ page }) => {
  await openFreshBlankProject(page);
  const requests = new Map<string, { requested: ReturnType<typeof deferred>; settled: ReturnType<typeof deferred> }>();
  const releases = new Map<string, ReturnType<typeof deferred>>();
  for (const phase of ["replace", "switch", "remove"]) {
    requests.set(phase, { requested: deferred(), settled: deferred() });
    releases.set(phase, deferred());
  }
  await page.route("**/e2e/ti-angle-stale-*.png", async (route) => {
    const phase = new URL(route.request().url()).pathname.match(/ti-angle-stale-(replace|switch|remove)\.png$/)?.[1];
    if (!phase) return route.continue();
    requests.get(phase)!.requested.resolve();
    await releases.get(phase)!.promise;
    await route.fulfill({ status: 500, contentType: "image/png", body: "late reference image" });
    requests.get(phase)!.settled.resolve();
  });

  const loadAngleFlow = async (projectId: string, imageUrl: string) => page.evaluate(async ({ projectId, imageUrl }) => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storePath);
    useFlowStore.getState().loadFlow({
      projectId,
      projectName: `TiAngelNode 异步资源 ${projectId}`,
      markDirty: true,
      nodes: [
        {
          id: "ti-angle-async",
          type: "ti-angle",
          position: { x: 0, y: 0 },
          data: {
            kind: "ti-angle",
            label: "异步资源视角",
            status: "idle",
            angle: { version: 1, enabled: true, azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 },
          },
        },
        {
          id: "ti-angle-preview-source",
          type: "image-input",
          position: { x: -360, y: 0 },
          data: {
            kind: "image-input",
            label: "延迟示意图",
            status: "idle",
            imageRole: "reference",
            imageUrl,
          },
        },
      ],
      edges: [{
        id: `${projectId}-preview`,
        source: "ti-angle-preview-source",
        sourceHandle: "image",
        target: "ti-angle-async",
        targetHandle: "preview-image",
      }],
    });
  }, { projectId, imageUrl });

  await loadAngleFlow("async-replace", "/e2e/ti-angle-stale-replace.png");
  await requests.get("replace")!.requested.promise;
  const angleNode = page.locator('.react-flow__node[data-id="ti-angle-async"]');
  await expect(angleNode).toContainText("正在加载示意参考图");
  await loadAngleFlow("async-replacement", "");
  releases.get("replace")!.resolve();
  await requests.get("replace")!.settled.promise;
  await expect(angleNode.locator("[data-ti-angle-preview]")).not.toContainText("示意参考图无法加载");
  await expect.poll(() => page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveDocument } = await import(storePath);
    return selectActiveDocument(useFlowStore.getState()).projectId;
  })).toBe("async-replacement");

  await loadAngleFlow("async-switch", "/e2e/ti-angle-stale-switch.png");
  await requests.get("switch")!.requested.promise;
  await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storePath);
    useFlowStore.getState().createBlankTab();
  });
  await expect(page.getByRole("region", { name: "开始第一个创作任务" })).toBeVisible();
  releases.get("switch")!.resolve();
  await requests.get("switch")!.settled.promise;
  await expect(page.locator('[data-ti-angle-preview]')).toHaveCount(0);

  await loadAngleFlow("async-remove", "/e2e/ti-angle-stale-remove.png");
  await requests.get("remove")!.requested.promise;
  await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storePath);
    useFlowStore.getState().onNodesChange([{ id: "ti-angle-async", type: "remove" }]);
  });
  await expect(page.locator('.react-flow__node[data-id="ti-angle-async"]')).toHaveCount(0);
  releases.get("remove")!.resolve();
  await requests.get("remove")!.settled.promise;
  await expect.poll(() => page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveDocument } = await import(storePath);
    const document = selectActiveDocument(useFlowStore.getState());
    return document.nodes.some((node: { id: string }) => node.id === "ti-angle-async");
  })).toBe(false);
});


test("TiAngelNode reads authenticated reference images and completes a successful texture swap", async ({ page }) => {
  await openFreshBlankProject(page);
  const requests: Array<{ path: string; cookie: string }> = [];
  const imageBRequested = deferred();
  const releaseImageB = deferred();
  const imageBSettled = deferred();
  await page.route("**/api/files/ti-angle-auth-*.png", async (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push({ path, cookie: route.request().headers().cookie ?? "" });
    if (path.endsWith("ti-angle-auth-b.png")) {
      imageBRequested.resolve();
      await releaseImageB.promise;
    }
    await route.fulfill({ status: 200, contentType: "image/png", body: E2E_UPLOAD_PNG });
    if (path.endsWith("ti-angle-auth-b.png")) imageBSettled.resolve();
  });

  const loadAngleFlow = async (imageUrl: string) => page.evaluate(async (nextImageUrl) => {
    const storePath = "/src/store/flowStore.ts";
    const landingPath = "/src/lib/canvasLanding.ts";
    const { useFlowStore } = await import(storePath);
    const { requestCanvasLanding } = await import(landingPath);
    useFlowStore.getState().loadFlow({
      projectId: `ti-angle-auth-${nextImageUrl.endsWith("b.png") ? "b" : "a"}`,
      projectName: "TiAngelNode 鉴权参考图验收",
      markDirty: true,
      nodes: [
        {
          id: "ti-angle-auth-preview",
          type: "ti-angle",
          position: { x: 0, y: 0 },
          data: {
            kind: "ti-angle",
            label: "鉴权参考图视角",
            status: "idle",
            angle: { version: 1, enabled: true, azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 },
          },
        },
        {
          id: "ti-angle-auth-source",
          type: "image-input",
          position: { x: -360, y: 0 },
          data: {
            kind: "image-input",
            label: "鉴权参考图",
            status: "success",
            imageRole: "reference",
            imageUrl: nextImageUrl,
          },
        },
      ],
      edges: [{
        id: `ti-angle-auth-${nextImageUrl.endsWith("b.png") ? "b" : "a"}-edge`,
        source: "ti-angle-auth-source",
        sourceHandle: "image",
        target: "ti-angle-auth-preview",
        targetHandle: "preview-image",
      }],
    });
    useFlowStore.temporal.getState().clear();
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, fitView: true });
  }, imageUrl);

  await loadAngleFlow("/api/files/ti-angle-auth-a.png");
  const node = page.locator('.react-flow__node[data-id="ti-angle-auth-preview"]');
  const preview = node.locator("[data-ti-angle-preview]");
  await expect.poll(() => requests.some(({ path }) => path.endsWith("ti-angle-auth-a.png"))).toBe(true);
  await expect(preview).toHaveAttribute("data-ti-angle-image-state", "loaded");
  expect(requests.find(({ path }) => path.endsWith("ti-angle-auth-a.png"))?.cookie).toBeTruthy();

  await loadAngleFlow("/api/files/ti-angle-auth-b.png");
  await imageBRequested.promise;
  await expect(preview).toHaveAttribute("data-ti-angle-image-state", "loading");
  await expect(preview).not.toContainText("示意参考图无法加载");
  releaseImageB.resolve();
  await imageBSettled.promise;
  await expect(preview).toHaveAttribute("data-ti-angle-image-state", "loaded");
  expect(requests.find(({ path }) => path.endsWith("ti-angle-auth-b.png"))?.cookie).toBeTruthy();
});


test("TiAngelNode survives formal save, project-center reopen and page refresh without runtime state", async ({ page }) => {
  await openFreshBlankProject(page);
  const projectName = `TiAngelNode 保存重开 ${Date.now()}`;
  const identity = await page.evaluate(async (name) => {
    const storePath = "/src/store/flowStore.ts";
    const landingPath = "/src/lib/canvasLanding.ts";
    const { selectActiveDocument, useFlowStore } = await import(storePath);
    const { requestCanvasLanding } = await import(landingPath);
    const current = selectActiveDocument(useFlowStore.getState());
    useFlowStore.getState().loadFlow({
      projectId: current.projectId,
      projectName: name,
      markDirty: true,
      nodes: [
        {
          id: "ti-angle-save-source",
          type: "image-input",
          position: { x: -420, y: 0 },
          data: {
            kind: "image-input",
            label: "保存示意图",
            status: "idle",
            imageRole: "reference",
            autoConnectTargets: [{ targetNodeId: "ti-angle-save", targetHandle: "preview-image" }],
          },
        },
        {
          id: "ti-angle-save",
          type: "ti-angle",
          position: { x: 0, y: 0 },
          data: {
            kind: "ti-angle",
            label: "保存恢复视角",
            status: "idle",
            angle: {
              version: 1,
              enabled: true,
              azimuthDeg: 123,
              elevationDeg: -17,
              rollDeg: 12,
              dragState: { pointerId: 7 },
            } as never,
            collapsed: false,
            compiledText: "不得保存的运行时文本",
            renderer: { active: true },
          } as never,
        },
        {
          id: "ti-angle-save-target",
          type: "virtual-try-on",
          position: { x: 520, y: 0 },
          data: {
            kind: "virtual-try-on",
            label: "保存恢复第一轮",
            status: "idle",
            workflowStage: "scene-stabilize",
            prompt: "",
            modelId: "gemini-3.1-flash-image",
            modelOptions: { aspectRatio: "1:1", imageSize: "2K" },
            imageSize: "2K",
            aspectRatio: "1:1",
            basisRevision: 0,
            promptEnhancement: false,
            qualityMode: "fast",
            safetyFallback: false,
            stylePresetId: "faithful",
            outputImages: [],
          },
        },
      ],
      edges: [
        {
          id: "ti-angle-save-preview-edge",
          source: "ti-angle-save-source",
          sourceHandle: "image",
          target: "ti-angle-save",
          targetHandle: "preview-image",
        },
        {
          id: "ti-angle-save-text-edge",
          source: "ti-angle-save",
          sourceHandle: "text",
          target: "ti-angle-save-target",
          targetHandle: "angle-direction",
        },
      ],
    });
    useFlowStore.temporal.getState().clear();
    const document = selectActiveDocument(useFlowStore.getState());
    requestCanvasLanding({ tabId: document.id, fitView: true });
    return { projectId: document.projectId, projectName: document.projectName };
  }, projectName);

  const saveResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/projects"
  ));
  const saved = await page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storePath);
    return useFlowStore.getState().saveProject();
  });
  const saveResponse = await saveResponsePromise;
  expect(saved, await saveResponse.text()).toBe(true);
  expect(saveResponse.ok()).toBe(true);

  const detailResponse = await page.request.get(`/api/projects/${encodeURIComponent(identity.projectId)}`);
  expect(detailResponse.ok(), await detailResponse.text()).toBe(true);
  const detail = await detailResponse.json() as {
    flow: {
      nodes: Array<{ id: string; data: Record<string, unknown> }>;
      edges: Array<{ id: string; source: string; sourceHandle?: string; target: string; targetHandle?: string }>;
    };
  };
  const persistedAngle = detail.flow.nodes.find((node) => node.id === "ti-angle-save");
  expect(persistedAngle?.data.angle).toEqual({
    version: 1,
    enabled: true,
    azimuthDeg: 123,
    elevationDeg: -17,
    rollDeg: 12,
  });
  expect(JSON.stringify(persistedAngle)).not.toMatch(/dragState|collapsed|compiledText|renderer/);
  expect(detail.flow.nodes.find((node) => node.id === "ti-angle-save-source")?.data.autoConnectTargets).toEqual([
    { targetNodeId: "ti-angle-save", targetHandle: "preview-image" },
  ]);
  expect(detail.flow.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle,
    target: edge.target,
    targetHandle: edge.targetHandle,
  }))).toEqual([
    {
      id: "ti-angle-save-preview-edge",
      source: "ti-angle-save-source",
      sourceHandle: "image",
      target: "ti-angle-save",
      targetHandle: "preview-image",
    },
    {
      id: "ti-angle-save-text-edge",
      source: "ti-angle-save",
      sourceHandle: "text",
      target: "ti-angle-save-target",
      targetHandle: "angle-direction",
    },
  ]);

  await expect.poll(() => page.evaluate(async () => {
    const safetyPath = "/src/store/generationSafety.ts";
    const { getGenerationSafetyBlockReason } = await import(safetyPath);
    return getGenerationSafetyBlockReason();
  })).toBeNull();
  await page.getByRole("button", { name: `关闭 ${projectName}` }).click();
  await expect.poll(() => page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { selectActiveDocument, useFlowStore } = await import(storePath);
    return selectActiveDocument(useFlowStore.getState()).projectId;
  })).not.toBe(identity.projectId);
  await page.getByRole("button", { name: "打开项目中心" }).click();
  const projectCenter = page.getByRole("dialog", { name: "项目中心" });
  await expect(projectCenter).toBeVisible();
  await projectCenter.getByPlaceholder("搜索最近项目").fill(projectName);
  await projectCenter.getByRole("button", { name: new RegExp(projectName) }).click();

  const restoredNode = page.locator('.react-flow__node[data-id="ti-angle-save"]');
  await expect(restoredNode).toBeVisible();
  const outputToggle = restoredNode.getByRole("button", { name: "查看输出文本", exact: true });
  await expect(outputToggle).toHaveAttribute("aria-expanded", "false");

  const readRestoredDocument = () => page.evaluate(async () => {
    const storePath = "/src/store/flowStore.ts";
    const { selectActiveDocument, useFlowStore } = await import(storePath);
    const document = selectActiveDocument(useFlowStore.getState());
    const angle = document.nodes.find((node: { id: string }) => node.id === "ti-angle-save");
    return {
      projectId: document.projectId,
      dirty: document.dirty,
      angle: angle?.data.angle,
      autoConnectTargets: document.nodes.find((node: { id: string }) => node.id === "ti-angle-save-source")?.data.autoConnectTargets,
      edgeIds: document.edges.map((edge: { id: string }) => edge.id).sort(),
    };
  });
  await expect.poll(readRestoredDocument).toEqual({
    projectId: identity.projectId,
    dirty: false,
    angle: {
      version: 1,
      enabled: true,
      azimuthDeg: 123,
      elevationDeg: -17,
      rollDeg: 12,
    },
    autoConnectTargets: [{ targetNodeId: "ti-angle-save", targetHandle: "preview-image" }],
    edgeIds: ["ti-angle-save-preview-edge", "ti-angle-save-text-edge"],
  });

  await page.reload();
  await expect(page.locator('.react-flow__node[data-id="ti-angle-save"]')).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id="ti-angle-save"]')
    .getByRole("button", { name: "查看输出文本", exact: true }))
    .toHaveAttribute("aria-expanded", "false");
  await expect.poll(readRestoredDocument).toEqual({
    projectId: identity.projectId,
    dirty: false,
    angle: {
      version: 1,
      enabled: true,
      azimuthDeg: 123,
      elevationDeg: -17,
      rollDeg: 12,
    },
    autoConnectTargets: [{ targetNodeId: "ti-angle-save", targetHandle: "preview-image" }],
    edgeIds: ["ti-angle-save-preview-edge", "ti-angle-save-text-edge"],
  });
});


test("TiAngelNode output supports multi-target copy, focus restoration and read-only mode", async ({ page }) => {
  await openFreshBlankProject(page);
  const loadAngleFlow = async (readOnly = false) => page.evaluate(async (isReadOnly) => {
    const storePath = "/src/store/flowStore.ts";
    const landingPath = "/src/lib/canvasLanding.ts";
    const { useFlowStore } = await import(storePath);
    const { requestCanvasLanding } = await import(landingPath);
    useFlowStore.getState().loadFlow({
      projectId: `ti-angle-output-${isReadOnly ? "readonly" : "editable"}`,
      projectName: "TiAngelNode 输出交互验收",
      nodes: [
        {
          id: "ti-angle-output-e2e",
          type: "ti-angle",
          position: { x: 0, y: 0 },
          data: {
            kind: "ti-angle",
            label: "3D 视角输出",
            status: "idle",
            angle: { version: 1, enabled: true, azimuthDeg: 45, elevationDeg: 15, rollDeg: -10 },
          },
        },
        {
          id: "ti-angle-gpt-target",
          type: "sketch-to-render",
          position: { x: 560, y: 0 },
          data: {
            kind: "sketch-to-render",
            label: "GPT 目标",
            status: "idle",
            prompt: "",
            modelId: "gpt-image-2",
            modelOptions: { size: "1024x1024", quality: "medium" },
            aspectRatio: "1:1",
            batchSize: 1,
            outputImages: [],
          },
        },
        {
          id: "ti-angle-gemini-target",
          type: "ai-modify",
          position: { x: 560, y: 700 },
          data: {
            kind: "ai-modify",
            label: "Gemini 目标",
            status: "idle",
            prompt: "",
            modelId: "gemini-3.1-flash-image",
            modelOptions: { aspectRatio: "1:1", imageSize: "2K" },
            aspectRatio: "1:1",
            batchSize: 1,
            outputImages: [],
          },
        },
      ],
      edges: [
        { id: "ti-angle-output-gpt", source: "ti-angle-output-e2e", sourceHandle: "text", target: "ti-angle-gpt-target", targetHandle: "prompt" },
        { id: "ti-angle-output-gemini", source: "ti-angle-output-e2e", sourceHandle: "text", target: "ti-angle-gemini-target", targetHandle: "prompt" },
    ] });
    if (isReadOnly) {
      useFlowStore.setState((state: { activeTabId: string; tabs: Array<{ id: string; readOnly: boolean }> }) => ({
        tabs: state.tabs.map((tab) => tab.id === state.activeTabId ? { ...tab, readOnly: true } : tab),
      }));
    }
    useFlowStore.temporal.getState().clear();
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, fitView: true });
  }, readOnly);

  await loadAngleFlow();
  await page.evaluate(() => {
    const writes: string[] = [];
    Object.defineProperty(window, "__tiAngleClipboardWrites", { configurable: true, value: writes });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { writes.push(text); } },
    });
  });
  const node = page.locator('.react-flow__node[data-id="ti-angle-output-e2e"]');
  const outputToggle = node.getByRole("button", { name: "查看输出文本", exact: true });
  await expect(node).toBeVisible();
  await outputToggle.click();
  await expect(outputToggle).toHaveAttribute("aria-expanded", "true");
  await expect(node).toContainText("接收节点：GPT 目标");
  await expect(node).toContainText("模型：gpt-image-2");
  await expect(node).toContainText("接收节点：Gemini 目标");
  await expect(node).toContainText("模型：gemini-3.1-flash-image");
  const copyButtons = node.getByRole("button", { name: "复制视角文本", exact: true });
  await expect(copyButtons).toHaveCount(2);

  await outputToggle.click();
  await expect(outputToggle).toHaveAttribute("aria-expanded", "false");
  await expect(outputToggle).toBeFocused();
  await outputToggle.click();
  await copyButtons.first().click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __tiAngleClipboardWrites?: string[] }).__tiAngleClipboardWrites?.length ?? 0)).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as Window & { __tiAngleClipboardWrites?: string[] }).__tiAngleClipboardWrites?.[0] ?? "")).toContain("左前方");

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new Error("clipboard blocked"); } },
    });
  });
  await copyButtons.first().click();
  await expect(node).toContainText("只改变相机观察视角", { timeout: 1000 });

  const beforeReadOnly = await page.evaluate(async () => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveDocument } = await import(storeModulePath);
    return selectActiveDocument(useFlowStore.getState()).nodes.find((candidate: { id: string }) => candidate.id === "ti-angle-output-e2e")?.data.angle;
  });
  await loadAngleFlow(true);
  const readOnlyNode = page.locator('.react-flow__node[data-id="ti-angle-output-e2e"]');
  await expect(readOnlyNode.getByRole("switch", { name: "启用 3D 视角" })).toBeDisabled();
  await expect(readOnlyNode.getByRole("button", { name: "左前方 +45°", exact: true })).toBeDisabled();
  await expect(readOnlyNode.getByRole("button", { name: "重置视角", exact: true })).toBeDisabled();
  await expect(readOnlyNode.getByRole("spinbutton", { name: "环绕角数值" })).toBeDisabled();
  await expect(readOnlyNode.locator("[data-ti-angle-preview] canvas")).toHaveAttribute("aria-disabled", "true");
  const afterReadOnly = await page.evaluate(async () => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveDocument } = await import(storeModulePath);
    return selectActiveDocument(useFlowStore.getState()).nodes.find((candidate: { id: string }) => candidate.id === "ti-angle-output-e2e")?.data.angle;
  });
  expect(afterReadOnly).toEqual(beforeReadOnly);
});

test("color picker supports native fallback, direct selection, cancellation and failures", async ({ page }) => {
  // Exercise the production panel without touching saved projects or real AI APIs.
  await page.goto("/e2e/fixtures/color-tool.html?picker=native");
  await page.getByRole("button", { name: "开始取色测试" }).click();
  const dialog = page.getByRole("dialog", { name: "色彩工具" });
  const nativeInput = page.getByLabel("系统颜色选择器");
  await expect(dialog.getByText(/将打开系统颜色选择器/)).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  // OS color UI is outside Playwright's DOM; simulate only its return channel.
  await nativeInput.evaluate((input: HTMLInputElement) => {
    input.showPicker = () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "#12ab34");
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
  });
  await dialog.getByRole("button", { name: "屏幕取色" }).click();
  await expect(dialog.getByLabel("颜色值", { exact: true })).toHaveValue("#12ab34");
  await expect(dialog.getByRole("button", { name: "创建新色板节点" })).toBeDisabled();
  await dialog.getByRole("button", { name: "添加", exact: true }).click();
  await expect(dialog.getByText("已选 1/8")).toBeVisible();
  await dialog.getByRole("button", { name: "创建新色板节点" }).click();
  await expect(page.getByLabel("创建结果")).toContainText('"value":"#12AB34"');

  for (const mode of ["success", "cancel", "failure"]) {
    await page.goto(`/e2e/fixtures/color-tool.html?picker=${mode}`);
    await page.getByRole("button", { name: "开始取色测试" }).click();
    await dialog.getByRole("button", { name: "屏幕取色" }).click();
    if (mode === "success") {
      await expect(dialog.getByText("已选 1/8")).toBeVisible();
      await dialog.getByRole("button", { name: "创建新色板节点" }).click();
      await expect(page.getByLabel("创建结果")).toContainText('"source":"eyedropper"');
      await expect(page.getByLabel("创建结果")).toContainText('"value":"#123456"');
    } else {
      await expect(dialog.getByRole("button", { name: "创建新色板节点" })).toBeDisabled();
      if (mode === "cancel") await expect(dialog.getByRole("alert")).toHaveCount(0);
      else await expect(dialog.getByRole("alert")).toContainText("屏幕取色失败");
    }
  }
});

test("color series favorites sync and remain available in My Favorites", async ({ page }) => {
  let persistedFavorites: string[] = [];
  const ownerId = "color-favorites-e2e-owner";
  let responseOwnerId = ownerId;
  let removalResponse: Promise<void> | undefined;
  let releaseRemoval: (() => void) | undefined;
  await page.route("**/api/auth/color-preferences", async (route) => {
    const method = route.request().method();
    expect(route.request().headers()["x-expected-user-id"]).toBe(ownerId);
    if (method === "PATCH") {
      const body = route.request().postDataJSON() as {
        color: string; favorite: boolean; bootstrapFavorites?: string[];
      };
      const base = persistedFavorites.length > 0 ? persistedFavorites : (body.bootstrapFavorites ?? []);
      persistedFavorites = body.favorite
        ? [...base.filter((color) => color !== body.color), body.color]
        : base.filter((color) => color !== body.color);
      if (!body.favorite) await removalResponse;
      await route.fulfill({ json: { ownerId: responseOwnerId, favorites: persistedFavorites } });
      return;
    }
    if (method === "PUT") {
      const body = route.request().postDataJSON() as { favorites?: string[] };
      if (persistedFavorites.length === 0) persistedFavorites = body.favorites ?? [];
      await route.fulfill({ json: { ownerId: responseOwnerId, favorites: persistedFavorites } });
      return;
    }
    await route.fulfill({ json: { ownerId: responseOwnerId, favorites: persistedFavorites, initialized: true } });
  });
  const bindOwner = () => page.evaluate(async (targetOwnerId) => {
    const storePath = "/src/store/customColors.ts";
    const { useCustomColors } = await import(storePath);
    useCustomColors.getState().bindOwner(targetOwnerId);
  }, ownerId);

  await page.goto("/e2e/fixtures/color-tool.html?picker=native");
  await bindOwner();
  await page.getByRole("button", { name: "开始取色测试" }).click();
  const dialog = page.getByRole("dialog", { name: "色彩工具" });
  await expect(dialog.getByRole("tab")).toHaveCount(5);
  await expect(dialog.getByRole("tab").allTextContents()).resolves.toEqual(["中性基础色", "暖色系", "冷色系", "Pantone", "我的收藏"]);

  const favoriteControl = dialog.getByRole("button", { name: "收藏 #161616" });
  const selectControl = dialog.getByRole("button", { name: "选择 #161616" });
  await expect(favoriteControl).toBeVisible();
  await expect(selectControl).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  const favoriteBox = await favoriteControl.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(favoriteBox).not.toBeNull();
  expect(favoriteBox!.x).toBeGreaterThanOrEqual(dialogBox!.x);
  expect(favoriteBox!.x + favoriteBox!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width);
  await favoriteControl.click();
  await expect.poll(() => persistedFavorites).toEqual(["#161616"]);

  await dialog.getByRole("tab", { name: "我的收藏" }).click();
  const favoritesPanel = dialog.getByRole("tabpanel", { name: "我的收藏" });
  await expect(favoritesPanel.getByRole("button", { name: "选择 #161616" })).toBeVisible();
  await expect(favoritesPanel.getByRole("button", { name: "取消收藏 #161616" })).toBeVisible();
  // The favorite now overlays the upper-right corner; select the uncovered color area.
  await favoritesPanel.getByRole("button", { name: "选择 #161616" }).click({ position: { x: 5, y: 30 } });
  await expect(dialog.getByText("已选 1/8")).toBeVisible();

  await page.reload();
  await bindOwner();
  await page.getByRole("button", { name: "开始取色测试" }).click();
  await dialog.getByRole("tab", { name: "我的收藏" }).click();
  await expect(favoritesPanel.getByRole("button", { name: "选择 #161616" })).toBeVisible();
  const removeFavorite = favoritesPanel.getByRole("button", { name: "取消收藏 #161616" });
  removalResponse = new Promise<void>((resolve) => { releaseRemoval = resolve; });
  await removeFavorite.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => persistedFavorites).toEqual([]);
  await expect(dialog.getByRole("tab", { name: "我的收藏" })).toBeFocused();
  const colorInput = dialog.getByRole("textbox", { name: "颜色值", exact: true });
  await colorInput.fill("#123456");
  releaseRemoval?.();
  await expect(dialog.getByText("还没有普通颜色收藏")).toBeVisible();
  await expect(colorInput).toBeFocused();

  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  responseOwnerId = "different-owner";
  await page.getByRole("button", { name: "开始取色测试" }).click();
  await expect(dialog.getByRole("alert")).toContainText("登录账号已切换，请刷新后重试");
});

test("node handles disconnect only their edges with one undo and preserve left drag", async ({ page }) => {
  await openFreshBlankProject(page);
  await page.evaluate(async (image) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const landingModulePath = "/src/lib/canvasLanding.ts";
    const { useFlowStore } = await import(storeModulePath);
    const { requestCanvasLanding } = await import(landingModulePath);
    useFlowStore.getState().loadFlow({
      projectId: `handle-test-${crypto.randomUUID()}`,
      projectName: "连线点回归",
      markDirty: true,
      nodes: [
        { id: "source", type: "result", position: { x: 0, y: 0 }, data: { kind: "result", label: "保留结果", status: "idle", images: [image, image] } },
        { id: "text", type: "text-input", position: { x: 0, y: 550 }, data: { kind: "text-input", label: "保留提示词", status: "idle", text: "保留文本" } },
        { id: "target", type: "ai-modify", position: { x: 550, y: 0 }, data: { kind: "ai-modify", label: "改款", status: "idle", prompt: "", modelId: "gpt-image-2", modelOptions: {}, aspectRatio: "1:1", batchSize: 1, outputImages: [] } },
        { id: "sink", type: "result", position: { x: 1100, y: 0 }, data: { kind: "result", label: "汇总", status: "idle", images: [] } },
      ],
      edges: [
        { id: "a", source: "source", sourceHandle: "image:0", target: "target", targetHandle: "references" },
        { id: "b", source: "source", sourceHandle: "image:0", target: "sink", targetHandle: "references" },
        { id: "c", source: "source", sourceHandle: "image:1", target: "target", targetHandle: "references" },
        { id: "d", source: "text", sourceHandle: "text", target: "target", targetHandle: "prompt" },
      ],
    });
    useFlowStore.temporal.getState().clear();
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, fitView: true });
  }, RESULTS_DENSITY_IMAGE);

  const handle = (node: string, id: string, type: "source" | "target") => page.locator(`.react-flow__node[data-id="${node}"] .react-flow__handle.${type}[data-handleid="${id}"]`);
  const source = handle("source", "image:0", "source");
  const target = handle("target", "references", "target");
  const state = () => page.evaluate(async () => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore, selectActiveDocument } = await import(storeModulePath);
    const document = selectActiveDocument(useFlowStore.getState());
    return {
      edges: document.edges.map((edge: { id: string }) => edge.id).sort(),
      history: useFlowStore.temporal.getState().pastStates.length,
      nodes: document.nodes.map((node: BrowserFlowNode) => ({ id: node.id, data: node.data })),
    };
  });
  const history = (action: "undo" | "redo") => page.evaluate(async (action) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    useFlowStore.getState()[action]();
  }, action);
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  await expect(source).toHaveAttribute("title", /右键取消连线/);
  // Assert the hit targets are actually inside each supported desktop viewport.
  for (const point of [source, target]) {
    const box = await point.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  }
  const before = await state();
  await source.click({ button: "right" });
  await expect.poll(async () => (await state()).edges).toEqual(["c", "d"]);
  expect((await state()).history).toBe(before.history + 1);
  expect((await state()).nodes).toEqual(before.nodes);
  await history("undo");
  await expect.poll(async () => (await state()).edges).toEqual(before.edges);
  await history("redo");
  await expect.poll(async () => (await state()).edges).toEqual(["c", "d"]);
  // An empty port must not consume an undo entry or open the canvas menu.
  await source.click({ button: "right" });
  expect((await state()).history).toBe(before.history + 1);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await history("undo");
  await target.click({ button: "right" });
  await expect.poll(async () => (await state()).edges).toEqual(["b", "d"]);
  expect((await state()).history).toBe(before.history + 1);
  await history("undo");
  await page.evaluate(async () => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    useFlowStore.setState((state: { activeTabId: string; tabs: BrowserProjectTab[] }) => ({
      tabs: state.tabs.map((tab) => tab.id === state.activeTabId ? { ...tab, readOnly: true } : tab),
    }));
  });
  const readOnlyBefore = await state();
  await source.click({ button: "right" });
  await target.click({ button: "right" });
  expect(await state()).toEqual(readOnlyBefore);
  await page.evaluate(async () => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    useFlowStore.setState((state: { activeTabId: string; tabs: BrowserProjectTab[] }) => ({
      tabs: state.tabs.map((tab) => tab.id === state.activeTabId ? { ...tab, readOnly: false } : tab),
    }));
  });
  await target.click({ button: "right" });
  const start = await source.boundingBox();
  const end = await target.boundingBox();
  if (!start || !end) throw new Error("连线点未渲染");
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 16 });
  await page.mouse.up();
  await expect.poll(async () => (await state()).edges.length).toBe(3);
  await target.click({ button: "right" });
  await expect.poll(async () => (await state()).edges).toEqual(["b", "d"]);
  expect((await state()).nodes).toEqual(before.nodes);
});

interface BrowserFlowNode {
  id: string;
  data: { kind: string; stylePresetId?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface BrowserProjectTab {
  id: string;
  projectId: string;
  nodes: BrowserFlowNode[];
}

const TEMPLATE_FIXTURES = Array.from({ length: 3 }, (_, index) => ({
  schemaVersion: WORKFLOW_SCHEMA_VERSION,
  id: `e2e-template-${index + 1}`,
  name: `E2E 模板 ${index + 1}`,
  description: "用于验证模板面板在桌面 Dock 组合下的响应式网格",
  builtIn: true,
  createdAt: "2026-08-24T00:00:00.000Z",
  flow: { schemaVersion: WORKFLOW_SCHEMA_VERSION, nodes: [], edges: [] },
})) satisfies WorkflowTemplate[];

const PROJECT_CENTER_PROJECT_FIXTURES = Array.from({ length: 5 }, (_, index) => ({
  id: `e2e-project-${index + 1}`,
  name: `超长项目名称 ${index + 1} · 用于验证单元长度折行在不同分辨率下的稳定展示`,
  ownerName: "E2E 演示用户",
  readOnly: index === 0,
  updatedAt: "2026-08-24T00:00:00.000Z",
}));

const PROJECT_CENTER_TEMPLATE_FIXTURES: Array<WorkflowTemplate> = [
  {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: "e2e-template-builtin-1",
    name: "超长内置模板示例 1",
    description: "用于验证 3 列/4 列切换时模板卡片标题双行截断的稳定效果",
    builtIn: true,
    createdAt: "2026-08-24T00:00:00.000Z",
    flow: { schemaVersion: WORKFLOW_SCHEMA_VERSION, nodes: [], edges: [] },
  },
  {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: "e2e-template-builtin-2",
    name: "内置模板示例 2",
    description: "快速创建一个基础画布与节点",
    builtIn: true,
    createdAt: "2026-08-24T00:00:01.000Z",
    flow: { schemaVersion: WORKFLOW_SCHEMA_VERSION, nodes: [], edges: [] },
  },
  {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: "e2e-template-my-1",
    name: "超长自建模板名称 1",
    description: "用于验证我的模板卡片标题与动作区域在窄列下依然可见且不溢出",
    builtIn: false,
    createdAt: "2026-08-24T00:00:02.000Z",
    flow: { schemaVersion: WORKFLOW_SCHEMA_VERSION, nodes: [], edges: [] },
  },
];

const RESULTS_DENSITY_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAoAAAAHgCAIAAAC6s0uzAAAF+klEQVR42u3VMQ0AAAgEsZfCxIx/dbiApUkV3HKpHgDgWCQAAAMGAAMGAAwYAAwYADBgADBgAMCAAcCAAQADBgADBgADBgAMGAAMGAAwYAAwYADAgAHAgAEAAwYAAwYAAwYADBgADBgAMGAAMGAAwIABwIABAAMGAAMGAAMGAAwYAAwYADBgADBgAMCAAcCAAQADBgADBgADBgAMGAAMGAAwYAAwYADAgAHAgAEAAwYAAwYAAwYADBgADBgAMGAAMGAAwIABwIABAAMGAAMGAAMGAAwYAAwYADBgADBgAMCAAcCAAQADBgADBgADBgAMGAAMGAAwYAAwYADAgAHAgAEAAwYAAwYAAwYADBgADBgAMGAAMGAAwIABwIABAAMGAAMGAANWAQAMGAAMGAAwYAAwYADAgAHAgAEAAwYAAwYADBgADBgADBgAMGAAMGAAwIABwIABAAMGAAMGAAwYAAwYAAwYADBgADBgAMCAAcCAAQADBgADBgAMGAAMGAAMGAAwYAAwYADAgAHAgAEAAwYAAwYADBgADBgADBgAMGAAMGAAwIABwIABAAMGAAMGAAwYAAwYAAwYADBgADBgAMCAAcCAAQADBgADBgAMGAAMGAAMGAAwYAAwYADAgAHAgAEAAwYAAwYADBgADBgADBgAMGAAMGAAwIABwIABAAMGAAMGAAwYAAwYAAwYADBgADBgAMCAAcCAAQADBgADBgAMGAAMGAAMWAUAMGAAMGAAwIABwIABAAMGAAMGAAwYAAwYADBgADBgADBgAMCAAcCAAQADBgADBgAMGAAMGAAwYAAwYAAwYADAgAHAgAEAAwYAAwYADBgADBgAMGAAMGAAMGAAwIABwIABAAMGAAMGAAwYAAwYADBgADBgADBgAMCAAcCAAQADBgADBgAMGAAMGAAwYAAwYAAwYADAgAHAgAEAAwYAAwYADBgADBgAMGAAMGAAMGAAwIABwIABAAMGAAMGAAwYAAwYADBgADBgADBgAMCAAcCAAQADBgADBgAMGAAMGAAwYAAwYAAwYADAgAHAgAEAAwYAAwYADBgADBgAMGAAMGAAMGAAwIABwIABAAMGAAMGAAwYAAwYADBgADBgADBgCQDAgAHAgAEAAwYAAwYADBgADBgAMGAAMGAAwIABwIABwIABAAMGAAMGAAwYAAwYADBgADBgAMCAAcCAAcCAAQADBgADBgAMGAAMGAAwYAAwYADAgAHAgAHAgAEAAwYAAwYADBgADBgAMGAAMGAAwIABwIABwIABAAMGAAMGAAwYAAwYADBgADBgAMCAAcCAAcCAAQADBgADBgAMGAAMGAAwYAAwYADAgAHAgAHAgAEAAwYAAwYADBgADBgAMGAAMGAAwIABwIABwIABAAMGAAMGAAwYAAwYADBgADBgAMCAAcCAAcCAAQADBgADBgAMGAAMGAAwYAAwYADAgAHAgAHAgFUAAAMGAAMGAAwYAAwYADBgADBgAMCAAcCAAQADBgADBgADBgAMGAAMGAAwYAAwYADAgAHAgAEAAwYAAwYAAwYADBgADBgAMGAAMGAAwIABwIABAAMGAAMGAAMGAAwYAAwYADBgADBgAMCAAcCAAQADBgADBgADBgAMGAAMGAAwYAAwYADAgAHAgAEAAwYAAwYAAwYADBgADBgAMGAAMGAAwIABwIABAAMGAAMGAAMGAAwYAAwYADBgADBgAMCAAcCAAQADBgADBgADBgAMGAAMGAAwYAAwYADAgAHAgAEAAwYAAwYAAwYADBgADBgAMGAAMGAAwIABwIABAAMGAAMGAANWAQAMGAAMGAAwYAAwYADAgAHAgAEAAwYAAwYADBgADBgADBgAMGAAMGAAwIABwIABAAMGAAMGAAwYAAwYAAwYADBgADBgAMCAAcCAAQADBgADBgAMGAAMGAAMGAAwYAAwYADAgAHAgAEAAwYAAwYADBgADBgADBgAMGAAMGAAwIABwIABAAMGAAMGAAwYAAwYAAwYADBgADBgAMCAAcCAAQADBgADBgAMGAD+LTRiQGhLJaS5AAAAAElFTkSuQmCC";
const E2E_UPLOAD_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const RESULTS_DENSITY_FIXTURES = [
  {
    id: "e2e-result-success",
    runId: "e2e-run-success",
    image: RESULTS_DENSITY_IMAGE,
    thumbnail: RESULTS_DENSITY_IMAGE,
    nodeId: "node-success",
    nodeLabel: "超长成功结果卡片标题 · 用于验证双列布局下动作按钮可读性",
    kind: "sketch-to-render" as const,
    projectId: "e2e-project-1",
    projectName: "演示项目",
    prompt: "检查结果卡片动作与布局",
    model: "gpt-image-2",
    startedAt: 1760000000000,
    finishedAt: 1760000001000,
    status: "success" as const,
    ownerName: "E2E 演示用户",
  },
  {
    id: "e2e-result-failed",
    runId: "e2e-run-failed",
    image: RESULTS_DENSITY_IMAGE,
    nodeId: "node-failed",
    nodeLabel: "失败结果测试",
    kind: "sketch-to-render" as const,
    projectId: "e2e-project-2",
    prompt: "失败演示",
    startedAt: 1760000002000,
    status: "error" as const,
    error: "演示错误",
  },
  {
    id: "e2e-result-unknown",
    runId: "e2e-run-unknown",
    image: RESULTS_DENSITY_IMAGE,
    nodeId: "node-unknown",
    nodeLabel: "未知状态结果测试",
    kind: "sketch-to-render" as const,
    projectId: "e2e-project-3",
    prompt: "未知演示",
    startedAt: 1760000003000,
    status: "outcome_unknown" as const,
  },
];

async function rect(locator: Locator): Promise<Rect> {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
    };
  });
}

async function expectWidth(locator: Locator, width: number) {
  await expect.poll(async () => (await rect(locator)).width).toBe(width);
}

async function expectInert(locator: Locator, inert: boolean) {
  await expect.poll(async () => locator.evaluate((element) => (element as HTMLElement).inert)).toBe(inert);
  expect(await locator.getAttribute("inert")).toBe(inert ? "" : null);
}

function expectInside(child: Rect, parent: Rect) {
  expect(child.left).toBeGreaterThanOrEqual(parent.left - 1);
  expect(child.right).toBeLessThanOrEqual(parent.right + 1);
  expect(child.top).toBeGreaterThanOrEqual(parent.top - 1);
  expect(child.bottom).toBeLessThanOrEqual(parent.bottom + 1);
}

async function gridColumnCount(locator: Locator): Promise<number> {
  return locator.evaluate((element) => (
    getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length
  ));
}

async function expectGridColumns(locator: Locator, count: number) {
  await expect(locator).toBeVisible();
  await expect.poll(async () => gridColumnCount(locator)).toBe(count);
}

async function expectTwoLineTitle(locator: Locator) {
  await expect(locator).toBeVisible();
  const metrics = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: element.getBoundingClientRect().height,
      lineClamp: style.webkitLineClamp,
    };
  });
  expect(metrics.lineClamp).toBe("2");
  expect(metrics.height).toBeGreaterThanOrEqual(31);
  expect(metrics.height).toBeLessThanOrEqual(33);
}

async function flowCenter(canvas: Locator): Promise<{ x: number; y: number }> {
  return canvas.evaluate((element) => {
    const viewport = element.querySelector<HTMLElement>(".react-flow__viewport");
    if (!viewport) throw new Error("React Flow viewport is missing");
    const canvasRect = element.getBoundingClientRect();
    const transform = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
    return {
      x: (canvasRect.width / 2 - transform.e) / transform.a,
      y: (canvasRect.height / 2 - transform.f) / transform.d,
    };
  });
}

async function expectFlowCenter(
  canvas: Locator,
  expected: { x: number; y: number },
) {
  await expect.poll(async () => {
    const current = await flowCenter(canvas);
    return Math.max(Math.abs(current.x - expected.x), Math.abs(current.y - expected.y));
  }).toBeLessThanOrEqual(1);
}

async function openFreshBlankProject(page: Page) {
  await page.getByRole("button", { name: "打开项目中心" }).click();
  const center = page.getByRole("dialog", { name: "项目中心" });
  await expect(center).toBeVisible();
  await center.getByRole("button", { name: "新建项目" }).click();
  await expect(page.getByRole("region", { name: "开始第一个创作任务" })).toBeVisible();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => { resolve = release; });
  return { promise, resolve };
}

async function addTextNode(page: Page): Promise<Locator> {
  const nodes = page.locator(".react-flow__node");
  const before = await nodes.count();
  const rail = page.getByRole("navigation", { name: "工作台左侧工具" });
  await rail.getByRole("button", { name: "添加节点", exact: true }).click();
  await page.getByRole("menu", { name: "添加节点" }).getByRole("menuitem", { name: /文本节点/ }).click();
  await expect(nodes).toHaveCount(before + 1);
  return nodes.filter({ hasText: "文本节点" }).last();
}

async function expectCurrentThemeContract(page: Page) {
  const theme = await page.locator("html").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      selector: element.getAttribute("data-theme"),
      shell: style.getPropertyValue("--gc-shell").trim(),
      panel: style.getPropertyValue("--gc-panel").trim(),
      text: style.getPropertyValue("--gc-text").trim(),
      border: style.getPropertyValue("--gc-border").trim(),
      accent: style.getPropertyValue("--gc-accent").trim(),
    };
  });
  expect(theme).toEqual({
    selector: null,
    shell: "#101214",
    panel: "#17191c",
    text: "#e5e7eb",
    border: "#2b2e32",
    accent: "#b18745",
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("application", { name: "工作流画布" })).toBeVisible();
  await expect(page.getByText(/正在确认运行历史|运行历史同步失败/)).toHaveCount(0);
});

test("five tool groups support hover keyboard click drag and disabled no-op", async ({ page }) => {
  await openFreshBlankProject(page);
  const canvas = page.getByRole("application", { name: "工作流画布" });
  const toolRail = page.getByRole("navigation", { name: "工作台左侧工具" });
  const groupNames = ["添加节点", "服装设计", "模特换装", "视频制作", "创作工具"];
  for (const name of groupNames) await expect(toolRail.getByRole("button", { name, exact: true })).toBeVisible();

  for (const name of groupNames) {
    const trigger = toolRail.getByRole("button", { name, exact: true });
    await trigger.hover();
    const menu = page.getByRole("menu", { name });
    await expect(menu).toBeVisible();
    const menuRect = await rect(menu);
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("Desktop viewport is required");
    expectInside(menuRect, {
      left: 0,
      top: 0,
      right: viewport.width,
      bottom: viewport.height,
      width: viewport.width,
      height: viewport.height,
    });
  }

  const addTrigger = toolRail.getByRole("button", { name: "添加节点", exact: true });
  await addTrigger.hover();
  const addMenu = page.getByRole("menu", { name: "添加节点" });
  await expect(addMenu).toBeVisible();
  await addMenu.hover();
  await expect(addMenu).toBeVisible();

  const beforeClick = await page.locator(".react-flow__node").count();
  await addMenu.getByRole("menuitem", { name: /文本节点/ }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(beforeClick + 1);

  const apparelTrigger = toolRail.getByRole("button", { name: "服装设计", exact: true });
  await apparelTrigger.focus();
  await apparelTrigger.press("Enter");
  const apparelMenu = page.getByRole("menu", { name: "服装设计" });
  await expect(apparelMenu).toBeVisible();
  await expect(apparelMenu.getByRole("menuitem").first()).toBeFocused();
  await apparelMenu.press("Escape");
  await expect(apparelMenu).toBeHidden();
  await expect(apparelTrigger).toBeFocused();

  await toolRail.getByRole("button", { name: "视频制作", exact: true }).click();
  const videoMenu = page.getByRole("menu", { name: "视频制作" });
  const videoItem = videoMenu.getByRole("menuitem", { name: /文生视频/ });
  await expect(videoItem).toHaveAttribute("aria-disabled", "false");
  await expect(videoItem).toHaveAttribute("data-approval-state", "approved");
  await videoItem.click();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(page.locator(".react-flow__node").filter({ hasText: "文生视频" })).toBeVisible();

  await addTrigger.click();
  const uploadItem = page.getByRole("menu", { name: "添加节点" }).getByRole("menuitem", { name: /本地上传图片/ });
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await uploadItem.dispatchEvent("dragstart", { dataTransfer: transfer });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas box missing");
  await canvas.dispatchEvent("drop", {
    dataTransfer: transfer,
    clientX: box.x + box.width * 0.72,
    clientY: box.y + box.height * 0.42,
  });
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
});

test("one-click try-on uploads auto-connect and uploaded media drags as one history action", async ({ page }) => {
  await openFreshBlankProject(page);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  const rail = page.getByRole("navigation", { name: "工作台左侧工具" });
  await rail.getByRole("button", { name: "模特换装", exact: true }).click();
  const menu = page.getByRole("menu", { name: "模特换装" });
  await menu.getByRole("menuitem", { name: /一键换装/ }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(21);
  const personId = await nodeIdByLabel(page, "图 1 · 人物身份参考（必需）");
  const outfitId = await nodeIdByLabel(page, "主穿搭图（必需）");
  const composeId = await nodeIdByLabel(page, "前置 · AI 换脸与换姿势");
  const stabilizeId = await nodeIdByLabel(page, "第一轮 · Gemini 场景化定版");
  const refineId = await nodeIdByLabel(page, "第二轮 · GPT 服装还原与精修");
  const garmentDetailId = await nodeIdByLabel(page, "第二轮 · 局部重绘（可选）");
  const personNode = page.locator(`.react-flow__node[data-id="${personId}"]`);
  const outfitNode = page.locator(`.react-flow__node[data-id="${outfitId}"]`);
  const personMedia = personNode.locator(".gc-image-input-media");
  await personNode.locator('input[type="file"]').setInputFiles({
    name: "person.png",
    mimeType: "image/png",
    buffer: E2E_UPLOAD_PNG,
  });
  await expect(personMedia.getByAltText("已上传图片")).toBeVisible();
  await expect.poll(() => page.evaluate(async ({ personId, stabilizeId }) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    const tab = useFlowStore.getState().tabs.find((candidate: { id: string }) => candidate.id === useFlowStore.getState().activeTabId);
    return tab?.edges.map((edge: { source: string; target: string; targetHandle?: string | null }) => `${edge.source}:${edge.target}:${edge.targetHandle}`).sort();
  }, { personId, stabilizeId })).toEqual(expect.arrayContaining([
    `${personId}:${composeId}:references`,
  ]));

  await outfitNode.locator('input[type="file"]').setInputFiles({
    name: "outfit.png",
    mimeType: "image/png",
    buffer: E2E_UPLOAD_PNG,
  });
  await expect.poll(() => page.evaluate(async ({ outfitId, stabilizeId, refineId, garmentDetailId }) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    const state = useFlowStore.getState();
    const tab = state.tabs.find((candidate: { id: string }) => candidate.id === state.activeTabId);
    return tab?.edges.filter((edge: { source: string }) => edge.source === outfitId).map((edge: { target: string }) => edge.target).sort();
  }, { outfitId, stabilizeId, refineId, garmentDetailId })).toEqual([garmentDetailId, refineId, stabilizeId].sort());

  const stabilizeNode = page.locator(`.react-flow__node[data-id="${stabilizeId}"]`);
  await expect(stabilizeNode).toBeVisible();
  await stabilizeNode.locator(".gc-node-floating-title").click();
  await page.getByRole("button", { name: "属性", exact: true }).click();
  const qualityControls = page.locator("#workbench-inspector-panel");
  await expect(qualityControls.getByRole("combobox", { name: "图像模型" })).toContainText("Gemini 3 Pro");
  await expect(qualityControls.getByRole("switch", { name: "提示词增强" })).toHaveCount(0);
  await expect(qualityControls.getByRole("switch", { name: "审核失败安全降级一次" })).toHaveCount(0);
  await page.getByRole("button", { name: "属性", exact: true }).click();

  await page.evaluate(async (garmentDetailId) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    useFlowStore.getState().setSelectedNodeIds([garmentDetailId]);
  }, garmentDetailId);
  await expect(page.locator(`.react-flow__node[data-id="${garmentDetailId}"]`)).toContainText("第二轮 · 局部重绘（可选）");
  const localRedraw = await page.evaluate(async (garmentDetailId) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { selectActiveDocument, useFlowStore } = await import(storeModulePath);
    const document = selectActiveDocument(useFlowStore.getState());
    return document.nodes.find((node: BrowserFlowNode) => node.id === garmentDetailId)?.data;
  }, garmentDetailId);
  expect(localRedraw).toMatchObject({
    kind: "mask-redraw",
    modelId: "gpt-image-2.5-sunburst",
    repairFocus: "custom",
    executionMode: "repair",
  });

  await page.evaluate(async () => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    useFlowStore.getState().setSelectedNodeIds([]);
    useFlowStore.temporal.getState().clear();
  });
  const beforePan = await personMedia.boundingBox();
  if (!beforePan) throw new Error("Uploaded image is missing before viewport positioning");
  if (beforePan.x < 96 || beforePan.y < 64) {
    const panStart = await page.evaluate(() => {
      for (let y = 140; y < window.innerHeight - 80; y += 40) {
        for (let x = 160; x < window.innerWidth - 160; x += 40) {
          const element = document.elementFromPoint(x, y);
          if (element?.classList.contains("react-flow__pane")) return { x, y };
        }
      }
      return null;
    });
    if (!panStart) throw new Error("No clear canvas point is available for viewport positioning");
    await page.mouse.move(panStart.x, panStart.y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(
      panStart.x + Math.max(0, 128 - beforePan.x),
      panStart.y + Math.max(0, 96 - beforePan.y),
      { steps: 8 },
    );
    await page.mouse.up({ button: "middle" });
  }
  await expect.poll(async () => (await personMedia.boundingBox())?.x ?? 0).toBeGreaterThan(95);
  await expect.poll(async () => (await personMedia.boundingBox())?.y ?? 0).toBeGreaterThan(63);
  await personMedia.click();
  await expect(personNode).toHaveClass(/\bselected\b/);
  const minimapThumbnail = page.locator(".gc-minimap-node-thumbnail").first();
  await expect(minimapThumbnail).toBeVisible();
  const resizeBefore = await page.evaluate(async (personId) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { persistedWorkflowForProjectTab, useFlowStore } = await import(storeModulePath);
    const state = useFlowStore.getState();
    const tab = state.tabs.find((candidate: { id: string }) => candidate.id === state.activeTabId)!;
    const node = tab.nodes.find((candidate: { id: string }) => candidate.id === personId)!;
    return { position: node.position, revision: tab.revision, persistedPosition: persistedWorkflowForProjectTab(tab).nodes.find((candidate: { id: string }) => candidate.id === personId)?.position };
  }, personId);
  const cornerHandles = personNode.locator(".react-flow__resize-control.handle");
  await expect(cornerHandles).toHaveCount(4);
  const topLeftBox = await personNode.locator(".react-flow__resize-control.handle.top.left").boundingBox();
  const nodeBoxBeforeResize = await personNode.boundingBox();
  if (!topLeftBox || !nodeBoxBeforeResize) throw new Error("Reference image resize controls are missing");
  expect(await page.evaluate(({ x, y }) => (
    document.elementFromPoint(x, y)?.closest(".react-flow__resize-control")?.className
  ), {
    x: topLeftBox.x + topLeftBox.width / 2, y: topLeftBox.y + topLeftBox.height / 2,
  })).toContain("react-flow__resize-control");
  await page.mouse.move(topLeftBox.x + topLeftBox.width / 2, topLeftBox.y + topLeftBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(topLeftBox.x - 28, topLeftBox.y - 20, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await personNode.boundingBox())?.width ?? 0).toBeGreaterThan(nodeBoxBeforeResize.width);
  const resizeAfter = await page.evaluate(async (personId) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { persistedWorkflowForProjectTab, useFlowStore } = await import(storeModulePath);
    const state = useFlowStore.getState();
    const tab = state.tabs.find((candidate: { id: string }) => candidate.id === state.activeTabId)!;
    const node = tab.nodes.find((candidate: { id: string }) => candidate.id === personId)!;
    return {
      position: node.position,
      revision: tab.revision,
      pastStates: useFlowStore.temporal.getState().pastStates.length,
      persistedPosition: persistedWorkflowForProjectTab(tab).nodes.find((candidate: { id: string }) => candidate.id === personId)?.position,
    };
  }, personId);
  expect(resizeAfter.position).not.toEqual(resizeBefore.position);
  expect(resizeAfter.persistedPosition).toEqual(resizeBefore.persistedPosition);
  expect(resizeAfter.revision).toBe(resizeBefore.revision);
  expect(resizeAfter.pastStates).toBe(0);
  const widthBeforeKeyboardResize = (await personNode.boundingBox())!.width;
  await personNode.getByRole("button", { name: "调整参考图尺寸：top-left" }).press("ArrowUp");
  await expect.poll(async () => (await personNode.boundingBox())?.width ?? 0).toBeGreaterThan(widthBeforeKeyboardResize);
  await expect(page.getByRole("dialog", { name: "图片查看器" })).toHaveCount(0);

  const start = await page.evaluate(async (personId) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    const state = useFlowStore.getState();
    const tab = state.tabs.find((candidate: { id: string }) => candidate.id === state.activeTabId);
    return tab?.nodes.find((node: { id: string; position: { x: number; y: number } }) => node.id === personId)?.position;
  }, personId);
  const mediaBox = await personMedia.boundingBox();
  if (!mediaBox || !start) throw new Error("Uploaded image drag target is missing");
  await page.mouse.move(mediaBox.x + mediaBox.width / 2, mediaBox.y + mediaBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(mediaBox.x + mediaBox.width / 2 + 90, mediaBox.y + mediaBox.height / 2 + 35, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(async () => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    return useFlowStore.temporal.getState().pastStates.length;
  })).toBe(1);
  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(() => page.evaluate(async ({ expected, personId }) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    const state = useFlowStore.getState();
    const tab = state.tabs.find((candidate: { id: string }) => candidate.id === state.activeTabId);
    const position = tab?.nodes.find((node: { id: string; position: { x: number; y: number } }) => node.id === personId)?.position;
    return position ? Math.max(Math.abs(position.x - expected.x), Math.abs(position.y - expected.y)) : Infinity;
  }, { expected: start, personId })).toBeLessThan(0.001);
  const removableEdgeId = await page.evaluate(async (personId) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    const state = useFlowStore.getState();
    const tab = state.tabs.find((candidate: { id: string }) => candidate.id === state.activeTabId);
    return tab?.edges.find((edge: { source: string }) => edge.source === personId)?.id;
  }, personId);
  if (!removableEdgeId) throw new Error("Expected a person reference edge");
  const removableEdge = page.locator(`.react-flow__edge[data-id="${removableEdgeId}"] .react-flow__edge-interaction`);
  const removableEdgeBox = await removableEdge.boundingBox();
  if (!removableEdgeBox) throw new Error("Expected a visible person reference edge");
  await removableEdge.dispatchEvent("contextmenu", {
    button: 2,
    clientX: removableEdgeBox.x + removableEdgeBox.width / 2,
    clientY: removableEdgeBox.y + removableEdgeBox.height / 2,
  });
  const edgeMenu = page.getByRole("menu").filter({ hasText: "断开连线" });
  await expect(edgeMenu).toBeVisible();
  await edgeMenu.getByRole("menuitem", { name: "断开连线" }).click();
  await expect.poll(() => page.evaluate(async (edgeId) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    const state = useFlowStore.getState();
    const tab = state.tabs.find((candidate: { id: string }) => candidate.id === state.activeTabId);
    return tab?.edges.some((edge: { id: string }) => edge.id === edgeId);
  }, removableEdgeId)).toBe(false);
});

test("delayed style preset writes stay bound to the initiating document", async ({ page }, testInfo) => {
  const styleAssets: Array<{ name: string; url: string }> = [];
  for (const category of ["upload", "generated"]) {
    const name = `风格分类-${category}-${testInfo.project.name}`;
    const response = await page.request.post("/api/assets", {
      data: { name, category, image: RESULTS_DENSITY_IMAGE },
    });
    expect(response.status()).toBe(201);
    styleAssets.push({ name, url: ((await response.json()) as { url: string }).url });
  }
  await openFreshBlankProject(page);
  const rail = page.getByRole("navigation", { name: "工作台左侧工具" });
  await rail.getByRole("button", { name: "模特换装", exact: true }).click();
  await page.getByRole("menu", { name: "模特换装" }).getByRole("menuitem", { name: /一键换装/ }).click();

  const stabilizeId = await nodeIdByLabel(page, "第一轮 · Gemini 场景化定版");
  const stabilizeNode = page.locator(`.react-flow__node[data-id="${stabilizeId}"]`);
  await expect(stabilizeNode).toBeVisible();
  await stabilizeNode.locator(".gc-node-floating-title").click();
  const inspector = page.locator("#workbench-inspector-panel");
  if (!await inspector.isVisible()) {
    await page.getByRole("button", { name: "属性", exact: true }).click();
  }
  await expect(inspector).toBeVisible();

  const assetOffsets: number[] = [];
  let failAssetPage = true;
  await page.route("**/api/assets?*", async (route) => {
    const offset = Number(new URL(route.request().url()).searchParams.get("offset") ?? 0);
    assetOffsets.push(offset);
    if (offset === 100 && failAssetPage) {
      await route.fulfill({ status: 503, json: { error: "test unavailable" } });
      return;
    }
    await route.fulfill({ json: offset === 0
      ? Array.from({ length: 100 }, (_, index) => ({
        id: `newer-${index}`, name: `较新素材 ${index}`, image: `/api/files/newer-${index}.png`, category: "upload",
      }))
      : styleAssets.map((asset, index) => ({ id: `older-${index}`, name: asset.name, image: asset.url, category: "generated" })),
    });
  });

  const saveStarted = deferred();
  const releaseSave = deferred();
  await page.route("**/api/try-on-style-presets", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    saveStarted.resolve();
    expect(route.request().postDataJSON().referenceImage).toBe(styleAssets[1].url);
    await releaseSave.promise;
    const response = await route.fetch();
    await route.fulfill({ response });
  });

  await inspector.getByRole("button", { name: "保存为我的风格预设" }).click();
  const dialog = page.getByRole("dialog", { name: "保存风格预设" });
  await expect(dialog.getByRole("alert")).toHaveText("参考素材加载失败，请重新打开后重试");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  failAssetPage = false;
  await inspector.getByRole("button", { name: "保存为我的风格预设" }).click();
  await expect.poll(() => assetOffsets).toEqual([0, 100, 0, 100]);
  await dialog.getByLabel("名称").fill(`延迟隔离 ${testInfo.project.name}`);
  await dialog.getByLabel("提示词片段").fill("仅用于验证异步文档隔离");
  await dialog.getByRole("combobox", { name: "固定参考图（可选）" }).click();
  await expect(page.getByRole("option")).toHaveCount(103);
  for (const asset of styleAssets) {
    await page.getByRole("option", { name: asset.name, exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("option", { name: asset.name, exact: true })).toBeVisible();
  }
  await page.getByRole("option", { name: styleAssets[1].name, exact: true }).click();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await saveStarted.promise;

  const saveTargets = await page.evaluate(async (stabilizeId) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    const store = useFlowStore.getState();
    const source = store.tabs.find((tab: BrowserProjectTab) => tab.id === store.activeTabId)!;
    const stage = source.nodes.find((node: BrowserFlowNode) => node.id === stabilizeId)!;
    store.createBlankTab();
    useFlowStore.getState().loadFlow({
      projectId: `style-isolation-${crypto.randomUUID()}`,
      projectName: "异步隔离目标",
      nodes: [{ ...stage, data: { ...stage.data, stylePresetId: "faithful", stylePresetName: "忠实还原" } }],
      edges: [],
      markDirty: true,
    });
    return { sourceTabId: source.id, activeTabId: useFlowStore.getState().activeTabId };
  }, stabilizeId);
  const saveRefresh = page.waitForResponse((response) => (
    response.request().method() === "GET"
    && new URL(response.url()).pathname === "/api/try-on-style-presets"
  ));
  releaseSave.resolve();
  await saveRefresh;
  await expect.poll(() => page.evaluate(async ({ sourceTabId, activeTabId, stabilizeId }) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    const state = useFlowStore.getState();
    const source = state.tabs.find((tab: BrowserProjectTab) => tab.id === sourceTabId)?.nodes.find((node: BrowserFlowNode) => node.id === stabilizeId);
    const active = state.tabs.find((tab: BrowserProjectTab) => tab.id === activeTabId)?.nodes.find((node: BrowserFlowNode) => node.id === stabilizeId);
    return {
      sourceIsCustom: source?.data.kind === "virtual-try-on" && Boolean(source.data.stylePresetId && source.data.stylePresetId !== "faithful"),
      activePreset: active?.data.kind === "virtual-try-on" ? active.data.stylePresetId : undefined,
    };
  }, { ...saveTargets, stabilizeId })).toEqual({ sourceIsCustom: true, activePreset: "faithful" });
  await page.unroute("**/api/try-on-style-presets");
  await page.unroute("**/api/assets?*");

  await page.evaluate(async ({ sourceTabId, stabilizeId }) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    useFlowStore.getState().switchTab(sourceTabId);
    useFlowStore.getState().setSelectedNodeIds([stabilizeId]);
  }, { sourceTabId: saveTargets.sourceTabId, stabilizeId });
  await expect(inspector.getByRole("button", { name: "删除当前风格预设" })).toBeVisible();

  const deleteStarted = deferred();
  const releaseDelete = deferred();
  await page.route("**/api/try-on-style-presets/*", async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.continue();
      return;
    }
    deleteStarted.resolve();
    await releaseDelete.promise;
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  await inspector.getByRole("button", { name: "删除当前风格预设" }).click();
  await deleteStarted.promise;

  const replacement = await page.evaluate(async (stabilizeId) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    const state = useFlowStore.getState();
    const current = state.tabs.find((tab: BrowserProjectTab) => tab.id === state.activeTabId)!;
    const stage = current.nodes.find((node: BrowserFlowNode) => node.id === stabilizeId)!;
    const nextProjectId = `style-replacement-${crypto.randomUUID()}`;
    state.loadFlow({
      projectId: nextProjectId,
      projectName: "替换后的项目",
      nodes: [{ ...stage, data: { ...stage.data, stylePresetId: "faithful", stylePresetName: "忠实还原" } }],
      edges: [],
      markDirty: true,
    });
    return { tabId: current.id, projectId: nextProjectId };
  }, stabilizeId);
  const deleteRefresh = page.waitForResponse((response) => (
    response.request().method() === "GET"
    && new URL(response.url()).pathname === "/api/try-on-style-presets"
  ));
  releaseDelete.resolve();
  await deleteRefresh;
  await page.waitForTimeout(100);
  expect(await page.evaluate(async ({ tabId, projectId, stabilizeId }) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    const tab = useFlowStore.getState().tabs.find((candidate: BrowserProjectTab) => candidate.id === tabId);
    const stage = tab?.nodes.find((node: BrowserFlowNode) => node.id === stabilizeId);
    return {
      projectId: tab?.projectId,
      presetId: stage?.data.kind === "virtual-try-on" ? stage.data.stylePresetId : undefined,
    };
  }, { ...replacement, stabilizeId })).toEqual({ projectId: replacement.projectId, presetId: "faithful" });
});

test("staged try-on confirms a semantic role before connecting and invalidates stale approval", async ({ page }, testInfo) => {
  const templateName = `双模型分步换装 E2E ${testInfo.project.name}`;
  const createResponse = await page.request.post("/api/templates", {
    data: {
      name: templateName,
      description: "验证分步换装角色确认与独立审批失效",
      flow: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          {
            id: "e2e-role-source",
            type: "image-input",
            position: { x: 0, y: 0 },
            data: { kind: "image-input", label: "待分配参考图", status: "idle", imageRole: "reference" },
          },
          {
            id: "e2e-stabilize",
            type: "virtual-try-on",
            position: { x: 380, y: 0 },
            data: {
              kind: "virtual-try-on",
              label: "第一轮 · Gemini 场景化定版",
              status: "idle",
              workflowStage: "scene-stabilize",
              prompt: "",
              modelId: "gemini-3.1-flash-image",
              modelOptions: { aspectRatio: "1:1", imageSize: "2K" },
              imageSize: "2K",
              aspectRatio: "1:1",
              basisRevision: 0,
              promptEnhancement: false,
              qualityMode: "fast",
              safetyFallback: false,
              stylePresetId: "faithful",
              outputImages: [],
            },
          },
          {
            id: "e2e-approval",
            type: "stage-approval",
            position: { x: 760, y: 0 },
            data: {
              kind: "stage-approval",
              label: "确认第一轮基准",
              status: "idle",
              approvalKind: "scene-baseline",
            },
          },
          {
            id: "e2e-refine",
            type: "virtual-try-on",
            position: { x: 1120, y: 0 },
            data: {
              kind: "virtual-try-on",
              label: "第二轮 · GPT 服装精修",
              status: "idle",
              workflowStage: "garment-refine",
              prompt: "",
              modelId: "gpt-image-2",
              modelOptions: { quality: "medium" },
              imageSize: "2K",
              aspectRatio: "1:1",
              garmentCategory: "knit",
              materialSpec: "羊毛混纺，双股纱，中等厚度",
              constructionSpec: "12GG 平针，1×1 罗纹领口",
              promptEnhancement: false,
              qualityMode: "fast",
              safetyFallback: false,
              stylePresetId: "faithful",
              outputImages: [],
            },
          },
        ],
        edges: [
          {
            id: "e2e-stage-candidate",
            source: "e2e-stabilize",
            target: "e2e-approval",
            sourceHandle: "image",
            targetHandle: "baseline-candidate",
          },
        ],
      },
    },
  });
  expect(createResponse.ok(), await createResponse.text()).toBeTruthy();

  await page.getByRole("button", { name: "打开项目中心" }).click();
  const projectCenter = page.getByRole("dialog", { name: "项目中心" });
  await expect(projectCenter).toBeVisible();
  await projectCenter.getByRole("tab", { name: "我的模板" }).click();
  const openTemplate = projectCenter.getByRole("button", { name: `打开我的模板：${templateName}` });
  await expect(openTemplate).toBeVisible();
  await openTemplate.click();
  await expect(projectCenter).toBeHidden();
  const sourceId = await nodeIdByLabel(page, "待分配参考图");
  const stabilizeId = await nodeIdByLabel(page, "第一轮 · Gemini 场景化定版");
  const approvalId = await nodeIdByLabel(page, "确认第一轮基准");
  const refineId = await nodeIdByLabel(page, "第二轮 · GPT 服装精修");
  const stabilizeNode = page.locator(`.react-flow__node[data-id="${stabilizeId}"]`);
  const approvalNode = page.locator(`.react-flow__node[data-id="${approvalId}"]`);
  const refineNode = page.locator(`.react-flow__node[data-id="${refineId}"]`);
  await expect(stabilizeNode).toBeVisible();
  expect((await rect(stabilizeNode)).height).toBeLessThanOrEqual(page.viewportSize()!.height - 120);
  expect((await rect(refineNode)).height).toBeLessThanOrEqual(637.4375);

  for (const [node, portIds] of [
    [stabilizeNode, ["person", "scene", "outfit", "detail", "angle-direction"]],
    [refineNode, ["baseline", "outfit", "material", "detail"]],
  ] as const) {
    for (const portId of portIds) {
      const row = node.locator(`[data-port-row="${portId}"]`);
      const port = row.locator(`.gc-staged-role-handle[data-handleid="${portId}"]`);
      await expect(port).toBeVisible();
      await expect(row.locator("[data-port-state]")).toHaveCount(0);
      const [rowBox, portBox, labelBox] = await Promise.all([
        row.boundingBox(),
        port.boundingBox(),
        row.locator("span").first().boundingBox(),
      ]);
      expect(rowBox).not.toBeNull();
      expect(portBox).not.toBeNull();
      expect(labelBox).not.toBeNull();
      expect(portBox!.width).toBeLessThanOrEqual(8);
      expect(portBox!.height).toBeLessThanOrEqual(8);
      expect(portBox!.x).toBeGreaterThanOrEqual(rowBox!.x);
      expect(portBox!.y).toBeGreaterThanOrEqual(rowBox!.y);
      expect(portBox!.x + portBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width);
      expect(portBox!.y + portBox!.height).toBeLessThanOrEqual(rowBox!.y + rowBox!.height);
      expect(portBox!.x + portBox!.width).toBeLessThanOrEqual(labelBox!.x);
    }
  }

  await expect(stabilizeNode.locator('[data-handleid="person"]')).toHaveAttribute("data-connection-state", "required");
  await expect(stabilizeNode.locator('[data-handleid="detail"]')).toHaveAttribute("data-connection-state", "optional");
  await expect(refineNode.locator('[data-handleid="baseline"]')).toHaveAttribute("data-connection-state", "required");
  await expect(refineNode.locator('[data-handleid="material"]')).toHaveAttribute("data-connection-state", "optional");

  for (const node of [stabilizeNode, refineNode]) {
    const output = node.locator('.gc-staged-output-handle[data-handleid="image"]');
    await expect(output).toBeVisible();
    const outputBox = await output.boundingBox();
    expect(outputBox).not.toBeNull();
    expect(outputBox!.width).toBeLessThanOrEqual(8);
    expect(outputBox!.height).toBeLessThanOrEqual(8);
  }

  await expectCurrentThemeContract(page);
  expect((await rect(stabilizeNode)).height).toBeLessThanOrEqual(page.viewportSize()!.height - 120);
  expect((await rect(refineNode)).height).toBeLessThanOrEqual(637.4375);

  await page.evaluate(async () => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    useFlowStore.getState().setSelectedNodeIds([]);
  });
  await expect(page.locator(".gc-workflow-edge--quiet")).toHaveCount(1);
  await stabilizeNode.locator(".gc-node-floating-title").click();
  await expect(page.locator(".gc-workflow-edge--downstream")).toHaveCount(1);

  await page.evaluate(async (stabilizeId) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    useFlowStore.getState().setNodeStatus(stabilizeId, "running");
  }, stabilizeId);
  const flowDots = page.locator(".gc-edge-flow-dots");
  await expect(flowDots).toHaveCount(1);
  await expect.poll(() => flowDots.evaluate((element) => getComputedStyle(element).display)).toBe("none");
  await page.evaluate(async ({ stabilizeId, approvalId }) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    useFlowStore.getState().setNodeStatus(stabilizeId, "idle");
    useFlowStore.getState().onNodesChange([
      { id: stabilizeId, type: "position", position: { x: 380, y: 0 } },
      { id: approvalId, type: "position", position: { x: 400, y: 10 } },
    ]);
  }, { stabilizeId, approvalId });
  await expect.poll(async () => {
    const a = await rect(stabilizeNode);
    const b = await rect(approvalNode);
    return a.right > b.left && b.right > a.left && a.bottom > b.top && b.bottom > a.top;
  }).toBe(true);
  const componentCenterBefore = await Promise.all([rect(stabilizeNode), rect(approvalNode)]).then(([a, b]) => ({
    x: (Math.min(a.left, b.left) + Math.max(a.right, b.right)) / 2,
    y: (Math.min(a.top, b.top) + Math.max(a.bottom, b.bottom)) / 2,
  }));
  const refinePositionBefore = await page.evaluate(async (refineId) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    const state = useFlowStore.getState();
    const tab = state.tabs.find((candidate: { id: string }) => candidate.id === state.activeTabId);
    return tab?.nodes.find((node: { id: string }) => node.id === refineId)?.position;
  }, refineId);
  const canvasCenterBefore = await flowCenter(page.getByRole("application", { name: "工作流画布" }));
  await page.getByRole("button", { name: "整理所选工作流" }).click();
  await expect.poll(async () => {
    const a = await rect(stabilizeNode);
    const b = await rect(approvalNode);
    return a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
  }).toBe(true);
  const componentCenterAfter = await Promise.all([rect(stabilizeNode), rect(approvalNode)]).then(([a, b]) => ({
    x: (Math.min(a.left, b.left) + Math.max(a.right, b.right)) / 2,
    y: (Math.min(a.top, b.top) + Math.max(a.bottom, b.bottom)) / 2,
  }));
  expect(Math.abs(componentCenterAfter.x - componentCenterBefore.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(componentCenterAfter.y - componentCenterBefore.y)).toBeLessThanOrEqual(1);
  await expectFlowCenter(page.getByRole("application", { name: "工作流画布" }), canvasCenterBefore);
  expect(await page.evaluate(async (refineId) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    const state = useFlowStore.getState();
    const tab = state.tabs.find((candidate: { id: string }) => candidate.id === state.activeTabId);
    return tab?.nodes.find((node: { id: string }) => node.id === refineId)?.position;
  }, refineId)).toEqual(refinePositionBefore);

  // 自动整理刻意只移动所选连通分量；把未连接的测试素材放回第一轮左侧，
  // 避免它与保持中心后的节点重叠，随后再验证真实拖线交互。
  await page.evaluate(async ({ stabilizeId, sourceId }) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    const state = useFlowStore.getState();
    const tab = state.tabs.find((candidate: { id: string }) => candidate.id === state.activeTabId);
    const stage = tab?.nodes.find((node: { id: string }) => node.id === stabilizeId);
    if (!stage) throw new Error("missing staged node");
    state.onNodesChange([{
      id: sourceId,
      type: "position",
      position: { x: stage.position.x - 420, y: stage.position.y },
    }]);
  }, { stabilizeId, sourceId });

  const sourceHandle = page.locator(`.react-flow__node[data-id="${sourceId}"] .react-flow__handle.source`);
  const detailHandle = page.locator(`.react-flow__node[data-id="${stabilizeId}"] [data-handleid="detail"]`);
  await sourceHandle.dragTo(detailHandle);
  const roleDialog = page.getByRole("dialog", { name: "确认连接角色" });
  await expect(roleDialog).toBeVisible();
  await expect(detailHandle).toHaveAttribute("data-connection-state", "optional");
  await roleDialog.getByRole("button", { name: "取消" }).click();
  await expect(roleDialog).toBeHidden();
  await expect(detailHandle).toHaveAttribute("data-connection-state", "optional");

  await sourceHandle.dragTo(detailHandle);
  await expect(roleDialog).toBeVisible();
  await roleDialog.getByRole("radio", { name: /服装局部结构参考/ }).check();
  await roleDialog.getByRole("button", { name: "确认连接" }).click();
  await expect(roleDialog).toBeHidden();
  await expect.poll(async () => page.evaluate(async ({ sourceId, stabilizeId }) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    const state = useFlowStore.getState();
    const tab = state.tabs.find((candidate: { id: string }) => candidate.id === state.activeTabId);
    return tab?.edges.some((edge: { source: string; target: string; targetHandle?: string | null }) => (
      edge.source === sourceId && edge.target === stabilizeId && edge.targetHandle === "detail"
    ));
  }, { sourceId, stabilizeId })).toBe(true);
  await expect(detailHandle).toHaveAttribute("data-connection-state", "connected");

  await detailHandle.click({ button: "right" });
  await expect.poll(async () => page.evaluate(async ({ sourceId, stabilizeId }) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    const state = useFlowStore.getState();
    const tab = state.tabs.find((candidate: { id: string }) => candidate.id === state.activeTabId);
    return tab?.edges.some((edge: { source: string; target: string; targetHandle?: string | null }) => (
      edge.source === sourceId && edge.target === stabilizeId && edge.targetHandle === "detail"
    ));
  }, { sourceId, stabilizeId })).toBe(false);
  await expect(detailHandle).toHaveAttribute("data-connection-state", "optional");

  await page.evaluate(async (stabilizeId) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    useFlowStore.getState().updateNodeData(stabilizeId, {
      outputImages: ["data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="],
    });
  }, stabilizeId);
  const approval = page.locator(`.react-flow__node[data-id="${approvalId}"]`);
  await expect(approval.getByText("待确认", { exact: true })).toBeVisible();
  await approval.getByRole("button", { name: "确认当前第一轮基准" }).click();
  await expect(approval.getByText("基准已确认")).toBeVisible();

  await page.evaluate(async (stabilizeId) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    useFlowStore.getState().updateNodeData(stabilizeId, { prompt: "改变第一轮生成依据" });
  }, stabilizeId);
  await expect(approval.locator('.gc-node-card[data-display-state="needs-reconfirmation"]')).toBeVisible();
});

test("project center separates built-in and user templates and keeps template actions reachable", async ({ page }, testInfo) => {
  const templateName = `E2E 我的模板 ${testInfo.project.name}`;
  const createResponse = await page.request.post("/api/templates", {
    data: {
      name: templateName,
      description: "验证我的模板入口、保存入口与删除确认层级",
      flow: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [],
        edges: [],
      },
    },
  });
  expect(createResponse.ok(), await createResponse.text()).toBeTruthy();

  await page.getByRole("button", { name: "打开项目中心" }).click();
  const center = page.getByRole("dialog", { name: "项目中心" });
  await expect(center).toBeVisible();

  await center.getByRole("tab", { name: "内置模板" }).click();
  await expect(center.getByText("文生图（服装设计）", { exact: true })).toBeVisible();
  await expect(center.getByText(templateName)).toHaveCount(0);

  await center.getByRole("tab", { name: "我的模板" }).click();
  await expect(center.getByRole("button", { name: "保存当前画布为模板" })).toBeVisible();
  await expect(center.getByText(templateName)).toBeVisible();
  await expect(center.getByText("文生图（服装设计）")).toHaveCount(0);

  await center.getByRole("button", { name: "保存当前画布为模板" }).click();
  const saveDialog = page.getByRole("dialog", { name: "存为模板" });
  await expect(saveDialog).toBeVisible();
  await saveDialog.getByRole("button", { name: "取消" }).click();
  await expect(saveDialog).toBeHidden();

  await center.getByRole("button", { name: `管理模板 ${templateName}` }).click();
  await page.getByRole("menuitem", { name: "删除模板" }).click();
  const deleteDialog = page.getByRole("alertdialog", { name: `删除“${templateName}”？` });
  await expect(deleteDialog).toBeVisible();
  await deleteDialog.getByRole("button", { name: "保留模板" }).click();
  await expect(deleteDialog).toBeHidden();
  await expect(center.getByText(templateName)).toBeVisible();
});

test("project center keeps projects usable when template loading fails", async ({ page }) => {
  await page.route("**/api/templates", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 500, json: { error: "template fixture unavailable" } });
      return;
    }
    await route.fallback();
  });

  await page.getByRole("button", { name: "打开项目中心" }).click();
  const center = page.getByRole("dialog", { name: "项目中心" });
  await expect(center).toBeVisible();
  await expect(center.getByRole("button", { name: "新建项目" })).toBeVisible();
  await expect(center.getByRole("alert")).toContainText("模板 HTTP 500");
  await expect(center.getByText("正在加载模板")).toHaveCount(0);
});

test("results and project center follow desktop density for cards", async ({ page }) => {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Desktop viewport is required");
  const expectedProjectColumns = viewport.width >= 1280 ? 4 : 3;

  await page.route("**/api/history*", async (route) => {
    const method = route.request().method();
    const pathname = new URL(route.request().url()).pathname;
    if (method !== "GET") {
      await route.fallback();
      return;
    }
    if (pathname === "/api/history/active") {
      await route.fulfill({
        json: { records: [], nextCursor: null, hasMore: false },
      });
      return;
    }
    await route.fulfill({
      json: { records: RESULTS_DENSITY_FIXTURES, nextCursor: null, hasMore: false },
    });
  });
  await page.route("**/api/projects", (route) => {
    if (route.request().method() !== "GET") {
      route.fallback();
      return;
    }
    route.fulfill({ json: PROJECT_CENTER_PROJECT_FIXTURES });
  });
  await page.route("**/api/templates", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: PROJECT_CENTER_TEMPLATE_FIXTURES });
      return;
    }
    await route.fallback();
  });

  await page.reload();
  await expect(page.getByRole("application", { name: "工作流画布" })).toBeVisible();

  await page.getByRole("button", { name: "结果 / 记录", exact: true }).click();
  const resultsRegion = page.getByRole("region", { name: "最近生成" });
  await expect(resultsRegion).toBeVisible();

  const resultsGrid = resultsRegion.locator("div.grid.grid-cols-2.gap-2");
  await expect(resultsGrid).toHaveCount(1);
  await expectGridColumns(resultsGrid, 2);

  const resultsScroller = resultsRegion.locator(".overflow-y-auto");
  const resultCards = resultsGrid.locator(":scope > *");
  const visibleResults = await resultCards.count();
  expect(visibleResults).toBeGreaterThanOrEqual(1);
  await expect(resultsRegion.getByRole("img", { name: "超长成功结果卡片标题 · 用于验证双列布局下动作按钮可读性" })).toBeVisible();
  await expect(resultsRegion).toContainText("失败结果测试");
  await expect(resultsRegion).toContainText("未知状态结果测试");
  const firstSuccessCard = resultsGrid.locator("article").first();
  await expect(firstSuccessCard).toBeVisible();
  await firstSuccessCard.hover();
  const compareButton = firstSuccessCard.locator('button[title="加入对比"]');
  const viewButton = firstSuccessCard.locator('button[title="查看图片"]');
  const downloadButton = firstSuccessCard.locator('a[title="下载"]');
  const applyButton = firstSuccessCard.locator('button[title="设为输入"]');
  await expect(compareButton).toBeVisible();
  await expect(viewButton).toBeVisible();
  await expect(downloadButton).toBeVisible();
  await expect(applyButton).toBeVisible();

  await page.addScriptTag({ content: axe.source });
  const resultStateViolations = await page.evaluate(async () => {
    const axeRuntime = (window as unknown as Window & { axe: typeof axe }).axe;
    const result = await axeRuntime.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    });
    return result.violations.map(({ id, impact, help, nodes }) => ({
      id,
      impact,
      help,
      nodes: nodes.map(({ html, target }) => ({ html, target })),
    }));
  });
  expect(resultStateViolations).toEqual([]);

  const resultsRect = await rect(resultsScroller);
  await expectInside(await rect(firstSuccessCard), resultsRect);

  await viewButton.click();
  const viewerHint = page.getByText(/滚轮缩放 100%/);
  const viewerImage = page.getByTestId("image-viewer-image");
  const viewerStage = page.getByTestId("image-viewer-stage");
  await expect(viewerHint).toBeVisible();
  await expect(viewerImage).toHaveCSS("cursor", "default");

  const imageBox = await viewerImage.boundingBox();
  const stageBox = await viewerStage.boundingBox();
  if (!imageBox) throw new Error("图片查看器主图缺少可见边界");
  if (!stageBox) throw new Error("图片查看器舞台缺少可见边界");
  await page.mouse.move(stageBox.x + stageBox.width - 48, stageBox.y + stageBox.height / 2);
  await page.mouse.wheel(0, -4000);
  await expect(page.getByText(/滚轮缩放 500%（最大 500%）/)).toBeVisible();
  await expect(viewerImage).toHaveCSS("cursor", "grab");

  await page.mouse.wheel(0, -4000);
  await expect(page.getByText(/滚轮缩放 500%（最大 500%）/)).toBeVisible();
  const transformBeforePan = await viewerImage.evaluate((element) => getComputedStyle(element).transform);
  await page.mouse.down();
  await page.mouse.move(imageBox.x + imageBox.width / 2 + 64, imageBox.y + imageBox.height / 2 + 48, { steps: 4 });
  await expect(viewerImage).toHaveCSS("cursor", "grabbing");
  await page.mouse.up();
  await expect(viewerImage).toHaveCSS("cursor", "grab");
  await expect.poll(
    () => viewerImage.evaluate((element) => getComputedStyle(element).transform),
  ).not.toBe(transformBeforePan);

  await page.mouse.dblclick(stageBox.x + stageBox.width - 48, stageBox.y + stageBox.height / 2);
  await expect(page.getByText(/滚轮缩放 100%（最大 500%）/)).toBeVisible();
  await expect(viewerImage).toHaveCSS("cursor", "default");
  await expect(viewerImage).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await page.keyboard.press("Escape");
  await expect(viewerHint).toBeHidden();

  await firstSuccessCard.hover();
  await compareButton.click();
  await expect(firstSuccessCard.locator('button[title="取消对比"]')).toBeVisible();

  const download = page.waitForEvent("download");
  await downloadButton.click();
  await download;

  const nodeCountBeforeApply = await page.locator(".react-flow__node").count();
  await applyButton.click();
  await expect(page.locator(".react-flow__node")).toHaveCount(nodeCountBeforeApply + 1);
  await expect(resultsRegion).toBeVisible();

  await expectCurrentThemeContract(page);
  await expectGridColumns(resultsGrid, 2);

  await page.getByRole("button", { name: "打开项目中心" }).click();
  const center = page.getByRole("dialog", { name: "项目中心" });
  await expect(center).toBeVisible();
  const sectionGrid = (name: string) => (
    center.getByRole("tabpanel", { name }).locator(":scope > .grid").first()
  );

  await center.getByRole("tab", { name: "最近项目" }).click();
  const recentGrid = sectionGrid("最近项目");
  await expectGridColumns(recentGrid, expectedProjectColumns);
  await expectTwoLineTitle(center.getByText(PROJECT_CENTER_PROJECT_FIXTURES[0].name, { exact: true }));
  const projectCardHeights = await center.getByRole("button", { name: /^超长项目名称/ }).evaluateAll(
    (elements) => elements.map((element) => element.getBoundingClientRect().height),
  );
  expect(projectCardHeights).toHaveLength(PROJECT_CENTER_PROJECT_FIXTURES.length);
  expect(Math.max(...projectCardHeights) - Math.min(...projectCardHeights)).toBeLessThanOrEqual(1);

  await center.getByRole("tab", { name: "内置模板" }).click();
  const builtinTemplatesGrid = sectionGrid("内置模板");
  await expectGridColumns(builtinTemplatesGrid, expectedProjectColumns);
  await expectTwoLineTitle(center.getByText(PROJECT_CENTER_TEMPLATE_FIXTURES[0].name, { exact: true }));

  await center.getByRole("tab", { name: "我的模板" }).click();
  const myTemplatesGrid = sectionGrid("我的模板");
  await expectGridColumns(myTemplatesGrid, expectedProjectColumns);
  await expectTwoLineTitle(center.getByText(PROJECT_CENTER_TEMPLATE_FIXTURES[2].name, { exact: true }));

  // Read the named panel's grid and children atomically: during a Base UI tab
  // transition a generic "first tabpanel" locator can re-resolve to the outgoing
  // panel between separate visibility and geometry reads.
  await expect.poll(async () => myTemplatesGrid.evaluate((grid) => {
    const gridRect = grid.getBoundingClientRect();
    const cards = Array.from(grid.children).slice(0, 8);
    return cards.length > 0 && cards.every((card) => {
      const cardRect = card.getBoundingClientRect();
      return cardRect.left >= gridRect.left - 1 && cardRect.right <= gridRect.right + 1;
    });
  })).toBe(true);
  await center.getByRole("button", { name: "关闭项目中心" }).click();
});

test("adding an AI redesign node keeps the canvas mounted and exposes one clear workflow", async ({ page }) => {
  await openFreshBlankProject(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const nodes = page.locator(".react-flow__node");

  await page.getByRole("navigation", { name: "工作台左侧工具" })
    .getByRole("button", { name: "服装设计", exact: true }).click();
  await page.getByRole("menu", { name: "服装设计" }).getByRole("menuitem", { name: /AI 改款/ }).click();

  await expect(nodes).toHaveCount(3);
  await expect(page.getByRole("application", { name: "工作流画布" })).toBeVisible();
  const redesignNode = nodes.filter({ hasText: "AI 改款" });
  await expect(redesignNode.getByText("编辑指令", { exact: true })).toBeVisible();
  await expect(redesignNode.getByRole("button", { name: "AI 改款", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "取消" })).toHaveCount(0);
  await expect(page.getByText("页面出现异常")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("node drag is one undo transaction and selection stays canonical", async ({ page }) => {
  await openFreshBlankProject(page);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  const nodes = page.locator(".react-flow__node");
  const selectedNodes = page.locator(".react-flow__node.selected");
  const node = await addTextNode(page);
  const initialNodeCount = await nodes.count();
  const nodeDragTarget = node.locator(".gc-node-floating-title");
  const pane = page.locator(".react-flow__pane");

  await expect(node).toBeVisible();
  await expect(nodeDragTarget).toBeVisible();

  // 悬停反馈不得移动节点；否则 React Flow 加上 dragging 类时会瞬间跳回原位。
  await nodeDragTarget.hover();
  await expect.poll(
    () => node.evaluate((element) => getComputedStyle(element).translate),
  ).toBe("none");

  // React Flow 的 .selected 投影必须与 store 的 canonical selection 同步。
  await nodeDragTarget.click();
  await expect(node).toHaveClass(/\bselected\b/);
  await expect(selectedNodes).toHaveCount(1);

  // 全选、复制与粘贴共用 canonical selection。批量粘贴只形成一次撤销记录。
  await page.keyboard.press(`${modifier}+a`);
  await expect(selectedNodes).toHaveCount(initialNodeCount);
  await page.keyboard.press(`${modifier}+c`);
  await page.keyboard.press(`${modifier}+v`);
  await expect(nodes).toHaveCount(initialNodeCount * 2);
  await expect(selectedNodes).toHaveCount(initialNodeCount);
  await page.keyboard.press(`${modifier}+z`);
  await expect(nodes).toHaveCount(initialNodeCount);
  await expect(selectedNodes).toHaveCount(0);

  // 主修饰键 + D 复用同一原子批量复制路径。
  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.press(`${modifier}+d`);
  await expect(nodes).toHaveCount(initialNodeCount * 2);
  await expect(selectedNodes).toHaveCount(initialNodeCount);
  await page.keyboard.press(`${modifier}+z`);
  await expect(nodes).toHaveCount(initialNodeCount);
  await expect(selectedNodes).toHaveCount(0);
  await nodeDragTarget.click();
  await expect(selectedNodes).toHaveCount(1);

  const paneBox = await pane.boundingBox();
  if (!paneBox) throw new Error("React Flow pane is missing");
  await page.mouse.click(paneBox.x + paneBox.width - 80, paneBox.y + 80);
  await expect(selectedNodes).toHaveCount(0);

  const start = await node.boundingBox();
  const startTransform = await node.evaluate((element) => (element as HTMLElement).style.transform);
  const handle = await nodeDragTarget.boundingBox();
  if (!start || !handle) throw new Error("Initial workflow node is missing");
  const dragDelta = { x: 160, y: 90 };
  const pointer = {
    x: handle.x + Math.min(24, handle.width / 2),
    y: handle.y + handle.height / 2,
  };

  await page.mouse.move(pointer.x, pointer.y);
  await page.mouse.down();
  await page.mouse.move(pointer.x + dragDelta.x, pointer.y + dragDelta.y, { steps: 12 });
  const beforeRelease = await node.boundingBox();
  const viewportBeforeRelease = await page.locator(".react-flow__viewport").evaluate(
    (element) => getComputedStyle(element).transform,
  );
  if (!beforeRelease) throw new Error("Dragged workflow node disappeared before pointer release");
  await page.mouse.up();
  const immediatelyAfterRelease = await node.boundingBox();
  await page.waitForTimeout(250);
  const settledAfterRelease = await node.boundingBox();
  const viewportAfterRelease = await page.locator(".react-flow__viewport").evaluate(
    (element) => getComputedStyle(element).transform,
  );
  if (!immediatelyAfterRelease || !settledAfterRelease) {
    throw new Error("Dragged workflow node disappeared after pointer release");
  }
  expect(Math.abs(immediatelyAfterRelease.x - beforeRelease.x)).toBeLessThan(1);
  expect(Math.abs(immediatelyAfterRelease.y - beforeRelease.y)).toBeLessThan(1);
  expect(Math.abs(settledAfterRelease.x - beforeRelease.x)).toBeLessThan(1);
  expect(Math.abs(settledAfterRelease.y - beforeRelease.y)).toBeLessThan(1);
  expect(viewportAfterRelease).toBe(viewportBeforeRelease);

  // React Flow 会先跨过内部拖拽阈值，最终位移无需等于指针位移，但必须明显移动。
  await expect.poll(async () => {
    const box = await node.boundingBox();
    return box ? Math.round(box.x - start.x) : 0;
  }).toBeGreaterThan(100);
  await expect.poll(async () => {
    const box = await node.boundingBox();
    return box ? Math.round(box.y - start.y) : 0;
  }).toBeGreaterThan(50);
  const end = await node.boundingBox();
  if (!end) throw new Error("Dragged workflow node is missing");
  const endTransform = await node.evaluate((element) => (element as HTMLElement).style.transform);
  expect(endTransform).not.toBe(startTransform);

  // 尽管鼠标产生多个 position change，一次撤销必须完整返回拖拽前位置。
  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(
    () => node.evaluate((element) => (element as HTMLElement).style.transform),
  ).toBe(startTransform);

  await page.keyboard.press(process.platform === "darwin" ? `${modifier}+Shift+z` : `${modifier}+y`);
  await expect.poll(
    () => node.evaluate((element) => (element as HTMLElement).style.transform),
  ).toBe(endTransform);
});

test("image node hides asset address entry and keeps upload and library usable", async ({ page }) => {
  await openFreshBlankProject(page);
  const rail = page.getByRole("navigation", { name: "工作台左侧工具" });
  await rail.getByRole("button", { name: "添加节点", exact: true }).click();
  await page.getByRole("menu", { name: "添加节点" }).getByRole("menuitem", { name: /本地上传图片/ }).click();
  const imageNode = page.locator(".react-flow__node").filter({ hasText: "图片上传" }).last();
  await expect(imageNode.getByLabel("API易图片素材 ID")).toHaveCount(0);
  await expect(imageNode.getByRole("button", { name: "应用 API易图片素材" })).toHaveCount(0);
  const upload = imageNode.getByLabel("本地上传");
  const library = imageNode.getByRole("button", { name: "从素材库选择" });
  await expect(upload).toBeVisible();
  await expect(library).toBeVisible();
  const bounds = await imageNode.boundingBox();
  if (!bounds) throw new Error("Image node bounds are missing");
  for (const control of [upload, library]) {
    const box = await control.boundingBox();
    if (!box) throw new Error("Image input control bounds are missing");
    expect(box.width).toBeGreaterThan(20);
    expect(box.height).toBeGreaterThan(20);
    expect(box.x).toBeGreaterThanOrEqual(bounds.x);
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
  }
  await library.focus();
  await library.press("Enter");
  const picker = page.getByRole("dialog", { name: "从素材库选择" });
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(library).toBeFocused();
  await upload.setInputFiles({ name: "hidden-address.png", mimeType: "image/png", buffer: E2E_UPLOAD_PNG });
  const uploadedImage = imageNode.getByAltText("已上传图片");
  await expect(uploadedImage).toBeVisible();
  await expect(uploadedImage).toHaveAttribute("src", /^\/api\/files\/[A-Za-z0-9_-]+\.png$/);
  await expect(imageNode.getByLabel("API易图片素材 ID")).toHaveCount(0);
  await imageNode.locator(".gc-node-floating-title").click();
  await expect(imageNode.getByLabel("重新上传")).toBeVisible();
  await expect(imageNode.getByRole("button", { name: "素材库", exact: true })).toBeVisible();
});

test("asset library previews and deletes manageable images without selecting them", async ({ page }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const createAsset = async (name: string) => {
    const response = await page.request.post("/api/assets", {
      data: { name, category: "reference", image: RESULTS_DENSITY_IMAGE },
    });
    expect(response.ok()).toBeTruthy();
    return (await response.json()) as { id: string };
  };
  const removableName = `可删除素材-${suffix}`;
  const blockedName = `受保护素材-${suffix}`;
  const removable = await createAsset(removableName);
  const blocked = await createAsset(blockedName);

  await page.route(`**/api/assets/${blocked.id}`, async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "素材正在被项目使用，不能删除" }),
      });
      return;
    }
    await route.fallback();
  });

  await openFreshBlankProject(page);
  const rail = page.getByRole("navigation", { name: "工作台左侧工具" });
  await rail.getByRole("button", { name: "添加节点", exact: true }).click();
  await page.getByRole("menu", { name: "添加节点" }).getByRole("menuitem", { name: /本地上传图片/ }).click();
  const imageNode = page.locator(".react-flow__node").filter({ hasText: "图片上传" }).last();
  await imageNode.getByRole("button", { name: "从素材库选择" }).click();

  const picker = page.getByRole("dialog", { name: "从素材库选择" });
  const removableCard = picker.locator(`[data-asset-card-id="${removable.id}"]`);
  const blockedCard = picker.locator(`[data-asset-card-id="${blocked.id}"]`);
  const previewButton = removableCard.getByRole("button", { name: `查看图片 ${removableName}` });
  const deleteButton = removableCard.getByRole("button", { name: `删除素材 ${removableName}` });
  await expect(removableCard).toBeVisible();
  await expect(blockedCard).toBeVisible();
  await picker.getByRole("heading", { name: "从素材库选择" }).hover();
  await expect.poll(() => previewButton.evaluate((element) => getComputedStyle(element.parentElement!).opacity)).toBe("0");
  await page.addScriptTag({ content: axe.source });
  const pickerViolations = await page.evaluate(async () => {
    const axeRuntime = (window as unknown as Window & { axe: typeof axe }).axe;
    const result = await axeRuntime.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    });
    return result.violations.map(({ id, impact, help }) => ({ id, impact, help }));
  });
  expect(pickerViolations).toEqual([]);

  await removableCard.hover();
  await expect.poll(() => previewButton.evaluate((element) => getComputedStyle(element.parentElement!).opacity)).toBe("1");
  await expect(deleteButton).toBeVisible();
  await previewButton.focus();
  await expect(previewButton).toBeFocused();
  await previewButton.press("Enter");

  const viewer = page.getByRole("dialog", { name: "图片查看器" });
  await expect(picker).toBeHidden();
  await expect(viewer).toBeVisible();
  await expect(viewer.getByAltText(removableName)).toBeVisible();
  const viewerStage = page.getByTestId("image-viewer-stage");
  const stageBox = await viewerStage.boundingBox();
  if (!stageBox) throw new Error("Asset preview stage is missing");
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
  await page.mouse.wheel(0, -4_000);
  await expect(page.getByText(/滚轮缩放 500%（最大 500%）/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(picker).toBeVisible();
  await expect(previewButton).toBeFocused();
  await expect(imageNode.getByAltText("已上传图片")).toHaveCount(0);

  const blockedDeleteButton = blockedCard.getByRole("button", { name: `删除素材 ${blockedName}` });
  await blockedCard.hover();
  await blockedDeleteButton.click();
  const confirmation = page.getByRole("alertdialog", { name: "删除素材" });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "确认删除" }).click();
  await expect(confirmation.getByRole("alert")).toHaveText("素材正在被项目使用，不能删除");
  await confirmation.getByRole("button", { name: "取消" }).click();
  await expect(confirmation).toBeHidden();
  await expect(blockedCard).toBeVisible();

  await removableCard.hover();
  await deleteButton.click();
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "确认删除" }).click();
  await expect(confirmation).toBeHidden();
  await expect(removableCard).toHaveCount(0);
  await expect(blockedCard).toBeVisible();

  await blockedCard.locator(`button[title="${blockedName}"]`).click();
  await expect(picker).toBeHidden();
  await expect(imageNode.getByAltText("已上传图片")).toBeVisible();
  await page.unroute(`**/api/assets/${blocked.id}`);
  await page.request.delete(`/api/assets/${blocked.id}`);
});

test("standalone asset library filters and reclassifies without changing canvas", async ({ page }, testInfo) => {
  const suffix = `catalog-${testInfo.project.name}-${Date.now()}`;
  const categories = [["upload", "用户上传"], ["generated", "生成结果"], ["print", "印花"], ["fabric", "布料"]] as const;
  const ids: string[] = [];
  for (const [category] of categories) {
    const response = await page.request.post("/api/assets", {
      data: { name: `${suffix}-${category}`, category, image: RESULTS_DENSITY_IMAGE },
    });
    expect(response.status()).toBe(201);
    ids.push(((await response.json()) as { id: string }).id);
  }
  await openFreshBlankProject(page);
  const rail = page.getByRole("navigation", { name: "工作台左侧工具" });
  const trigger = rail.getByRole("button", { name: "资产库", exact: true });
  const nodeIdsBefore = await page.locator(".react-flow__node").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-id")));
  const createBox = await rect(rail.getByRole("button", { name: "创作工具", exact: true }));
  const assetBox = await rect(trigger);
  const shortcutsBox = await rect(rail.getByRole("button", { name: "查看快捷键" }));
  expect(assetBox.top).toBeGreaterThan(createBox.bottom);
  expect(assetBox.bottom).toBeLessThan(shortcutsBox.top);
  expect(assetBox.width).toBe(createBox.width);
  await trigger.focus();
  await trigger.press("Enter");
  const library = page.getByRole("dialog", { name: "资产库", exact: true });
  const search = library.getByRole("searchbox", { name: "搜索素材名称" });
  await search.fill(suffix);
  await expect(library.locator("[data-asset-card-id]")).toHaveCount(4);
  for (const [category, label] of categories) {
    await library.getByRole("tab", { name: label, exact: true }).click();
    await expect(library.locator("[data-asset-card-id]")).toHaveCount(1);
    await expect(library.getByAltText(`${suffix}-${category}`)).toBeVisible();
  }
  await library.getByRole("tab", { name: "用户上传", exact: true }).click();
  const uploadCard = library.locator(`[data-asset-card-id="${ids[0]}"]`);
  const cardButton = uploadCard.locator(`button[title="${suffix}-upload"]`);
  await cardButton.click();
  const viewer = page.getByRole("dialog", { name: "图片查看器" });
  await expect(viewer).toBeVisible();
  const savedCopyResponse = page.waitForResponse((response) => response.url().endsWith("/api/assets") && response.request().method() === "POST");
  await viewer.getByRole("button", { name: "收藏为资产", exact: true }).click();
  const savedCopy = await savedCopyResponse;
  expect(savedCopy.status()).toBe(201);
  expect(savedCopy.request().postDataJSON().category).toBe("upload");
  await page.request.delete(`/api/assets/${((await savedCopy.json()) as { id: string }).id}`);
  await page.keyboard.press("Escape");
  await expect(library).toBeVisible();
  await expect(cardButton).toBeFocused();
  await uploadCard.getByRole("combobox").click();
  await page.getByRole("option", { name: "布料", exact: true }).click();
  await expect(uploadCard).toHaveCount(0);
  await expect(search).toBeFocused();
  await expect(library.getByText("没有匹配的素材", { exact: true })).toBeVisible();
  await library.getByRole("tab", { name: "布料", exact: true }).click();
  await expect(library.locator("[data-asset-card-id]")).toHaveCount(2);
  await library.getByRole("tab", { name: "全部", exact: true }).click();
  await expect(library.locator("[data-asset-card-id]")).toHaveCount(4);
  const bounds = await rect(library);
  expect(bounds.width).toBe(680);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(bounds.bottom).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(await library.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => {
    const runtime = (window as unknown as { axe: typeof axe }).axe;
    return (await runtime.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } })).violations;
  });
  expect(violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("asset-library.png") });
  await page.keyboard.press("Escape");
  await expect(library).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await page.locator(".react-flow__node").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-id")))).toEqual(nodeIdsBefore);
  for (const id of ids) await page.request.delete(`/api/assets/${id}`);
});

test("asset deletion resets pending pagination and restores focus on first deletion", async ({ page }) => {
  let assets = Array.from({ length: 40 }, (_, index) => ({
    id: `pagination-${index + 1}`,
    name: `分页素材 ${index + 1}`,
    category: "reference",
    image: RESULTS_DENSITY_IMAGE,
    thumbnail: RESULTS_DENSITY_IMAGE,
    createdAt: "2026-09-09T00:00:00.000Z",
    canManage: true,
  }));
  let delayNextPage = true;
  let releasePage!: () => void;
  const pendingPage = new Promise<void>((resolve) => { releasePage = resolve; });
  let pageStarted = false;
  let pageFinished = false;
  await page.route("**/api/assets?*", async (route) => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const delayed = offset === 20 && delayNextPage;
    if (delayed) {
      delayNextPage = false;
      pageStarted = true;
      await pendingPage;
    }
    await route.fulfill({ json: assets.slice(offset, offset + 20) });
    if (delayed) pageFinished = true;
  });
  await page.route("**/api/assets/pagination-1", async (route) => {
    expect(route.request().method()).toBe("DELETE");
    assets = assets.filter((asset) => asset.id !== "pagination-1");
    await route.fulfill({ json: { ok: true } });
  });

  try {
    await openFreshBlankProject(page);
    const rail = page.getByRole("navigation", { name: "工作台左侧工具" });
    await rail.getByRole("button", { name: "添加节点", exact: true }).click();
    await page.getByRole("menu", { name: "添加节点" }).getByRole("menuitem", { name: /本地上传图片/ }).click();
    const imageNode = page.locator(".react-flow__node").filter({ hasText: "图片上传" }).last();
    await imageNode.getByRole("button", { name: "从素材库选择" }).click();
    const picker = page.getByRole("dialog", { name: "从素材库选择" });
    const cards = picker.locator("[data-asset-card-id]");
    await expect(cards).toHaveCount(20);
    await picker.getByRole("button", { name: "加载更多素材" }).click();
    await expect.poll(() => pageStarted).toBe(true);
    await picker.getByRole("button", { name: "删除素材 分页素材 1", exact: true }).click();
    const confirmation = page.getByRole("alertdialog", { name: "删除素材" });
    await confirmation.getByRole("button", { name: "确认删除" }).click();
    await expect(confirmation).toBeHidden();
    await expect(picker.getByRole("searchbox", { name: "搜索素材名称" })).toBeFocused();
    await expect(picker.locator('[data-asset-card-id="pagination-21"]')).toHaveCount(1);
    releasePage();
    await expect.poll(() => pageFinished).toBe(true);
    await picker.getByRole("button", { name: "加载更多素材" }).click();
    await expect(cards).toHaveCount(39);
    await expect(picker.getByRole("button", { name: "加载更多素材" })).toHaveCount(0);
    expect(await cards.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-asset-card-id"))))
      .toEqual(assets.map((asset) => asset.id));
  } finally {
    releasePage();
  }
});

test("node title and media actions keep stable keyboard-accessible controls", async ({ page }) => {
  await openFreshBlankProject(page);
  const textNode = await addTextNode(page);
  const textNodeId = await textNode.getAttribute("data-id");
  if (!textNodeId) throw new Error("Text node id is missing");
  const stableTextNode = page.locator(`.react-flow__node[data-id="${textNodeId}"]`);
  const textTitle = stableTextNode.locator(".gc-node-floating-title span");
  await textTitle.click();
  const textToolbar = stableTextNode.getByRole("toolbar", { name: "文本节点操作" });
  await expect(textToolbar).toBeVisible();
  const toolbarWidth = await textToolbar.evaluate((element) => element.getBoundingClientRect().width);
  const copyButton = textToolbar.getByRole("button", { name: "复制" });
  await copyButton.hover();
  await expect.poll(() => textToolbar.evaluate((element) => element.getBoundingClientRect().width)).toBe(toolbarWidth);

  await textTitle.dblclick();
  const titleInput = stableTextNode.getByRole("textbox", { name: "节点名称" });
  await expect(titleInput).toBeFocused();
  await expect(titleInput).toHaveAttribute("data-slot", "input");
  await page.keyboard.press("Escape");
  await expect(titleInput).toHaveCount(0);

  const nodes = page.locator(".react-flow__node");
  const nodeCount = await nodes.count();
  const rail = page.getByRole("navigation", { name: "工作台左侧工具" });
  await rail.getByRole("button", { name: "添加节点", exact: true }).click();
  await page.getByRole("menu", { name: "添加节点" }).getByRole("menuitem", { name: /本地上传图片/ }).click();
  await expect(nodes).toHaveCount(nodeCount + 1);
  const imageNode = nodes.filter({ hasText: "图片上传" }).last();
  await imageNode.locator(".gc-node-floating-title").click();
  const mediaToolbar = imageNode.getByRole("toolbar", { name: "媒体节点操作" });
  await expect(mediaToolbar).toBeVisible();
  const upscaleTrigger = mediaToolbar.getByRole("button", { name: "高清放大" });
  await expect(upscaleTrigger).toBeDisabled();
  await imageNode.getByLabel("本地上传").setInputFiles({
    name: "quick-action.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
  });
  await expect(imageNode.getByAltText("已上传图片")).toBeVisible();
  await expect(upscaleTrigger).toBeEnabled();
  const edgeCount = await page.locator(".react-flow__edge").count();
  await upscaleTrigger.focus();
  await upscaleTrigger.press("Enter");
  const twoK = page.getByRole("menuitem", { name: "2K", exact: true });
  const fourK = page.getByRole("menuitem", { name: "4K", exact: true });
  await expect(twoK).toBeVisible();
  await expect(fourK).toBeVisible();
  await expect(twoK).toBeFocused();
  await twoK.click();
  await expect(twoK).toBeHidden();
  await expect(nodes).toHaveCount(nodeCount + 2);
  await expect(page.locator(".react-flow__edge")).toHaveCount(edgeCount + 1);
  const upscaleNode = nodes.filter({ hasText: "高清放大" }).last();
  await expect(upscaleNode).toHaveClass(/selected/);
  await expect(upscaleNode.getByRole("button", { name: "2K · 长边 2048" })).toBeVisible();
});

test("result quick transforms create server-safe edges for the selected image", async ({ page }) => {
  await openFreshBlankProject(page);
  await page.evaluate(async (image) => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    useFlowStore.getState().loadFlow({
      projectId: "e2e-result-transform-project",
      projectName: "结果快捷操作边 ID",
      markDirty: true,
      nodes: [{
        id: "e2e-transform-result",
        type: "result",
        position: { x: 0, y: 0 },
        data: {
          kind: "result",
          label: "待继续处理结果",
          status: "success",
          images: [image],
        },
      }],
      edges: [],
    });
  }, RESULTS_DENSITY_IMAGE);

  const resultNode = page.locator('.react-flow__node[data-id="e2e-transform-result"]');
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  const assertConnection = async (kind: string) => {
    const connection = await page.evaluate(async () => {
      const storeModulePath = "/src/store/flowStore.ts";
      const { selectActiveDocument, useFlowStore } = await import(storeModulePath);
      const document = selectActiveDocument(useFlowStore.getState());
      const selectedId = document.selectedNodeId;
      const node = document.nodes.find((candidate: BrowserFlowNode) => candidate.id === selectedId);
      const edge = document.edges.find((candidate: { target: string }) => candidate.target === selectedId);
      return { kind: node?.data.kind, edge };
    });
    expect(connection.kind).toBe(kind);
    expect(connection.edge?.id).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(connection.edge?.id).not.toContain(":");
    expect(connection.edge?.sourceHandle).toBe("image:0");
  };
  const selectResult = async () => {
    await resultNode.locator(".gc-node-floating-title").click();
    await expect(resultNode.getByRole("toolbar", { name: "媒体节点操作" })).toBeVisible();
  };
  const undoTransform = async () => {
    await page.keyboard.press(`${modifier}+z`);
    await expect(page.locator(".react-flow__node")).toHaveCount(1);
  };

  await selectResult();
  await resultNode.getByRole("button", { name: "风格转绘" }).click();
  await assertConnection("ai-modify");
  await undoTransform();

  await selectResult();
  await resultNode.getByRole("button", { name: "局部重绘" }).click();
  await assertConnection("mask-redraw");
  await undoTransform();

  await selectResult();
  await resultNode.getByRole("button", { name: "高清放大" }).click();
  await page.getByRole("menuitem", { name: "2K", exact: true }).click();
  await assertConnection("upscale");
});

test("copying a TiAngelNode subgraph remaps internal edges and node references", async ({ page }) => {
  await openFreshBlankProject(page);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.evaluate(async () => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    useFlowStore.getState().loadFlow({
      projectName: "TiAngelNode 子图复制",
      markDirty: true,
      nodes: [
        {
          id: "clipboard-person",
          type: "image-input",
          position: { x: 0, y: 0 },
          data: {
            kind: "image-input",
            label: "复制人物",
            status: "idle",
            imageRole: "reference",
            autoConnectTargets: [{ targetNodeId: "clipboard-angle", targetHandle: "preview-image" }],
          },
        },
        {
          id: "clipboard-angle",
          type: "ti-angle",
          position: { x: 360, y: 0 },
          data: {
            kind: "ti-angle",
            label: "复制视角",
            status: "idle",
            angle: { version: 1, enabled: true, azimuthDeg: 20, elevationDeg: 5, rollDeg: 0 },
          },
        },
      ],
      edges: [{
        id: "clipboard-preview",
        source: "clipboard-person",
        sourceHandle: "image",
        target: "clipboard-angle",
        targetHandle: "preview-image",
      }],
    });
    useFlowStore.getState().setSelectedNodeIds(["clipboard-person", "clipboard-angle"]);
  });
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await page.keyboard.press(`${modifier}+c`);
  await page.keyboard.press(`${modifier}+v`);
  await expect(page.locator(".react-flow__node")).toHaveCount(4);

  const pasted = await page.evaluate(async () => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { selectActiveDocument, useFlowStore } = await import(storeModulePath);
    const document = selectActiveDocument(useFlowStore.getState());
    const cloneNodes = document.nodes.filter((node: BrowserFlowNode) => !["clipboard-person", "clipboard-angle"].includes(node.id));
    const cloneIds = new Set(cloneNodes.map((node: BrowserFlowNode) => node.id));
    const cloneEdge = document.edges.find((edge: { source: string; target: string }) => cloneIds.has(edge.source) && cloneIds.has(edge.target));
    const clonePerson = cloneNodes.find((node: BrowserFlowNode) => node.data.kind === "image-input");
    return {
      cloneIds: cloneNodes.map((node: BrowserFlowNode) => node.id),
      edge: cloneEdge ? {
        source: cloneEdge.source,
        target: cloneEdge.target,
        sourceHandle: cloneEdge.sourceHandle,
        targetHandle: cloneEdge.targetHandle,
      } : null,
      autoConnectTarget: clonePerson?.data.kind === "image-input"
        ? clonePerson.data.autoConnectTargets?.[0]?.targetNodeId
        : undefined,
    };
  });
  expect(pasted.cloneIds).toHaveLength(2);
  expect(pasted.edge?.source).toBeTruthy();
  expect(pasted.edge?.target).toBeTruthy();
  expect(pasted.edge?.source).not.toBe("clipboard-person");
  expect(pasted.edge?.target).not.toBe("clipboard-angle");
  expect(pasted.edge?.sourceHandle).toBe("image");
  expect(pasted.edge?.targetHandle).toBe("preview-image");
  expect(pasted.autoConnectTarget).toBe(pasted.edge?.target);

  await page.keyboard.press(`${modifier}+z`);
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect.poll(() => page.evaluate(async () => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { selectActiveDocument, useFlowStore } = await import(storeModulePath);
    return selectActiveDocument(useFlowStore.getState()).edges.map((edge: { id: string }) => edge.id);
  })).toEqual(["clipboard-preview"]);
});

test("dragging a node near the canvas edge never auto-pans the viewport", async ({ page }) => {
  await openFreshBlankProject(page);
  const node = await addTextNode(page);
  const nodeDragTarget = node.locator(".gc-node-floating-title");
  const pane = page.locator(".react-flow__pane");
  const viewport = page.locator(".react-flow__viewport");

  await expect(nodeDragTarget).toBeVisible();
  const handle = await nodeDragTarget.boundingBox();
  const paneBox = await pane.boundingBox();
  if (!handle || !paneBox) throw new Error("Workflow node or React Flow pane is missing");

  const initialViewport = await viewport.evaluate((element) => getComputedStyle(element).transform);
  await page.mouse.move(handle.x + Math.min(24, handle.width / 2), handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(paneBox.x + paneBox.width - 8, handle.y + handle.height / 2, { steps: 16 });
  await page.waitForTimeout(250);
  const viewportWhileDragging = await viewport.evaluate(
    (element) => getComputedStyle(element).transform,
  );
  await page.mouse.up();
  await page.waitForTimeout(100);
  const viewportAfterRelease = await viewport.evaluate(
    (element) => getComputedStyle(element).transform,
  );

  expect(viewportWhileDragging).toBe(initialViewport);
  expect(viewportAfterRelease).toBe(initialViewport);
});

test("tool rail, right dock and horizontal zoom controls preserve canvas identity, geometry, focus, and results", async ({ page }, testInfo) => {
  await openFreshBlankProject(page);
  await addTextNode(page);
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Desktop viewport is required");
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  const expectedDockWidth = viewport.width <= 1100 ? 360 : viewport.width < 1360 ? 400 : 440;

  const contextToggle = page.getByRole("button", { name: "属性", exact: true });
  const resultsToggle = page.getByRole("button", { name: "结果 / 记录", exact: true });
  const floatingRail = page.getByRole("navigation", { name: "工作台左侧工具" });
  const dock = page.locator("#workbench-inspector-panel");
  const resultsFlyout = page.locator("#workbench-results-flyout");
  const contextPanel = dock;
  const canvas = page.getByRole("application", { name: "工作流画布" });
  const zoomControls = page.getByTestId("canvas-zoom-controls");
  const zoomSlider = page.getByRole("slider", { name: "画布缩放比例" });
  const zoomSliderRoot = zoomControls.locator('[data-slot="slider"]');
  const zoomOutput = zoomControls.locator("output");
  const originalCanvas = await canvas.elementHandle();
  if (!originalCanvas) throw new Error("Canvas element is missing");
  await expect(contextToggle).toHaveAttribute("aria-expanded", "false");
  await expect(dock).toHaveAttribute("aria-hidden", "true");
  await expectInert(dock, true);
  await expectWidth(dock, 0);
  await expect(resultsFlyout).toHaveAttribute("aria-hidden", "true");
  await expectInert(resultsFlyout, true);
  await expect(floatingRail).toBeVisible();
  await expectWidth(canvas, viewport.width);

  const closedCanvasRect = await rect(canvas);
  const zoomControlsRect = await rect(zoomControls);
  expectInside(zoomControlsRect, closedCanvasRect);
  expect(zoomControlsRect.width).toBeGreaterThan(zoomControlsRect.height * 3);
  const closedMinimapRect = await rect(page.locator(".react-flow__minimap"));
  expect(closedMinimapRect.left - zoomControlsRect.right).toBeGreaterThanOrEqual(27);
  expect(closedMinimapRect.left - zoomControlsRect.right).toBeLessThanOrEqual(29);
  await expect(zoomOutput).toHaveText("100%");

  const sliderThumbBox = await zoomSlider.boundingBox();
  const sliderRootBox = await zoomSliderRoot.boundingBox();
  if (!sliderThumbBox || !sliderRootBox) throw new Error("Zoom slider geometry is missing");
  await page.mouse.move(sliderThumbBox.x + sliderThumbBox.width / 2, sliderThumbBox.y + sliderThumbBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sliderRootBox.x + sliderRootBox.width * 0.75, sliderRootBox.y + sliderRootBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Number.parseInt((await zoomOutput.textContent()) ?? "0", 10)).toBeGreaterThan(180);

  await zoomSlider.fill("300");
  await expect(zoomOutput).toHaveText("300%");
  await zoomSlider.fill("20");
  await expect(zoomOutput).toHaveText("20%");
  await zoomSlider.fill("125");
  await expect(zoomOutput).toHaveText("125%");
  await zoomSlider.fill("100");
  await expect(zoomOutput).toHaveText("100%");

  await zoomControls.getByRole("button", { name: "适应画布" }).click();
  await expect(zoomOutput).toHaveText("68%");
  await zoomSlider.fill("100");
  await expect(zoomOutput).toHaveText("100%");

  await page.keyboard.press(`${modifier}+=`);
  await expect(zoomOutput).toHaveText("120%");
  await page.keyboard.press(`${modifier}+-`);
  await expect(zoomOutput).toHaveText("100%");

  const shortcutTrigger = floatingRail.getByRole("button", { name: "查看快捷键" });
  const createTrigger = floatingRail.getByRole("button", { name: "创作工具", exact: true });
  const shortcutMenu = page.locator("#workbench-shortcuts");
  await expect(page.locator("header").getByRole("button", { name: "查看快捷键" })).toHaveCount(0);
  await expect(floatingRail.getByRole("button")).toHaveCount(7);
  await expect(floatingRail.getByRole("button").nth(4)).toHaveAttribute("aria-label", "创作工具");
  await expect(floatingRail.getByRole("button").nth(5)).toHaveAttribute("aria-label", "资产库");
  await expect(floatingRail.getByRole("button").nth(6)).toHaveAttribute("aria-label", "查看快捷键");
  await expect(floatingRail.getByRole("separator")).toHaveCount(0);
  const createTriggerRect = await rect(createTrigger);
  const shortcutTriggerRect = await rect(shortcutTrigger);
  const assetTriggerRect = await rect(floatingRail.getByRole("button", { name: "资产库", exact: true }));
  expect(assetTriggerRect.top - createTriggerRect.bottom).toBeGreaterThanOrEqual(3);
  expect(assetTriggerRect.top - createTriggerRect.bottom).toBeLessThanOrEqual(5);
  expect(shortcutTriggerRect.top - assetTriggerRect.bottom).toBeGreaterThanOrEqual(3);
  expect(shortcutTriggerRect.top - assetTriggerRect.bottom).toBeLessThanOrEqual(5);

  await createTrigger.hover();
  const createMenu = page.getByRole("menu", { name: "创作工具" });
  await expect(createMenu).toBeVisible();
  await shortcutTrigger.hover();
  await expect(shortcutMenu).toBeVisible();
  await expect(createMenu).toBeHidden();
  await expect.poll(() => shortcutMenu.evaluate((element) => (element as HTMLElement).offsetWidth)).toBe(224);
  const shortcutMenuRect = await rect(shortcutMenu);
  expect(shortcutMenuRect.left - shortcutTriggerRect.right).toBeGreaterThanOrEqual(-1);
  expect(shortcutMenuRect.left - shortcutTriggerRect.right).toBeLessThanOrEqual(4);
  await expect(shortcutMenu).toContainText(process.platform === "darwin" ? "macOS" : "Windows");
  await expect(shortcutMenu).toContainText("移动画布");
  await expect(shortcutMenu).toContainText(process.platform === "darwin" ? "⌘ +" : "Ctrl +");
  await expect(shortcutMenu).toContainText(process.platform === "darwin" ? "⇧⌘ Z" : "Ctrl Y");

  await shortcutTrigger.click();
  await page.mouse.move(0, 80);
  await expect(shortcutMenu).toBeHidden();

  await shortcutTrigger.focus();
  await page.keyboard.press("Enter");
  await expect(shortcutMenu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(shortcutMenu).toBeHidden();
  await expect(shortcutTrigger).toBeFocused();

  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const transformBeforeDock = await page.locator(".react-flow__viewport").evaluate(
    (element) => getComputedStyle(element).transform,
  );

  // 属性使用固定右侧 Dock，不能覆盖横向缩放条或 MiniMap。
  await contextToggle.click();
  await expect(contextToggle).toBeFocused();
  await expect(contextToggle).toHaveAttribute("aria-expanded", "true");
  await expect(dock).toHaveAttribute("aria-hidden", "false");
  await expectInert(dock, false);
  await expect(contextPanel).toHaveAttribute("aria-hidden", "false");
  await expectInert(contextPanel, false);
  await expectWidth(dock, expectedDockWidth);
  await expectWidth(canvas, viewport.width - expectedDockWidth);

  const contextCanvasRect = await rect(canvas);
  expect(Math.abs((await rect(dock)).left - contextCanvasRect.right)).toBeLessThanOrEqual(1);
  expectInside(await rect(zoomControls), contextCanvasRect);
  const contextMinimapRect = await rect(page.locator(".react-flow__minimap"));
  expectInside(contextMinimapRect, contextCanvasRect);
  expect(contextMinimapRect.width).toBe(contextCanvasRect.width < 760 ? 128 : 200);
  const contextZoomRect = await rect(zoomControls);
  expect(contextMinimapRect.left - contextZoomRect.right).toBeGreaterThanOrEqual(27);
  expect(contextMinimapRect.left - contextZoomRect.right).toBeLessThanOrEqual(29);
  await expect.poll(async () => page.locator(".react-flow__viewport").evaluate(
    (element) => getComputedStyle(element).transform,
  )).toBe(transformBeforeDock);

  // 结果使用独立左侧覆盖浮层；开合不能丢失 Results DOM 或滚动状态。
  await resultsToggle.click();
  await expect(resultsToggle).toHaveAttribute("aria-expanded", "true");
  await expect(resultsFlyout).toHaveAttribute("aria-hidden", "false");
  await expectInert(resultsFlyout, false);
  const resultsRegion = page.getByRole("region", { name: "最近生成" });
  await expect(resultsRegion).toContainText("运行 AI 节点后，最近生成会显示在这里");
  const originalResultsRegion = await resultsRegion.elementHandle();
  if (!originalResultsRegion) throw new Error("Results region is missing");
  const resultsScroller = resultsRegion.locator(".overflow-y-auto");
  await resultsScroller.evaluate((element) => {
    const filler = document.createElement("div");
    filler.dataset.e2eScrollFiller = "true";
    filler.style.height = "1000px";
    element.appendChild(filler);
    element.scrollTop = 37;
  });
  await expect.poll(async () => resultsScroller.evaluate((element) => element.scrollTop)).toBe(37);

  await page.getByRole("button", { name: "收起结果与记录" }).click();
  await expect(resultsFlyout).toHaveAttribute("aria-hidden", "true");
  await expectInert(resultsFlyout, true);
  await resultsToggle.click();
  await expect(resultsFlyout).toHaveAttribute("aria-hidden", "false");
  expect(await resultsRegion.evaluate((current, original) => current === original, originalResultsRegion)).toBe(true);
  await expect.poll(async () => resultsScroller.evaluate((element) => element.scrollTop)).toBe(37);
  await page.getByRole("button", { name: "收起结果与记录" }).click();

  await contextToggle.click();
  await expect(dock).toHaveAttribute("aria-hidden", "true");
  await expectInert(dock, true);
  await expectWidth(dock, 0);
  await expectWidth(canvas, viewport.width);
  await page.keyboard.press("Shift+Tab");
  const contextClosedFocus = await contextPanel.evaluate((panel) => ({
    inside: panel.contains(document.activeElement),
    tag: document.activeElement?.tagName,
  }));
  expect(contextClosedFocus.inside).toBe(false);
  expect(contextClosedFocus.tag).not.toBe("BODY");

  await contextToggle.click();
  await resultsToggle.click();
  await expect(resultsFlyout).toHaveAttribute("aria-hidden", "false");
  expect(await resultsRegion.evaluate((current, original) => current === original, originalResultsRegion)).toBe(true);
  await expect.poll(async () => resultsScroller.evaluate((element) => element.scrollTop)).toBe(37);
  await page.getByRole("button", { name: "收起结果与记录" }).click();

  // 五组工具使用锚定浮层；打开或关闭工具组不卸载右侧上下文，也不改变画布宽度。
  const apparelToggle = floatingRail.getByRole("button", { name: "服装设计", exact: true });
  await apparelToggle.focus();
  await apparelToggle.press("Enter");
  const apparelMenu = page.getByRole("menu", { name: "服装设计" });
  await expect(apparelToggle).toHaveAttribute("aria-expanded", "true");
  await expect(apparelMenu).toBeVisible();
  await expect(apparelMenu.getByRole("menuitem").first()).toBeFocused();
  await expect(contextToggle).toHaveAttribute("aria-expanded", "true");
  await expectInert(contextPanel, false);
  await expectWidth(dock, expectedDockWidth);
  await expectWidth(canvas, viewport.width - expectedDockWidth);
  const sessionBeforeDomFocus = await page.evaluate(() => (
    window.sessionStorage.getItem("garment-canvas-project-tabs")
  ));
  await apparelMenu.press("Escape");
  await expect(apparelMenu).toBeHidden();
  await expect(apparelToggle).toBeFocused();
  await expect.poll(() => page.evaluate(() => (
    window.sessionStorage.getItem("garment-canvas-project-tabs")
  ))).toBe(sessionBeforeDomFocus);

  await expectWidth(dock, expectedDockWidth);
  await expectWidth(canvas, viewport.width - expectedDockWidth);

  const canvasRect = await rect(canvas);
  expect(Math.abs((await rect(dock)).left - canvasRect.right)).toBeLessThanOrEqual(1);
  expectInside(await rect(zoomControls), canvasRect);
  const minimapRect = await rect(page.locator(".react-flow__minimap"));
  expectInside(minimapRect, canvasRect);
  expect(minimapRect.width).toBe(canvasRect.width < 760 ? 128 : 200);
  await expect.poll(async () => page.locator(".react-flow__viewport").evaluate(
    (element) => getComputedStyle(element).transform,
  )).toBe(transformBeforeDock);

  // 模板浮层必须按当前 Dock 后的中心宽度收缩，不能被画布容器裁切。
  const releaseTemplateSaves: Array<() => void> = [];
  const templateSaveGates = Array.from({ length: 3 }, () => new Promise<void>((resolve) => {
    releaseTemplateSaves.push(resolve);
  }));
  let resolveFailedOldRequest: (() => void) | undefined;
  const failedOldRequestHandled = new Promise<void>((resolve) => {
    resolveFailedOldRequest = resolve;
  });
  let templateSaveRequestIndex = 0;
  await page.route("**/api/templates", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: TEMPLATE_FIXTURES });
      return;
    }
    if (route.request().method() === "POST") {
      const requestIndex = templateSaveRequestIndex++;
      await templateSaveGates[requestIndex];
      if (requestIndex === 1) {
        await route.abort("failed");
        resolveFailedOldRequest?.();
        return;
      }
      await route.fulfill({ status: 201, json: TEMPLATE_FIXTURES[0] });
      return;
    }
    await route.fallback();
  });
  const projectCenterToggle = page.getByRole("button", { name: "打开项目中心" });
  await projectCenterToggle.click();
  const projectCenter = page.getByRole("dialog", { name: "项目中心" });
  await expect(projectCenter).toBeVisible();
  await projectCenter.getByRole("tab", { name: "我的模板" }).click();
  await expect(projectCenter.getByRole("button", { name: "保存当前画布为模板" })).toBeVisible();
  const projectCenterRect = await rect(projectCenter);
  expect(projectCenterRect.left).toBeGreaterThanOrEqual(39);
  expect(projectCenterRect.right).toBeLessThanOrEqual(viewport.width - 39);
  await testInfo.attach(`desktop-${viewport.width}-dock-layout-template`, {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  const saveTemplateButton = projectCenter.getByRole("button", { name: "保存当前画布为模板" });
  await saveTemplateButton.click();
  const saveTemplateDialog = page.getByRole("dialog", { name: "存为模板" });
  await expect(saveTemplateDialog).toBeVisible();
  const saveTemplateName = saveTemplateDialog.getByRole("textbox", { name: "名称" });
  const submitTemplate = saveTemplateDialog.getByRole("button", { name: /^保存/ });
  await expect(saveTemplateName).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(submitTemplate).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(saveTemplateName).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(saveTemplateDialog).toHaveCount(0);
  await expect(projectCenter).toBeVisible();
  await expect(saveTemplateButton).toBeFocused();

  // 已关闭会话的延迟响应不得关闭或改写后来重新打开的表单。
  await saveTemplateButton.click();
  await saveTemplateName.fill("旧会话模板");
  const oldSaveResponse = page.waitForResponse((response) => (
    response.request().method() === "POST" &&
    response.request().postData()?.includes("旧会话模板") === true
  ));
  await submitTemplate.click();
  await expect(submitTemplate).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(saveTemplateDialog).toHaveCount(0);
  await saveTemplateButton.click();
  await expect(saveTemplateName).toHaveValue("");
  await saveTemplateName.fill("新会话模板");
  releaseTemplateSaves[0]();
  await oldSaveResponse;
  await expect(saveTemplateDialog).toBeVisible();
  await expect(saveTemplateName).toHaveValue("新会话模板");
  await expect(submitTemplate).toBeEnabled();
  await expect(saveTemplateDialog.locator(".text-red-400")).toHaveCount(0);

  // 旧网络异常的 catch/finally 也不能污染仍在提交的新会话。
  await saveTemplateName.fill("失败旧会话");
  const failedOldSaveRequest = page.waitForRequest((request) => (
    request.method() === "POST" && request.postData()?.includes("失败旧会话") === true
  ));
  await submitTemplate.click();
  await failedOldSaveRequest;
  await expect(submitTemplate).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(saveTemplateDialog).toHaveCount(0);
  await saveTemplateButton.click();
  await saveTemplateName.fill("并发新会话");
  const currentSaveResponse = page.waitForResponse((response) => (
    response.request().method() === "POST" &&
    response.request().postData()?.includes("并发新会话") === true
  ));
  await submitTemplate.click();
  await expect(submitTemplate).toBeDisabled();
  releaseTemplateSaves[1]();
  await failedOldRequestHandled;
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(saveTemplateDialog).toBeVisible();
  await expect(saveTemplateName).toHaveValue("并发新会话");
  await expect(submitTemplate).toBeDisabled();
  await expect(saveTemplateDialog.locator(".text-red-400")).toHaveCount(0);
  releaseTemplateSaves[2]();
  await currentSaveResponse;
  await expect(saveTemplateDialog).toHaveCount(0);
  await expect(saveTemplateButton).toBeFocused();
  await projectCenter.getByRole("button", { name: "关闭项目中心" }).click();
  await expect(projectCenter).toHaveCount(0);
  await expect(projectCenterToggle).toBeFocused();

  await resultsScroller.locator("[data-e2e-scroll-filler='true']").evaluateAll((elements) => {
    for (const element of elements) element.remove();
  });
  await page.mouse.move(canvasRect.left + canvasRect.width / 2, canvasRect.top + 20);
  await page.waitForTimeout(300);

  await testInfo.attach(`desktop-${viewport.width}-dock-layout`, {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  await contextToggle.click();
  await expect(contextToggle).toBeFocused();
  await expect(dock).toHaveAttribute("aria-hidden", "true");
  await expectInert(dock, true);
  await expectWidth(dock, 0);
  await expectWidth(canvas, viewport.width);
  await page.keyboard.press("Tab");
  expect(await contextPanel.evaluate((panel) => panel.contains(document.activeElement))).toBe(false);

  expect(await canvas.evaluate((current, original) => current === original, originalCanvas)).toBe(true);
  await expect.poll(async () => page.locator(".react-flow__viewport").evaluate(
    (element) => getComputedStyle(element).transform,
  )).toBe(transformBeforeDock);
});

test("single current theme remains applied without a picker", async ({ page }) => {
  await expectCurrentThemeContract(page);
  await expect(page.getByRole("button", { name: /^切换主题，当前为/ })).toHaveCount(0);
  await expect(page.getByRole("menuitemradio")).toHaveCount(0);
});

test("conversation edit dock preserves desktop geometry, focus, and mode drafts", async ({ page }) => {
  await openFreshBlankProject(page);
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Desktop viewport is required");
  const expectedDockWidth = viewport.width <= 1100 ? 360 : viewport.width < 1360 ? 400 : 440;
  const propertyToggle = page.getByRole("button", { name: "属性", exact: true });
  const conversationToggle = page.getByRole("button", { name: "对话修改", exact: true });
  const dock = page.locator("#workbench-inspector-panel");
  const panel = page.getByTestId("image-conversation-panel");
  const canvas = page.getByRole("application", { name: "工作流画布" });
  const viewportTransform = page.locator(".react-flow__viewport");

  const propertyBox = await propertyToggle.boundingBox();
  const conversationBox = await conversationToggle.boundingBox();
  expect(propertyBox).not.toBeNull();
  expect(conversationBox).not.toBeNull();
  expect(propertyBox!.y + propertyBox!.height).toBeLessThanOrEqual(conversationBox!.y);
  await expect(dock).toHaveAttribute("aria-hidden", "true");
  await expectWidth(dock, 0);
  const transformBefore = await viewportTransform.evaluate((element) => getComputedStyle(element).transform);

  await conversationToggle.click();
  await expect(conversationToggle).toBeHidden();
  await expect(propertyToggle).toBeHidden();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("tab", { name: "单图修改" })).toBeVisible();
  await expect(panel.getByRole("tab", { name: "多图融合" })).toBeVisible();
  await expect(panel.getByRole("tab", { name: "局部重绘" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "本地上传" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "素材库" })).toBeVisible();
  await panel.getByRole("button", { name: "素材库" }).click();
  const conversationAssetDialog = page.getByRole("dialog", { name: "开始新修改：选择底图" });
  await expect(conversationAssetDialog).toBeVisible();
  await conversationAssetDialog.getByRole("button", { name: "关闭" }).click();
  await expect(conversationAssetDialog).toBeHidden();
  await expectWidth(dock, expectedDockWidth);
  await expectWidth(canvas, viewport.width - expectedDockWidth);
  await expect.poll(async () => viewportTransform.evaluate((element) => getComputedStyle(element).transform)).toBe(transformBefore);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const prompt = panel.getByRole("textbox", { name: "对话修改指令" });
  await prompt.fill("单图草稿");
  await panel.getByRole("tab", { name: "多图融合" }).click();
  await prompt.fill("融合草稿");
  await panel.getByRole("tab", { name: "局部重绘" }).click();
  await prompt.fill("蒙版草稿");
  await panel.getByRole("tab", { name: "单图修改" }).click();
  await expect(prompt).toHaveValue("单图草稿");
  await panel.getByRole("tab", { name: "多图融合" }).click();
  await expect(prompt).toHaveValue("融合草稿");
  await panel.getByRole("tab", { name: "局部重绘" }).click();
  await expect(prompt).toHaveValue("蒙版草稿");

  await page.getByRole("button", { name: "关闭对话修改" }).click();
  await expect(panel).toBeHidden();
  await propertyToggle.click();
  await expect(propertyToggle).toHaveAttribute("aria-expanded", "true");
  await expect(conversationToggle).toHaveAttribute("aria-expanded", "false");
  await expectWidth(dock, expectedDockWidth);
  await expectWidth(canvas, viewport.width - expectedDockWidth);
  await expect.poll(async () => viewportTransform.evaluate((element) => getComputedStyle(element).transform)).toBe(transformBefore);

  await conversationToggle.click();
  await expect(conversationToggle).toBeHidden();
  await expect(propertyToggle).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(conversationToggle).toHaveAttribute("aria-expanded", "false");
  await expect(conversationToggle).toBeFocused();
  await expectWidth(dock, 0);
  await expectWidth(canvas, viewport.width);
  await expect.poll(async () => viewportTransform.evaluate((element) => getComputedStyle(element).transform)).toBe(transformBefore);
});

test("creation tools open an editable board and create a new typed palette without AI", async ({ page }) => {
  const rail = page.getByRole("navigation", { name: "工作台左侧工具" });
  const canvasNodes = page.locator(".react-flow__node");
  const before = await canvasNodes.count();

  const createTrigger = rail.getByRole("button", { name: "创作工具", exact: true });
  await createTrigger.focus();
  await createTrigger.press("Enter");
  const menu = page.getByRole("menu", { name: "创作工具" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: /绘画工具/ }).click();
  const boardDialog = page.getByRole("dialog", { name: "绘画板" });
  await expect(boardDialog).toBeVisible();
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Desktop viewport is required");
  expectInside(await rect(boardDialog), {
    left: 0, top: 0, right: viewport.width, bottom: viewport.height, width: viewport.width, height: viewport.height,
  });
  await expect(canvasNodes).toHaveCount(before);
  await boardDialog.getByRole("button", { name: "取消" }).click();
  await expect(boardDialog).toHaveCount(0);
  await expect(canvasNodes).toHaveCount(before);

  await createTrigger.focus();
  await createTrigger.press("Enter");
  await menu.getByRole("menuitem", { name: /绘画工具/ }).click();
  await expect(boardDialog).toBeVisible();
  await expect(boardDialog.getByRole("toolbar", { name: "绘画工具" })).toBeVisible();
  await boardDialog.getByRole("button", { name: "文字" }).click();
  await boardDialog.getByRole("textbox", { name: "文字内容" }).fill("服装草图备注");
  await boardDialog.getByRole("button", { name: "添加文字" }).click();
  const creationRequests: string[] = [];
  await page.route("**/api/drawing-boards/create", async (route) => {
    creationRequests.push(route.request().postData() ?? "");
    const response = await route.fetch();
    if (creationRequests.length === 1) {
      await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "模拟提交后应答丢失" }) });
    } else {
      await route.fulfill({ response });
    }
  });
  await boardDialog.getByRole("button", { name: "保存画板" }).click();
  await expect(boardDialog.getByText("模拟提交后应答丢失", { exact: true })).toBeVisible();
  await expect(canvasNodes).toHaveCount(before);
  expect(await page.evaluate(async () => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    return useFlowStore.getState().saveProject();
  })).toBe(false);
  await boardDialog.getByRole("button", { name: "取消" }).click();
  await expect(boardDialog).toBeVisible();
  await boardDialog.getByRole("button", { name: "保存画板" }).click();
  await expect(boardDialog).toHaveCount(0);
  expect(creationRequests).toHaveLength(2);
  expect(creationRequests[1]).toBe(creationRequests[0]);
  await expect(canvasNodes).toHaveCount(before + 1);
  const board = canvasNodes.filter({ hasText: "绘画工具" }).last();
  await expect(board.getByAltText("画板已保存预览")).toBeVisible();
  await page.evaluate(async (nodeId) => {
    const landingPath = "/src/lib/canvasLanding.ts";
    const storePath = "/src/store/flowStore.ts";
    const { requestCanvasLanding } = await import(landingPath);
    const { useFlowStore } = await import(storePath);
    requestCanvasLanding({ tabId: useFlowStore.getState().activeTabId, nodeId, fitView: true });
  }, await board.getAttribute("data-id"));
  await board.getByRole("button", { name: "导出为图片节点" }).click();
  await expect(canvasNodes).toHaveCount(before + 2);

  await createTrigger.focus();
  await createTrigger.press("Enter");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: /色彩工具/ }).click();
  const colorDialog = page.getByRole("dialog", { name: "色彩工具" });
  await expect(colorDialog).toBeVisible();
  expectInside(await rect(colorDialog), {
    left: 0, top: 0, right: viewport.width, bottom: viewport.height, width: viewport.width, height: viewport.height,
  });
  await expect(colorDialog.getByRole("tab", { name: "中性基础色" })).toBeVisible();
  await expect(colorDialog.getByRole("tab", { name: "暖色系" })).toBeVisible();
  await expect(colorDialog.getByRole("tab", { name: "冷色系" })).toBeVisible();
  await colorDialog.getByRole("button", { name: /选择 #[0-9A-F]{6}/ }).first().click();
  await expect(colorDialog.getByText(/已选 1\/8/)).toBeVisible();
  await colorDialog.getByRole("button", { name: "创建新色板节点" }).click();
  await expect(colorDialog).toHaveCount(0);
  await expect(canvasNodes).toHaveCount(before + 3);
  await expect(canvasNodes.filter({ hasText: "色板" }).last()).toContainText(/#[0-9A-F]{6}/);
});


test("fabric recolor picker keeps the ninth color error visible and Escape cancels the draft", async ({ page }) => {
  await openFreshBlankProject(page);
  const rail = page.getByRole("navigation", { name: "工作台左侧工具" });
  await rail.getByRole("button", { name: "服装设计", exact: true }).click();
  await page.getByRole("menu", { name: "服装设计" }).getByRole("menuitem", { name: /面料配色替换/ }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  const nodeId = await page.evaluate(async () => {
    const storeModulePath = "/src/store/flowStore.ts";
    const { useFlowStore } = await import(storeModulePath);
    const state = useFlowStore.getState();
    const tab = state.tabs.find((candidate: { id: string }) => candidate.id === state.activeTabId)!;
    const node = tab.nodes.find((candidate: BrowserFlowNode) => candidate.data.kind === "fabric-recolor")!;
    useFlowStore.getState().updateNodeData(node.id, {
      colors: ["#111111", "#222222", "#333333", "#444444", "#555555", "#666666", "#777777", "#888888"],
    });
    useFlowStore.getState().setSelectedNodeIds([node.id]);
    return node.id;
  });
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
  await node.getByRole("button", { name: "自定义色" }).click();
  const pickerTrigger = node.getByRole("button", { name: "打开自定义取色器" });
  await pickerTrigger.click();
  const colorInput = page.getByRole("textbox", { name: "自定义颜色值" });
  await colorInput.fill("#123456");
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("最多选择 8 个颜色");
  await expect(colorInput).toBeVisible();
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Desktop viewport is required");
  expectInside(await rect(page.getByText("选择颜色并确认后", { exact: false }).locator("..")), {
    left: 0, top: 0, right: viewport.width, bottom: viewport.height, width: viewport.width, height: viewport.height,
  });
  await page.keyboard.press("Escape");
  await expect(colorInput).toHaveCount(0);
  await expect(pickerTrigger).toBeFocused();
  await pickerTrigger.click();
  await expect(page.getByRole("textbox", { name: "自定义颜色值" })).toHaveValue("#C9A66B");
  await page.keyboard.press("Escape");
});
test("approved video capabilities open complete workflows without triggering generation", async ({ page }) => {
  await openFreshBlankProject(page);
  const generationPosts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/(?:generate|run-plan)(?:\/|\?|$)/.test(request.url())) {
      generationPosts.push(request.url());
    }
  });
  const nodes = page.locator(".react-flow__node");
  const capabilities = [
    { name: "文生视频", nodeCount: 2 },
    { name: "首帧生视频", nodeCount: 3 },
    { name: "首尾帧生视频", nodeCount: 4 },
    { name: "多模态参考生视频", nodeCount: 5 },
    { name: "视频编辑", nodeCount: 3 },
    { name: "视频延长", nodeCount: 3 },
  ];
  for (const capability of capabilities) {
    const trigger = page.getByRole("navigation", { name: "工作台左侧工具" })
      .getByRole("button", { name: "视频制作", exact: true });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = page.getByRole("menu", { name: "视频制作" });
    await expect(menu).toBeVisible();
    const { name, nodeCount } = capability;
    const item = menu.getByRole("menuitem", { name: new RegExp(name) });
    await expect(item).toHaveAttribute("aria-disabled", "false");
    await expect(item).toHaveAttribute("data-video-capability-id");
    await expect(item).toHaveAttribute("data-approval-state", "approved");
    await item.click();
    await expect(nodes).toHaveCount(nodeCount);
    await expect(nodes.filter({ hasText: name })).toBeVisible();
  }
  expect(generationPosts).toEqual([]);
});

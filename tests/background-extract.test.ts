import sharp from "sharp";
import assert from "node:assert/strict";
import { buildExecutionPlan, assertPlanInputs, type FlowNode, type FlowEdge } from "../server/engine/dag";
import { executeStep } from "../server/engine/runner";
import { createDocumentSnapshot, documentSnapshotToPersistedWorkflow } from "../src/lib/documentSnapshot";
import { NODE_SPECS, WORKFLOW_SCHEMA_VERSION } from "../src/types/workflow";
import { GENERATION_IMAGE_MODEL_IDS, defaultImageModelOptions } from "../src/types/imageModels";
import { validateAndMigrateFlow } from "../server/lib/workflowSchema";
import { validateDirectGenerateRequest } from "../server/routes/generate";
import type { AIProvider, ImageGenRequest } from "../src/types/workflow";

const KIND = "background-extract";
const SOURCE_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const GENERATED_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function createImageDataUrl(width: number, height: number): Promise<string> {
  const buffer = await sharp({
    create: { width, height, channels: 4, background: { r: 224, g: 198, b: 170, alpha: 1 } },
  }).png().toBuffer();
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

type Spec = {
  inputs: number;
  outputs: string;
  inputPorts: Array<{ id: string; valueKind: string; required: boolean; maxSources: number }>;
  outputPorts: Array<{ id: string; valueKind: string }>;
};

function imageNode(id: string, imageUrl: string): FlowNode {
  return {
    id,
    type: "image-input",
    position: { x: 0, y: 0 },
    data: {
      kind: "image-input",
      label: id,
      status: "idle",
      imageRole: "default",
      imageUrl,
    } as never,
  };
}

function backgroundNode(id: string, outputImages: string[] = []): FlowNode {
  return {
    id,
    type: KIND,
    position: { x: 0, y: 0 },
    data: {
      kind: KIND,
      label: "提取背景",
      status: "idle",
      modelId: "gpt-image-2.5-flare",
      modelOptions: { size: "2048x2048", quality: "medium" },
      outputImages,
    } as never,
  };
}

function modifyNode(id: string): FlowNode {
  return {
    id,
    type: "ai-modify",
    position: { x: 0, y: 0 },
    data: {
      kind: "ai-modify",
      label: id,
      status: "idle",
      prompt: "继续修改",
      aspectRatio: "1:1",
      batchSize: 1,
      outputImages: [],
      modelId: "gpt-image-2.5-flare",
      modelOptions: { size: "2048x2048", quality: "medium" },
    } as never,
  };
}

const inputEdge = (source: string, target: string): FlowEdge => ({
  id: `${source}-${target}`,
  source,
  target,
  sourceHandle: "image",
  targetHandle: "references",
});

async function main(): Promise<void> {
  const spec = (NODE_SPECS as unknown as Record<string, Spec>)[KIND];
  assert.ok(spec, "提取背景必须注册为独立节点规格");
  assert.equal(spec.inputs, 1);
  assert.equal(spec.outputs, "images");
  assert.deepEqual(spec.inputPorts, [{
    id: "references",
    label: "参考图",
    direction: "input",
    valueKind: "image",
    required: true,
    maxSources: 1,
  }]);
  assert.deepEqual(spec.outputPorts, [{
    id: "image",
    label: "图片",
    direction: "output",
    valueKind: "image",
    required: false,
    maxSources: 1,
  }]);

  assert.deepEqual(validateDirectGenerateRequest(KIND, {
    prompt: "ignored",
    referenceImages: [SOURCE_IMAGE],
  }), { ok: true, kind: KIND });
  assert.equal(validateDirectGenerateRequest(KIND, { prompt: "missing source" }).ok, false);

  const source = imageNode("source", SOURCE_IMAGE);
  const background = backgroundNode("background", [GENERATED_IMAGE]);
  const modify = modifyNode("modify");
  const edges = [inputEdge("source", "background"), inputEdge("background", "modify")];
  const plan = buildExecutionPlan([source, background, modify], edges);
  const backgroundStep = plan.steps.find((step) => step.nodeId === "background");
  assert.deepEqual(backgroundStep?.upstream, [{
    nodeId: "source",
    images: [SOURCE_IMAGE],
    sourceHandle: "image",
    targetHandle: "references",
  }]);
  const modifyStep = plan.steps.find((step) => step.nodeId === "modify");
  assert.deepEqual(modifyStep?.upstream, [{
    nodeId: "background",
    images: [GENERATED_IMAGE],
    sourceHandle: "image",
    targetHandle: "references",
  }]);
  assert.doesNotThrow(() => assertPlanInputs(plan, edges));

  const snapshot = createDocumentSnapshot({
    projectName: "背景测试",
    nodes: [source, background],
    edges: [edges[0]],
  });
  const persisted = documentSnapshotToPersistedWorkflow(snapshot);
  assert.equal(persisted.schemaVersion, WORKFLOW_SCHEMA_VERSION);
  assert.deepEqual(persisted.nodes[1].data, {
    kind: KIND,
    status: "idle",
    label: "提取背景",
    modelId: "gpt-image-2.5-flare",
    modelOptions: { size: "2048x2048", quality: "medium" },
    outputImages: [GENERATED_IMAGE],
  });
  const validated = validateAndMigrateFlow(persisted);
  assert.equal(validated.nodes[1].type, KIND);
  assert.equal(validated.nodes[1].data.kind, KIND);

  for (const modelId of GENERATION_IMAGE_MODEL_IDS) {
    const flow = validateAndMigrateFlow({
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes: [backgroundNode(`background-${modelId.replaceAll(".", "-")}`)],
      edges: [],
    });
    const node = flow.nodes[0];
    node.data.modelId = modelId;
    node.data.modelOptions = defaultImageModelOptions(modelId);
    assert.equal(validateAndMigrateFlow(flow).nodes[0].data.modelId, modelId);
  }

  let editRequest: ImageGenRequest | undefined;
  let editCalls = 0;
  const provider: AIProvider = {
    id: "background-test-provider",
    async generate() {
      throw new Error("提取背景必须使用图片编辑路径");
    },
    async edit(request) {
      editCalls += 1;
      editRequest = request;
      return { images: [GENERATED_IMAGE], model: "background-test-model" };
    },
  };
  const executionSource = await createImageDataUrl(3, 2);
  const result = await executeStep({
    nodeId: "background",
    kind: KIND as never,
    inputImages: [executionSource],
    params: {
      modelId: "gpt-image-2.5-flare",
      modelOptions: { size: "2048x2048", quality: "medium" },
    },
  }, [executionSource], () => provider);
  assert.equal(result.images.length, 1);
  assert.match(result.images[0], /^data:image\/webp;base64,/);
  const metadata = await sharp(Buffer.from(result.images[0].split(",")[1], "base64")).metadata();
  assert.deepEqual({ width: metadata.width, height: metadata.height }, { width: 3, height: 2 });
  assert.equal(editCalls, 1);
  assert.deepEqual(editRequest?.referenceImages, [executionSource]);
  assert.match(editRequest?.prompt ?? "", /人物|物体/);
  assert.match(editRequest?.prompt ?? "", /仅含背景|仅保留.*背景/);
  assert.equal(editRequest?.batchSize, 1);

  console.log("背景提取节点测试通过");
}

await main();

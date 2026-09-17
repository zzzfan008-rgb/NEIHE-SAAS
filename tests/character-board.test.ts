import assert from "node:assert/strict";
import { buildExecutionPlan, assertPlanInputs, type FlowNode } from "../server/engine/dag";
import { executeStep } from "../server/engine/runner";
import { validateAndMigrateFlow } from "../server/lib/workflowSchema";
import { createDocumentSnapshot, documentSnapshotToPersistedWorkflow } from "../src/lib/documentSnapshot";
import { NODE_SPECS, type AIProvider, type ImageGenRequest } from "../src/types/workflow";
import { DEFAULT_GENERATION_MODEL_ID } from "../src/types/imageModels";
import { useFlowStore, selectActiveDocument, selectActiveDocumentTarget, applyRunEventToTab, selectActiveNodeInputImages } from "../src/store/flowStore";
import { uploadCharacterBoardSource } from "../src/lib/characterBoardUpload";
import { connectionCompatibilityError, inputPortSpecs } from "../src/lib/workflowPorts";
import type { NodeKind } from "../src/types/workflow";

const source = "/api/files/source.png", output = "/api/files/board.png";
const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const board: FlowNode = { id: "board", type: "character-board", position: { x: 0, y: 0 }, data: { kind: "character-board", label: "人物板生成", status: "idle", sourceImage: source, outputImages: [output] } };
const result: FlowNode = { id: "result", type: "result", position: { x: 400, y: 0 }, data: { kind: "result", label: "结果", status: "idle", images: [] } };
const edge = { id: "board-result", source: "board", target: "result", sourceHandle: "image", targetHandle: "images" };
const plan = buildExecutionPlan([board, result], [edge]);
assert.deepEqual(plan.steps[0].inputImages, [source]);
assert.deepEqual(plan.steps[1].inputImages, [output]);
assert.equal(NODE_SPECS["character-board"].inputPorts.length, 0);
assert.doesNotThrow(() => assertPlanInputs(plan, [edge]));
assert.throws(() => assertPlanInputs({ steps: [{ ...plan.steps[0], inputImages: [] }] }, []));
const snapshot = createDocumentSnapshot({ projectName: "人物板", nodes: [board], edges: [] });
const restored = validateAndMigrateFlow(documentSnapshotToPersistedWorkflow(snapshot));
assert.deepEqual(restored.nodes[0].data, board.data);
assert.throws(() => validateAndMigrateFlow({ ...restored, nodes: [{ ...board, data: { ...board.data, sourceImage: "https://example.com/private.png" } }] }));
assert.throws(() => validateAndMigrateFlow({ ...restored, nodes: [{ ...board, data: { ...board.data, sourceImage: "/api/files/../secret.png" } }] }));
assert.throws(() => validateAndMigrateFlow({ ...restored, nodes: [{ ...board, data: { ...board.data, outputImages: [output, output] } }] }));

let request: ImageGenRequest | undefined;
let model: string | undefined;
const generate = async (value: ImageGenRequest) => { request = value; return { images: [pixel], model: DEFAULT_GENERATION_MODEL_ID }; };
const provider = { id: "apiyi", generate, edit: generate } as AIProvider;
await executeStep({ ...plan.steps[0], params: { prompt: "FORGED", batchSize: 8, modelId: "FORGED", aspectRatio: "1:1" } }, [pixel], (id) => { model = id; return provider; });
assert.equal(model, DEFAULT_GENERATION_MODEL_ID);
assert.equal(request?.batchSize, 1);
assert.equal(request?.aspectRatio, "3:4");
assert.equal(request?.referenceImages?.length, 1);
for (const text of ["左上：正面全身", "右上：背面全身", "左下：侧面全身", "右下：正面面部特写", "原图表情"]) assert.ok(request?.prompt.includes(text));
assert.ok(request?.prompt.includes("浅白色无图案背心"));
assert.ok(request?.prompt.includes("浅白色短裤"));
assert.ok(request?.prompt.includes("移除所有配饰"));
assert.ok(request?.prompt.includes("不保留原图的帽子、眼镜、首饰、包袋、腰带等"));
assert.ok(!request?.prompt.includes("保留上传照片的服装与配饰"));
assert.ok(!request?.prompt.includes("FORGED"));
await assert.rejects(() => executeStep(plan.steps[0], [], () => provider));

useFlowStore.getState().createBlankTab();
const target = selectActiveDocumentTarget(useFlowStore.getState());
useFlowStore.setState((state) => ({ tabs: state.tabs.map((tab) => tab.id === target.tabId ? { ...tab, nodes: [board, result], edges: [edge] } : tab) }));
assert.deepEqual(selectActiveNodeInputImages(useFlowStore.getState(), "result"), [output]);
applyRunEventToTab(target, "board", { type: "node-status", nodeId: "board", status: "error", error: "mock failure" });
assert.deepEqual(selectActiveDocument(useFlowStore.getState()).nodes[0].data.outputImages, [output]);
const fetcher = async () => Response.json({ normalized: true, url: "/api/files/new-source.png" });
assert.equal(await uploadCharacterBoardSource(target, "board", pixel, "模特.png", fetcher), true);
assert.deepEqual(selectActiveNodeInputImages(useFlowStore.getState(), "result"), [], "上传原图不应作为输出传递");
assert.equal(selectActiveDocument(useFlowStore.getState()).nodes[0].data.sourceImage, "/api/files/new-source.png");

let complete!: (response: Response) => void;
const pending = uploadCharacterBoardSource(target, "board", pixel, "late.png", () => new Promise((resolve) => { complete = resolve; }));
useFlowStore.getState().createBlankTab();
const newTabNodes = selectActiveDocument(useFlowStore.getState()).nodes;
complete(Response.json({ normalized: true, url: "/api/files/other-source.png" }));
assert.equal(await pending, true, "切换页签仍须回写原文档");
assert.deepEqual(selectActiveDocument(useFlowStore.getState()).nodes, newTabNodes);
const stale = uploadCharacterBoardSource(target, "board", pixel, "stale.png", () => new Promise((resolve) => { complete = resolve; }));
useFlowStore.setState((state) => ({ tabs: state.tabs.map((tab) => tab.id === target.tabId ? { ...tab, documentEpoch: tab.documentEpoch + 1 } : tab) }));
complete(Response.json({ normalized: true, url: "/api/files/stale.png" }));
assert.equal(await stale, false, "复用页签的旧上传必须丢弃");
applyRunEventToTab(target, "board", { type: "node-status", nodeId: "board", status: "success", images: [output] });
assert.deepEqual(useFlowStore.getState().tabs.find((tab) => tab.id === target.tabId)?.nodes[0].data.outputImages, []);
for (const kind of Object.keys(NODE_SPECS) as NodeKind[]) {
  const id = useFlowStore.getState().addNode(kind, { x: 0, y: 0 });
  const targetNode = selectActiveDocument(useFlowStore.getState()).nodes.find((node) => node.id === id)!;
  for (const port of inputPortSpecs(targetNode.data)) {
    const error = connectionCompatibilityError({ source: board, target: targetNode, sourceHandle: "image", targetHandle: port.id });
    if (kind === "ai-styling") assert.ok(error, "保留搭配节点专用服饰来源约束");
    else if ((port.accepts ?? [port.valueKind]).includes("image")) assert.equal(error, undefined, `${kind}.${port.id} 应接受人物板`);
    else assert.ok(error, `${kind}.${port.id} 不应接受图片`);
  }
}
console.log("character-board: schema, fixed generation, image output and document boundary tests passed");

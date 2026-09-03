import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { savePrintOutputAsAsset } from "../src/lib/printAsset";
import {
  selectActiveCompareIds,
  selectActiveDirty,
  selectActiveDocument,
  selectActiveDocumentEpoch,
  selectActiveEdges,
  selectActiveNodes,
  selectActivePrimarySelectedNodeId,
  selectActiveProjectId,
  selectActiveProjectName,
  selectActiveReadOnly,
  selectActiveRevision,
  selectActiveSavedRevision,
  selectActiveSaveState,
  selectActiveSelectedNodeId,
  selectActiveSelectedNodeIds,
  selectActiveSelectedResultId,
  selectDocumentForTab,
  selectHasDirtyTabs,
  useFlowStore,
  type FlowNode,
} from "../src/store/flowStore";

const ACTIVE_DOCUMENT_FIELDS = new Set([
  "projectId",
  "projectName",
  "readOnly",
  "nodes",
  "edges",
  "selectedNodeIds",
  "selectedNodeId",
  "selectedResultId",
  "compareIds",
  "saveState",
  "hasBeenPersisted",
  "revision",
  "savedRevision",
  "dirty",
  "documentEpoch",
]);

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testRoot, "..");
const sourceRoot = path.resolve(testRoot, "../src");

const configPath = path.join(repositoryRoot, "tsconfig.json");
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
}
const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repositoryRoot);
const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
const flowStoreFile = program.getSourceFile(path.join(sourceRoot, "store/flowStore.ts"));
assert.ok(flowStoreFile, "TypeScript Program 未包含 flowStore.ts");
const flowStateDeclaration = flowStoreFile.statements.find(
  (statement): statement is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(statement) && statement.name.text === "FlowState",
);
assert.ok(flowStateDeclaration, "flowStore.ts 缺少 FlowState interface");

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(absolute));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(absolute);
  }
  return files.sort();
}

function imageNode(id: string, label: string): FlowNode {
  return {
    id,
    type: "image-input",
    position: { x: 0, y: 0 },
    data: { kind: "image-input", label, status: "idle", imageRole: "default" },
  };
}

console.log("活动文档 selector 边界测试");

const flowStateMembers = new Set(flowStateDeclaration.members.flatMap((member) => {
  const name = member.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? [name.text] : [];
}));
assert.deepEqual(
  [...ACTIVE_DOCUMENT_FIELDS].filter((field) => flowStateMembers.has(field)),
  [],
  "FlowState 不得恢复任何顶层活动文档镜像字段",
);
const sourceText = sourceFiles(sourceRoot).map((file) => fs.readFileSync(file, "utf8")).join("\n");
assert.doesNotMatch(
  sourceText,
  /\b(?:snapshotActiveTab|activeFields|lastActiveSnapshot)\b/,
  "旧镜像投影 helper/subscriber 不得回归",
);
console.log("  ✓ FlowState 与源码不再包含活动文档镜像边界");

useFlowStore.getState().loadFlow({
  projectId: "selector-a",
  projectName: "Selector A",
  nodes: [imageNode("selector-a-node", "A")],
  edges: [],
  markDirty: true,
});
useFlowStore.setState({
  recentResults: [{
    id: "selector-result",
    image: "/api/files/selector-result.png",
    nodeId: "selector-a-node",
    nodeLabel: "Selector result",
    kind: "ai-modify",
    projectId: "selector-a",
    startedAt: 1,
    finishedAt: 2,
    status: "success",
  }],
});
useFlowStore.getState().setSelectedNodeIds(["selector-a-node"]);
const selectedState = useFlowStore.getState();
assert.equal(selectActivePrimarySelectedNodeId(selectedState), "selector-a-node");
assert.deepEqual(selectActiveSelectedNodeIds(selectedState), ["selector-a-node"]);
assert.equal(selectActiveSelectedNodeId(selectedState), "selector-a-node");
useFlowStore.getState().setSelectedResultId("selector-result");
const resultSelectedState = useFlowStore.getState();
assert.equal(selectActiveSelectedResultId(resultSelectedState), "selector-result");
useFlowStore.getState().toggleCompareId("selector-result");

const stateA = useFlowStore.getState();
const documentA = selectActiveDocument(stateA);
assert.strictEqual(
  documentA,
  stateA.tabs.find((tab) => tab.id === stateA.activeTabId),
  "active-document selector 必须返回 canonical tabs 中的原始对象引用",
);
for (const field of ACTIVE_DOCUMENT_FIELDS) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(stateA, field),
    false,
    `FlowState 运行时不得含有镜像字段 ${field}`,
  );
}
assert.equal(selectActiveProjectId(stateA), documentA.projectId);
assert.equal(selectActiveProjectName(stateA), documentA.projectName);
assert.equal(selectActiveReadOnly(stateA), documentA.readOnly);
assert.strictEqual(selectActiveNodes(stateA), documentA.nodes);
assert.strictEqual(selectActiveEdges(stateA), documentA.edges);
assert.strictEqual(selectActiveSelectedNodeIds(stateA), documentA.selectedNodeIds);
assert.equal(selectActiveSelectedNodeId(stateA), documentA.selectedNodeId);
assert.equal(selectActivePrimarySelectedNodeId(stateA), null);
assert.equal(selectActiveSelectedResultId(stateA), null);
assert.deepEqual(selectActiveCompareIds(stateA), ["selector-result"]);
assert.strictEqual(selectActiveCompareIds(stateA), documentA.compareIds);
assert.equal(selectActiveSaveState(stateA), documentA.saveState);
assert.equal(selectActiveRevision(stateA), documentA.revision);
assert.equal(selectActiveSavedRevision(stateA), documentA.savedRevision);
assert.equal(selectActiveDirty(stateA), documentA.dirty);
assert.equal(selectActiveDocumentEpoch(stateA), documentA.documentEpoch);
assert.equal(selectHasDirtyTabs(stateA), documentA.dirty);
assert.deepEqual(selectDocumentForTab(stateA, stateA.activeTabId), documentA);
let projectNameEmissions = 0;
let inconsistentProjectNameEmission = false;
const unsubscribeProjectName = useFlowStore.subscribe((next) => {
  projectNameEmissions += 1;
  const active = next.tabs.find((tab) => tab.id === next.activeTabId);
  if (!active || selectActiveDocument(next) !== active || selectActiveProjectName(next) !== active.projectName) {
    inconsistentProjectNameEmission = true;
  }
});
useFlowStore.getState().setProjectName("Selector A atomic");
unsubscribeProjectName();
assert.equal(projectNameEmissions, 1, "单次文档 action 只能发布一个 Zustand snapshot");
assert.equal(inconsistentProjectNameEmission, false, "订阅者不得观察到 selector/tabs 不一致");
console.log("  ✓ canonical selector 覆盖当前文档，且 action 原子发布一次");

useFlowStore.getState().openFlowTab({
  projectId: "selector-read-only",
  projectName: "Read only",
  nodes: [imageNode("selector-read-only-node", "Read only")],
  edges: [],
  readOnly: true,
});
assert.equal(selectActiveReadOnly(useFlowStore.getState()), true);
useFlowStore.getState().switchTab(stateA.activeTabId);
assert.equal(selectActiveReadOnly(useFlowStore.getState()), false);

useFlowStore.getState().createBlankTab();
const blankState = useFlowStore.getState();
const previousDocument = selectDocumentForTab(blankState, stateA.activeTabId);
assert.equal(previousDocument?.projectId, "selector-a");
assert.equal(previousDocument?.nodes[0]?.id, "selector-a-node");
assert.equal(selectActiveProjectId(blankState) === "selector-a", false);
assert.equal(selectHasDirtyTabs(blankState), true, "非活动页签的 dirty 仍必须被卸载保护感知");
console.log("  ✓ 切页后 selector 区分活动文档与非活动页签快照");

const printUrl = "/api/files/selector-print.png";
useFlowStore.getState().loadFlow({
  projectId: "selector-print-a",
  projectName: "Print source",
  nodes: [{
    id: "selector-print-node",
    type: "print-extract",
    position: { x: 0, y: 0 },
    data: {
      kind: "print-extract",
      label: "Print source",
      status: "success",
      prompt: "",
      outputImages: [printUrl],
      savedAsAssets: [],
      modelId: "grok-imagine-image",
      modelOptions: { aspectRatio: "1:1", resolution: "2k" },
    },
  }],
  edges: [],
});
const printSourceTabId = useFlowStore.getState().activeTabId;
let resolveAssetRequest: ((response: Pick<Response, "ok" | "status">) => void) | undefined;
const savePending = savePrintOutputAsAsset(
  {
    nodeId: "selector-print-node",
    nodeLabel: "Print source",
    url: printUrl,
    now: new Date("2026-08-25T01:02:03Z"),
  },
  async () => new Promise((resolve) => {
    resolveAssetRequest = resolve;
  }),
);
assert.ok(resolveAssetRequest, "素材请求应在函数返回前启动");
useFlowStore.getState().createBlankTab();
const destinationTabId = useFlowStore.getState().activeTabId;
resolveAssetRequest({ ok: true, status: 201 });
await savePending;

const postSaveState = useFlowStore.getState();
const printSource = selectDocumentForTab(postSaveState, printSourceTabId);
const destination = selectDocumentForTab(postSaveState, destinationTabId);
const savedPrint = printSource?.nodes.find((node) => node.id === "selector-print-node")?.data;
assert.equal(savedPrint?.kind, "print-extract");
assert.deepEqual(savedPrint?.kind === "print-extract" ? savedPrint.savedAsAssets : [], [printUrl]);
assert.equal(destination?.nodes.some((node) => node.id === "selector-print-node"), false);
assert.equal(postSaveState.activeTabId, destinationTabId);
console.log("  ✓ 异步素材保存在切页后仍定向回写发起命令的原页签");

useFlowStore.getState().loadFlow({
  projectId: "selector-replaced-print-a",
  projectName: "Replaced print source",
  nodes: [{
    id: "selector-replaced-print-node",
    type: "print-extract",
    position: { x: 0, y: 0 },
    data: {
      kind: "print-extract",
      label: "Old print source",
      status: "success",
      prompt: "",
      outputImages: [printUrl],
      savedAsAssets: [],
      modelId: "grok-imagine-image",
      modelOptions: { aspectRatio: "1:1", resolution: "2k" },
    },
  }],
  edges: [],
});
let resolveReplacedAsset: ((response: Pick<Response, "ok" | "status">) => void) | undefined;
const staleAssetSave = savePrintOutputAsAsset(
  {
    nodeId: "selector-replaced-print-node",
    nodeLabel: "Old print source",
    url: printUrl,
  },
  async () => new Promise((resolve) => {
    resolveReplacedAsset = resolve;
  }),
);
assert.ok(resolveReplacedAsset);
useFlowStore.getState().loadFlow({
  projectId: "selector-replaced-print-b",
  projectName: "Replacement document",
  nodes: [imageNode("selector-replaced-print-node", "Replacement node")],
  edges: [],
});
resolveReplacedAsset({ ok: true, status: 201 });
await assert.rejects(staleAssetSave, /原节点所在项目已关闭/);
const replacementDocument = selectActiveDocument(useFlowStore.getState());
assert.equal(replacementDocument.projectId, "selector-replaced-print-b");
assert.equal(replacementDocument.nodes[0].data.label, "Replacement node");
console.log("  ✓ 同页签换项目后旧素材响应被 documentEpoch 拦截");

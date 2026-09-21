import assert from "node:assert/strict";
import {
  createDocumentSnapshot,
  documentSnapshotToPersistedWorkflow,
} from "../src/lib/documentSnapshot";
import { validateAndMigrateFlow, WorkflowValidationError } from "../server/lib/workflowSchema";
import {
  readTabSessionSnapshot,
  selectActiveDocument,
  TAB_SESSION_SCHEMA_VERSION,
  useFlowStore,
  writeTabSessionSnapshot,
} from "../src/store/flowStore";
import { WORKFLOW_SCHEMA_VERSION } from "../src/types/workflow";

console.log("TiAngelNode 持久化与 Schema 测试");

const angle = {
  version: 1,
  enabled: true,
  azimuthDeg: 45,
  elevationDeg: 15,
  rollDeg: -10,
} as const;

const runtimeNode = {
  id: "view-angle",
  type: "ti-angle",
  position: { x: 100, y: 200 },
  selected: true,
  width: 320,
  data: {
    kind: "ti-angle",
    label: "3D 视角",
    status: "running",
    error: "transient",
    angle,
    collapsed: false,
    compiledText: "不得进入文档",
    renderer: {},
  },
} as unknown as Parameters<typeof createDocumentSnapshot>[0]["nodes"][number];

const snapshot = createDocumentSnapshot({
  projectName: "TiAngelNode persistence",
  nodes: [runtimeNode],
  edges: [],
});
assert.deepEqual(snapshot.nodes[0]?.data, {
  kind: "ti-angle",
  label: "3D 视角",
  angle,
});

const snapshotWithNestedRuntimeField = createDocumentSnapshot({
  projectName: "TiAngelNode persistence",
  nodes: [{
    ...runtimeNode,
    data: {
      ...runtimeNode.data,
      angle: {
        ...angle,
        dragState: { pointerId: 7, active: true },
      },
    },
  }],
  edges: [],
});
assert.deepEqual(
  snapshotWithNestedRuntimeField.nodes[0]?.data,
  { kind: "ti-angle", label: "3D 视角", angle },
  "角度配置的运行时扩展字段也不得穿透严格文档快照",
);

const sessionValues = new Map<string, string>();
const sessionStorage = {
  getItem: (key: string) => sessionValues.get(key) ?? null,
  setItem: (key: string, value: string) => { sessionValues.set(key, value); },
  removeItem: (key: string) => { sessionValues.delete(key); },
  key: (index: number) => [...sessionValues.keys()][index] ?? null,
  get length() { return sessionValues.size; },
};
useFlowStore.getState().loadFlow({
  projectId: "ti-angle-draft",
  projectName: "TiAngelNode draft",
  nodes: [{
    ...runtimeNode,
    data: {
      ...runtimeNode.data,
      angle: {
        ...angle,
        dragState: { pointerId: 11, active: true },
      },
    },
  } as never],
  edges: [],
  markDirty: true,
});
const draftTab = selectActiveDocument(useFlowStore.getState());
assert.equal(
  writeTabSessionSnapshot(sessionStorage, {
    schemaVersion: TAB_SESSION_SCHEMA_VERSION,
    tabs: [draftTab],
    activeTabId: draftTab.id,
  }).ok,
  true,
);
const serializedDraft = [...sessionValues.values()].join("\n");
assert.doesNotMatch(serializedDraft, /dragState|compiledText|collapsed|renderer/);
const restoredDraft = readTabSessionSnapshot(sessionStorage);
assert.ok(restoredDraft);
const restoredDraftNode = restoredDraft.tabs[0]?.nodes[0];
assert.deepEqual(
  restoredDraftNode?.data.kind === "ti-angle" ? restoredDraftNode.data.angle : undefined,
  angle,
  "草稿写入再读取后应保留角度协议字段",
);
assert.equal(
  restoredDraftNode && "collapsed" in restoredDraftNode.data,
  false,
  "草稿恢复不得恢复折叠运行态",
);

const persisted = documentSnapshotToPersistedWorkflow(snapshot);
assert.equal(persisted.schemaVersion, WORKFLOW_SCHEMA_VERSION);
assert.deepEqual(persisted.nodes[0]?.data, {
  kind: "ti-angle",
  label: "3D 视角",
  angle,
  status: "idle",
});

const validated = validateAndMigrateFlow(persisted);
assert.deepEqual(validated.nodes[0]?.data, persisted.nodes[0]?.data);
assert.equal(validated.nodes[0]?.position.x, 100);

assert.throws(
  () => validateAndMigrateFlow({
    ...persisted,
    nodes: [{
      ...persisted.nodes[0],
      data: { ...persisted.nodes[0]?.data, angle: { ...angle, rollDeg: 31 } },
    }],
  }),
  (error: unknown) => error instanceof WorkflowValidationError && /rollDeg/.test(error.message),
);

useFlowStore.getState().loadFlow({
  projectId: "ti-angle-default",
  projectName: "TiAngelNode default",
  nodes: [],
  edges: [],
});
const createdId = useFlowStore.getState().addNode("ti-angle", { x: 0, y: 0 });
assert.ok(createdId);
const created = selectActiveDocument(useFlowStore.getState()).nodes.find((node) => node.id === createdId);
assert.equal(created?.data.kind, "ti-angle");
assert.deepEqual(created?.data.kind === "ti-angle" ? created.data.angle : undefined, {
  version: 1,
  enabled: false,
  azimuthDeg: 0,
  elevationDeg: 0,
  rollDeg: 0,
});
assert.equal(created?.data.kind === "ti-angle" && "collapsed" in created.data, false);

console.log("通过 TiAngelNode 快照、Schema、默认数据与非法角度校验");

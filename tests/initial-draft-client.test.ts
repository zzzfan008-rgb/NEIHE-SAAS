import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { ProjectTab, ServerInitialDraftSnapshot } from "../src/store/flowStore";
import {
  applyServerInitialDraftToTab,
  createFreshLocalTabForInitialDraft,
  isPristineProjectTab,
  normalizeTabSessionValue,
  persistedWorkflowForProjectTab,
  projectTabLifecycle,
  selectActiveDocument,
  useFlowStore,
} from "../src/store/flowStore";
import {
  bootstrapNeedsFreshProjectIdentity,
  decideInitialDraftStartup,
  selectLocalInitialDraftCandidate,
  shouldRestoreSavedProjectOnStartup,
} from "../src/initialDraft/initialDraftMigration";
import { settleInitialDraftBeforeAbandon } from "../src/initialDraft/InitialDraftWorkspace";
import {
  copyProjectScopedMasks,
  fetchSavedProject,
  fetchSavedProjects,
  isServerInitialDraftPristine,
  parseInitialDraft,
  syncInitialDraft,
} from "../src/initialDraft/initialDraftClient";
import {
  registerInitialDraftSaveBarrier,
  waitForInitialDraftSyncBeforeFormalSave,
} from "../src/initialDraft/initialDraftRuntime";
import { inferTemplateLaunchMode } from "../src/lib/templateLaunch";
import type { WorkflowTemplate } from "../src/types/workflow";

function tab(overrides: Partial<ProjectTab> = {}): ProjectTab {
  return {
    id: "tab-local",
    projectId: "project-local",
    projectName: "未命名设计项目",
    readOnly: false,
    nodes: [{
      id: "starter",
      type: "image-input",
      position: { x: 0, y: 0 },
      data: { kind: "image-input", label: "上传服装图", status: "idle", imageRole: "default" },
    }],
    edges: [],
    selectedNodeIds: [],
    selectedNodeId: null,
    selectedResultId: null,
    compareIds: [],
    saveState: "idle",
    hasBeenPersisted: false,
    revision: 0,
    savedRevision: 0,
    dirty: false,
    documentEpoch: 0,
    lifecycle: "local",
    ...overrides,
  };
}

function draft(overrides: Partial<ServerInitialDraftSnapshot> = {}): ServerInitialDraftSnapshot {
  const source = tab({
    projectId: "draft-server",
    projectName: "未修改项目名称20260826000000",
  });
  return {
    id: "draft-server",
    name: "未修改项目名称20260826000000",
    flow: persistedWorkflowForProjectTab(source),
    revision: 0,
    lifecycle: "initial_draft",
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

console.log("初始项目客户端测试");

const placeholder = tab();
const editedLegacy = tab({ projectName: "本机设计", dirty: true, revision: 2 });
assert.equal(decideInitialDraftStartup(placeholder, editedLegacy, null).kind, "bootstrap-local");
assert.equal(
  bootstrapNeedsFreshProjectIdentity(decideInitialDraftStartup(placeholder, editedLegacy, null)),
  false,
);
console.log("  ✓ 首次接入会迁移已有本机未保存内容");

const staleInitialDraft = tab({
  projectId: "retired-draft-id",
  lifecycle: "initial_draft",
  dirty: true,
  revision: 3,
  draftRevision: 2,
  draftSyncedRevision: 2,
});
const staleDecision = decideInitialDraftStartup(placeholder, staleInitialDraft, null);
assert.equal(staleDecision.kind, "bootstrap-local");
assert.equal(bootstrapNeedsFreshProjectIdentity(staleDecision), true);
console.log("  ✓ 其他页签已保存或放弃的旧草稿会保留内容但分配新项目 ID");

const serverOnly = draft();
assert.equal(decideInitialDraftStartup(placeholder, null, serverOnly).kind, "restore-server");
console.log("  ✓ 新标签页和重新登录会恢复同一份云端初始项目");

assert.equal(shouldRestoreSavedProjectOnStartup(null, null, 1), true);
assert.equal(shouldRestoreSavedProjectOnStartup(null, serverOnly, 1), true);
assert.equal(shouldRestoreSavedProjectOnStartup(null, { ...serverOnly, name: "已修改草稿" }, 1), false);
assert.equal(shouldRestoreSavedProjectOnStartup(editedLegacy, null, 1), false);
assert.equal(shouldRestoreSavedProjectOnStartup(null, null, 0), false);
console.log("  ✓ 已有正式项目时优先恢复最近项目，未保存草稿仍优先保留");

assert.equal(decideInitialDraftStartup(placeholder, editedLegacy, serverOnly).kind, "sync-local");
console.log("  ✓ 空白云端草稿允许一次性接管可信旧本机修改");

const changedServer = draft({ revision: 3, name: "云端也修改过" });
assert.equal(decideInitialDraftStartup(placeholder, editedLegacy, changedServer).kind, "conflict");
console.log("  ✓ 本机与云端同时修改时必须进入显式冲突选择");

const markedLocal = tab({
  projectId: changedServer.id,
  projectName: "本机继续修改",
  lifecycle: "initial_draft",
  revision: 5,
  draftSyncedRevision: 4,
  draftRevision: changedServer.revision,
});
assert.equal(decideInitialDraftStartup(placeholder, markedLocal, changedServer).kind, "sync-local");
assert.equal(
  decideInitialDraftStartup(
    placeholder,
    { ...markedLocal, revision: 4, draftSyncedRevision: 4 },
    changedServer,
  ).kind,
  "restore-server",
);
console.log("  ✓ 同一草稿按 revision 判定续传或恢复，不会静默覆盖");

assert.equal(selectLocalInitialDraftCandidate([editedLegacy], editedLegacy.id, false), null);
assert.equal(selectLocalInitialDraftCandidate([editedLegacy], editedLegacy.id, true)?.id, editedLegacy.id);
console.log("  ✓ 只有确认当前账号后才读取本机会话草稿");

const dynamicPristine = tab({
  projectId: serverOnly.id,
  projectName: "未修改项目名称20260825000000",
  lifecycle: "initial_draft",
  draftRevision: 0,
  draftSyncedRevision: 0,
});
assert.equal(isPristineProjectTab(dynamicPristine), true);
assert.equal(isServerInitialDraftPristine(serverOnly), true);
assert.equal(isServerInitialDraftPristine({ ...serverOnly, name: "未修改项目名称20260827000000" }), true);
console.log("  ✓ 动态默认名称跨日期保持原名称且仍可识别为空白初始项目");

const normalized = normalizeTabSessionValue({
  activeTabId: dynamicPristine.id,
  tabs: [dynamicPristine],
});
assert.ok(normalized);
assert.equal(normalized.tabs[0].lifecycle, "initial_draft");
assert.equal(normalized.tabs[0].draftRevision, 0);
assert.equal(normalized.tabs[0].draftSyncedRevision, 0);
console.log("  ✓ 刷新会话保留初始项目身份与同步版本");

assert.equal(parseInitialDraft(serverOnly).id, serverOnly.id);
assert.throws(() => parseInitialDraft({ ...serverOnly, revision: -1 }), /响应格式无效/);
console.log("  ✓ 客户端拒绝无效草稿响应");

const originalFetch = globalThis.fetch;
let requestBody: Record<string, unknown> | null = null;
globalThis.fetch = async (_input, init) => {
  requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
  return new Response(JSON.stringify({ draft: { ...serverOnly, revision: 8 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
try {
  const synced = await syncInitialDraft({
    id: serverOnly.id,
    expectedRevision: 7,
    name: serverOnly.name,
    flow: serverOnly.flow,
  });
  assert.equal(requestBody?.expectedRevision, 7);
  assert.equal(synced.revision, 8);
} finally {
  globalThis.fetch = originalFetch;
}
console.log("  ✓ 自动同步携带乐观锁版本");

const projectFlow = persistedWorkflowForProjectTab(tab({ projectId: "saved-project" }));
globalThis.fetch = async (input) => {
  if (String(input) === "/api/projects") {
    return Response.json([{
      id: "saved-project",
      name: "最近正式项目",
      updatedAt: "2026-08-27T00:00:00.000Z",
    }]);
  }
  return Response.json({
    id: "saved-project",
    name: "最近正式项目",
    updatedAt: "2026-08-27T00:00:00.000Z",
    flow: projectFlow,
  });
};
try {
  const savedProjects = await fetchSavedProjects();
  assert.equal(savedProjects[0]?.id, "saved-project");
  const savedProject = await fetchSavedProject("saved-project");
  assert.equal(savedProject.flow.schemaVersion, projectFlow.schemaVersion);
} finally {
  globalThis.fetch = originalFetch;
}
console.log("  ✓ 登录恢复可读取最近正式项目及完整画布");

const maskLocal = tab({
  projectId: "mask-source-project",
  nodes: [{
    id: "mask-node",
    type: "mask-redraw",
    position: { x: 0, y: 0 },
    data: {
      kind: "mask-redraw",
      label: "局部重绘",
      status: "idle",
      modelId: "gpt-image-2",
      modelOptions: {},
      prompt: "改色",
      mask: "/api/files/source-mask.png",
      outputImages: [],
    },
  }],
});
const maskFlow = persistedWorkflowForProjectTab(maskLocal);
let maskCopyPayload: Record<string, unknown> | null = null;
globalThis.fetch = async (_input, init) => {
  maskCopyPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
  return Response.json({
    targetProjectId: "mask-target-project",
    masks: [{
      sourceUrl: "/api/files/source-mask.png",
      targetUrl: "/api/files/copied-mask.png",
      nodeId: "mask-node",
    }],
  });
};
try {
  const copied = await copyProjectScopedMasks({
    sourceProjectId: "mask-source-project",
    targetProjectId: "mask-target-project",
    flow: maskFlow,
  });
  assert.equal(maskCopyPayload?.sourceProjectId, "mask-source-project");
  assert.equal(maskCopyPayload?.targetProjectId, "mask-target-project");
  assert.deepEqual(maskCopyPayload?.masks, [{ fileId: "source-mask.png", nodeId: "mask-node" }]);
  assert.equal(copied.targetProjectId, "mask-target-project");
  assert.equal(copied.flow.nodes[0].data.kind, "mask-redraw");
  if (copied.flow.nodes[0].data.kind !== "mask-redraw") throw new Error("unexpected node kind");
  assert.equal(copied.flow.nodes[0].data.mask, "/api/files/copied-mask.png");
} finally {
  globalThis.fetch = originalFetch;
}
console.log("  ✓ 项目身份变化会复制并改写项目级蒙版引用");

let sameProjectFetchCalls = 0;
globalThis.fetch = async () => {
  sameProjectFetchCalls += 1;
  throw new Error("同项目蒙版同步不应发起复制请求");
};
try {
  const unchanged = await copyProjectScopedMasks({
    sourceProjectId: "same-draft-project",
    targetProjectId: "same-draft-project",
    flow: maskFlow,
  });
  assert.equal(sameProjectFetchCalls, 0);
  assert.equal(unchanged.targetProjectId, "same-draft-project");
  assert.equal(unchanged.flow, maskFlow);
} finally {
  globalThis.fetch = originalFetch;
}
console.log("  ✓ 同一初始草稿的未同步修改保留蒙版且不发起复制请求");

let freshCopyPayload: Record<string, unknown> | null = null;
globalThis.fetch = async (_input, init) => {
  freshCopyPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
  return Response.json({
    targetProjectId: "server-issued-backup",
    masks: [{
      sourceUrl: "/api/files/source-mask.png",
      targetUrl: "/api/files/fresh-mask.png",
      nodeId: "mask-node",
    }],
  });
};
try {
  const copied = await copyProjectScopedMasks({
    sourceProjectId: "mask-source-project",
    createFreshTarget: true,
    flow: maskFlow,
  });
  assert.equal(freshCopyPayload?.createTarget, true);
  assert.equal(freshCopyPayload?.targetProjectId, undefined);
  assert.equal(copied.targetProjectId, "server-issued-backup");
} finally {
  globalThis.fetch = originalFetch;
}
console.log("  ✓ 本机备份的目标项目 ID 由服务端分配，不能探测任意项目 ID");

let abandonSnapshot = tab({
  id: "abandon-tab",
  projectId: "abandon-draft",
  lifecycle: "initial_draft",
  revision: 4,
  draftSyncedRevision: 2,
  draftRevision: 1,
});
let abandonSyncCalls = 0;
const settledForAbandon = await settleInitialDraftBeforeAbandon(
  abandonSnapshot.id,
  () => abandonSnapshot,
  async (latest) => {
    abandonSyncCalls += 1;
    abandonSnapshot = {
      ...latest,
      draftSyncedRevision: latest.revision,
      draftRevision: (latest.draftRevision ?? 0) + 1,
    };
    return true;
  },
  () => false,
);
assert.equal(abandonSyncCalls, 1);
assert.equal(settledForAbandon?.draftSyncedRevision, 4);
assert.equal(settledForAbandon?.draftRevision, 2);
assert.equal(await settleInitialDraftBeforeAbandon(
  abandonSnapshot.id,
  () => abandonSnapshot,
  async () => false,
  () => false,
), abandonSnapshot);
console.log("  ✓ 放弃草稿前会收口最新编辑并使用同步后的 revision");

let barrierCalls = 0;
const unregisterBarrier = registerInitialDraftSaveBarrier(async (target) => {
  barrierCalls += 1;
  assert.equal(target.projectId, serverOnly.id);
});
await waitForInitialDraftSyncBeforeFormalSave({
  tabId: "tab-server",
  projectId: serverOnly.id,
  documentEpoch: 0,
});
unregisterBarrier();
await waitForInitialDraftSyncBeforeFormalSave({
  tabId: "tab-server",
  projectId: serverOnly.id,
  documentEpoch: 0,
});
assert.equal(barrierCalls, 1);
console.log("  ✓ 正式保存会等待已注册的初始草稿同步屏障");

const formalDraft = draft({ revision: 5, name: "保存边界草稿" });
const activeBeforeFormalSave = selectActiveDocument(useFlowStore.getState());
assert.equal(applyServerInitialDraftToTab(activeBeforeFormalSave.id, formalDraft, {
  dirty: true,
  localDocumentRevision: 1,
}), true);
let formalSavePayload: Record<string, unknown> | null = null;
globalThis.fetch = async (_input, init) => {
  formalSavePayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
  return Response.json({ error: "forced failure" }, { status: 503 });
};
try {
  assert.equal(await useFlowStore.getState().saveProject(), false);
  const failed = selectActiveDocument(useFlowStore.getState());
  assert.equal(projectTabLifecycle(failed), "initial_draft");
  assert.equal(failed.projectId, formalDraft.id);
  assert.equal(failed.draftRevision, formalDraft.revision);

  globalThis.fetch = async (_input, init) => {
    formalSavePayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ ok: true });
  };
  assert.equal(await useFlowStore.getState().saveProject(), true);
  const saved = selectActiveDocument(useFlowStore.getState());
  assert.equal(formalSavePayload?.expectedDraftRevision, formalDraft.revision);
  assert.equal(saved.projectId, formalDraft.id);
  assert.equal(projectTabLifecycle(saved), "saved");
} finally {
  globalThis.fetch = originalFetch;
}
console.log("  ✓ 正式保存失败保留初始草稿，成功才以同一 ID 原子提升");

const conflictLocal = tab({
  ...maskLocal,
  id: "conflict-local-tab",
  projectId: "conflict-draft",
  lifecycle: "initial_draft",
  dirty: true,
  revision: 3,
  draftRevision: 1,
  draftSyncedRevision: 1,
});
useFlowStore.setState({ tabs: [conflictLocal], activeTabId: conflictLocal.id, viewer: null });
const copiedBackupFlow = {
  ...persistedWorkflowForProjectTab(conflictLocal),
  nodes: persistedWorkflowForProjectTab(conflictLocal).nodes.map((node) => node.data.kind === "mask-redraw"
    ? { ...node, data: { ...node.data, mask: "/api/files/backup-mask.png" } }
    : node),
};
assert.equal(applyServerInitialDraftToTab(conflictLocal.id, draft({ id: "conflict-draft" }), {
  preserveReplacedAsBackup: { projectId: "backup-project", flow: copiedBackupFlow },
}), true);
const backup = useFlowStore.getState().tabs.find((candidate) => candidate.projectId === "backup-project");
assert.ok(backup);
assert.equal(projectTabLifecycle(backup), "local");
assert.equal(backup.nodes[0].data.kind, "mask-redraw");
if (backup.nodes[0].data.kind !== "mask-redraw") throw new Error("unexpected backup node kind");
assert.equal(backup.nodes[0].data.mask, "/api/files/backup-mask.png");
console.log("  ✓ 采用云端冲突版本时，本机备份使用独立项目 ID 与复制后的蒙版");

const savedPlaceholder = tab({
  id: "saved-placeholder-tab",
  projectId: "saved-placeholder-project",
  lifecycle: "saved",
  hasBeenPersisted: true,
  saveState: "saved",
});
useFlowStore.setState({ tabs: [savedPlaceholder], activeTabId: savedPlaceholder.id, viewer: null });
const freshInitial = createFreshLocalTabForInitialDraft(savedPlaceholder.id);
assert.ok(freshInitial);
assert.notEqual(freshInitial.projectId, savedPlaceholder.projectId);
assert.ok(useFlowStore.getState().tabs.some((candidate) => candidate.id === savedPlaceholder.id));
assert.equal(useFlowStore.getState().activeTabId, freshInitial.id);
console.log("  ✓ 服务器无草稿时为初始项目分配新 ID，且不覆盖已保存页签");

const projectTabsSource = readFileSync(
  new URL("../src/components/panels/ProjectTabs.tsx", import.meta.url),
  "utf8",
);
assert.match(projectTabsSource, /唯一的未保存初始项目/);
assert.match(projectTabsSource, /再次确认放弃/);
assert.match(projectTabsSource, /await abandon\(latestTab\.id\)/);
console.log("  ✓ 放弃初始项目必须经过两次确认并调用专用放弃流程");

const flowStoreSource = readFileSync(
  new URL("../src/store/flowStore.ts", import.meta.url),
  "utf8",
);
assert.match(flowStoreSource, /tab\.draftRevision \?\? ""/);
assert.match(flowStoreSource, /tab\.draftSyncedRevision \?\? ""/);
assert.match(flowStoreSource, /tab\.draftCreatedAt \?\? ""/);
console.log("  ✓ 云端同步元数据变化会触发本机会话分片持久化");

const taskLauncherSource = readFileSync(
  new URL("../src/components/TaskLauncher.tsx", import.meta.url),
  "utf8",
);
const templateLaunchSource = readFileSync(
  new URL("../src/lib/templateLaunch.ts", import.meta.url),
  "utf8",
);
const templatePresentationSource = readFileSync(
  new URL("../src/lib/templatePresentation.ts", import.meta.url),
  "utf8",
);
function launchModeTemplate(kinds: string[]): Pick<WorkflowTemplate, "flow"> {
  return {
    flow: {
      nodes: kinds.map((kind, index) => ({ id: `node-${index}`, data: { kind } })),
      edges: [],
    },
  } as unknown as Pick<WorkflowTemplate, "flow">;
}
assert.equal(inferTemplateLaunchMode(launchModeTemplate(["image-input"])), "upload");
assert.equal(inferTemplateLaunchMode(launchModeTemplate(["sketch-to-render"])), "text");
assert.equal(inferTemplateLaunchMode(launchModeTemplate(["result"])), "default");
assert.match(taskLauncherSource, /inferTemplateLaunchMode\(template\)/);
for (const cover of [
  "pattern-style-transfer",
  "person-scene-transfer",
  "sketch-recolor",
  "sketch-upscale",
  "text-recolor",
  "text-to-image",
]) {
  assert.match(templatePresentationSource, new RegExp(`${cover}\\.webp`));
  assert.ok(existsSync(new URL(`../public/assets/project-center/templates/${cover}.webp`, import.meta.url)));
}
assert.doesNotMatch(templatePresentationSource, /project-center\/templates\/[^\n]+\.png/);
assert.match(taskLauncherSource, /launchStarterTemplate/);
assert.match(templateLaunchSource, /projectTabLifecycle\(active\) !== "initial_draft"/);
assert.match(templateLaunchSource, /commitDocumentMutation\(/);
assert.match(templateLaunchSource, /projectId: active\.projectId/);
console.log("  ✓ 首次任务复用唯一初始草稿 ID，并按模板类型落地到上传或文本输入");

import assert from "node:assert/strict";
import { createEmptyDrawingDocument } from "../src/components/drawing/drawingModel";
import {
  DrawingDraftStorageError,
  createDrawingDraftStore,
  createMemoryDrawingDraftBackend,
  drawingDraftKey,
  type DrawingRecoveryDraft,
} from "../src/lib/drawingDraftStore";

const base: DrawingRecoveryDraft = {
  ownerId: "owner-a",
  tabId: "tab-a",
  projectId: "project-a",
  documentEpoch: 2,
  nodeId: "board-a",
  baseContentRef: "content-1",
  baseContentHash: "hash-1",
  draftRevision: 3,
  document: createEmptyDrawingDocument(1024, 1024, "#FFFFFF"),
  updatedAt: "2026-09-03T08:00:00.000Z",
};

console.log("画板恢复草稿隔离测试");
assert.equal(drawingDraftKey(base), "owner-a\u0000tab-a\u0000project-a\u00002\u0000board-a");

const backend = createMemoryDrawingDraftBackend();
const store = createDrawingDraftStore(backend);
await store.save(base);
assert.equal((await store.findRecovery({
  ownerId: base.ownerId, tabId: base.tabId, projectId: base.projectId,
  documentEpoch: base.documentEpoch, nodeId: base.nodeId,
  baseContentRef: base.baseContentRef, baseContentHash: base.baseContentHash,
}))?.status, "matching");
assert.equal((await store.findRecovery({
  ownerId: base.ownerId, tabId: base.tabId, projectId: base.projectId,
  documentEpoch: base.documentEpoch, nodeId: base.nodeId,
  baseContentRef: "content-2", baseContentHash: "hash-2",
}))?.status, "base-mismatch");
assert.equal(await store.findRecovery({
  ownerId: base.ownerId, tabId: base.tabId, projectId: base.projectId,
  documentEpoch: 3, nodeId: base.nodeId,
  baseContentRef: base.baseContentRef, baseContentHash: base.baseContentHash,
}), null);
console.log("  ✓ owner/tab/project/epoch/node 精确分区并区分 base mismatch");

await store.save({ ...base, ownerId: "owner-b", tabId: "tab-b", projectId: "project-b" });
assert.equal((await store.listOwner("owner-a")).length, 1);
assert.equal((await store.listOwner("owner-b")).length, 1);
await store.clearOwner("owner-a");
assert.equal((await store.listOwner("owner-a")).length, 0);
assert.equal((await store.listOwner("owner-b")).length, 1);
console.log("  ✓ 登出只清理当前账号草稿，不枚举其他账号");

const quotaBackend = createMemoryDrawingDraftBackend({ failWrites: true });
const quotaStore = createDrawingDraftStore(quotaBackend);
await assert.rejects(() => quotaStore.save(base), DrawingDraftStorageError);
assert.equal((await store.listOwner("owner-b")).length, 1);
console.log("  ✓ 配额失败给出有界错误且不会删除现有恢复点");

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDocumentSnapshot, documentSnapshotToPersistedWorkflow } from "../src/lib/documentSnapshot";
import { conversationSourceForOutput, documentTargetsMatch } from "../src/lib/imageConversationInputs";
import { validateAndMigrateFlow } from "../server/lib/workflowSchema";

console.log("图片对话历史恢复与结果操作测试");

const source = conversationSourceForOutput({
  generationOutputId: "output-recovery-1",
  imageRef: "/api/files/recovery.png",
});
assert.deepEqual(source, {
  sourceRef: "generation-output/output-recovery-1",
  previewRef: "/api/files/recovery.png",
});

const snapshot = createDocumentSnapshot({
  projectName: "恢复测试",
  nodes: [{
    id: "image-result",
    type: "image-input",
    position: { x: 0, y: 0 },
    data: {
      kind: "image-input",
      label: "对话结果",
      imageRole: "default",
      imageUrl: "/api/files/recovery.png",
      imageConversationSourceRef: source!.sourceRef,
      imageConversationId: "conversation-recovery-1",
    },
  }],
  edges: [],
});
const persisted = documentSnapshotToPersistedWorkflow(snapshot);
const validated = validateAndMigrateFlow(persisted);
const persistedData = validated.nodes[0]?.data as Record<string, unknown>;
assert.equal(persistedData.imageConversationSourceRef, "generation-output/output-recovery-1");
assert.equal(persistedData.imageConversationId, "conversation-recovery-1");

assert.equal(documentTargetsMatch(
  { tabId: "tab-a", projectId: "project-a", documentEpoch: 4 },
  { tabId: "tab-a", projectId: "project-a", documentEpoch: 4 },
), true);
assert.equal(documentTargetsMatch(
  { tabId: "tab-a", projectId: "project-a", documentEpoch: 4 },
  { tabId: "tab-a", projectId: "project-b", documentEpoch: 4 },
), false);

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const panelSource = fs.readFileSync(path.resolve(testRoot, "../src/components/conversation/ConversationPanel.tsx"), "utf8");
const actionsSource = fs.readFileSync(path.resolve(testRoot, "../src/components/conversation/ConversationResultActions.tsx"), "utf8");
const flowStoreSource = fs.readFileSync(path.resolve(testRoot, "../src/store/flowStore.ts"), "utf8");
assert.match(panelSource, /openRequest/);
assert.match(panelSource, /resolveImageConversation/);
assert.match(panelSource, /imageConversationSourceRef/);
assert.match(actionsSource, /OPEN_COMPARE_EVENT/);
assert.match(actionsSource, /download=/);
assert.match(actionsSource, /addImageConversationResultNode/);
assert.match(flowStoreSource, /addImageConversationResultNode/);

console.log("图片对话历史恢复与结果操作测试通过");

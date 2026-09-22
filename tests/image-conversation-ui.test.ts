import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createImageConversationTargetState,
  getImageConversationTargetState,
  imageConversationTargetKey,
  useImageConversationStore,
} from "../src/store/imageConversationStore";
import type { ImageConversationView } from "../src/types/imageConversation";
import { imageConversationRecentResults, syncImageConversationResults } from "../src/lib/imageConversationResults";
import { useFlowStore } from "../src/store/flowStore";

console.log("图片对话前端状态与侧栏契约测试");

const target = { tabId: "tab-a", projectId: "project-a", documentEpoch: 3 } as const;
const otherEpoch = { ...target, documentEpoch: 4 } as const;
const otherProject = { ...target, projectId: "project-b" } as const;
assert.notEqual(imageConversationTargetKey(target), imageConversationTargetKey(otherEpoch));
assert.notEqual(imageConversationTargetKey(target), imageConversationTargetKey(otherProject));

useImageConversationStore.setState({ byTarget: {} });
const store = useImageConversationStore.getState();
store.ensureTarget(target);
store.updateDraft(target, "single", {
  prompt: "单图要求",
  inputs: [{ role: "base", ordinal: 0, sourceRef: "/api/files/base.png" }],
});
store.setMode(target, "fusion");
store.updateDraft(target, "fusion", {
  prompt: "融合要求",
  inputs: [
    { role: "base", ordinal: 0, sourceRef: "/api/files/fusion-base.png" },
    { role: "reference", ordinal: 1, sourceRef: "/api/files/fusion-ref.png" },
  ],
});
store.setSourcePreview(target, "asset/asset-1", "/api/files/asset-1.png");
const targetState = getImageConversationTargetState(useImageConversationStore.getState(), target);
assert.equal(targetState?.mode, "fusion");
assert.equal(targetState?.modeDrafts.single.prompt, "单图要求");
assert.equal(targetState?.modeDrafts.single.inputs.length, 1);
assert.equal(targetState?.modeDrafts.fusion.prompt, "融合要求");
assert.equal(targetState?.modeDrafts.mask.prompt, "");
assert.equal(targetState?.modeDrafts.single.parameters?.modelId, "gpt-image-2.5-sunburst");
assert.equal(targetState?.sourcePreviews["asset/asset-1"], "/api/files/asset-1.png");
assert.equal(Object.keys(useImageConversationStore.getState().byTarget).length, 1);
console.log("  ✓ tabId/projectId/documentEpoch 组成隔离键，三种模式草稿互不覆盖且默认参数只存在内存 Store");

store.setConversation(target, {
  id: "conversation-async-resolution",
  ownerId: "owner-a",
  projectId: target.projectId,
  sourceRef: "/api/files/base.png",
  sourceKind: "file",
  status: "active",
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
  sourcePreviews: {},
  rounds: [],
  outputs: [],
} satisfies ImageConversationView);
const resolvedDraftState = getImageConversationTargetState(useImageConversationStore.getState(), target);
assert.equal(resolvedDraftState?.modeDrafts.single.prompt, "单图要求");
assert.equal(resolvedDraftState?.modeDrafts.fusion.prompt, "融合要求");
assert.equal(resolvedDraftState?.draftDirty.single, true);
assert.equal(resolvedDraftState?.draftDirty.fusion, true);
console.log("  ✓ 异步建立图片对话时保留尚未提交的未绑定模式草稿");

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const storeSource = fs.readFileSync(path.resolve(testRoot, "../src/store/imageConversationStore.ts"), "utf8");
const clientSource = fs.readFileSync(path.resolve(testRoot, "../src/lib/imageConversationClient.ts"), "utf8");
const panelSource = fs.readFileSync(path.resolve(testRoot, "../src/components/conversation/ConversationPanel.tsx"), "utf8");
const composerSource = fs.readFileSync(path.resolve(testRoot, "../src/components/conversation/ConversationComposer.tsx"), "utf8");
const historySource = fs.readFileSync(path.resolve(testRoot, "../src/components/conversation/ConversationHistory.tsx"), "utf8");
const resultActionsSource = fs.readFileSync(
  path.resolve(testRoot, "../src/components/conversation/ConversationResultActions.tsx"),
  "utf8",
);
const overlayEventsSource = fs.readFileSync(path.resolve(testRoot, "../src/lib/overlayEvents.ts"), "utf8");

assert.match(storeSource, /DocumentTarget/);
assert.doesNotMatch(storeSource, /DocumentSnapshot|sessionStorage|localStorage|persist\(/);
assert.match(storeSource, /clarificationAnswers/);
assert.match(storeSource, /draftDirty/);
assert.match(clientSource, /target: DocumentTarget/);
assert.match(clientSource, /projectId: target\.projectId/);
assert.match(clientSource, /reconcileImageConversationRound/);
assert.match(clientSource, /startNew: true/);
assert.match(panelSource, /selectActiveDocumentTarget/);
assert.match(panelSource, /const target = useMemo\(\(\) => \(\{[\s\S]*selection\.tabId[\s\S]*selection\.projectId[\s\S]*selection\.documentEpoch/);
assert.match(panelSource, /const targetKey = imageConversationTargetKey\(target\)/);
assert.match(panelSource, /getDraftValidationError/);
assert.match(panelSource, /sourcePreviews/);
assert.match(panelSource, /buildConversationInputManifest/);
assert.match(panelSource, /mode: "conversation"/);
assert.match(panelSource, /clarificationRoundId/);
assert.match(panelSource, /restoreConversationDraft/);
assert.match(panelSource, /pendingBaseChange/);
assert.match(panelSource, /pendingSourceChoices/);
assert.match(panelSource, /pendingSourceSwitch/);
assert.match(panelSource, /MultiSourceChoiceState/);
assert.match(panelSource, /不会自动融合或发送生成请求/);
assert.match(panelSource, /切换并清空当前模式草稿/);
assert.match(panelSource, /开始新修改/);
assert.match(panelSource, /setInterval\(\(\) => void refresh\(\), 1500\)/);
assert.match(panelSource, /round\.status === "outcome_unknown"/);
assert.match(panelSource, /validateImageConversationParameters/);
assert.match(panelSource, /documentTargetsMatch/);
assert.match(panelSource, /uploadMaskDraft/);
assert.match(panelSource, /<MaskEditor/);
assert.match(composerSource, /event\.nativeEvent\.isComposing/);
assert.match(composerSource, /event\.metaKey[\s\S]*event\.ctrlKey/);
assert.match(composerSource, /Textarea/);
assert.match(composerSource, /澄清补充回答/);
assert.match(composerSource, /sourcePreviews\[input\.sourceRef\]/);
assert.match(composerSource, /onClick=\{onEditMask\}/);
assert.match(composerSource, /aspectRatioMode/);
assert.match(composerSource, /getImageConversationModelsForMode/);
assert.match(composerSource, /availableModels\.map/);
assert.match(composerSource, /xhigh/);
assert.match(composerSource, /capabilities\?\.sizes/);
assert.match(resultActionsSource, /作为参考/);
assert.match(resultActionsSource, /conversationSourceForOutput/);
assert.match(historySource, /ConversationResultActions/);
assert.match(historySource, /可能产生额外费用/);
assert.match(historySource, /核对结果/);
assert.match(historySource, /输入快照/);
assert.match(historySource, /sourcePreviews/);
assert.match(historySource, /maskRef/);
assert.match(historySource, /基于第 .*轮结果/);
assert.match(historySource, /Collapsible/);
assert.match(historySource, /本轮参数/);
assert.match(overlayEventsSource, /mode: "conversation"/);
assert.match(overlayEventsSource, /purpose: "base" \| "reference"/);
console.log("  ✓ 异步客户端和 UI 回写按 DocumentTarget 绑定，未进入 flowStore/DocumentSnapshot/sessionStorage，IME 与键盘边界已声明");

console.log("图片对话前端状态与侧栏契约测试通过");

const conversationA = resolvedDraftState!.conversation!;
const submittedDraft = structuredClone(resolvedDraftState!.modeDrafts.single);
store.setPendingSubmission(target, conversationA.id, {
  request: { clientRequestId: "retry-stable", mode: "single", inputManifest: submittedDraft.inputs, prompt: submittedDraft.prompt, parameters: submittedDraft.parameters! },
  draft: submittedDraft,
});
store.updateDraft(target, "single", { prompt: "等待响应期间的新编辑" });
store.markSubmitted(target, conversationA.id, submittedDraft);
assert.equal(getImageConversationTargetState(useImageConversationStore.getState(), target)?.draftDirty.single, true);
store.setConversation(target, { ...conversationA, id: "conversation-b" });
store.markSubmitted(target, conversationA.id, submittedDraft);
assert.equal(getImageConversationTargetState(useImageConversationStore.getState(), target)?.conversation?.id, "conversation-b");
store.setConversation(target, conversationA);
const preserved = getImageConversationTargetState(useImageConversationStore.getState(), target)!;
assert.equal(preserved.modeDrafts.single.prompt, "等待响应期间的新编辑");
assert.equal(preserved.draftDirty.single, true);
assert.equal(preserved.pendingSubmissions[conversationA.id].request.clientRequestId, "retry-stable");
assert.equal(preserved.pendingSubmissions[conversationA.id].request.prompt, submittedDraft.prompt);
store.markSubmitted(target, conversationA.id, preserved.modeDrafts.single);
assert.equal(getImageConversationTargetState(useImageConversationStore.getState(), target)?.draftDirty.single, false);
assert.equal(getImageConversationTargetState(useImageConversationStore.getState(), otherEpoch), undefined);
console.log("  ✓ 重试保留原请求快照与编号；迟到确认不会抹掉新编辑或切换对话");

const completed: ImageConversationView = {
  ...conversationA,
  rounds: [{
    id: "round-result", conversationId: conversationA.id, ownerId: conversationA.ownerId, projectId: target.projectId,
    ordinal: 1, clientRequestId: "round-request", mode: "single", sourceResultId: null,
    inputManifest: submittedDraft.inputs, prompt: "修改", parameters: { ...submittedDraft.parameters },
    effectiveRequirements: {}, incrementalRequirements: {}, maskRef: null, status: "succeeded",
    createdAt: conversationA.createdAt, updatedAt: conversationA.updatedAt, clarification: null,
    intents: [{ id: "intent-result", roundId: "round-result", conversationId: conversationA.id, ordinal: 1,
      label: "结果", instruction: "修改", requirements: {}, status: "succeeded",
      createdAt: conversationA.createdAt, updatedAt: conversationA.updatedAt,
      attempts: [{ id: "attempt-result", intentId: "intent-result", roundId: "round-result", conversationId: conversationA.id,
        attemptNumber: 1, clientRequestId: "attempt-request", generationRunId: "run-result", retryOfAttemptId: null,
        status: "succeeded", error: null, createdAt: conversationA.createdAt, updatedAt: conversationA.updatedAt }],
    }],
  }],
  outputs: [{ id: "conversation-output", roundId: "round-result", conversationId: conversationA.id, intentId: "intent-result",
    ownerId: conversationA.ownerId, projectId: target.projectId, generationOutputId: "output-result", imageRef: "/api/files/result.png",
    status: "ready", prompt: "修改", error: null, createdAt: conversationA.createdAt }],
};
const records = imageConversationRecentResults(completed);
assert.equal(records[0].id, "output-result");
assert.equal(records[0].runId, "run-result");
assert.equal(records[0].nodeId, "image-conversation-intent-result");
useFlowStore.setState({ recentResults: [] });
syncImageConversationResults(completed);
syncImageConversationResults(completed);
assert.equal(useFlowStore.getState().recentResults.length, 1);
assert.equal(useFlowStore.getState().recentResults[0].status, "success");
assert.equal(useFlowStore.getState().recentResults[0].image, "/api/files/result.png");
console.log("  ✓ 对话结果使用真实输出 ID 进入全局结果，重复同步不产生重复卡片");

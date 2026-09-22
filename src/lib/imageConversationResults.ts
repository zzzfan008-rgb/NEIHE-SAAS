import { recentResultsPatch, resumeRecentResults, trimRecentResults, useFlowStore, type RecentResult } from "@/store/flowStore";
import type { ImageConversationView } from "@/types/imageConversation";

/** Project conversation attempts into the existing global result/SSE contract. */
export function imageConversationRecentResults(conversation: ImageConversationView): RecentResult[] {
  return conversation.rounds.flatMap((round) => round.intents.flatMap((intent) => {
    const successfulAttempt = [...intent.attempts].reverse().find((attempt) => attempt.status === "succeeded");
    return intent.attempts.flatMap((attempt): RecentResult[] => {
      if (!attempt.generationRunId) return [];
      const outputs = attempt.id === successfulAttempt?.id
        ? conversation.outputs.filter((output) => output.intentId === intent.id && output.status === "ready" && output.imageRef)
        : [];
      const base: RecentResult = {
        id: attempt.generationRunId,
        runId: attempt.generationRunId,
        nodeId: `image-conversation-${intent.id}`,
        nodeLabel: `对话修改·${intent.label}`,
        kind: "image-conversation",
        projectId: conversation.projectId,
        ownerId: conversation.ownerId,
        image: "",
        prompt: intent.instruction,
        model: String(round.parameters.modelId ?? ""),
        parameters: round.parameters,
        referenceImages: round.inputManifest.map((input) => conversation.sourcePreviews[input.sourceRef] ?? input.sourceRef),
        startedAt: Date.parse(attempt.createdAt),
        status: attempt.status === "succeeded" ? "success" : attempt.status === "failed" ? "error" : attempt.status,
        error: attempt.error ?? undefined,
        requestedCount: 1,
      };
      return outputs.length ? outputs.map((output) => ({
        ...base,
        id: output.generationOutputId ?? output.id,
        image: output.imageRef!,
        status: "success" as const,
        finishedAt: Date.parse(attempt.updatedAt),
        successfulCount: 1,
      })) : [base];
    });
  }));
}

export function syncImageConversationResults(conversation: ImageConversationView): void {
  const incoming = imageConversationRecentResults(conversation);
  if (!incoming.length) return;
  const active = new Set(["queued", "running", "retry_wait", "cancel_requested"]);
  useFlowStore.setState((state) => {
    // SSE can be ahead of the conversation snapshot. Never replace a terminal
    // record with an older active snapshot or an image with an empty run card.
    const records = incoming.filter((record) => !state.recentResults.some((current) =>
      current.runId === record.runId && ((!active.has(current.status) && active.has(record.status)) || (current.image && !record.image))));
    const replacedRuns = new Set(records.map((record) => record.runId));
    return recentResultsPatch(state, trimRecentResults([
      ...records.map((record) => ({ ...state.recentResults.find((current) => current.id === record.id), ...record })),
      ...state.recentResults.filter((record) => !replacedRuns.has(record.runId)),
    ]));
  });
  resumeRecentResults(incoming);
}

import { Button } from "@/components/ui/button";
import { OPEN_COMPARE_EVENT } from "@/lib/overlayEvents";
import { conversationSourceForOutput, type ImageConversationSourceSelection } from "@/lib/imageConversationInputs";
import { requestCanvasLanding } from "@/lib/canvasLanding";
import {
  recentResultsPatch,
  selectActiveCompareIds,
  trimRecentResults,
  useFlowStore,
  type DocumentTarget,
  type RecentResult,
} from "@/store/flowStore";
import type { ImageConversationOutputView } from "@/types/imageConversation";

interface ConversationResultActionsProps {
  output: ImageConversationOutputView;
  target: DocumentTarget;
  onView: (imageRef: string) => void;
  onContinue: (selection: ImageConversationSourceSelection) => void;
  onAddReference: (selection: ImageConversationSourceSelection) => void;
}

export function ConversationResultActions({
  output,
  target,
  onView,
  onContinue,
  onAddReference,
}: ConversationResultActionsProps) {
  const compareIds = useFlowStore(selectActiveCompareIds);
  const recentResults = useFlowStore((state) => state.recentResults);
  const readOnly = useFlowStore((state) => (
    state.tabs.find((tab) => tab.id === target.tabId)?.readOnly ?? true
  ));
  if (!output.imageRef) return null;
  const source = conversationSourceForOutput(output);
  if (!source) return null;
  const selection = { ...source, label: "对话修改结果" } satisfies ImageConversationSourceSelection;
  const resultRecord = recentResults.find((record) => (
    (output.generationOutputId && record.id === output.generationOutputId) || record.image === output.imageRef
  ));
  const compareSelected = resultRecord ? compareIds.includes(resultRecord.id) : false;

  // Older outputs may have dropped out of the capped recentResults list; inject a transient
  // record so the compare overlay can still show them. It is trimmed with recentResults and
  // never persisted, so it disappears on the next reload.
  const ensureComparableRecord = (): RecentResult | undefined => {
    if (!output.imageRef) return undefined;
    const record: RecentResult = {
      id: output.generationOutputId ?? output.id,
      image: output.imageRef,
      nodeId: "image-conversation-result",
      nodeLabel: "对话修改结果",
      kind: "image-conversation",
      projectId: output.projectId,
      ownerId: output.ownerId,
      prompt: output.prompt ?? undefined,
      startedAt: Date.parse(output.createdAt),
      status: "success",
    };
    useFlowStore.setState((state) => recentResultsPatch(state, trimRecentResults([
      record,
      ...state.recentResults.filter((existing) => existing.id !== record.id),
    ])));
    return record;
  };

  const toggleCompare = () => {
    const record = resultRecord ?? ensureComparableRecord();
    if (!record) return;
    useFlowStore.getState().toggleCompareId(record.id);
    if (!compareSelected && compareIds.length >= 1) {
      window.dispatchEvent(new CustomEvent(OPEN_COMPARE_EVENT));
    }
  };

  const addToCanvas = () => {
    if (readOnly) return;
    const nodeId = useFlowStore.getState().addImageConversationResultNode(target, {
      name: "对话修改结果",
      image: output.imageRef!,
      sourceRef: source.sourceRef,
      conversationId: output.conversationId,
    });
    if (nodeId) requestCanvasLanding({ tabId: target.tabId, nodeId, fitView: false });
  };

  return (
    <div className="grid grid-cols-3 gap-1 p-1">
      <Button type="button" variant="ghost" size="xs" className="w-full min-w-0 justify-center" onClick={() => onView(output.imageRef!)}>
        查看
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="w-full min-w-0 justify-center"
        render={<a href={output.imageRef} download="garment-conversation-result.png">下载</a>}
      />
      <Button type="button" variant="ghost" size="xs" className="w-full min-w-0 justify-center" onClick={toggleCompare} aria-pressed={compareSelected}>
        {compareSelected ? "取消对比" : "对比"}
      </Button>
      <Button type="button" variant="ghost" size="xs" className="w-full min-w-0 justify-center" onClick={() => onContinue(selection)}>
        继续修改
      </Button>
      <Button type="button" variant="ghost" size="xs" className="w-full min-w-0 justify-center" onClick={() => onAddReference(selection)}>
        作为参考
      </Button>
      <Button type="button" variant="ghost" size="xs" className="w-full min-w-0 justify-center" onClick={addToCanvas} disabled={readOnly}>
        加入画布
      </Button>
    </div>
  );
}

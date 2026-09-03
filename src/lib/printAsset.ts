import {
  appendSavedAsset,
  selectActiveDocumentTarget,
  selectDocumentForTab,
  useFlowStore,
} from "@/store/flowStore";

type AssetRequest = (
  input: string,
  init: RequestInit,
) => Promise<Pick<Response, "ok" | "status">>;

/**
 * Save a print output and route the asynchronous node write-back to the tab
 * that initiated the command, even when the user switches projects meanwhile.
 */
export async function savePrintOutputAsAsset(
  input: { nodeId: string; nodeLabel: string; url: string; now?: Date },
  request: AssetRequest = fetch,
): Promise<void> {
  const target = selectActiveDocumentTarget(useFlowStore.getState());
  const now = input.now ?? new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const name = `印花素材-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const response = await request("/api/assets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      category: "print",
      image: input.url,
      sourceNote: `来自节点「${input.nodeLabel}」`,
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const state = useFlowStore.getState();
  const document = selectDocumentForTab(state, target.tabId);
  const targetStillMatches = document?.projectId === target.projectId &&
    document.documentEpoch === target.documentEpoch;
  const latest = document?.nodes.find((node) => node.id === input.nodeId)?.data;
  if (!targetStillMatches || !latest || latest.kind !== "print-extract") {
    throw new Error("原节点所在项目已关闭，素材已保存但节点未回写");
  }
  state.updateNodeDataInTab(target, input.nodeId, {
    savedAsAssets: appendSavedAsset(latest.savedAsAssets, input.url),
  });
}

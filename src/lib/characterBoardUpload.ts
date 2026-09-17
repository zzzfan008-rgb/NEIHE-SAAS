import { useFlowStore, type DocumentTarget } from "../store/flowStore";
import { isNodeRunActive } from "../types/workflow";

/** Upload completion belongs to its initiating document, never the currently visible tab. */
export async function uploadCharacterBoardSource(
  target: DocumentTarget, nodeId: string, image: string, name: string, fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const document = () => useFlowStore.getState().tabs.find((tab) =>
    tab.id === target.tabId && tab.projectId === target.projectId && tab.documentEpoch === target.documentEpoch);
  const initial = document();
  const node = initial?.nodes.find((candidate) => candidate.id === nodeId);
  if (!initial || initial.readOnly || node?.data.kind !== "character-board" || isNodeRunActive(node.data.status)) return false;
  const originalSource = node.data.sourceImage;
  const response = await fetcher("/api/assets", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.replace(/\.[^.]+$/, "").slice(0, 180) || "人物板模特图", category: "upload", scope: "private", image, sourceNote: "来自人物板生成节点" }),
  });
  const body = await response.json();
  if (!response.ok || body?.normalized !== true || typeof body.url !== "string" || !/^\/api\/files\/[A-Za-z0-9_-]+\.(png|jpe?g|webp|gif)$/i.test(body.url)) {
    throw new Error(typeof body?.error === "string" ? body.error : "图片标准化失败，请重试");
  }
  const current = document()?.nodes.find((candidate) => candidate.id === nodeId);
  if (document()?.readOnly !== false || current?.data.kind !== "character-board" ||
      current.data.sourceImage !== originalSource || isNodeRunActive(current.data.status)) return false;
  useFlowStore.getState().updateNodeDataInTab(target, nodeId, {
    sourceImage: body.url, outputImages: [], status: "idle", error: undefined,
  });
  return true;
}

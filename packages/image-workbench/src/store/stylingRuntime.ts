import { create } from "zustand";
import { nanoid } from "nanoid";
import { orderedOutfitImages, stylingReferenceKey, stylingReferenceLimit } from "../lib/styling";
import { useFlowStore, type DocumentTarget, type ProjectTab } from "./flowStore";
import type { OutfitAnalysisRecord } from "../types/styling";
import { isNodeRunActive } from "../types/workflow";
import { stylingRequestVersion } from "./stylingRequestVersions";

interface AnalysisState { loading: boolean; record?: OutfitAnalysisRecord; error?: string }
export const useStylingRuntime = create<{ analyses: Record<string, AnalysisState> }>(() => ({ analyses: {} }));
const requests = new Map<string, Promise<void>>();
export function stylingRuntimeKey(target: DocumentTarget, nodeId: string): string {
  return JSON.stringify([target.tabId, target.projectId, target.documentEpoch, nodeId]);
}
export function stylingDocument(target: DocumentTarget): ProjectTab | undefined {
  return useFlowStore.getState().tabs.find((tab) => tab.id === target.tabId && tab.projectId === target.projectId && tab.documentEpoch === target.documentEpoch);
}
export function stylingInput(document: Pick<ProjectTab, "nodes" | "edges">, nodeId: string) {
  const edges = document.edges.filter((edge) => edge.target === nodeId);
  const source = edges.length === 1 ? document.nodes.find((node) => node.id === edges[0].source) : undefined;
  if (source?.data.kind !== "outfit-reference") return { sourceId: "", images: [] as string[], key: "" };
  const images = orderedOutfitImages(source.data);
  return { sourceId: source.id, images, key: stylingReferenceKey(source.id, images) };
}
function patchRuntime(key: string, state: AnalysisState) {
  useStylingRuntime.setState((current) => ({ analyses: { ...current.analyses, [key]: state } }));
}
export function validStylingAnalysis(target: DocumentTarget, nodeId: string): OutfitAnalysisRecord | undefined {
  const document = stylingDocument(target);
  if (!document) return;
  const node = document.nodes.find((candidate) => candidate.id === nodeId);
  if (node?.data.kind !== "ai-styling") return;
  const record = useStylingRuntime.getState().analyses[stylingRuntimeKey(target, nodeId)]?.record;
  const input = stylingInput(document, nodeId);
  if (record && record.id === node.data.analysisId && record.status === "succeeded" && record.result && !record.result.ambiguous &&
    record.result.categories.length > 0 && record.referenceFingerprint === node.data.referenceFingerprint &&
    stylingReferenceKey(record.sourceNodeId, record.images) === input.key) return record;
}
async function responseRecord(response: Response): Promise<OutfitAnalysisRecord> {
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : `识别服务 HTTP ${response.status}`);
  if (!value || typeof value.id !== "string" || typeof value.sourceNodeId !== "string" || !Array.isArray(value.images) ||
    !value.images.every((image: unknown) => typeof image === "string") || typeof value.referenceFingerprint !== "string" ||
    !["pending", "running", "succeeded", "failed", "outcome_unknown"].includes(value.status)) throw new Error("识别结果格式无效");
  if (value.status === "succeeded" && (!value.result || !Array.isArray(value.result.categories) ||
    !value.result.categories.every((item: unknown) => ["upper", "lower", "one-piece", "whole"].includes(String(item))) ||
    typeof value.result.description !== "string" || typeof value.result.ambiguous !== "boolean" ||
    typeof value.result.hasPerson !== "boolean" || typeof value.result.upperIsOuterwear !== "boolean" ||
    !value.result.existingExtras || !["outerwear", "shoes", "bag", "accessories", "hat"].every((key) => typeof value.result.existingExtras[key] === "boolean"))) {
    throw new Error("识别结果格式无效");
  }
  return value;
}
/** Recognition is explicit; remount only GETs a previously accepted request. */
export async function recognizeOutfit(target: DocumentTarget, nodeId: string, restore = false): Promise<void> {
  const key = stylingRuntimeKey(target, nodeId);
  const existing = requests.get(key);
  if (existing) return existing;
  const initial = stylingDocument(target);
  const node = initial?.nodes.find((candidate) => candidate.id === nodeId);
  if (!initial || initial.readOnly || node?.data.kind !== "ai-styling" || (!restore && isNodeRunActive(node.data.status))) return;
  if (restore && !node.data.analysisId) return;
  const analysisId = node.data.analysisId;
  const input = stylingInput(initial, nodeId);
  const inputVersion = stylingRequestVersion(target, nodeId);
  if (!input.images.length) return;
  const limit = stylingReferenceLimit(node.data.modelId, node.data.batchSize);
  if (input.images.length > limit) { patchRuntime(key, { loading: false, error: `当前模型最多支持 ${limit} 张参考图` }); return; }
  const stillCurrent = () => {
    const doc = stylingDocument(target);
    return doc && !doc.readOnly && stylingRequestVersion(target, nodeId) === inputVersion && doc.nodes.some((candidate) => candidate.id === nodeId && candidate.data.kind === "ai-styling") && stylingInput(doc, nodeId).key === input.key;
  };
  const task = (async () => {
    patchRuntime(key, { loading: true });
    try {
      let record: OutfitAnalysisRecord;
      if (restore) record = await responseRecord(await fetch(`/api/outfit-analysis/${encodeURIComponent(analysisId!)}`, { cache: "no-store" }));
      else {
        if (!await useFlowStore.getState().saveProjectInTab(target)) throw new Error("项目保存失败，请重试识别");
        if (!stillCurrent()) return;
        record = await responseRecord(await fetch("/api/outfit-analysis", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: target.projectId, nodeId, images: input.images, mainImage: input.images[0], clientRequestId: nanoid(16) }) }));
      }
      if (!stillCurrent()) return;
      if (stylingReferenceKey(record.sourceNodeId, record.images) !== input.key) throw new Error("参考图已变化，请重新识别");
      if (!restore) useFlowStore.getState().updateNodeDataInTab(target, nodeId, { analysisId: record.id, referenceFingerprint: record.referenceFingerprint, preserve: null });
      const deadline = Date.now() + 150_000;
      while (record.status === "pending" || record.status === "running") {
        if (Date.now() > deadline) throw new Error("识别状态同步超时，可点击识别服饰继续查询");
        patchRuntime(key, { loading: true, record });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!stillCurrent()) return;
        record = await responseRecord(await fetch(`/api/outfit-analysis/${encodeURIComponent(record.id)}`, { cache: "no-store" }));
      }
      if (!stillCurrent()) return;
      patchRuntime(key, { loading: false, record, error: record.error });
      if (!restore && record.status === "succeeded" && record.result && !record.result.ambiguous && record.result.categories.length === 1) {
        useFlowStore.getState().updateNodeDataInTab(target, nodeId, { preserve: record.result.categories[0] });
      }
    } catch (error) {
      if (stillCurrent()) patchRuntime(key, { loading: false, error: error instanceof Error ? error.message : "识别失败" });
    } finally {
      if (!stillCurrent()) patchRuntime(key, { loading: false });
    }
  })();
  requests.set(key, task);
  try { await task; } finally { if (requests.get(key) === task) requests.delete(key); }
}

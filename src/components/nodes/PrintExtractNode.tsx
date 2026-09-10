import { useState } from "react";
import { Position, type NodeProps, type Node } from "@xyflow/react";
import { NodeHandle as Handle } from "./NodeHandle";
import { useFlowStore } from "@/store/flowStore";
import { isNodeRunActive, type PrintExtractNodeData } from "@/types/workflow";
import { NodeFrame, RunButton, Developing, inputClass } from "./NodeFrame";
import { ImageGrid } from "./ImageGrid";
import { ModelControls } from "./ModelControls";
import { savePrintOutputAsAsset } from "@/lib/printAsset";
import { useCoalescedTextEdit } from "@/hooks/useCoalescedTextEdit";

export function PrintExtractNode({ id, data, selected }: NodeProps<Node<PrintExtractNodeData>>) {
  const runNode = useFlowStore((s) => s.runNode);
  const running = isNodeRunActive(data.status);
  const [savingUrl, setSavingUrl] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saved = data.savedAsAssets ?? [];
  const promptEdit = useCoalescedTextEdit(
    { kind: "node-data", nodeId: id, field: "prompt" },
    { multiline: true },
  );

  const saveAsAsset = async (url: string) => {
    setSavingUrl(url);
    setSaveError(null);
    try {
      await savePrintOutputAsAsset({ nodeId: id, nodeLabel: data.label, url });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingUrl(null);
    }
  };

  return (
    <>
      <Handle id="references" type="target" position={Position.Left} title="参考图" style={{ top: "38%" }} />
      <Handle id="prompt" type="target" position={Position.Left} title="提示词" style={{ top: "72%" }} />
      <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected}>
        <label className="block space-y-1">
          <span className="text-[10px] text-neutral-500">补充说明</span>
          <textarea
            value={data.prompt}
            {...promptEdit.bind}
            rows={3}
            placeholder='可选：如"只要胸前那朵花"'
            className={`${inputClass} resize-none`}
          />
          <span className="text-[9px] text-neutral-600">可连接 1–8 张参考图，按连线顺序传入</span>
        </label>
        <ModelControls nodeId={id} modelId={data.modelId} modelOptions={data.modelOptions} disabled={running} />
        <RunButton status={data.status} onClick={() => void runNode(id)} label="提取印花" />
        {running && <Developing />}
        <ImageGrid
          images={data.outputImages}
          renderAction={(url) => {
            const isSaved = saved.includes(url);
            return (
              <button
                type="button"
                disabled={isSaved || savingUrl === url}
                onClick={() => void saveAsAsset(url)}
                className={`w-full px-1.5 py-1 text-[10px] transition-colors ${
                  isSaved
                    ? "cursor-not-allowed text-gold/70"
                    : "text-neutral-400 hover:text-gold disabled:opacity-50"
                }`}
              >
                {isSaved ? "已存素材✓" : savingUrl === url ? "保存中…" : "存为素材"}
              </button>
            );
          }}
        />
        {saveError && (
          <p className="text-[10px] text-red-400">存素材失败：{saveError}</p>
        )}
      </NodeFrame>
      <Handle id="image" type="source" position={Position.Right} title="生成图片" />
    </>
  );
}

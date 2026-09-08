import { useEffect, useState } from "react";
import { LinkIcon } from "lucide-react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { selectActiveDocumentTarget, useFlowStore } from "@/store/flowStore";
import type { AudioInputNodeData } from "@/types/workflow";
import { MediaNodeActionToolbar } from "./NodeActionToolbar";
import { NodeFrame } from "./NodeFrame";

const validReference = (value: string) => /^https:\/\//i.test(value) || /^asset:\/\/[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);

export function AudioInputNode({ id, data, selected }: NodeProps<Node<AudioInputNodeData>>) {
  const updateNodeDataInTab = useFlowStore((state) => state.updateNodeDataInTab);
  const [draft, setDraft] = useState(data.audioUrl ?? "");

  useEffect(() => setDraft(data.audioUrl ?? ""), [data.audioUrl]);

  const applyReference = () => {
    const value = draft.trim();
    const target = selectActiveDocumentTarget(useFlowStore.getState());
    if (!validReference(value)) {
      updateNodeDataInTab(target, id, { status: "error", error: "请输入 HTTPS 或 asset:// 音频引用" });
      return;
    }
    updateNodeDataInTab(target, id, {
      audioUrl: value,
      mimeType: value.startsWith("asset://") ? undefined : data.mimeType,
      status: "success",
      error: undefined,
    });
  };

  return (
    <>
      <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected} toolbar={<MediaNodeActionToolbar nodeId={id} imageActions={false} />}>
        {data.audioUrl && !data.audioUrl.startsWith("asset://") && (
          <audio src={data.audioUrl} controls preload="metadata" className="nodrag w-full" />
        )}
        {data.audioUrl?.startsWith("asset://") && (
          <div className="rounded-md border border-[var(--gc-node-border)] bg-[var(--gc-node-inner)] px-2 py-2 text-[10px] text-[var(--gc-node-text)]">
            API易音频素材
          </div>
        )}
        <div className="flex gap-1">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                applyReference();
              }
            }}
            aria-label="音频公网地址或素材 ID"
            placeholder="https://… 或 asset://…"
            className="nodrag h-7 min-w-0 border-[var(--gc-node-border)] bg-[var(--gc-node-inner)] px-2 text-[10px] text-[var(--gc-node-text)]"
          />
          <Button type="button" variant="outline" size="icon-sm" aria-label="应用音频引用" onClick={applyReference} className="nodrag border-[var(--gc-node-border)] text-[var(--gc-node-text)]">
            <LinkIcon />
          </Button>
        </div>
      </NodeFrame>
      <Handle id="audio" type="source" position={Position.Right} title="音频输出" />
    </>
  );
}

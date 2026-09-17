import { useCallback, useRef, useState } from "react";
import { Position, type Node, type NodeProps } from "@xyflow/react";
import { NodeHandle as Handle } from "./NodeHandle";
import {
  useFlowStore,
  selectActiveDocumentTarget,
  selectActiveNodeInputImages,
  selectActiveReadOnly,
} from "@/store/flowStore";
import {
  isNodeRunActive,
  type BackgroundExtractNodeData,
} from "@/types/workflow";
import { NodeFrame, RunButton, Developing } from "./NodeFrame";
import { ImageGrid } from "./ImageGrid";
import { FilePickerButton, uploadFile } from "./ImageInputNode";
import { ModelControls } from "./ModelControls";

export function BackgroundExtractNode({
  id,
  data,
  selected,
}: NodeProps<Node<BackgroundExtractNodeData>>) {
  const runNode = useFlowStore((state) => state.runNode);
  const updateNodeDataInTab = useFlowStore(
    (state) => state.updateNodeDataInTab,
  );
  const connectedInputCount = useFlowStore(
    (state) => selectActiveNodeInputImages(state, id).length,
  );
  const readOnly = useFlowStore(selectActiveReadOnly);
  const running = isNodeRunActive(data.status);
  const inputCount = connectedInputCount + (data.imageUrl ? 1 : 0);
  const uploadRequestRef = useRef(0);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = useCallback(
    async (file: File | undefined | null) => {
      if (!file || !file.type.startsWith("image/") || readOnly || running || uploading) return;
      const requestId = ++uploadRequestRef.current;
      const target = selectActiveDocumentTarget(useFlowStore.getState());
      setUploading(true);
      try {
        const upload = await uploadFile(file, "来自提取背景节点");
        if (requestId !== uploadRequestRef.current) return;
        updateNodeDataInTab(target, id, {
          imageUrl: upload.url,
          status: "idle",
          error: undefined,
        });
      } catch (error) {
        if (requestId !== uploadRequestRef.current) return;
        updateNodeDataInTab(target, id, {
          status: "error",
          error:
            error instanceof Error
              ? error.message || "上传失败，请重试"
              : "上传失败，请重试",
        });
      } finally {
        if (requestId === uploadRequestRef.current) setUploading(false);
      }
    },
    [id, readOnly, running, uploading, updateNodeDataInTab],
  );

  return (
    <>
      <Handle
        id="references"
        type="target"
        position={Position.Left}
        title="待提取图片（上传一张或连接一张）"
        isConnectable={!readOnly}
      />
      <NodeFrame
        nodeId={id}
        title={data.label}
        status={data.status}
        error={data.error}
        selected={selected}
        missingInput={inputCount !== 1}
      >
        <p className="text-[10px] leading-relaxed text-[var(--gc-node-muted)]">
          上传或连接一张图片，移除人物和物体，仅保留原图背景。
        </p>
        <div
          className={`relative mt-2 overflow-hidden rounded-lg border ${dragOver ? "border-[var(--gc-node-accent)] bg-amber-50" : "border-[var(--gc-node-border)] bg-white"}`}
          onDragOver={(event) => {
            if (readOnly || running || uploading) return;
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            void handleFile(event.dataTransfer.files?.[0]);
          }}
        >
          {data.imageUrl ? (
            <div className="relative h-32">
              <img
                src={data.imageUrl}
                alt="待提取的原图"
                className="block h-full w-full select-none object-contain"
                draggable={false}
              />
              {uploading && (
                <div
                  role="status"
                  className="absolute inset-0 grid place-items-center bg-white/80 text-[10px] text-[var(--gc-node-muted)]"
                >
                  素材处理中…
                </div>
              )}
            </div>
          ) : (
            <div className="grid min-h-32 place-items-center px-3 py-4 text-center">
              <div>
                {!readOnly && (
                  <FilePickerButton
                    label={uploading ? "处理中…" : "上传原图"}
                    disabled={running || uploading}
                    onFile={(file) => void handleFile(file)}
                  />
                )}
                <p className="mt-2 text-[9px] leading-4 text-[var(--gc-node-muted)]">
                  {connectedInputCount > 0
                    ? "已连接上游图片"
                    : "支持拖拽图片到此处"}
                </p>
              </div>
            </div>
          )}
          {data.imageUrl && !readOnly && (
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2">
              <FilePickerButton
                label={uploading ? "处理中…" : "重新上传"}
                compact
                disabled={running || uploading}
                onFile={(file) => void handleFile(file)}
              />
            </div>
          )}
        </div>
        {inputCount === 0 && (
          <p className="mt-2 text-[10px] text-[var(--gc-node-muted)]">
            请上传或连接一张图片后再提取背景。
          </p>
        )}
        {inputCount > 1 && (
          <p className="mt-2 text-[10px] text-[var(--gc-node-muted)]">
            请只保留一张输入图片。
          </p>
        )}
        <ModelControls
          nodeId={id}
          modelId={data.modelId}
          modelOptions={data.modelOptions}
          disabled={readOnly || running}
        />
        <RunButton
          status={data.status}
          label="提取背景"
          disabled={readOnly || uploading || inputCount !== 1}
          onClick={() => void runNode(id)}
        />
        {running && <Developing />}
        <ImageGrid images={data.outputImages} />
      </NodeFrame>
      <Handle
        id="image"
        type="source"
        position={Position.Right}
        title="背景图片"
        isConnectable={!readOnly}
      />
    </>
  );
}

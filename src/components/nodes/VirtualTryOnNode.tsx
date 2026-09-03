import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useCoalescedTextEdit } from "@/hooks/useCoalescedTextEdit";
import { selectActiveEdges, selectActiveNodes, useFlowStore } from "@/store/flowStore";
import { isNodeRunActive, type VirtualTryOnNodeData, type WorkflowNodeData } from "@/types/workflow";
import type { VirtualTryOnModelId } from "@/types/imageModels";
import { ImageGrid } from "./ImageGrid";
import { Developing, inputClass, NodeFrame, RunButton } from "./NodeFrame";

const MODELS: Array<{ id: VirtualTryOnModelId; label: string }> = [
  { id: "gpt-image-2", label: "GPT Image 2" },
  { id: "gemini-3.1-flash-image-preview", label: "Gemini 3.1 Flash" },
];
const IMAGE_SIZES = ["2K", "4K"] as const;
const CATEGORIES = [
  { id: "knit", label: "针织" },
  { id: "woven", label: "梭织" },
  { id: "other", label: "其他" },
] as const;

function firstOutput(data: WorkflowNodeData): string | undefined {
  if (data.kind === "image-input") return data.imageUrl;
  if (data.kind === "result") return data.images[0];
  if ("outputImages" in data && Array.isArray(data.outputImages)) return data.outputImages[0];
  return undefined;
}

function StageHandles({ stage }: { stage: VirtualTryOnNodeData["workflowStage"] }) {
  if (stage === "standard") return <Handle type="target" position={Position.Left} />;
  const handles = stage === "scene-stabilize"
    ? [
        ["person", "人物身份图", "10%"],
        ["scene", "场景/表演参考图", "20%"],
        ["outfit", "主穿搭图", "30%"],
        ["bag", "包袋参考图（可选）", "40%"],
        ["shoes", "鞋履参考图（可选）", "50%"],
        ["hat", "帽子参考图（可选）", "60%"],
        ["ring", "戒指参考图（可选）", "70%"],
        ["earrings", "耳环参考图（可选）", "80%"],
        ["bracelet", "手镯参考图（可选）", "90%"],
      ]
    : [
        ["baseline", "已确认第一轮基准", "22%"],
        ["outfit", "主穿搭图", "40%"],
        ["material", "面料参考图（可选）", "58%"],
        ["detail", "局部结构图（可多张）", "76%"],
      ];
  return handles.map(([handleId, title, top]) => (
    <Handle key={handleId} type="target" position={Position.Left} id={handleId} title={title} style={{ top }} />
  ));
}

export function VirtualTryOnNode({ id, data, selected }: NodeProps<Node<VirtualTryOnNodeData>>) {
  const updateNodeData = useFlowStore((state) => state.updateNodeData);
  const runNode = useFlowStore((state) => state.runNode);
  const nodes = useFlowStore(selectActiveNodes);
  const edges = useFlowStore(selectActiveEdges);
  const promptEdit = useCoalescedTextEdit(
    { kind: "node-data", nodeId: id, field: "prompt" },
    { multiline: true },
  );
  const running = isNodeRunActive(data.status);
  const materialEdit = useCoalescedTextEdit(
    { kind: "node-data", nodeId: id, field: "materialSpec" },
    { multiline: true },
  );
  const constructionEdit = useCoalescedTextEdit(
    { kind: "node-data", nodeId: id, field: "constructionSpec" },
    { multiline: true },
  );
  const baselineEdge = data.workflowStage === "garment-refine"
    ? edges.find((edge) => edge.target === id && edge.targetHandle === "baseline")
    : undefined;
  const baselineNode = baselineEdge ? nodes.find((node) => node.id === baselineEdge.source) : undefined;
  const baselineRef = baselineNode ? firstOutput(baselineNode.data) : undefined;
  const baselineApproved = Boolean(baselineRef && data.approvedBaselineRef === baselineRef);

  const selectModel = (modelId: VirtualTryOnModelId) => {
    if (data.workflowStage !== "standard") return;
    updateNodeData(id, {
      modelId,
      modelOptions: modelId === "gemini-3.1-flash-image-preview"
        ? { aspectRatio: "1:1", imageSize: data.imageSize }
        : {},
      error: undefined,
    });
  };
  const selectImageSize = (imageSize: "2K" | "4K") => {
    updateNodeData(id, {
      imageSize,
      modelOptions: data.modelId === "gemini-3.1-flash-image-preview"
        ? { ...data.modelOptions, imageSize }
        : data.workflowStage === "garment-refine" ? { quality: "medium" } : {},
      error: undefined,
    });
  };
  const materialLabels = data.garmentCategory === "knit"
    ? {
        material: "纱线/面料说明（必填）",
        materialPlaceholder: "例如：70%羊毛、30%羊绒，双股纱，中等厚度，低光泽",
        construction: "针织手法（必填）",
        constructionPlaceholder: "例如：12GG，衣身平针，1×1罗纹领口，全成型收针",
      }
    : data.garmentCategory === "woven"
      ? {
          material: "面料说明（必填）",
          materialPlaceholder: "例如：羊毛混纺斜纹，280g/m²，中等垂感，哑光",
          construction: "织造/结构工艺（必填）",
          constructionPlaceholder: "例如：前片双褶，腰头粘衬，侧缝插袋，裤脚暗针",
        }
      : {
          material: "材料说明（必填）",
          materialPlaceholder: "例如：哑光软羊皮，中等厚度，轻微自然纹理",
          construction: "成型/加工工艺（必填）",
          constructionPlaceholder: "例如：分片拼接、薄棉绗缝、边缘热压处理",
        };

  return (
    <>
      <StageHandles stage={data.workflowStage} />
      <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected}>
        {data.workflowStage === "standard" ? (
          <StageHelp title="系统参考图角色" lines={[
            "首图锁定最终模特身份、姿势与背景",
            "第二图控制主穿搭轮廓、比例与层叠",
            "其余图片补充鞋包、材质与工艺细节",
          ]} />
        ) : data.workflowStage === "scene-stabilize" ? (
          <StageHelp title="第一轮 · 场景化定版" lines={[
            "左侧接口从上到下：人物、场景、穿搭、包、鞋、帽、戒指、耳环、手镯",
            "人物图是身份唯一来源；右下角会自动提取为脸部恢复唯一锚点",
            "场景图只做背景、光线、构图、动作与神态分析，原图不发送给生图模型",
            "主穿搭图是服装与搭配风格唯一来源；配饰仅约束已提交类别且各限一张",
          ]} />
        ) : (
          <StageHelp title="第二轮 · 服装结构与面料精修" lines={[
            "左侧接口从上到下：基准、穿搭、面料、局部结构",
            "第一轮基准锁定人物、姿势、配饰、场景、光线与构图",
            "主穿搭控制整体版型，面料和局部图只覆盖对应细节",
            "必须确认基准并填写材料与工艺，才会发起付费请求",
          ]} />
        )}

        {data.workflowStage === "garment-refine" && (
          <>
            <div className="space-y-1 rounded-md border border-[#262626] bg-[#0f0f0f] p-2">
              <p className="text-[10px] text-neutral-400">第一轮人工确认</p>
              <p className="text-[9px] leading-relaxed text-neutral-600">
                检查身份、动作神态、手脚、场景构图、主穿搭轮廓与目标配饰。
              </p>
              <Button
                type="button"
                size="sm"
                variant={baselineApproved ? "default" : "outline"}
                aria-pressed={baselineApproved}
                disabled={running || !baselineRef}
                onClick={() => updateNodeData(id, { approvedBaselineRef: baselineRef, error: undefined })}
                className="nodrag h-8 w-full text-[10px]"
              >
                {baselineApproved ? "当前基准已确认" : baselineRef ? "确认当前第一轮基准" : "等待第一轮生成结果"}
              </Button>
              {data.approvedBaselineRef && !baselineApproved && (
                <p className="text-[9px] text-amber-600">第一轮结果或连线已变化，请重新确认。</p>
              )}
            </div>

            <ChoiceGroup label="服装品类（必选）">
              {CATEGORIES.map((category) => (
                <Button
                  key={category.id}
                  type="button"
                  size="sm"
                  variant={data.garmentCategory === category.id ? "default" : "outline"}
                  aria-pressed={data.garmentCategory === category.id}
                  disabled={running}
                  onClick={() => updateNodeData(id, { garmentCategory: category.id, error: undefined })}
                  className="nodrag h-8 flex-1 text-[10px]"
                >
                  {category.label}
                </Button>
              ))}
            </ChoiceGroup>

            <label className="block space-y-1">
              <span className="text-[10px] text-neutral-500">{materialLabels.material}</span>
              <textarea
                value={data.materialSpec ?? ""}
                {...materialEdit.bind}
                rows={3}
                placeholder={materialLabels.materialPlaceholder}
                className={`${inputClass} resize-none`}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[10px] text-neutral-500">{materialLabels.construction}</span>
              <textarea
                value={data.constructionSpec ?? ""}
                {...constructionEdit.bind}
                rows={3}
                placeholder={materialLabels.constructionPlaceholder}
                className={`${inputClass} resize-none`}
              />
            </label>
          </>
        )}

        <label className="block space-y-1">
          <span className="text-[10px] text-neutral-500">补充要求（可选）</span>
          <textarea
            value={data.prompt}
            {...promptEdit.bind}
            rows={data.workflowStage === "garment-refine" ? 3 : 5}
            placeholder="只描述最终效果，不要重定义参考图角色或编号"
            className={`${inputClass} resize-none`}
          />
        </label>

        <p className="text-[9px] leading-relaxed text-amber-600">
          连接中断会自动重试最多 2 次；单个阶段最多可能产生 3 次上游计费请求。
        </p>

        {data.workflowStage === "standard" ? (
          <ChoiceGroup label="图片模型">
            {MODELS.map((model) => (
              <Button
                key={model.id}
                type="button"
                size="sm"
                variant={data.modelId === model.id ? "default" : "outline"}
                aria-pressed={data.modelId === model.id}
                disabled={running}
                onClick={() => selectModel(model.id)}
                className="nodrag h-auto min-h-8 flex-1 whitespace-normal px-2 py-1 text-[10px] leading-tight"
              >
                {model.label}
              </Button>
            ))}
          </ChoiceGroup>
        ) : (
          <div className="rounded-md border border-[#262626] bg-[#0f0f0f] px-2 py-1.5 text-[10px] text-neutral-400">
            固定模型：{data.workflowStage === "scene-stabilize" ? "Gemini 3.1 Flash" : "GPT Image 2 · 中等质量"}
          </div>
        )}

        <ChoiceGroup label="输出档位">
          {IMAGE_SIZES.map((imageSize) => (
            <Button
              key={imageSize}
              type="button"
              size="sm"
              variant={data.imageSize === imageSize ? "default" : "outline"}
              aria-pressed={data.imageSize === imageSize}
              disabled={running}
              onClick={() => selectImageSize(imageSize)}
              className="nodrag h-8 flex-1 text-[10px]"
            >
              {imageSize}
            </Button>
          ))}
        </ChoiceGroup>

        <RunButton
          status={data.status}
          onClick={() => void runNode(id)}
          label={data.workflowStage === "scene-stabilize" ? "生成第一轮基准" : data.workflowStage === "garment-refine" ? "生成服装精修" : "生成换装效果"}
        />
        {running && <Developing />}
        <ImageGrid images={data.outputImages} />
      </NodeFrame>
      <Handle type="source" position={Position.Right} />
    </>
  );
}

function StageHelp({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="space-y-1 rounded-md border border-[#262626] bg-[#0f0f0f] p-2">
      <p className="text-[10px] text-neutral-300">{title}</p>
      <ul className="list-disc space-y-0.5 pl-4 text-[9px] leading-relaxed text-neutral-600">
        {lines.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </div>
  );
}

function ChoiceGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-[10px] text-neutral-500">{label}</legend>
      <div className="flex gap-2">{children}</div>
    </fieldset>
  );
}

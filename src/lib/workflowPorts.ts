import {
  MAX_VIRTUAL_TRY_ON_REFERENCE_IMAGES,
  NODE_SPECS,
  type NodePortSpec,
  type PortValueKind,
  type WorkflowInputRole,
  type WorkflowNodeData,
} from "../types/workflow";

export type WorkflowPortPayload =
  | { valueKind: "image"; images: string[] }
  | { valueKind: "text"; text: string }
  | { valueKind: "colors"; colors: string[] }
  | { valueKind: "video"; videos: string[] }
  | { valueKind: "none" };

const input = (
  id: WorkflowInputRole | "references",
  label: string,
  valueKind: PortValueKind,
  required: boolean,
  maxSources: number,
): NodePortSpec => ({ id, label, direction: "input", valueKind, required, maxSources });

const SCENE_STABILIZE_PORTS: readonly NodePortSpec[] = [
  input("person", "人物身份图", "image", true, 1),
  input("scene", "场景或表演参考图", "image", true, 1),
  input("outfit", "主穿搭图", "image", true, 1),
  input("bag", "包袋参考图", "image", false, 1),
  input("shoes", "鞋履参考图", "image", false, 1),
  input("hat", "帽子参考图", "image", false, 1),
  input("ring", "戒指参考图", "image", false, 1),
  input("earrings", "耳环参考图", "image", false, 1),
  input("bracelet", "手镯参考图", "image", false, 1),
  input("detail", "服装局部结构参考图", "image", false, 5),
];

const GARMENT_REFINE_PORTS: readonly NodePortSpec[] = [
  input("baseline", "已确认第一轮基准", "image", true, 1),
  input("outfit", "主穿搭图", "image", true, 1),
  input("material", "面料参考图", "image", false, 1),
  input("detail", "局部结构参考图", "image", false, MAX_VIRTUAL_TRY_ON_REFERENCE_IMAGES - 3),
];

export const STAGED_ROLE_LABELS: Readonly<Partial<Record<WorkflowInputRole, string>>> = {
  person: "人物身份图",
  scene: "场景或表演参考图",
  outfit: "主穿搭图",
  bag: "包袋参考图",
  shoes: "鞋履参考图",
  hat: "帽子参考图",
  ring: "戒指参考图",
  earrings: "耳环参考图",
  bracelet: "手镯参考图",
  detail: "服装局部结构参考图",
  baseline: "已确认第一轮基准",
  material: "面料参考图",
  palette: "目标色板",
  prompt: "提示词",
  "baseline-candidate": "待确认第一轮基准",
  "first-frame": "首帧 / 参考图一",
  "last-frame": "尾帧 / 参考图二",
  "source-video": "源视频",
};

export function isStagedTryOnData(data: WorkflowNodeData): boolean {
  return data.kind === "virtual-try-on" && data.workflowStage !== "standard";
}

export function compatibleUnusedInputRoles(options: {
  source: { id: string; data: WorkflowNodeData };
  target: { id: string; data: WorkflowNodeData };
  sourceHandle?: string | null;
  existingEdges?: readonly ConnectionLike[];
}): NodePortSpec[] {
  const { source, target, sourceHandle, existingEdges = [] } = options;
  const sourcePort = outputPortFor(source.data, sourceHandle);
  if (!sourcePort) return [];
  return inputPortSpecs(target.data).filter((port) => {
    if (!portKindsCompatible(sourcePort, port)) return false;
    const count = existingEdges.filter((edge) => edge.target === target.id && edge.targetHandle === port.id).length;
    return count < port.maxSources;
  });
}

export function inputPortSpecs(data: WorkflowNodeData): readonly NodePortSpec[] {
  if (data.kind === "video-generate") {
    const prompt = input("prompt", "视频提示词", "text", true, 1);
    if (data.mode === "text-to-video") return [prompt];
    if (data.mode === "video-to-video") return [
      input("source-video", "源视频", "video", true, 1),
      prompt,
    ];
    return [
      input("first-frame", data.mode === "multi-image-video" ? "参考图一" : "首帧", "image", true, 1),
      input("last-frame", data.mode === "multi-image-video" ? "参考图二" : "尾帧", "image", true, 1),
      prompt,
    ];
  }
  if (data.kind === "virtual-try-on") {
    if (data.workflowStage === "scene-stabilize") return SCENE_STABILIZE_PORTS;
    if (data.workflowStage === "garment-refine") return GARMENT_REFINE_PORTS;
  }
  return NODE_SPECS[data.kind].inputPorts;
}

export function outputPortSpecs(data: WorkflowNodeData): readonly NodePortSpec[] {
  return NODE_SPECS[data.kind].outputPorts;
}

export function inputPortFor(
  data: WorkflowNodeData,
  targetHandle?: string | null,
): NodePortSpec | undefined {
  const ports = inputPortSpecs(data);
  if (targetHandle) return ports.find((port) => port.id === targetHandle);
  return ports.find((port) => port.id === "references") ?? (ports.length === 1 ? ports[0] : undefined);
}

export function outputPortFor(
  data: WorkflowNodeData,
  sourceHandle?: string | null,
): NodePortSpec | undefined {
  const ports = outputPortSpecs(data);
  if (sourceHandle) return ports.find((port) => port.id === sourceHandle);
  return ports.length === 1 ? ports[0] : undefined;
}

export function portKindsCompatible(source: NodePortSpec, target: NodePortSpec): boolean {
  if (source.direction !== "output" || target.direction !== "input") return false;
  const accepted = target.accepts?.length ? target.accepts : [target.valueKind];
  return accepted.includes(source.valueKind);
}

export interface ConnectionLike {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export function connectionCompatibilityError(options: {
  source: { id: string; data: WorkflowNodeData };
  target: { id: string; data: WorkflowNodeData };
  sourceHandle?: string | null;
  targetHandle?: string | null;
  existingEdges?: readonly ConnectionLike[];
  maxSources?: number;
}): string | undefined {
  const { source, target, sourceHandle, targetHandle, existingEdges = [] } = options;
  if (source.id === target.id) return "节点不能连接到自身";
  const sourcePort = outputPortFor(source.data, sourceHandle);
  if (!sourcePort) return "来源节点没有可用的输出端口";
  const targetPort = inputPortFor(target.data, targetHandle);
  if (!targetPort) return targetHandle ? `目标节点不支持输入角色：${targetHandle}` : "请选择一个明确的输入角色";
  if (!portKindsCompatible(sourcePort, targetPort)) {
    return `${sourcePort.label}不能连接到${targetPort.label}：数据类型不兼容`;
  }
  if (
    isStagedTryOnData(target.data)
    && existingEdges.filter((edge) => edge.target === target.id).length >= MAX_VIRTUAL_TRY_ON_REFERENCE_IMAGES
  ) {
    return `分步换装最多 ${MAX_VIRTUAL_TRY_ON_REFERENCE_IMAGES} 张参考图`;
  }
  const sameRole = existingEdges.filter((edge) => (
    edge.target === target.id && (edge.targetHandle ?? null) === (targetHandle ?? null)
  ));
  const maxSources = options.maxSources ?? targetPort.maxSources;
  if (sameRole.length >= maxSources) {
    return `${targetPort.label}最多连接 ${maxSources} 个来源`;
  }
  if (existingEdges.some((edge) => (
    edge.source === source.id && edge.target === target.id
    && (edge.sourceHandle ?? null) === (sourceHandle ?? null)
    && (edge.targetHandle ?? null) === (targetHandle ?? null)
  ))) return "这条连接已经存在";
  return undefined;
}

export function portPayloadKind(payload: WorkflowPortPayload): PortValueKind {
  return payload.valueKind;
}

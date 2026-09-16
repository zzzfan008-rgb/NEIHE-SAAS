import {
  MAX_MASK_USER_REFERENCE_IMAGES,
  MAX_VIRTUAL_TRY_ON_REFERENCE_IMAGES,
  NODE_SPECS,
  WORKFLOW_INPUT_ROLES,
  type NodePortSpec,
  type PortValueKind,
  type WorkflowInputRole,
  type WorkflowNodeData,
} from "../types/workflow";
import { SEEDANCE_MODEL_CAPABILITIES } from "./seedance";

export type WorkflowPortPayload =
  | { valueKind: "image"; images: string[] }
  | { valueKind: "text"; text: string }
  | { valueKind: "colors"; colors: string[] }
  | { valueKind: "video"; videos: string[] }
  | { valueKind: "audio"; audios: string[] }
  | { valueKind: "none" };

const input = (
  id: WorkflowInputRole | "references",
  label: string,
  valueKind: PortValueKind,
  required: boolean,
  maxSources: number,
): NodePortSpec => ({ id, label, direction: "input", valueKind, required, maxSources });

const SCENE_STABILIZE_PORTS: readonly NodePortSpec[] = [
  input("person", "人物身份参考", "image", true, 3),
  input("scene", "场景参考图", "image", true, 1),
  input("pose", "人物姿势参考图", "image", true, 1),
  input("outfit", "主穿搭图", "image", true, 1),
  input("bag", "包袋参考图", "image", false, 1),
  input("shoes", "鞋履参考图", "image", false, 1),
  input("socks", "袜子参考图", "image", false, 1),
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

const MASK_REPAIR_PORTS: readonly NodePortSpec[] = [
  input("repair-source", "待修改底图", "image", true, 1),
  input("references", "细节参考图", "image", false, MAX_MASK_USER_REFERENCE_IMAGES - 1),
];

export const STAGED_ROLE_LABELS: Readonly<Partial<Record<WorkflowInputRole, string>>> = {
  person: "人物身份图",
  scene: "场景参考图",
  pose: "人物姿势参考图",
  outfit: "主穿搭图",
  bag: "包袋参考图",
  shoes: "鞋履参考图",
  socks: "袜子参考图",
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
  "reference-image": "参考图片",
  "reference-video": "参考视频",
  "reference-audio": "参考音频",
};

export function isStagedTryOnData(data: WorkflowNodeData): boolean {
  return data.kind === "virtual-try-on" && data.workflowStage !== "standard";
}

/** Recover only the role explicitly and uniquely declared by an image template node. */
export function declaredAutoConnectTargetHandle(
  data: WorkflowNodeData,
  targetNodeId: string,
): WorkflowInputRole | undefined {
  if (data.kind !== "image-input" || !Array.isArray(data.autoConnectTargets)) return undefined;
  const roles = new Set<WorkflowInputRole>();
  for (const value of data.autoConnectTargets as unknown[]) {
    if (!value || typeof value !== "object") continue;
    const target = value as { targetNodeId?: unknown; targetHandle?: unknown };
    if (
      target.targetNodeId === targetNodeId
      && typeof target.targetHandle === "string"
      && WORKFLOW_INPUT_ROLES.includes(target.targetHandle as WorkflowInputRole)
    ) roles.add(target.targetHandle as WorkflowInputRole);
  }
  return roles.size === 1 ? roles.values().next().value : undefined;
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
    const capability = SEEDANCE_MODEL_CAPABILITIES[data.videoModel];
    if (data.mode === "text-to-video") return [prompt];
    if (data.mode === "first-frame-to-video") return [
      input("first-frame", "首帧", "image", true, 1),
      prompt,
    ];
    if (data.mode === "keyframes-to-video") return [
      input("first-frame", "首帧", "image", true, 1),
      input("last-frame", "尾帧", "image", true, 1),
      prompt,
    ];
    if (data.mode === "multimodal-reference") return [
      input("reference-image", "参考图片", "image", false, capability.maxImages),
      input("reference-video", "参考视频", "video", false, capability.maxVideos),
      input("reference-audio", "参考音频", "audio", false, capability.maxAudios),
      prompt,
    ];
    return [input("source-video", data.mode === "video-edit" ? "待编辑视频" : "待延长视频", "video", true, 1), prompt];
  }
  if (data.kind === "virtual-try-on") {
    if (data.workflowStage === "scene-stabilize") return SCENE_STABILIZE_PORTS;
    if (data.workflowStage === "garment-refine") return GARMENT_REFINE_PORTS;
  }
  if (data.kind === "mask-redraw") return MASK_REPAIR_PORTS;
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
  if (sourceHandle) {
    const exact = ports.find((port) => port.id === sourceHandle);
    if (exact) return exact;
    if (data.kind === "result" && /^image:\d+$/.test(sourceHandle)) {
      const imagePort = ports.find((port) => port.valueKind === "image");
      return imagePort ? { ...imagePort, id: sourceHandle } : undefined;
    }
    return undefined;
  }
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
  if (target.data.kind === "ai-styling" && source.data.kind !== "outfit-reference") return "AI 搭配需要连接服饰参考图节点";
  if (
    source.data.kind === "image-input"
    && source.data.imageUrl?.startsWith("asset://")
    && target.data.kind !== "video-generate"
  ) return "asset:// 图片素材只能连接 Seedance 视频节点";
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

/** Result nodes expose one stable image handle per thumbnail. Other handles keep all outputs. */
export function imagesForSourceHandle(images: readonly string[], sourceHandle?: string | null): string[] {
  const match = sourceHandle?.match(/^image:(\d+)$/);
  if (!match) return [...images];
  const selected = images[Number(match[1])];
  return selected ? [selected] : [];
}

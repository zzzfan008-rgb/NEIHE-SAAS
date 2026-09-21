import type { PersistedWorkflow, WorkflowTemplate, WorkflowInputRole } from "../types/workflow";
import { WORKFLOW_SCHEMA_VERSION } from "../types/workflow";
import { MULTI_IMAGE_ROLE_LABELS, MULTI_IMAGE_TRY_ON_MODE } from "./multiImageTryOn";
import { createDocumentSnapshot, documentSnapshotToPersistedWorkflow } from "./documentSnapshot";

export const MULTI_IMAGE_TRY_ON_TEMPLATE_NAME = "多图编辑换装+修改";

/** Copy the selected saved flow, never mutate it or replace the existing built-in. */
export function copyMultiImageTryOnTemplate(source: PersistedWorkflow): Pick<WorkflowTemplate, "name" | "description" | "flow"> {
  const original = structuredClone(source);
  const generation = original.nodes.find(node => node.id === "stabilize" && node.data.kind === "virtual-try-on");
  const repair = original.nodes.find(node => node.id === "garment-detail" && node.data.kind === "mask-redraw");
  if (!generation || generation.data.kind !== "virtual-try-on" || !repair || repair.data.kind !== "mask-redraw")
    throw new Error("来源不是预期的一键换装副本，请重新选择原项目");
  const nodes: PersistedWorkflow["nodes"] = [];
  const edges: PersistedWorkflow["edges"] = [];
  const connect = (from: string, to: string, role: WorkflowInputRole, handle = "image") => edges.push({
    id: `${from}-${to}-${role}`, source: from, target: to, sourceHandle: handle, targetHandle: role,
  });
  const slots: Array<[string, WorkflowInputRole]> = [
    ["pose", "pose"], ["person", "person"], ["scene", "scene"],
    ["outfit", "outfit"], ["material", "detail"], ["detail", "detail"],
    ["shoes", "shoes"], ["socks", "socks"], ["bag", "bag"],
    ["hat", "hat"], ["eyewear", "eyewear"], ["neckwear", "neckwear"],
    ["earrings", "earrings"], ["ring", "ring"], ["bracelet", "bracelet"],
    ["belt", "belt"], ["watch", "watch"],
  ];
  for (const [index, [id, role]] of slots.entries()) {
    const old = original.nodes.find(node => node.id === id && node.data.kind === "image-input");
    const required = ["pose", "person", "scene", "outfit"].includes(role);
    nodes.push({ id, type: "image-input", position: { x: Math.floor(index / 3) * 330, y: (index % 3) * 360 },
      data: {
        kind: "image-input", imageRole: old?.data.kind === "image-input" ? old.data.imageRole : "reference",
        label: `${index < 3 ? `图 ${index + 1} · ` : ""}${id === "material" ? "面料 / 纱线" : MULTI_IMAGE_ROLE_LABELS[role]}（${required ? "必需" : "可选"}）`,
        status: "idle", autoConnectTargets: [{ targetNodeId: generation.id, targetHandle: role }],
      } });
    // Optional empty nodes stay unconnected; upload auto-connects them with the correct role.
    if (required) connect(id, generation.id, role);
  }
  nodes.push({ ...generation, position: { x: 2060, y: 0 }, data: {
    ...generation.data, label: "第一阶段 · 多图编辑换装", sceneInputMode: MULTI_IMAGE_TRY_ON_MODE,
    modelId: "gemini-3-pro-image-preview", modelOptions: { aspectRatio: generation.data.aspectRatio, imageSize: generation.data.imageSize },
    qualityMode: "fast", promptEnhancement: false, safetyFallback: false, basisRevision: 0, outputImages: [], status: "idle",
  } });
  const angle = original.nodes.find(node => node.data.kind === "ti-angle");
  if (angle) {
    nodes.push({ ...angle, position: { x: 2060, y: 1120 } });
    connect(angle.id, generation.id, "angle-direction", "text");
  }
  nodes.push({ id: "try-on-result", type: "result", position: { x: 2470, y: 0 }, data: {
    kind: "result", label: "换装成片 · 选择后按需修改", status: "idle", images: [], note: "",
  } });
  connect(generation.id, "try-on-result", "references");
  nodes.push({ ...repair, position: { x: 2900, y: 0 }, data: {
    ...repair.data, label: "第二阶段 · 按需局部修改", executionMode: "repair" as const, outputImages: [], status: "idle",
    mask: undefined, maskSourceRef: undefined,
  } });
  // No automatic result-to-repair edge: user selects the exact image to edit.
  connect("outfit", repair.id, "references");
  nodes.push({ id: "repair-result", type: "result", position: { x: 3320, y: 0 }, data: {
    kind: "result", label: "局部修改结果", status: "idle", images: [], note: "",
  } });
  connect(repair.id, "repair-result", "references");
  nodes.push({ id: "guide", type: "text-input", position: { x: 2470, y: 700 }, data: {
    kind: "text-input", label: "两阶段使用说明", status: "idle",
    text: "① 上传姿势、人物、场景、主穿搭原图；鞋袜、帽子、眼镜/墨镜、首饰等按需上传，自动连接对应用途。前三张参数固定为姿势、人物、场景。② 点击生成多图换装，Pro 不超过6张直接传入，超过时自动拼接服装细节、鞋袜、配饰；不执行前置人物合成或整图精修。③ 成片满意即可结束。需要修改时，从结果中选择具体单张图片，连接到第二阶段的待修改底图，绘制并保存蒙版、填写修改要求，再单独运行。未选择底图或未保存蒙版时不执行修改。",
  } });
  const flow = documentSnapshotToPersistedWorkflow(createDocumentSnapshot({
    projectName: MULTI_IMAGE_TRY_ON_TEMPLATE_NAME, nodes, edges,
  }));
  return { name: MULTI_IMAGE_TRY_ON_TEMPLATE_NAME,
    description: "从一键换装副本独立复制：原始多图一次编辑换装 → 用户选择成片后按需蒙版修改；Gemini Pro 超过6张时自动分组拼接。",
    flow: { ...flow, schemaVersion: WORKFLOW_SCHEMA_VERSION } };
}

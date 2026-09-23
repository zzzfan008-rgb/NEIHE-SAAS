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
        label: id === "person"
          ? `图 ${index + 1} · 人物（必需 · 虚构或授权）`
          : `${index < 3 ? `图 ${index + 1} · ` : ""}${id === "material" ? "面料 / 纱线" : MULTI_IMAGE_ROLE_LABELS[role]}（${required ? "必需" : "可选"}）`,
        status: "idle", autoConnectTargets: [{ targetNodeId: generation.id, targetHandle: role }],
      } });
    // Optional empty nodes stay unconnected; upload auto-connects them with the correct role.
    if (required) connect(id, generation.id, role);
  }
  nodes.push({ ...generation, position: { x: 2060, y: 0 }, data: {
    ...generation.data, label: "第一阶段 · 多图编辑换装", sceneInputMode: MULTI_IMAGE_TRY_ON_MODE,
    modelId: "gemini-3.1-flash-image", modelOptions: { aspectRatio: generation.data.aspectRatio, imageSize: generation.data.imageSize },
    qualityMode: "fast", promptEnhancement: false, safetyFallback: false, basisRevision: 0, outputImages: [], status: "idle",
  } });
  const angle = original.nodes.find(node => node.data.kind === "ti-angle");
  const angleId = angle?.id ?? "view-angle";
  nodes.push({ id: angleId, type: "ti-angle", position: { x: 2060, y: 1120 }, data: {
    kind: "ti-angle", label: angle?.data.label ?? "3D 视角", status: "idle",
    angle: angle?.data.kind === "ti-angle"
      ? { ...angle.data.angle, enabled: false }
      : { version: 1, enabled: false, azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 },
  } });
  connect(angleId, generation.id, "angle-direction", "text");
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
    text: "① 上传姿势、人物、场景、主穿搭原图；鞋袜、帽子、眼镜/墨镜、首饰等按需上传，自动连接对应用途。前三张参数固定为姿势、人物、场景。② 默认使用 Gemini Flash、2K 一次生成成片。TiAngel 默认关闭，姿势图控制动作与取景；可手动开启 TiAngel 指定拍摄视角，姿势图仍控制肢体动作。Flash 最多14张直接传入；可手动选择 Pro，超过14张时才按需分组拼接，最多20张原始素材。③ 成片满意即可结束。需要修改时，从结果中选择具体单张图片，连接到第二阶段的待修改底图，绘制并保存蒙版、填写修改要求，再单独运行。未选择底图或未保存蒙版时不执行修改。④ 过审与素材边界：人物请使用原创虚构角色或已获授权的模特形象，避免公众人物、名人、知名 IP 与未成年人的可识别形象；成片为风格化人物呈现，不保证照片级真人身份复刻。服装与配饰请使用无真实品牌标识、无文字水印的原创素材。审核拒绝时查看服务方说明，简化提示词不保证通过审核。",
  } });
  const flow = documentSnapshotToPersistedWorkflow(createDocumentSnapshot({
    projectName: MULTI_IMAGE_TRY_ON_TEMPLATE_NAME, nodes, edges,
  }));
  return { name: MULTI_IMAGE_TRY_ON_TEMPLATE_NAME,
    description: "原始多图一次编辑换装 → 用户选择成片后按需蒙版修改；人物为原创虚构或授权形象、风格化呈现，不做照片级真人身份复刻；默认 Gemini Flash，TiAngel 默认关闭、可手动开启；Pro 超过14张时按需分组拼接。",
    flow: { ...flow, schemaVersion: WORKFLOW_SCHEMA_VERSION } };
}

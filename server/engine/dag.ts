/**
 * DAG 工作流执行计划构建。
 * 输入 React Flow 的 nodes/edges JSON，Kahn 拓扑排序输出 ExecutionPlan。
 * 支持环检测与两种局部重跑：只跑选中节点，或选中节点及其下游。
 */
import type {
  ExecutionPlan,
  NodeExecution,
  NodeKind,
  WorkflowNodeData,
} from "../../src/types/workflow";
import {
  MASK_PIPELINE_VERSION,
  MAX_MASK_USER_REFERENCE_IMAGES,
  MAX_REFERENCE_IMAGES,
  MAX_VIRTUAL_TRY_ON_REFERENCE_IMAGES,
  NODE_SPECS,
} from "../../src/types/workflow";
import {
  DEFAULT_GENERATION_MODEL_ID,
  MASK_REDRAW_MODEL_ID,
  defaultImageModelOptions,
  isImageModelId,
  isModelAllowedForNode,
  modelMaxReferenceImages,
} from "../../src/types/imageModels";

/** React Flow 节点/边的最小结构（前端传入） */
export interface FlowNode {
  id: string;
  type?: string;
  data: WorkflowNodeData & { kind: NodeKind };
}

export interface FlowEdge {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export class DagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DagError";
  }
}

/** 运行前验证会产生费用的节点具备真实图片输入。 */
export function assertPlanInputs(plan: ExecutionPlan, edges: FlowEdge[]): void {
  const executingNodeIds = new Set(plan.steps.map((step) => step.nodeId));
  for (const step of plan.steps) {
    const spec = NODE_SPECS[step.kind];
    if (!spec.providerId) continue;
    if (step.kind === "video-generate") {
      const prompt = typeof step.params.prompt === "string" ? step.params.prompt.trim() : "";
      if (!prompt) throw new DagError(`Node ${step.nodeId} requires a video prompt`);
      const mode = String(step.params.mode);
      const mediaInputs = (step.upstream ?? []).filter((source) => source.targetHandle !== "prompt");
      if (mode === "text-to-video" && mediaInputs.length !== 0) throw new DagError(`Node ${step.nodeId} text-to-video does not accept media inputs`);
      if ((mode === "keyframes-to-video" || mode === "multi-image-video") && mediaInputs.length !== 2) {
        throw new DagError(`Node ${step.nodeId} requires exactly two ordered reference frames`);
      }
      if (mode === "video-to-video" && (mediaInputs.length !== 1 || mediaInputs[0].targetHandle !== "source-video")) {
        throw new DagError(`Node ${step.nodeId} requires exactly one source video`);
      }
      if ((step.params.resolution === "1080p" || step.params.resolution === "4k") && step.params.seconds !== 8) {
        throw new DagError(`Node ${step.nodeId} requires 8 seconds for 1080p or 4K`);
      }
      continue;
    }
    const modelId = isImageModelId(step.params.modelId)
      ? step.params.modelId
      : step.kind === "mask-redraw" ? MASK_REDRAW_MODEL_ID : DEFAULT_GENERATION_MODEL_ID;
    if (!isModelAllowedForNode(modelId, step.kind)) {
      throw new DagError(`Model ${modelId} is not allowed for node ${step.nodeId}`);
    }
    const usableImages = (step.upstream ?? []).flatMap((upstream) =>
      executingNodeIds.has(upstream.nodeId) ? ["__runtime_output__"] : upstream.images,
    );
    const maxReferences = Math.min(
      step.kind === "virtual-try-on" ? MAX_VIRTUAL_TRY_ON_REFERENCE_IMAGES : MAX_REFERENCE_IMAGES,
      modelMaxReferenceImages(modelId),
    );
    const maxUserReferences = step.kind === "mask-redraw"
      ? Math.min(MAX_MASK_USER_REFERENCE_IMAGES, Math.max(0, maxReferences - 1))
      : maxReferences;
    if (usableImages.length > maxUserReferences) {
      const qualifier = step.kind === "mask-redraw" ? " user" : "";
      throw new DagError(
        `Node ${step.nodeId} accepts at most ${maxUserReferences}${qualifier} reference images for ${modelId}`,
      );
    }
    if (step.kind === "sketch-to-render" && usableImages.length === 0) {
      // sketch-to-render 同时承担文生款式，只有 prompt 时允许无图片执行。
      const prompt = typeof step.params.prompt === "string" ? step.params.prompt.trim() : "";
      if (!prompt) throw new DagError(`Node ${step.nodeId} requires an image or a prompt`);
      continue;
    }
    if (step.kind === "fabric-recolor") {
      const garmentEdges = edges.filter(
        (edge) => edge.target === step.nodeId && edge.targetHandle !== "fabric",
      );
      const garmentIds = new Set(garmentEdges.map((edge) => edge.source));
      const garmentImages = (step.upstream ?? [])
        .filter((upstream) => garmentIds.has(upstream.nodeId))
        .flatMap((upstream) =>
          executingNodeIds.has(upstream.nodeId) ? ["__runtime_output__"] : upstream.images,
        );
      if (garmentImages.length === 0) {
        throw new DagError(`Node ${step.nodeId} requires a garment image`);
      }
      continue;
    }
    if (step.kind === "virtual-try-on") {
      const stage = step.params.workflowStage;
      const allowedRoles = stage === "scene-stabilize"
        ? new Set(["person", "scene", "outfit", "bag", "shoes", "hat", "ring", "earrings", "bracelet", "detail"])
        : stage === "garment-refine"
          ? new Set(["baseline", "outfit", "material", "detail"])
          : undefined;
      if (allowedRoles && (step.upstream ?? []).some((upstream) => !upstream.targetHandle || !allowedRoles.has(upstream.targetHandle))) {
        throw new DagError(`节点 ${step.nodeId} 存在未指定角色的输入连线，请删除多余连线后重试`);
      }
      const roleImages = (role: string) => (step.upstream ?? [])
        .filter((upstream) => upstream.targetHandle === role)
        .flatMap((upstream) => executingNodeIds.has(upstream.nodeId) ? ["__runtime_output__"] : upstream.images);
      const roleSources = (role: string) => (step.upstream ?? []).filter((upstream) => upstream.targetHandle === role);
      const requireOne = (role: string, label: string) => {
        if (roleSources(role).length !== 1 || roleImages(role).length !== 1) {
          throw new DagError(`节点 ${step.nodeId} 必须且只能连接 1 张 ${label} 图片`);
        }
      };
      if (stage === "scene-stabilize") {
        if (modelId !== "gemini-3.1-flash-image-preview") {
          throw new DagError(`节点 ${step.nodeId} 第一轮必须使用 Gemini 3.1 Flash`);
        }
        requireOne("person", "person");
        requireOne("scene", "scene");
        requireOne("outfit", "outfit");
        for (const [role, label] of [
          ["bag", "包袋"], ["shoes", "鞋履"], ["hat", "帽子"],
          ["ring", "戒指"], ["earrings", "耳环"], ["bracelet", "手镯"],
        ] as const) {
          if (roleSources(role).length > 1 || roleImages(role).length > 1) {
            throw new DagError(`节点 ${step.nodeId} 的${label}参考图最多只能连接 1 张`);
          }
        }
        if (roleSources("detail").length > 5 || roleImages("detail").length > 5) {
          throw new DagError(`节点 ${step.nodeId} 的服装局部结构参考图最多只能连接 5 张`);
        }
        continue;
      }
      if (stage === "garment-refine") {
        if (modelId !== "gpt-image-2") {
          throw new DagError(`节点 ${step.nodeId} 第二轮必须使用 GPT Image 2`);
        }
        requireOne("baseline", "approved baseline");
        requireOne("outfit", "outfit");
        if (roleSources("baseline").some((upstream) => executingNodeIds.has(upstream.nodeId))) {
          throw new DagError(`Node ${step.nodeId} requires the user to approve the completed baseline before refinement`);
        }
        if (roleSources("material").length > 1 || roleImages("material").length > 1) {
          throw new DagError(`Node ${step.nodeId} accepts at most one material image`);
        }
        if (step.params.baselineApprovalValid !== true || step.params.approvedBaselineRef !== roleImages("baseline")[0]) {
          throw new DagError(`节点 ${step.nodeId} 的第一轮基准尚未确认或确认已失效`);
        }
        if (!["knit", "woven", "other"].includes(String(step.params.garmentCategory))) {
          throw new DagError(`Node ${step.nodeId} requires a garment category`);
        }
        if (typeof step.params.materialSpec !== "string" || !step.params.materialSpec.trim()) {
          throw new DagError(`Node ${step.nodeId} requires a material specification`);
        }
        if (typeof step.params.constructionSpec !== "string" || !step.params.constructionSpec.trim()) {
          throw new DagError(`Node ${step.nodeId} requires a construction specification`);
        }
        continue;
      }
      if (usableImages.length < 2) {
        throw new DagError(`Node ${step.nodeId} requires a model image and at least one garment reference image`);
      }
      continue;
    }
    if (step.kind === "mask-redraw") {
      if (usableImages.length === 0) throw new DagError(`Node ${step.nodeId} requires an upstream image`);
      if (typeof step.params.mask !== "string" || !step.params.mask) {
        throw new DagError(`Node ${step.nodeId} requires a saved PNG mask`);
      }
      if (typeof step.params.maskSourceRef !== "string" || step.params.maskSourceRef !== usableImages[0]) {
        throw new DagError(`Node ${step.nodeId} mask does not match its current source image`);
      }
      continue;
    }
    if (usableImages.length === 0) {
      throw new DagError(`Node ${step.nodeId} requires an upstream image`);
    }
  }
}

/**
 * 构建执行计划。
 * @param opts.onlyNodeId 从指定节点开始构建局部计划
 * @param opts.includeDownstream 是否把指定节点的下游也纳入计划（默认 true，保持旧接口语义）
 */
export function buildExecutionPlan(
  nodes: FlowNode[],
  edges: FlowEdge[],
  opts?: { onlyNodeId?: string; includeDownstream?: boolean },
): ExecutionPlan {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // 校验边引用的节点存在
  for (const e of edges) {
    if (!nodeMap.has(e.source)) throw new DagError(`Edge source not found: ${e.source}`);
    if (!nodeMap.has(e.target)) throw new DagError(`Edge target not found: ${e.target}`);
  }

  // 局部重跑：目标节点始终在范围内；按需继续扩展到全部下游。
  let scope: Set<string> | null = null;
  if (opts?.onlyNodeId) {
    if (!nodeMap.has(opts.onlyNodeId)) {
      throw new DagError(`Node not found: ${opts.onlyNodeId}`);
    }
    scope = new Set([opts.onlyNodeId]);
    if (opts.includeDownstream !== false) {
      const queue = [opts.onlyNodeId];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const e of edges) {
          if (e.source === cur && !scope.has(e.target)) {
            scope.add(e.target);
            queue.push(e.target);
          }
        }
      }
    }
  }

  const inScope = (id: string) => scope === null || scope.has(id);
  const scopedNodes = nodes.filter((n) => inScope(n.id));
  const scopedEdges = edges.filter((e) => inScope(e.source) && inScope(e.target));

  // Kahn 拓扑排序
  const indegree = new Map<string, number>();
  for (const n of scopedNodes) indegree.set(n.id, 0);
  for (const e of scopedEdges) indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);

  const queue = scopedNodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const sorted: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    sorted.push(id);
    for (const e of scopedEdges) {
      if (e.source !== id) continue;
      const d = (indegree.get(e.target) ?? 0) - 1;
      indegree.set(e.target, d);
      if (d === 0) queue.push(e.target);
    }
  }

  if (sorted.length !== scopedNodes.length) {
    const remaining = scopedNodes.filter((n) => !sorted.includes(n.id)).map((n) => n.id);
    throw new DagError(`Cycle detected in workflow, involved nodes: ${remaining.join(", ")}`);
  }

  // 生成执行步骤：记录每个节点的上游依赖（节点 ID + 计划期快照）。
  // 运行时由 runner 从本次 Run 的 outputs 解析真实输入；
  // 上游不在执行范围（单节点重跑）时回退到快照。
  const steps: NodeExecution[] = sorted.map((id) => {
    const node = nodeMap.get(id)!;
    const data = node.data;

    // 上游按 edges 数组顺序（result 节点多输入时保持连接顺序）
    const upstream: { nodeId: string; images: string[]; targetHandle?: string | null }[] = [];
    for (const e of edges) {
      if (e.target !== id) continue;
      const srcData = nodeMap.get(e.source)!.data;
      upstream.push({
        nodeId: e.source,
        images: extractOutputImages(srcData),
        // Persisted v4/v5 edges normalize an omitted handle to null. Canonicalize
        // both forms by omitting the field, while retaining explicit typed roles.
        ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
      });
    }
    if (data.kind === "virtual-try-on" && data.workflowStage !== "standard") {
      const order = data.workflowStage === "scene-stabilize"
        ? ["scene", "person", "outfit", "bag", "shoes", "hat", "ring", "earrings", "bracelet", "detail"]
        : ["baseline", "outfit", "material", "detail"];
      const rank = (handle: string | null | undefined) => {
        const index = order.indexOf(handle ?? "");
        return index < 0 ? order.length : index;
      };
      upstream.sort((a, b) => rank(a.targetHandle) - rank(b.targetHandle));
    }

    const params = extractParams(data);
    const upstreamText = edges
      .filter((edge) => edge.target === id && edge.targetHandle === "prompt")
      .map((edge) => nodeMap.get(edge.source)?.data)
      .filter((source): source is Extract<WorkflowNodeData, { kind: "text-input" }> => source?.kind === "text-input")
      .map((source) => source.text.trim())
      .filter(Boolean);
    if (upstreamText.length > 0) {
      const ownPrompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
      params.prompt = [...upstreamText, ownPrompt].filter(Boolean).join("\n\n");
    }
    if (data.kind === "fabric-recolor") {
      const paletteEdge = edges.find((edge) => edge.target === id && edge.targetHandle === "palette");
      const paletteNode = paletteEdge ? nodeMap.get(paletteEdge.source) : undefined;
      if (paletteNode?.data.kind === "color-palette") {
        params.colors = paletteNode.data.swatches.map((swatch) => swatch.value);
        params.paletteSourceNodeId = paletteNode.id;
      }
    }
    if (data.kind === "virtual-try-on" && data.workflowStage === "garment-refine") {
      const baselineEdge = edges.find((edge) => edge.target === id && edge.targetHandle === "baseline");
      const approvalNode = baselineEdge ? nodeMap.get(baselineEdge.source) : undefined;
      const candidateEdge = approvalNode?.data.kind === "stage-approval"
        ? edges.find((edge) => edge.target === approvalNode.id && edge.targetHandle === "baseline-candidate")
        : undefined;
      const candidateNode = candidateEdge ? nodeMap.get(candidateEdge.source) : undefined;
      const currentRef = candidateNode ? extractOutputImages(candidateNode.data)[0] : undefined;
      const currentRevision = candidateNode?.data.kind === "virtual-try-on"
        && candidateNode.data.workflowStage === "scene-stabilize"
        ? candidateNode.data.basisRevision ?? 0
        : undefined;
      const approved = approvalNode?.data.kind === "stage-approval"
        && candidateNode
        && currentRef
        && approvalNode.data.approvedSourceNodeId === candidateNode.id
        && approvalNode.data.approvedBaselineRef === currentRef
        && approvalNode.data.approvedBasisRevision === currentRevision;
      params.baselineApprovalValid = Boolean(approved);
      params.approvedBaselineRef = approved ? currentRef : approvalNode?.data.kind === "stage-approval"
        ? approvalNode.data.approvedBaselineRef
        : undefined;
    }

    return {
      nodeId: id,
      kind: data.kind,
      inputImages: upstream.flatMap((u) => u.images),
      upstream,
      params,
    };
  });

  return { steps };
}

/** 从节点 data 提取该节点当前已知的输出图片 */
function extractOutputImages(data: WorkflowNodeData): string[] {
  switch (data.kind) {
    case "image-input":
      return data.imageUrl ? [data.imageUrl] : [];
    case "drawing-board":
      return data.previewImageRef ? [data.previewImageRef] : [];
    case "stage-approval":
      return data.approvedBaselineRef ? [data.approvedBaselineRef] : [];
    case "video-input":
      return data.videoUrl ? [data.videoUrl] : [];
    case "text-input":
    case "color-palette":
      return [];
    case "sketch-to-render":
    case "ai-modify":
    case "fabric-recolor":
    case "upscale":
    case "print-extract":
    case "print-mutate":
    case "virtual-try-on":
    case "mask-redraw":
    case "video-generate":
      return data.outputImages ?? [];
    case "result":
      return data.images ?? [];
  }
}

/** 提取节点执行参数（prompt / aspectRatio / batchSize / fabricImageUrl 等） */
function extractParams(data: WorkflowNodeData): Record<string, unknown> {
  const modelFields = (preferredAspectRatio = "1:1") => {
    if (!NODE_SPECS[data.kind].providerId) return {};
    const modelId = "modelId" in data && isImageModelId(data.modelId)
      ? data.modelId
      : data.kind === "mask-redraw" || data.kind === "virtual-try-on"
        ? MASK_REDRAW_MODEL_ID
        : DEFAULT_GENERATION_MODEL_ID;
    return {
      modelId,
      modelOptions: "modelOptions" in data && data.modelOptions
        ? data.modelOptions
        : defaultImageModelOptions(modelId, preferredAspectRatio),
    };
  };
  switch (data.kind) {
    case "image-input":
      return { imageUrl: data.imageUrl, imageRole: data.imageRole };
    case "text-input":
      return { text: data.text };
    case "drawing-board":
      return {
        boardVersion: data.boardVersion,
        contentRef: data.contentRef,
        previewImageRef: data.previewImageRef,
      };
    case "color-palette":
      return { colors: data.swatches.map((swatch) => swatch.value) };
    case "stage-approval":
      return {
        approvalKind: data.approvalKind,
        approvedSourceNodeId: data.approvedSourceNodeId,
        approvedBaselineRef: data.approvedBaselineRef,
        approvedBasisRevision: data.approvedBasisRevision,
        approvedAt: data.approvedAt,
      };
    case "video-input":
      return { videoUrl: data.videoUrl, mimeType: data.mimeType };
    case "video-generate":
      return {
        mode: data.mode,
        prompt: data.prompt,
        videoModel: data.videoModel,
        quality: data.quality,
        aspectRatio: data.aspectRatio,
        resolution: data.resolution,
        seconds: data.seconds,
      };
    case "sketch-to-render":
      return {
        prompt: data.prompt, aspectRatio: data.aspectRatio, batchSize: data.batchSize,
        ...modelFields(data.aspectRatio),
      };
    case "ai-modify":
      return {
        prompt: data.prompt, aspectRatio: data.aspectRatio, batchSize: data.batchSize,
        ...modelFields(data.aspectRatio),
      };
    case "fabric-recolor":
      return {
        operationMode: data.operationMode,
        prompt: data.prompt,
        colors: data.colors,
        fabricImageUrl: data.fabricImageUrl,
        ...modelFields(),
      };
    case "upscale":
      return { imageSize: data.imageSize, ...modelFields() };
    case "print-extract":
      return { prompt: data.prompt, ...modelFields() };
    case "print-mutate":
      return { prompt: data.prompt, count: data.count, ...modelFields() };
    case "virtual-try-on":
      return {
        workflowStage: data.workflowStage,
        prompt: data.prompt,
        imageSize: data.imageSize,
        aspectRatio: data.aspectRatio,
        garmentCategory: data.garmentCategory,
        materialSpec: data.materialSpec,
        constructionSpec: data.constructionSpec,
        basisRevision: data.basisRevision,
        ...modelFields(),
      };
    case "mask-redraw":
      return {
        prompt: data.prompt, mask: data.mask, maskSourceRef: data.maskSourceRef,
        maskPipelineVersion: MASK_PIPELINE_VERSION,
        modelId: MASK_REDRAW_MODEL_ID, modelOptions: {},
      };
    case "result":
      return { note: data.note };
  }
}

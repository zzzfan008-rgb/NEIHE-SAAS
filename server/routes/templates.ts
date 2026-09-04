/**
 * 工作流模板（JSON 文件存储）：
 *   GET    /api/templates      → WorkflowTemplate[]（内置在前，用户模板按 createdAt 倒序）
 *   GET    /api/templates/:id  → 单个模板
 *   POST   /api/templates      { name, description?, thumbnail?, flow } → { ok, id }
 *   DELETE /api/templates/:id  → 删除用户模板；内置模板返回 403
 * 内置模板存 data/templates/builtin/（启动时增量补齐），用户模板存 data/templates/user/
 */
import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { config } from "../config";
import { writeJsonAtomicSync } from "../lib/atomicJson";
import { validateAndMigrateFlow, WorkflowValidationError } from "../lib/workflowSchema";
import { isLocalImageReference } from "../lib/imageValidation";
import { thumbnailUrlForImage } from "../lib/fileStore";
import { requestUser } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { transaction } from "../lib/database";
import { lockActiveOwner, lockActiveOwnerMutation } from "../lib/ownerMutation";
import { purgeExpiredUserTemplates } from "../lib/userTemplateLifecycle";
import { WORKFLOW_SCHEMA_VERSION, type PersistedWorkflow, type WorkflowTemplate } from "../../src/types/workflow";
import {
  DEFAULT_GENERATION_MODEL_ID,
  defaultImageModelOptions,
} from "../../src/types/imageModels";

export const templatesRouter = Router();

interface StoredWorkflowTemplate extends WorkflowTemplate {
  deletedAt?: string;
  purgeAfter?: string;
}

function sanitizeTemplateFlow(flow: PersistedWorkflow): PersistedWorkflow {
  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      const data = { ...node.data } as Record<string, unknown>;
      delete data.error;
      if (node.data.kind === "image-input") delete data.imageUrl;
      if (node.data.kind === "drawing-board") {
        delete data.contentRef;
        delete data.previewImageRef;
        delete data.exportImageRef;
      }
      if (node.data.kind === "stage-approval") {
        delete data.approvedSourceNodeId;
        delete data.approvedBaselineRef;
        delete data.approvedBasisRevision;
        delete data.approvedAt;
      }
      if ("outputImages" in data) data.outputImages = [];
      if (node.data.kind === "result") data.images = [];
      if (node.data.kind === "fabric-recolor") delete data.fabricImageUrl;
      if (node.data.kind === "mask-redraw") {
        delete data.mask;
        delete data.maskSourceRef;
      }
      if (node.data.kind === "print-extract") data.savedAsAssets = [];
      return { ...node, data: data as typeof node.data };
    }),
  };
}

function templatesDir(sub: "builtin" | "user"): string {
  const dir = path.join(config.dataDir(), "templates", sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function templatePath(sub: "builtin" | "user", id: string): string {
  return path.join(templatesDir(sub), `${path.basename(id)}.json`);
}

// ---------- 内置模板（flow 为 React Flow 格式，data 默认值同前端 flowStore.defaultNodeData）----------
const BUILTIN_CREATED_AT = "2026-08-05T00:00:00.000Z";

function dualModelStagedTryOnTemplate(): WorkflowTemplate {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: "builtin-dual-model-staged-try-on",
    name: "双模型分步换装（场景表演定版→服装精修）",
    description: "Gemini 第一轮锁定人物身份、场景表演、主穿搭和六类可选配饰；人工确认基准后，GPT Image 2 按必填面料与工艺精修服装。",
    builtIn: true,
    createdAt: "2026-09-03T00:00:00.000Z",
    flow: {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes: [
        {
          id: "person",
          type: "image-input",
          position: { x: 0, y: -560 },
          data: { kind: "image-input", label: "人物身份图（必需）", status: "idle", imageRole: "reference" },
        },
        {
          id: "scene",
          type: "image-input",
          position: { x: 0, y: -300 },
          data: { kind: "image-input", label: "场景/表演参考图（必需）", status: "idle", imageRole: "reference" },
        },
        {
          id: "outfit",
          type: "image-input",
          position: { x: 0, y: -40 },
          data: { kind: "image-input", label: "主穿搭图（必需）", status: "idle", imageRole: "garment" },
        },
        {
          id: "bag",
          type: "image-input",
          position: { x: 300, y: -560 },
          data: { kind: "image-input", label: "包袋参考图（可选）", status: "idle", imageRole: "reference" },
        },
        {
          id: "shoes",
          type: "image-input",
          position: { x: 300, y: -300 },
          data: { kind: "image-input", label: "鞋履参考图（可选）", status: "idle", imageRole: "reference" },
        },
        {
          id: "hat",
          type: "image-input",
          position: { x: 300, y: -40 },
          data: { kind: "image-input", label: "帽子参考图（可选）", status: "idle", imageRole: "reference" },
        },
        {
          id: "ring",
          type: "image-input",
          position: { x: 300, y: 220 },
          data: { kind: "image-input", label: "戒指参考图（可选）", status: "idle", imageRole: "reference" },
        },
        {
          id: "earrings",
          type: "image-input",
          position: { x: 300, y: 480 },
          data: { kind: "image-input", label: "耳环参考图（可选）", status: "idle", imageRole: "reference" },
        },
        {
          id: "bracelet",
          type: "image-input",
          position: { x: 300, y: 740 },
          data: { kind: "image-input", label: "手镯参考图（可选）", status: "idle", imageRole: "reference" },
        },
        {
          id: "stabilize",
          type: "virtual-try-on",
          position: { x: 650, y: -120 },
          data: {
            kind: "virtual-try-on",
            label: "第一轮 · Gemini 场景化定版",
            status: "idle",
            workflowStage: "scene-stabilize",
            prompt: "",
            modelId: "gemini-3.1-flash-image-preview",
            modelOptions: { aspectRatio: "3:4", imageSize: "2K" },
            imageSize: "2K",
            aspectRatio: "3:4",
            basisRevision: 0,
            outputImages: [],
          },
        },
        {
          id: "approval",
          type: "stage-approval",
          position: { x: 980, y: -120 },
          data: {
            kind: "stage-approval",
            label: "确认第一轮人物与场景基准",
            status: "idle",
            approvalKind: "scene-baseline",
          },
        },
        {
          id: "material",
          type: "image-input",
          position: { x: 720, y: 420 },
          data: { kind: "image-input", label: "第二轮 · 面料/纱线参考（可选）", status: "idle", imageRole: "fabric" },
        },
        {
          id: "garment-detail",
          type: "image-input",
          position: { x: 720, y: 680 },
          data: { kind: "image-input", label: "第二轮 · 服装局部结构参考（可选）", status: "idle", imageRole: "garment" },
        },
        {
          id: "refine",
          type: "virtual-try-on",
          position: { x: 1320, y: -120 },
          data: {
            kind: "virtual-try-on",
            label: "第二轮 · GPT 服装还原与精修",
            status: "idle",
            workflowStage: "garment-refine",
            prompt: "",
            modelId: "gpt-image-2",
            modelOptions: { quality: "medium" },
            imageSize: "2K",
            aspectRatio: "3:4",
            garmentCategory: "knit",
            materialSpec: "",
            constructionSpec: "",
            outputImages: [],
          },
        },
        {
          id: "guide",
          type: "text-input",
          position: { x: 1080, y: 430 },
          data: {
            kind: "text-input",
            label: "使用步骤",
            status: "idle",
            text: "① 上传人物、场景和主穿搭必需图。② 按需上传包、鞋、帽子、戒指、耳环、手镯；未提供的类别不会写入约束。③ 运行第一轮并在独立节点确认基准。④ 在右侧属性中选择针织/梭织/其他，填写材料规格与结构工艺。⑤ 面料和服装局部图只供第二轮使用，确认后运行 GPT 精修。",
          },
        },
      ],
      edges: [
        { id: "person-stabilize", source: "person", target: "stabilize", sourceHandle: "image", targetHandle: "person" },
        { id: "scene-stabilize", source: "scene", target: "stabilize", sourceHandle: "image", targetHandle: "scene" },
        { id: "outfit-stabilize", source: "outfit", target: "stabilize", sourceHandle: "image", targetHandle: "outfit" },
        { id: "bag-stabilize", source: "bag", target: "stabilize", sourceHandle: "image", targetHandle: "bag" },
        { id: "shoes-stabilize", source: "shoes", target: "stabilize", sourceHandle: "image", targetHandle: "shoes" },
        { id: "hat-stabilize", source: "hat", target: "stabilize", sourceHandle: "image", targetHandle: "hat" },
        { id: "ring-stabilize", source: "ring", target: "stabilize", sourceHandle: "image", targetHandle: "ring" },
        { id: "earrings-stabilize", source: "earrings", target: "stabilize", sourceHandle: "image", targetHandle: "earrings" },
        { id: "bracelet-stabilize", source: "bracelet", target: "stabilize", sourceHandle: "image", targetHandle: "bracelet" },
        { id: "stabilize-approval", source: "stabilize", target: "approval", sourceHandle: "image", targetHandle: "baseline-candidate" },
        { id: "approval-refine", source: "approval", target: "refine", sourceHandle: "image", targetHandle: "baseline" },
        { id: "outfit-refine", source: "outfit", target: "refine", sourceHandle: "image", targetHandle: "outfit" },
        { id: "material-refine", source: "material", target: "refine", sourceHandle: "image", targetHandle: "material" },
        { id: "garment-detail-refine", source: "garment-detail", target: "refine", sourceHandle: "image", targetHandle: "detail" },
      ],
    },
  };
}

function toolWorkflowTemplates(): WorkflowTemplate[] {
  const image = (id: string, label: string, x: number, y: number, imageRole: "default" | "sketch" | "garment" | "fabric" | "reference" = "reference") => ({
    id, type: "image-input" as const, position: { x, y }, data: { kind: "image-input" as const, label, status: "idle" as const, imageRole },
  });
  const text = (id: string, label: string, x: number, y: number, value = "") => ({
    id, type: "text-input" as const, position: { x, y }, data: { kind: "text-input" as const, label, status: "idle" as const, text: value },
  });
  const imageGenerator = (id: string, kind: "sketch-to-render" | "ai-modify" | "print-extract" | "print-mutate", label: string, x: number, y: number, prompt = "") => ({
    id, type: kind as typeof kind, position: { x, y }, data: kind === "sketch-to-render"
      ? { kind, label, status: "idle" as const, prompt, aspectRatio: "3:4", batchSize: 1 as const, outputImages: [], modelId: DEFAULT_GENERATION_MODEL_ID, modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID, "3:4") }
      : kind === "ai-modify"
        ? { kind, label, status: "idle" as const, prompt, aspectRatio: "3:4", batchSize: 1 as const, outputImages: [], modelId: DEFAULT_GENERATION_MODEL_ID, modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID, "3:4") }
        : kind === "print-extract"
          ? { kind, label, status: "idle" as const, prompt, outputImages: [], savedAsAssets: [], modelId: DEFAULT_GENERATION_MODEL_ID, modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID) }
          : { kind, label, status: "idle" as const, prompt, count: 4, outputImages: [], modelId: DEFAULT_GENERATION_MODEL_ID, modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID) },
  });
  const template = (id: string, name: string, description: string, nodes: PersistedWorkflow["nodes"], edges: PersistedWorkflow["edges"]): WorkflowTemplate => ({
    schemaVersion: WORKFLOW_SCHEMA_VERSION, id, name, description, builtIn: true, createdAt: "2026-09-03T08:00:00.000Z",
    flow: { schemaVersion: WORKFLOW_SCHEMA_VERSION, nodes, edges },
  });
  const videoGenerator = (id: string, label: string, mode: "text-to-video" | "keyframes-to-video" | "multi-image-video" | "video-to-video", x = 760, y = 0) => ({
    id, type: "video-generate" as const, position: { x, y }, data: { kind: "video-generate" as const, label, status: "idle" as const, mode, prompt: "", videoModel: "veo-3.1" as const, quality: "fast" as const, aspectRatio: "16:9" as const, resolution: "720p" as const, seconds: 8 as const, outputImages: [] },
  });
  return [
    template("builtin-tool-sketch-render", "草图到效果图", "上传草图并渲染；成功后自动创建结果节点。", [image("sketch", "服装草图", 0, 0, "sketch"), imageGenerator("generate", "sketch-to-render", "草图渲染", 380, 0)], [{ id: "sketch-generate", source: "sketch", sourceHandle: "image", target: "generate", targetHandle: "references" }]),
    template("builtin-tool-ai-modify", "AI 改款", "款式图与改款要求已连接；成功后自动创建结果节点。", [image("garment", "原款式图", 0, -120, "garment"), text("prompt", "改款要求", 0, 180), imageGenerator("generate", "ai-modify", "AI 改款", 420, 0)], [{ id: "garment-generate", source: "garment", sourceHandle: "image", target: "generate", targetHandle: "references" }, { id: "prompt-generate", source: "prompt", sourceHandle: "text", target: "generate", targetHandle: "prompt" }]),
    template("builtin-tool-fabric-replace", "面料替换", "主服装与面料参考同时连接到替换节点。", [image("garment", "主服装图", 0, -120, "garment"), image("fabric", "目标面料图", 0, 180, "fabric"), { id: "generate", type: "fabric-recolor", position: { x: 420, y: 0 }, data: { kind: "fabric-recolor", label: "面料替换", status: "idle", operationMode: "fabric", colors: [], prompt: "保持服装版型、结构、配饰和构图，仅替换为目标面料的纹理、光泽、厚薄与垂感。", outputImages: [], modelId: DEFAULT_GENERATION_MODEL_ID, modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID) } }], [{ id: "garment-generate", source: "garment", sourceHandle: "image", target: "generate", targetHandle: "references" }, { id: "fabric-generate", source: "fabric", sourceHandle: "image", target: "generate", targetHandle: "references" }]),
    template("builtin-tool-color-replace", "配色替换", "主服装与目标色板已连接。", [image("garment", "主服装图", 0, -100, "garment"), { id: "palette", type: "color-palette", position: { x: 0, y: 180 }, data: { kind: "color-palette", label: "目标色板", status: "idle", paletteVersion: 1, swatches: [{ id: "black", value: "#000000", source: "quick" }] } }, { id: "generate", type: "fabric-recolor", position: { x: 420, y: 0 }, data: { kind: "fabric-recolor", label: "配色替换", status: "idle", operationMode: "color", colors: ["#000000"], prompt: "", outputImages: [], modelId: DEFAULT_GENERATION_MODEL_ID, modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID) } }], [{ id: "garment-generate", source: "garment", sourceHandle: "image", target: "generate", targetHandle: "references" }, { id: "palette-generate", source: "palette", sourceHandle: "colors", target: "generate", targetHandle: "palette" }]),
    template("builtin-tool-print-extract", "印花提取", "从上传图中提取可复用印花。", [image("source", "印花来源图", 0, 0), imageGenerator("generate", "print-extract", "印花提取", 380, 0)], [{ id: "source-generate", source: "source", sourceHandle: "image", target: "generate", targetHandle: "references" }]),
    template("builtin-tool-print-mutate", "印花裂变", "原始印花与裂变方向已连接。", [image("source", "原始印花", 0, -120), text("prompt", "裂变方向", 0, 180), imageGenerator("generate", "print-mutate", "印花裂变", 420, 0)], [{ id: "source-generate", source: "source", sourceHandle: "image", target: "generate", targetHandle: "references" }, { id: "prompt-generate", source: "prompt", sourceHandle: "text", target: "generate", targetHandle: "prompt" }]),
    template("builtin-tool-white-background", "白底图制作", "上传主体后制作纯白背景图。", [image("source", "商品或模特图", 0, 0), imageGenerator("generate", "ai-modify", "白底图制作", 380, 0, "保持主体外观、人物身份、服装和配饰细节，移除原背景，生成干净均匀的纯白背景与自然接触阴影。")], [{ id: "source-generate", source: "source", sourceHandle: "image", target: "generate", targetHandle: "references" }]),
    template("builtin-tool-one-click-try-on", "一键换装", "人物身份图与主穿搭图连接到固定引擎换装节点。", [image("person", "人物身份图", 0, -140, "reference"), image("outfit", "主穿搭图", 0, 180, "garment"), { id: "generate", type: "virtual-try-on", position: { x: 430, y: 0 }, data: { kind: "virtual-try-on", label: "一键换装", status: "idle", workflowStage: "standard", prompt: "", modelId: "gpt-image-2", modelOptions: {}, imageSize: "2K", aspectRatio: "3:4", basisRevision: 0, outputImages: [] } }], [{ id: "person-generate", source: "person", sourceHandle: "image", target: "generate", targetHandle: "references" }, { id: "outfit-generate", source: "outfit", sourceHandle: "image", target: "generate", targetHandle: "references" }]),
    template("builtin-tool-style-transfer", "风格迁移", "主体、风格参考和可选要求已连接。", [image("source", "目标主体图", 0, -180), image("style", "风格参考图", 0, 80), text("prompt", "补充要求", 0, 340), imageGenerator("generate", "ai-modify", "风格迁移", 430, 0, "只迁移参考图的视觉语言、材质、色彩与光影；保持目标主体的身份、结构和构图，不复制风格图中的人物、服装或配饰。")], [{ id: "source-generate", source: "source", sourceHandle: "image", target: "generate", targetHandle: "references" }, { id: "style-generate", source: "style", sourceHandle: "image", target: "generate", targetHandle: "references" }, { id: "prompt-generate", source: "prompt", sourceHandle: "text", target: "generate", targetHandle: "prompt" }]),
    template("builtin-tool-text-to-video", "文生视频", "文字提示连接真实视频生成节点。", [text("prompt", "视频提示词", 0, 0), videoGenerator("generate", "文生视频", "text-to-video", 420, 0)], [{ id: "prompt-generate", source: "prompt", sourceHandle: "text", target: "generate", targetHandle: "prompt" }]),
    template("builtin-tool-keyframes-to-video", "首尾帧生视频", "首帧、尾帧和提示词按角色连接。", [image("first", "首帧", 0, -220), image("last", "尾帧", 0, 60), text("prompt", "视频提示词", 0, 340), videoGenerator("generate", "首尾帧生视频", "keyframes-to-video", 430, 0)], [{ id: "first-generate", source: "first", sourceHandle: "image", target: "generate", targetHandle: "first-frame" }, { id: "last-generate", source: "last", sourceHandle: "image", target: "generate", targetHandle: "last-frame" }, { id: "prompt-generate", source: "prompt", sourceHandle: "text", target: "generate", targetHandle: "prompt" }]),
    template("builtin-tool-multi-image-video", "多图参考生视频", "当前真实通道使用两张有序参考图建立连续性。", [image("first", "参考图一", 0, -220), image("last", "参考图二", 0, 60), text("prompt", "视频提示词", 0, 340), videoGenerator("generate", "多图参考生视频", "multi-image-video", 430, 0)], [{ id: "first-generate", source: "first", sourceHandle: "image", target: "generate", targetHandle: "first-frame" }, { id: "last-generate", source: "last", sourceHandle: "image", target: "generate", targetHandle: "last-frame" }, { id: "prompt-generate", source: "prompt", sourceHandle: "text", target: "generate", targetHandle: "prompt" }]),
    template("builtin-tool-video-to-video", "视频生视频", "上传源视频并通过首帧重制生成新镜头。", [{ id: "source", type: "video-input", position: { x: 0, y: -100 }, data: { kind: "video-input", label: "源视频", status: "idle" } }, text("prompt", "重制要求", 0, 220), videoGenerator("generate", "视频生视频", "video-to-video", 430, 0)], [{ id: "source-generate", source: "source", sourceHandle: "video", target: "generate", targetHandle: "source-video" }, { id: "prompt-generate", source: "prompt", sourceHandle: "text", target: "generate", targetHandle: "prompt" }]),
  ];
}

function builtinTemplates(): WorkflowTemplate[] {
  return [
    dualModelStagedTryOnTemplate(),
    ...toolWorkflowTemplates(),
    {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id: "builtin-sketch-recolor",
      name: "草图→效果图→改款→多配色",
      description: "上传草图，渲染效果图后 AI 改款，再按配色批量出图",
      builtIn: true,
      createdAt: BUILTIN_CREATED_AT,
      flow: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          {
            id: "n1",
            type: "image-input",
            position: { x: 0, y: 0 },
            data: { kind: "image-input", label: "图片上传", status: "idle", imageRole: "sketch" },
          },
          {
            id: "n2",
            type: "sketch-to-render",
            position: { x: 380, y: 0 },
            data: {
              kind: "sketch-to-render",
              label: "草图→效果图",
              status: "idle",
              prompt: "",
              aspectRatio: "3:4",
              batchSize: 1,
              outputImages: [],
              modelId: DEFAULT_GENERATION_MODEL_ID,
              modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID, "3:4"),
            },
          },
          {
            id: "n3",
            type: "ai-modify",
            position: { x: 760, y: 0 },
            data: {
              kind: "ai-modify",
              label: "AI 改款",
              status: "idle",
              prompt: "",
              aspectRatio: "1:1",
              batchSize: 1,
              outputImages: [],
              modelId: DEFAULT_GENERATION_MODEL_ID,
              modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID, "1:1"),
            },
          },
          {
            id: "n4",
            type: "fabric-recolor",
            position: { x: 1140, y: 0 },
            data: {
              kind: "fabric-recolor",
              label: "面料/配色替换",
              status: "idle",
              operationMode: "combined",
              colors: [],
              prompt: "",
              outputImages: [],
              modelId: DEFAULT_GENERATION_MODEL_ID,
              modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID),
            },
          },
        ],
        edges: [
          { id: "e1", source: "n1", target: "n2" },
          { id: "e2", source: "n2", target: "n3" },
          { id: "e3", source: "n3", target: "n4" },
        ],
      },
    },
    {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id: "builtin-sketch-upscale",
      name: "草图→效果图→高清放大",
      description: "上传草图渲染效果图，再放大至 2K/4K 精修细节",
      builtIn: true,
      createdAt: BUILTIN_CREATED_AT,
      flow: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          {
            id: "n1",
            type: "image-input",
            position: { x: 0, y: 0 },
            data: { kind: "image-input", label: "图片上传", status: "idle", imageRole: "sketch" },
          },
          {
            id: "n2",
            type: "sketch-to-render",
            position: { x: 380, y: 0 },
            data: {
              kind: "sketch-to-render",
              label: "草图→效果图",
              status: "idle",
              prompt: "",
              aspectRatio: "3:4",
              batchSize: 1,
              outputImages: [],
              modelId: DEFAULT_GENERATION_MODEL_ID,
              modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID, "3:4"),
            },
          },
          {
            id: "n3",
            type: "upscale",
            position: { x: 760, y: 0 },
            data: {
              kind: "upscale",
              label: "高清放大",
              status: "idle",
              imageSize: "2K",
              outputImages: [],
              modelId: DEFAULT_GENERATION_MODEL_ID,
              modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID),
            },
          },
        ],
        edges: [
          { id: "e1", source: "n1", target: "n2" },
          { id: "e2", source: "n2", target: "n3" },
        ],
      },
    },
    {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id: "builtin-text-recolor",
      name: "文生款式→多配色",
      description: "纯提示词文生款式效果图，再按配色批量出图",
      builtIn: true,
      createdAt: BUILTIN_CREATED_AT,
      flow: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          {
            id: "n1",
            type: "sketch-to-render",
            position: { x: 0, y: 0 },
            data: {
              kind: "sketch-to-render",
              label: "草图→效果图",
              status: "idle",
              prompt: "设计一款简约通勤风女装连衣裙，正面全身效果图，浅灰纯色背景",
              aspectRatio: "3:4",
              batchSize: 1,
              outputImages: [],
              modelId: DEFAULT_GENERATION_MODEL_ID,
              modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID, "3:4"),
            },
          },
          {
            id: "n2",
            type: "fabric-recolor",
            position: { x: 380, y: 0 },
            data: {
              kind: "fabric-recolor",
              label: "面料/配色替换",
              status: "idle",
              operationMode: "combined",
              colors: [],
              prompt: "",
              outputImages: [],
              modelId: DEFAULT_GENERATION_MODEL_ID,
              modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID),
            },
          },
        ],
        edges: [{ id: "e1", source: "n1", target: "n2" }],
      },
    },
    {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id: "builtin-text-to-image",
      name: "文生图（服装设计）",
      description: "输入款式、面料、色彩、模特、场景与摄影要求，直接生成服装设计效果图",
      builtIn: true,
      createdAt: "2026-08-13T00:00:00.000Z",
      flow: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          {
            id: "generate",
            type: "sketch-to-render",
            position: { x: 0, y: 0 },
            data: {
              kind: "sketch-to-render",
              label: "文生图",
              status: "idle",
              prompt: "设计一套现代都市女装：廓形利落的短款西装搭配高腰阔腿长裤，使用有细腻垂坠感的深灰羊毛混纺面料，局部加入哑光黑色皮革滚边；年轻亚洲女模特全身站姿，正面略微侧身，服装结构、面料纹理和缝线细节清晰；极简浅灰摄影棚背景，柔和侧光，高级时装品牌 Lookbook 风格，写实摄影，高质感，画面干净，无文字、无水印。",
              aspectRatio: "3:4",
              batchSize: 1,
              outputImages: [],
              modelId: DEFAULT_GENERATION_MODEL_ID,
              modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID, "3:4"),
            },
          },
          {
            id: "result",
            type: "result",
            position: { x: 430, y: 0 },
            data: {
              kind: "result",
              label: "生成结果",
              status: "idle",
              images: [],
              note: "可修改提示词、画幅比例和生成数量后重新生成",
            },
          },
        ],
        edges: [{ id: "generate-to-result", source: "generate", target: "result" }],
      },
    },
    {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id: "builtin-person-scene-transfer",
      name: "人物场景迁移（人物→背景/座椅）",
      description: "上传图1人物与图2场景，将人物保真迁移到场景中并匹配座椅、姿态、光影与透视",
      builtIn: true,
      createdAt: "2026-08-13T00:00:00.000Z",
      flow: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          {
            id: "subject",
            type: "image-input",
            position: { x: 0, y: -170 },
            data: {
              kind: "image-input",
              label: "图1 · 人物主体",
              status: "idle",
              imageRole: "garment",
            },
          },
          {
            id: "scene",
            type: "image-input",
            position: { x: 0, y: 190 },
            data: {
              kind: "image-input",
              label: "图2 · 场景背景",
              status: "idle",
              imageRole: "reference",
            },
          },
          {
            id: "transfer",
            type: "ai-modify",
            position: { x: 430, y: 0 },
            data: {
              kind: "ai-modify",
              label: "人物场景迁移",
              status: "idle",
              prompt: "严格按照输入顺序处理：图1是需要保留的人物主体，图2是目标场景。将图1中的同一人物完整迁移到图2的背景中，并让人物自然坐在图2的椅子上。保持图1人物的脸部身份、发型、体型、服装款式、颜色与材质细节不变；保持图2的背景、椅子、构图与空间陈设不变。根据椅子的朝向和高度调整人物坐姿、肢体遮挡、比例与透视，使身体与椅面正确接触，补充自然的接触阴影，并统一光线方向、色温、景深与画面质感。不要复制图2中的人物，不要改变人物身份，不要新增多余人物或家具。输出一张真实、自然、无拼贴痕迹的完整图片。",
              aspectRatio: "3:4",
              batchSize: 1,
              outputImages: [],
              modelId: DEFAULT_GENERATION_MODEL_ID,
              modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID, "3:4"),
            },
          },
          {
            id: "result",
            type: "result",
            position: { x: 860, y: 0 },
            data: {
              kind: "result",
              label: "迁移结果",
              status: "idle",
              images: [],
              note: "人物来自图1，场景与椅子来自图2",
            },
          },
        ],
        edges: [
          { id: "subject-to-transfer", source: "subject", target: "transfer" },
          { id: "scene-to-transfer", source: "scene", target: "transfer" },
          { id: "transfer-to-result", source: "transfer", target: "result" },
        ],
      },
    },
    {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id: "builtin-pattern-style-transfer",
      name: "图案风格迁移（图案→参考风格）",
      description: "保留图1的主题与构图，使用图2的材料、工艺、色彩和视觉语言重新演绎",
      builtIn: true,
      createdAt: "2026-08-13T00:00:00.000Z",
      flow: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          {
            id: "pattern",
            type: "image-input",
            position: { x: 0, y: -170 },
            data: {
              kind: "image-input",
              label: "图1 · 原始图案",
              status: "idle",
              imageRole: "garment",
            },
          },
          {
            id: "style",
            type: "image-input",
            position: { x: 0, y: 190 },
            data: {
              kind: "image-input",
              label: "图2 · 风格参考",
              status: "idle",
              imageRole: "reference",
            },
          },
          {
            id: "transfer",
            type: "ai-modify",
            position: { x: 430, y: 0 },
            data: {
              kind: "ai-modify",
              label: "图案风格迁移",
              status: "idle",
              prompt: "严格按照输入顺序处理：图1是必须保留的原始图案，图2是仅用于学习材料、工艺、色彩和视觉语言的风格参考。保留图1的主题元素、数量、构图布局、轮廓比例和主要识别特征，将它们重新演绎为图2的面料纹理、手工工艺、笔触、配色和质感。不要复制图2的主体或构图，不要丢失图1的主体，不要新增无关文字、水印或元素。输出完整、清晰、可用于服装印花的单张图案。",
              aspectRatio: "3:4",
              batchSize: 1,
              outputImages: [],
              modelId: DEFAULT_GENERATION_MODEL_ID,
              modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID, "3:4"),
            },
          },
          {
            id: "result",
            type: "result",
            position: { x: 860, y: 0 },
            data: {
              kind: "result",
              label: "迁移结果",
              status: "idle",
              images: [],
              note: "图案主题来自图1，材料、工艺与视觉风格来自图2",
            },
          },
        ],
        edges: [
          { id: "pattern-to-transfer", source: "pattern", target: "transfer" },
          { id: "style-to-transfer", source: "style", target: "transfer" },
          { id: "transfer-to-result", source: "transfer", target: "result" },
        ],
      },
    },
  ];
}

function builtinTemplateIsReadable(filePath: string): boolean {
  try {
    readTemplateFile(filePath);
    return true;
  } catch {
    return false;
  }
}

function managedBuiltinNeedsRefresh(filePath: string, templateId: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      schemaVersion?: unknown;
      flow?: { edges?: Array<{ id?: unknown; targetHandle?: unknown }> };
    };
    if (templateId === "builtin-dual-model-staged-try-on") {
      const named = raw as typeof raw & { name?: unknown };
      return raw.schemaVersion !== WORKFLOW_SCHEMA_VERSION
        || named.name !== "双模型分步换装（场景表演定版→服装精修）";
    }
    return false;
  } catch {
    return true;
  }
}

/** 启动时补齐新增模板；保留可读旧版本，并用当前定义修复损坏或不兼容的内置文件。 */
export function ensureBuiltinTemplates(): void {
  // 旧版模板已拆分为两个明确模板；它是部署内置数据，不属于用户模板。
  fs.rmSync(templatePath("builtin", "builtin-style-transfer"), { force: true });
  for (const tpl of builtinTemplates()) {
    const filePath = templatePath("builtin", tpl.id);
    if (!fs.existsSync(filePath) || !builtinTemplateIsReadable(filePath) || managedBuiltinNeedsRefresh(filePath, tpl.id)) {
      writeJsonAtomicSync(filePath, tpl);
    }
  }
}

ensureBuiltinTemplates();

function readTemplates(sub: "builtin" | "user"): StoredWorkflowTemplate[] {
  if (sub === "user") purgeExpiredUserTemplates();
  const dir = templatesDir(sub);
  const list: StoredWorkflowTemplate[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const template = readTemplateFile(path.join(dir, f));
      if (sub === "user" && template.deletedAt) continue;
      list.push(template);
    } catch {
      // 跳过损坏文件
    }
  }
  return list;
}

function readTemplateFile(filePath: string): StoredWorkflowTemplate {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  const isLegacyVersion = raw.schemaVersion === undefined || raw.schemaVersion === 0 || raw.schemaVersion === 1 || raw.schemaVersion === 2 || raw.schemaVersion === 3 || raw.schemaVersion === 4 || raw.schemaVersion === 5;
  if (!isLegacyVersion && raw.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    throw new WorkflowValidationError(`unsupported template schemaVersion: ${String(raw.schemaVersion)}`);
  }
  const flow = validateAndMigrateFlow(raw.flow);
  if (
    typeof raw.id !== "string" || !raw.id ||
    typeof raw.name !== "string" || !raw.name ||
    typeof raw.description !== "string" ||
    typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))
  ) {
    throw new WorkflowValidationError("invalid template metadata");
  }
  if (raw.thumbnail !== undefined && !isLocalImageReference(raw.thumbnail)) {
    throw new WorkflowValidationError("template thumbnail must be a local /api/files image reference");
  }
  if (raw.ownerId !== undefined && (typeof raw.ownerId !== "string" || raw.ownerId.length === 0)) {
    throw new WorkflowValidationError("invalid template owner");
  }
  for (const key of ["deletedAt", "purgeAfter"] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== "string" || !Number.isFinite(Date.parse(raw[key])))) {
      throw new WorkflowValidationError(`invalid template ${key}`);
    }
  }
  return { ...raw, schemaVersion: WORKFLOW_SCHEMA_VERSION, flow } as unknown as StoredWorkflowTemplate;
}

function templateForResponse(template: StoredWorkflowTemplate): WorkflowTemplate {
  const { deletedAt: _deletedAt, purgeAfter: _purgeAfter, ...visible } = template;
  return visible.thumbnail
    ? { ...visible, thumbnail: thumbnailUrlForImage(visible.thumbnail) }
    : visible;
}

templatesRouter.get("/", (req, res) => {
  try {
    const currentUser = requestUser(req);
    res.setHeader("Cache-Control", "no-store");
    const builtin = readTemplates("builtin");
    const user = readTemplates("user")
      .filter((template) => template.ownerId === currentUser.id || currentUser.role === "admin")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json([...builtin, ...user].map(templateForResponse));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

templatesRouter.get("/:id", (req, res) => {
  const currentUser = requestUser(req);
  res.setHeader("Cache-Control", "no-store");
  const id = req.params.id;
  const userFilePath = templatePath("user", id);
  const isUserTemplate = fs.existsSync(userFilePath);
  const filePath = isUserTemplate ? userFilePath : templatePath("builtin", id);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "template not found" });
    return;
  }
  try {
    const template = readTemplateFile(filePath);
    if (isUserTemplate && template.deletedAt) {
      res.status(404).json({ error: "template not found" });
      return;
    }
    if (isUserTemplate && template.ownerId !== currentUser.id && currentUser.role !== "admin") {
      res.status(404).json({ error: "template not found" });
      return;
    }
    res.json(templateForResponse(template));
  } catch (err) {
    res.status(err instanceof WorkflowValidationError ? 422 : 500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

templatesRouter.post("/", asyncHandler(async (req, res) => {
  const currentUser = requestUser(req);
  const { name, description, thumbnail, flow } = req.body as {
    name?: string;
    description?: string;
    thumbnail?: string;
    flow?: unknown;
  };
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 200 || flow === undefined) {
    res.status(400).json({ error: "name and flow are required" });
    return;
  }
  let createdFilePath: string | undefined;
  try {
    if (description !== undefined && typeof description !== "string") throw new WorkflowValidationError("description must be a string");
    if (thumbnail !== undefined && !isLocalImageReference(thumbnail)) {
      throw new WorkflowValidationError("thumbnail must be a local /api/files image reference");
    }
    const id = nanoid(10);
    const validatedFlow = validateAndMigrateFlow(flow);
    const template: WorkflowTemplate = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id,
      ownerId: currentUser.id,
      name: name.trim(),
      description: description ?? "",
      ...(thumbnail ? { thumbnail } : {}),
      flow: sanitizeTemplateFlow(validatedFlow),
      createdAt: new Date().toISOString(),
    };
    createdFilePath = templatePath("user", id);
    const created = await transaction(async (client) => {
      if (!await lockActiveOwner(client, currentUser.id)) return false;
      writeJsonAtomicSync(createdFilePath as string, template);
      return true;
    });
    if (!created) {
      res.status(409).json({ error: "账号状态已变化，请刷新后重试" });
      return;
    }
    res.json({ ok: true, id });
  } catch (err) {
    if (createdFilePath) fs.rmSync(createdFilePath, { force: true });
    res.status(err instanceof WorkflowValidationError ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

templatesRouter.delete("/:id", asyncHandler(async (req, res) => {
  const currentUser = requestUser(req);
  const id = req.params.id;
  if (fs.existsSync(templatePath("builtin", id))) {
    res.status(403).json({ error: "builtin template cannot be deleted" });
    return;
  }
  const filePath = templatePath("user", id);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "template not found" });
    return;
  }
  let ownerId: string | undefined;
  try {
    ownerId = readTemplateFile(filePath).ownerId;
  } catch (err) {
    res.status(err instanceof WorkflowValidationError ? 422 : 500).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!ownerId) {
    res.status(409).json({ error: "模板归属待迁移，请先重启服务" });
    return;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outcome = await transaction(async (client) => {
      if (!await lockActiveOwnerMutation(client, ownerId as string)) {
        return { status: "owner_unavailable" as const };
      }
      if (!fs.existsSync(filePath)) return { status: "not_found" as const };
      const template = readTemplateFile(filePath);
      if (template.ownerId !== ownerId) {
        return { status: "owner_changed" as const, ownerId: template.ownerId };
      }
      if (template.deletedAt) return { status: "not_found" as const };
      if (template.ownerId !== currentUser.id && currentUser.role !== "admin") {
        return { status: "not_found" as const };
      }
      fs.unlinkSync(filePath);
      return { status: "deleted" as const };
    });
    if (outcome.status === "owner_changed" && outcome.ownerId) {
      ownerId = outcome.ownerId;
      continue;
    }
    if (outcome.status === "owner_unavailable") {
      res.status(409).json({ error: "账号状态已变化，请刷新后重试" });
      return;
    }
    if (outcome.status === "not_found") {
      res.status(404).json({ error: "template not found" });
      return;
    }
    res.json({ ok: true });
    return;
  }
  res.status(409).json({ error: "模板归属正在变化，请刷新后重试" });
}));

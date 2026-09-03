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
import { WORKFLOW_SCHEMA_VERSION, type WorkflowTemplate } from "../../src/types/workflow";
import {
  DEFAULT_GENERATION_MODEL_ID,
  defaultImageModelOptions,
} from "../../src/types/imageModels";

export const templatesRouter = Router();

interface StoredWorkflowTemplate extends WorkflowTemplate {
  deletedAt?: string;
  purgeAfter?: string;
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

function builtinTemplates(): WorkflowTemplate[] {
  return [
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
          { id: "e3", source: "n3", target: "n4", targetHandle: "garment" },
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
              colors: [],
              prompt: "",
              outputImages: [],
              modelId: DEFAULT_GENERATION_MODEL_ID,
              modelOptions: defaultImageModelOptions(DEFAULT_GENERATION_MODEL_ID),
            },
          },
        ],
        edges: [{ id: "e1", source: "n1", target: "n2", targetHandle: "garment" }],
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

/** 启动时补齐新增模板；保留可读旧版本，并用当前定义修复损坏或不兼容的内置文件。 */
export function ensureBuiltinTemplates(): void {
  // 旧版模板已拆分为两个明确模板；它是部署内置数据，不属于用户模板。
  fs.rmSync(templatePath("builtin", "builtin-style-transfer"), { force: true });
  for (const tpl of builtinTemplates()) {
    const filePath = templatePath("builtin", tpl.id);
    if (!fs.existsSync(filePath) || !builtinTemplateIsReadable(filePath)) {
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
  const isLegacyVersion = raw.schemaVersion === undefined || raw.schemaVersion === 0 || raw.schemaVersion === 1 || raw.schemaVersion === 2 || raw.schemaVersion === 3;
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
    const template: WorkflowTemplate = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id,
      ownerId: currentUser.id,
      name: name.trim(),
      description: description ?? "",
      ...(thumbnail ? { thumbnail } : {}),
      flow: validateAndMigrateFlow(flow),
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

/**
 * Express 入口：cors、50mb JSON body、API 路由、生产模式托管 dist 静态文件。
 */
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { config, ROOT_DIR } from "./config";
import { generateRouter } from "./routes/generate";
import { runPlanRouter } from "./routes/runPlan";
import { outfitAnalysisRouter } from "./routes/outfitAnalysis";
import { createPoseReferencesRouter } from "./routes/poseReferences";
import { filesRouter } from "./routes/files";
import { projectsRouter } from "./routes/projects";
import { templatesRouter } from "./routes/templates";
import { drawingBoardsRouter } from "./routes/drawingBoards";
import { assetsRouter } from "./routes/assets";
import { colorsRouter } from "./routes/colors";
import { materialAnalysesRouter } from "./routes/materialAnalyses";
import { createRateLimitMiddleware } from "./lib/rateLimit";
import { authRouter } from "./routes/auth";
import { historyRouter } from "./routes/history";
import { usageRouter } from "./routes/usage";
import { tutorialsRouter } from "./routes/tutorials";
import { createAiDiagnosticsRouter } from "./routes/aiDiagnostics";
import { promptOptimizeRouter } from "./routes/promptOptimize";
import { tryOnStylePresetsRouter } from "./routes/tryOnStylePresets";
import { requireAuth, requirePasswordChanged, pruneExpiredSessions } from "./lib/auth";
import { databaseReady, hasUsers, initializeDatabase } from "./lib/database";
import { migrateLegacyData } from "./lib/legacyMigration";
import { asyncHandler } from "./lib/asyncHandler";
import { mountProductionFrontend } from "./lib/staticFrontend";
import type { ErrorRequestHandler } from "express";
import { startGenerationWorker } from "./engine/runQueue";
import {
  migrateLegacyUserTemplateOwners,
  reconcileUserTemplateAccountMutations,
} from "./lib/userTemplateLifecycle";
import { purgeExpiredMaterialDrafts } from "./lib/materialAnalysisStore";
import { imageConversationsRouter } from "./routes/imageConversations";

const app = express();

app.use(express.json({ limit: "50mb" }));

const aiRateLimit = createRateLimitMiddleware();
const loginRateLimit = createRateLimitMiddleware({ windowMs: 60_000, maxRequests: 10 });
const materialDraftRateLimit = createRateLimitMiddleware({ windowMs: 60_000, maxRequests: 10 });
const aiDiagnosticsRouter = createAiDiagnosticsRouter(aiRateLimit);
app.get("/api/health", (_req, res) => res.json({ ok: true, status: "alive" }));

const isProduction = process.env.NODE_ENV === "production";
const apiOnly = config.apiOnly();
const distDir = path.join(ROOT_DIR, "dist");
const distIndex = path.join(distDir, "index.html");

function dataDirWritable(): boolean {
  const dataDir = config.dataDir();
  const probePath = path.join(dataDir, `.readiness-${process.pid}-${Date.now()}`);
  let fd: number | undefined;
  let writable = false;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.statSync(dataDir).isDirectory()) return false;
    fd = fs.openSync(probePath, "wx");
    fs.writeSync(fd, "ready");
    writable = true;
  } catch {
    writable = false;
  } finally {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } catch {
      writable = false;
    }
    try {
      fs.rmSync(probePath, { force: true });
    } catch {
      // 探针不能完整写入并清理，目录不应被标记为 ready。
      writable = false;
    }
  }
  return writable;
}

async function readiness() {
  const checks = {
    dataDirWritable: dataDirWritable(),
    frontend: !isProduction || apiOnly || fs.existsSync(distIndex),
    aiConfigured: config.aiConfigReady(),
    database: await databaseReady(),
    usersConfigured: await hasUsers(),
  };
  return { ok: Object.values(checks).every(Boolean), checks, mode: apiOnly ? "api-only" : "full" };
}

app.get("/api/ready", asyncHandler(async (_req, res) => {
  const ready = await readiness();
  res.status(ready.ok ? 200 : 503).json(ready);
}));

app.use("/api/auth/login", loginRateLimit);
app.use("/api/auth", authRouter);
app.use("/api", requireAuth, requirePasswordChanged);
app.use("/api/generate", aiRateLimit, generateRouter);
app.use("/api/prompt-optimize", aiRateLimit, promptOptimizeRouter);
// 仅入队请求消耗 AI 限流额度；状态与 SSE 重连必须始终可达。
app.post("/api/run-plan", aiRateLimit);
app.use("/api/run-plan", runPlanRouter);
app.post("/api/outfit-analysis", aiRateLimit);
app.use("/api/outfit-analysis", outfitAnalysisRouter);
app.post("/api/pose-references", aiRateLimit);
app.post("/api/pose-references/analyze", aiRateLimit);
app.post("/api/pose-references/outfit", aiRateLimit);
app.use("/api/pose-references", createPoseReferencesRouter());
app.use("/api/files", filesRouter);
app.use("/api/projects", projectsRouter);
app.post("/api/image-conversations/:conversationId/rounds/plan", aiRateLimit);
app.post("/api/image-conversations/:conversationId/intents/:intentId/retry", aiRateLimit);
app.use("/api/image-conversations", imageConversationsRouter);
app.use("/api/drawing-boards", drawingBoardsRouter);
app.use("/api/templates", templatesRouter);
app.use("/api/try-on-style-presets", tryOnStylePresetsRouter);
app.use("/api/assets", assetsRouter);
app.use("/api/colors", colorsRouter);
app.post("/api/material-analyses", materialDraftRateLimit);
app.post("/api/material-analyses/:id/analyze", aiRateLimit);
app.use("/api/material-analyses", materialAnalysesRouter);
app.use("/api/history", historyRouter);
app.use("/api/usage", usageRouter);
app.use("/api/tutorials", tutorialsRouter);
app.use("/api/ai-diagnostics", aiDiagnosticsRouter);
app.use("/api", (_req, res) => res.status(404).json({ error: "API not found" }));

// 生产模式：完整模式必须有前端构建；API_ONLY=true 可显式跳过前端托管。
if (isProduction && !apiOnly) {
  if (!fs.existsSync(distIndex)) {
    throw new Error(
      `Production frontend is missing: ${distIndex}. Run npm run build, or set API_ONLY=true for an API-only deployment.`,
    );
  }
  mountProductionFrontend(app, distDir);
}

const apiErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  console.error("[garment-canvas] request failed", error);
  if (!res.headersSent) res.status(500).json({ error: "服务器暂时无法处理请求" });
};
// Express 错误中间件必须位于 API、静态文件和 SPA fallback 之后。
app.use(apiErrorHandler);

const port = config.port();
async function start(): Promise<void> {
  await initializeDatabase();
  await pruneExpiredSessions();
  await migrateLegacyData();
  await migrateLegacyUserTemplateOwners();
  await reconcileUserTemplateAccountMutations();
  await purgeExpiredMaterialDrafts();
  const initialReadiness = await readiness();
  if (!initialReadiness.ok) throw new Error(`Server is not ready: ${JSON.stringify(initialReadiness.checks)}`);
  const sessionPruneTimer = setInterval(() => {
    void pruneExpiredSessions().catch((error) => {
      console.error("[garment-canvas] session cleanup failed", error);
    });
  }, 6 * 60 * 60 * 1000);
  sessionPruneTimer.unref();
  const materialDraftPruneTimer = setInterval(() => {
    void purgeExpiredMaterialDrafts().catch((error) => {
      console.error("[garment-canvas] material draft cleanup failed", error);
    });
  }, 6 * 60 * 60 * 1000);
  materialDraftPruneTimer.unref();
  startGenerationWorker();
  app.listen(port, () => {
    console.log(`[garment-canvas] server listening on http://localhost:${port} (${initialReadiness.mode})`);
  });
}

await start();

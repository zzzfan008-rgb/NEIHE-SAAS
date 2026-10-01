import express, { type ErrorRequestHandler } from "express";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { authRouter } from "./routes/auth";
import { filesRouter } from "./routes/files";
import { projectsRouter } from "./routes/projects";
import { assetsRouter } from "./routes/assets";
import { colorsRouter } from "./routes/colors";
import { historyRouter } from "./routes/history";
import { usageRouter } from "./routes/usage";
import { generateRouter } from "./routes/generate";
import { runPlanRouter } from "./routes/runPlan";
import { createPoseReferencesRouter } from "./routes/poseReferences";
import { imageConversationsRouter } from "./routes/imageConversations";
import { promptOptimizeRouter } from "./routes/promptOptimize";
import { materialAnalysesRouter } from "./routes/materialAnalyses";
import { drawingBoardsRouter } from "./routes/drawingBoards";
import { outfitAnalysisRouter } from "./routes/outfitAnalysis";
import { purgeExpiredMaterialDrafts } from "./lib/materialAnalysisStore";
import { reconcileUserTemplateAccountMutations } from "./lib/userTemplateLifecycle";
import { requireAuth, requirePasswordChanged, pruneExpiredSessions } from "./lib/auth";
import { databaseReady, hasUsers, initializeDatabase } from "./lib/database";
import { createRateLimitMiddleware } from "./lib/rateLimit";
import { asyncHandler } from "./lib/asyncHandler";
import { startGenerationWorker } from "./engine/runQueue";

function dataDirWritable(): boolean {
  const dir = config.dataDir();
  const probe = path.join(dir, `.readiness-${process.pid}-${Date.now()}`);
  let descriptor: number | undefined;
  let writable = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    descriptor = fs.openSync(probe, "wx");
    fs.writeSync(descriptor, "ready");
    writable = true;
  } catch {
    writable = false;
  } finally {
    try { if (descriptor !== undefined) fs.closeSync(descriptor); } catch { writable = false; }
    try { fs.rmSync(probe, { force: true }); } catch { writable = false; }
  }
  return writable;
}

export async function imageWorkbenchReadiness(): Promise<import("./public").WorkbenchReadiness> {
  const checks = {
    database: await databaseReady(),
    usersConfigured: await hasUsers(),
    dataDirWritable: dataDirWritable(),
    aiConfigured: config.aiConfigReady(),
  };
  return { ok: Object.values(checks).every(Boolean), mode: "api-only" as const, checks };
}

/** Same-origin API. Constructing an app does not connect a database or start a worker. */
export function createImageWorkbenchApp(): express.Express {
  const app = express();
  const aiRateLimit = createRateLimitMiddleware();
  const loginRateLimit = createRateLimitMiddleware({ windowMs: 60_000, maxRequests: 10 });
  app.disable("x-powered-by");
  app.use(express.json({ limit: "50mb" }));
  app.get("/api/health", (_req, res) => res.json({ ok: true, status: "alive" }));
  app.get("/api/ready", asyncHandler(async (_req, res) => {
    const result = await imageWorkbenchReadiness();
    res.status(result.ok ? 200 : 503).json(result);
  }));
  app.use("/api/auth/login", loginRateLimit);
  app.use("/api/auth", authRouter);
  app.use("/api", requireAuth, requirePasswordChanged);
  app.use("/api/generate", aiRateLimit, generateRouter);
  // Reconnection and reconciliation must not consume submission rate-limit capacity.
  app.post("/api/run-plan", aiRateLimit);
  app.use("/api/run-plan", runPlanRouter);
  app.post("/api/pose-references", aiRateLimit);
  app.post("/api/pose-references/analyze", aiRateLimit);
  app.post("/api/pose-references/outfit", aiRateLimit);
  app.use("/api/pose-references", createPoseReferencesRouter());
  app.post("/api/image-conversations/:conversationId/rounds/plan", aiRateLimit);
  app.post("/api/image-conversations/:conversationId/intents/:intentId/retry", aiRateLimit);
  app.use("/api/image-conversations", imageConversationsRouter);
  app.use("/api/files", filesRouter);
  app.use("/api/projects", projectsRouter);
  app.use("/api/assets", assetsRouter);
  app.use("/api/colors", colorsRouter);
  app.use("/api/history", historyRouter);
  app.use("/api/usage", usageRouter);
  app.use("/api/prompt-optimize", aiRateLimit, promptOptimizeRouter);
  app.post("/api/material-analyses", createRateLimitMiddleware({ windowMs: 60_000, maxRequests: 10 }));
  app.post("/api/material-analyses/:id/analyze", aiRateLimit);
  app.use("/api/material-analyses", materialAnalysesRouter);
  app.use("/api/drawing-boards", drawingBoardsRouter);
  app.post("/api/outfit-analysis", aiRateLimit);
  app.use("/api/outfit-analysis", outfitAnalysisRouter);
  app.use("/api", (_req, res) => res.status(404).json({ error: "API not found" }));
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    console.error("[image-workbench] request failed", error);
    if (!res.headersSent) res.status(500).json({ error: "服务器暂时无法处理请求" });
  };
  app.use(onError);
  return app;
}

/** One database and worker lifecycle per process; use a dedicated database/data directory. */
export async function startImageWorkbenchServer(port = config.port(), host = "127.0.0.1"): Promise<import("./public").WorkbenchServer> {
  await initializeDatabase();
  await pruneExpiredSessions();
  await reconcileUserTemplateAccountMutations();
  await purgeExpiredMaterialDrafts();
  const ready = await imageWorkbenchReadiness();
  if (!ready.ok) throw new Error(`Image workbench is not ready: ${JSON.stringify(ready.checks)}`);
  const app = createImageWorkbenchApp();
  const server = app.listen(port, host);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const stopWorker = startGenerationWorker();
  const cleanup = setInterval(() => {
    void pruneExpiredSessions().catch((error) => console.error("[image-workbench] session cleanup failed", error));
    void purgeExpiredMaterialDrafts().catch((error) => console.error("[image-workbench] material cleanup failed", error));
  }, 6 * 60 * 60 * 1000);
  cleanup.unref();
  server.once("close", () => { stopWorker(); clearInterval(cleanup); });
  return { app, server, stopWorker };
}

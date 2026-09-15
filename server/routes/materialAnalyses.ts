import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAdmin, requestUser } from "../lib/auth";
import { ImageValidationError } from "../lib/imageValidation";
import { ProviderError } from "../providers/base";
import {
  createMaterialAnalysis,
  deleteMaterialDraft,
  listMaterialModels,
  MaterialAnalysisQuotaError,
  purgeExpiredMaterialDrafts,
  readMaterialAnalysis,
  replaceMaterialModels,
  runMaterialAnalysis,
  saveMaterialAsset,
} from "../lib/materialAnalysisStore";
import {
  MaterialAnalysisCapacityError,
  withMaterialAnalysisSlot,
} from "../lib/materialAnalysisLimit";

export const materialAnalysesRouter = Router();
materialAnalysesRouter.use(
  asyncHandler(async (_req, _res, next) => {
    await purgeExpiredMaterialDrafts();
    next();
  }),
);

function validId(value: string) {
  return /^[A-Za-z0-9_-]{8,32}$/.test(value);
}

function badRequest(
  res: Parameters<Parameters<typeof asyncHandler>[0]>[1],
  error: unknown,
) {
  if (
    error instanceof MaterialAnalysisCapacityError ||
    error instanceof MaterialAnalysisQuotaError
  ) {
    res.status(429).json({ error: error.message });
    return;
  }
  if (error instanceof ImageValidationError) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof ProviderError) {
    res
      .status(
        error.status && error.status >= 400 && error.status < 500
          ? error.status
          : 502,
      )
      .json({ error: error.message, code: error.category });
    return;
  }
  res
    .status(400)
    .json({ error: error instanceof Error ? error.message : "请求格式无效" });
}

materialAnalysesRouter.get(
  "/models",
  asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await listMaterialModels(requestUser(req).role === "admin"));
  }),
);

materialAnalysesRouter.put(
  "/models",
  requireAdmin,
  asyncHandler(async (req, res) => {
    try {
      const updated = await replaceMaterialModels(
        req.body?.expectedRevision,
        req.body?.models,
      );
      if (!updated) {
        res.status(409).json({ error: "模型配置已更新，请刷新后重试" });
        return;
      }
      res.json(updated);
    } catch (error) {
      badRequest(res, error);
    }
  }),
);

materialAnalysesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    try {
      const record = await createMaterialAnalysis(
        requestUser(req).id,
        req.body?.image,
        req.body?.crop,
      );
      res.status(201).json(record);
    } catch (error) {
      badRequest(res, error);
    }
  }),
);

materialAnalysesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!validId(req.params.id)) {
      res.status(404).json({ error: "analysis not found" });
      return;
    }
    const record = await readMaterialAnalysis(
      requestUser(req).id,
      req.params.id,
    );
    if (!record) {
      res.status(404).json({ error: "analysis not found" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(record);
  }),
);

materialAnalysesRouter.post(
  "/:id/analyze",
  asyncHandler(async (req, res) => {
    if (!validId(req.params.id)) {
      res.status(404).json({ error: "analysis not found" });
      return;
    }
    try {
      const ownerId = requestUser(req).id;
      const result = await withMaterialAnalysisSlot(ownerId, () =>
        runMaterialAnalysis(
          ownerId,
          req.params.id,
          req.body?.expectedRevision,
          req.body?.modelId,
        ),
      );
      if (result.status === "missing")
        res.status(404).json({ error: "analysis not found" });
      else if (result.status === "model")
        res.status(400).json({ error: "所选模型未启用，请刷新后重试" });
      else if (
        result.status === "owner" ||
        result.status === "conflict" ||
        result.status === "superseded"
      ) {
        res.status(409).json({ error: "分析记录已更新，请刷新后重试" });
      } else res.json(result.row);
    } catch (error) {
      badRequest(res, error);
    }
  }),
);

materialAnalysesRouter.post(
  "/:id/save",
  asyncHandler(async (req, res) => {
    if (!validId(req.params.id)) {
      res.status(404).json({ error: "analysis not found" });
      return;
    }
    try {
      const result = await saveMaterialAsset(
        requestUser(req).id,
        req.params.id,
        req.body?.expectedRevision,
        req.body?.calibration,
      );
      if (result.status === "missing")
        res.status(404).json({ error: "analysis not found" });
      else if (result.status === "saved")
        res.status(201).json({ assetId: result.assetId, analysis: result.row });
      else res.status(409).json({ error: "分析记录已更新，请刷新后重试" });
    } catch (error) {
      badRequest(res, error);
    }
  }),
);

materialAnalysesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (
      !validId(req.params.id) ||
      !(await deleteMaterialDraft(requestUser(req).id, req.params.id))
    ) {
      res.status(404).json({ error: "analysis not found" });
      return;
    }
    res.status(204).end();
  }),
);

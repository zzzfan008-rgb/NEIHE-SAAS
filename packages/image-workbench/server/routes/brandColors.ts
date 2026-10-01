import { Router, type ErrorRequestHandler } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { requireAdmin, type AuthenticatedRequest } from "../lib/auth";
import { createRateLimitMiddleware } from "../lib/rateLimit";
import * as brands from "../lib/brandColorStore";
import * as imports from "../lib/colorImportStore";
import * as validate from "../lib/brandColorValidation";

export const brandColorsRouter = Router();
brandColorsRouter.get(
  "/brands",
  asyncHandler(async (req, res) => {
    res.json(await brands.listBrands(validate.pagination(req.query)));
  }),
);
brandColorsRouter.post(
  "/brands",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.status(201).json(await brands.createBrand(req.body));
  }),
);
brandColorsRouter.patch(
  "/brands/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await brands.changeBrand(validate.id(req.params.id), req.body));
  }),
);
brandColorsRouter.delete(
  "/brands/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await brands.changeBrand(validate.id(req.params.id), req.body, true);
    res.sendStatus(204);
  }),
);
brandColorsRouter.get(
  "/series",
  asyncHandler(async (req, res) => {
    res.json(
      await brands.listSeries(
        validate.id(req.query.brandId),
        validate.pagination(req.query),
      ),
    );
  }),
);
brandColorsRouter.post(
  "/series",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.status(201).json(await brands.createSeries(req.body));
  }),
);
brandColorsRouter.patch(
  "/series/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await brands.changeSeries(validate.id(req.params.id), req.body));
  }),
);
brandColorsRouter.delete(
  "/series/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await brands.changeSeries(validate.id(req.params.id), req.body, true);
    res.sendStatus(204);
  }),
);
brandColorsRouter.get(
  "/groups",
  asyncHandler(async (req, res) => {
    res.json(
      await brands.listGroups(
        validate.id(req.query.brandId),
        validate.pagination(req.query),
        req.query.seriesId === undefined
          ? undefined
          : validate.id(req.query.seriesId),
      ),
    );
  }),
);
brandColorsRouter.get(
  "/groups/:id",
  asyncHandler(async (req, res) => {
    res.json(await brands.readGroup(validate.id(req.params.id)));
  }),
);
brandColorsRouter.post(
  "/groups",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.status(201).json(await brands.saveGroup(req.body));
  }),
);
brandColorsRouter.put(
  "/groups/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await brands.saveGroup(req.body, validate.id(req.params.id)));
  }),
);
brandColorsRouter.delete(
  "/groups/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await brands.deleteGroup(validate.id(req.params.id), req.body);
    res.sendStatus(204);
  }),
);

brandColorsRouter.use("/imports", requireAdmin);
brandColorsRouter.get(
  "/imports",
  asyncHandler(async (req, res) => {
    res.json(
      await imports.listManagedImports(
        (req as AuthenticatedRequest).authUser.id,
        {
          ...validate.pagination(req.query),
          groupId:
            req.query.groupId === undefined
              ? undefined
              : validate.id(req.query.groupId),
        },
      ),
    );
  }),
);
brandColorsRouter.post(
  "/imports",
  createRateLimitMiddleware({ maxRequests: 20 }),
  asyncHandler(async (req, res) => {
    res
      .status(201)
      .json(
        await imports.createManagedImport(
          (req as AuthenticatedRequest).authUser.id,
          req.body,
        ),
      );
  }),
);
brandColorsRouter.get(
  "/imports/:id",
  asyncHandler(async (req, res) => {
    res.json(
      await imports.readManagedImport(
        validate.id(req.params.id),
        (req as AuthenticatedRequest).authUser.id,
      ),
    );
  }),
);
brandColorsRouter.patch(
  "/imports/:id",
  asyncHandler(async (req, res) => {
    res.json(
      await imports.updateManagedImport(
        validate.id(req.params.id),
        (req as AuthenticatedRequest).authUser.id,
        req.body,
      ),
    );
  }),
);
brandColorsRouter.post(
  "/imports/:id/confirm",
  asyncHandler(async (req, res) => {
    res.json(
      await imports.confirmManagedImport(
        validate.id(req.params.id),
        (req as AuthenticatedRequest).authUser.id,
        req.body,
      ),
    );
  }),
);

const errors: ErrorRequestHandler = (error, _req, res, next) => {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "23505"
  )
    res.status(409).json({ error: "名称或色号已存在，请核对重复项" });
  else next(error);
};
brandColorsRouter.use(errors);

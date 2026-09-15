import { Router, type ErrorRequestHandler } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { brandColorsRouter } from "./brandColors";
import {
  CATALOG_HUES,
  type CatalogSearch,
} from "../../src/types/colorManagement";
import {
  ColorCatalogError,
  activeColorCatalog,
  colorCatalogDetail,
  colorCatalogLibraries,
  searchColorCatalog,
} from "../lib/colorCatalogStore";

export const colorsRouter = Router();
colorsRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

function text(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength)
    throw new ColorCatalogError("色库查询参数无效", 400);
  return value;
}
function digest(value: unknown): string | undefined {
  const id = text(value, 64);
  if (id !== undefined && !/^[a-f0-9]{64}$/.test(id))
    throw new ColorCatalogError("色库标识无效", 400);
  return id;
}
function integer(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const raw = text(value, 8)!;
  if (!/^\d+$/.test(raw)) throw new ColorCatalogError("分页参数无效", 400);
  const parsed = Number(raw);
  if (parsed < min || parsed > max)
    throw new ColorCatalogError("分页参数超出范围", 400);
  return parsed;
}
function search(input: Record<string, unknown>): CatalogSearch {
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "releaseId",
          "q",
          "libraryKey",
          "status",
          "hue",
          "limit",
          "offset",
        ].includes(key),
    )
  )
    throw new ColorCatalogError("未知色库查询参数", 400);
  const libraryKey = text(input.libraryKey, 64);
  if (
    libraryKey !== undefined &&
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(libraryKey)
  )
    throw new ColorCatalogError("色库系列无效", 400);
  const status = text(input.status, 16);
  if (
    status !== undefined &&
    !["ready", "conflict", "unconverted"].includes(status)
  )
    throw new ColorCatalogError("色库状态无效", 400);
  const hue = text(input.hue, 16);
  if (hue !== undefined && !CATALOG_HUES.some((value) => value === hue))
    throw new ColorCatalogError("色相筛选无效", 400);
  return {
    releaseId: digest(input.releaseId),
    libraryKey,
    q: text(input.q, 96)?.trim(),
    status: status as CatalogSearch["status"],
    hue: hue as CatalogSearch["hue"],
    limit: integer(input.limit, 50, 1, 100),
    offset: integer(input.offset, 0, 0, 50_000),
  };
}

// Mounted after requireAuth + requirePasswordChanged in server/index.ts.
colorsRouter.get(
  "/catalog/state",
  asyncHandler(async (_req, res) => {
    res.json(await activeColorCatalog());
  }),
);
colorsRouter.get(
  "/catalog/libraries",
  asyncHandler(async (req, res) => {
    res.json(await colorCatalogLibraries(digest(req.query.releaseId)));
  }),
);
colorsRouter.get(
  "/catalog",
  asyncHandler(async (req, res) => {
    res.json(await searchColorCatalog(search(req.query)));
  }),
);
colorsRouter.get(
  "/catalog/:id",
  asyncHandler(async (req, res) => {
    res.json(
      await colorCatalogDetail(
        digest(req.params.id)!,
        digest(req.query.releaseId),
      ),
    );
  }),
);

colorsRouter.use(brandColorsRouter);

const errors: ErrorRequestHandler = (error, _req, res, next) => {
  if (error instanceof ColorCatalogError)
    res.status(error.status).json({ error: error.message });
  else next(error);
};
colorsRouter.use(errors);

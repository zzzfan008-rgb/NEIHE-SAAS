import { createHash } from "node:crypto";
import { buildColorCatalog, type CatalogSourceInput } from "./colorCatalog";

export class ColorCatalogError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "ColorCatalogError";
  }
}

/** Shared by dry-run and apply before any database connection or mutation. */
export function prepareColorCatalogRelease(
  sources: readonly CatalogSourceInput[],
) {
  const colors = buildColorCatalog(sources);
  if (!colors.length) throw new ColorCatalogError("不能以空目录替换主库", 400);
  if (
    colors.some(
      (color) =>
        color.variants.length > 64 ||
        color.variants.some((variant) => variant.sources.length > 128),
    )
  )
    throw new ColorCatalogError("单色变体或来源过多，请先核对源库", 400);
  const serialized = JSON.stringify(colors);
  if (Buffer.byteLength(serialized) > 64 * 1024 * 1024)
    throw new ColorCatalogError("主库转换结果超过 64 MiB", 400);
  return {
    colors,
    releaseId: createHash("sha256").update(serialized).digest("hex"),
  };
}

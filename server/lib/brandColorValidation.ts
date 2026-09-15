import {
  MAX_BRAND_COLORS,
  type BrandColorReference,
  type ImportColorDecision,
} from "../../src/types/brandColors";
import { ColorCatalogError } from "./colorCatalogRelease";

export function invalid(message: string): never {
  throw new ColorCatalogError(message, 400);
}
export function fields(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("请求对象无效");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    invalid("请求包含未知或只读字段");
  return body;
}
export function name(value: unknown, maximum = 120): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > maximum ||
    /[\u0000-\u001f]/.test(value)
  )
    invalid("名称无效或过长");
  return value.trim();
}
export function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value))
    invalid("标识无效");
  return value;
}
export function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    invalid("色库身份或版本无效");
  return value;
}
export function revision(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value >= 2147483647
  )
    invalid("必须提供有效 revision");
  return value;
}
export function referenceRatio(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    invalid("参考比例必须为 0–1 的数值或空值");
  return value;
}
export function colorReferences(value: unknown): BrandColorReference[] {
  if (!Array.isArray(value) || value.length > MAX_BRAND_COLORS)
    invalid("色组最多容纳 5000 色");
  const seen = new Set<string>();
  return value.map((entry) => {
    const row = fields(entry, ["catalogId", "releaseId", "ratio"]);
    const catalogId = digest(row.catalogId);
    if (seen.has(catalogId)) invalid("色组中存在重复的 Pantone 身份");
    seen.add(catalogId);
    return {
      catalogId,
      releaseId: digest(row.releaseId),
      ratio: referenceRatio(row.ratio),
    };
  });
}
export function importDecisions(
  value: unknown,
  count: number,
): ImportColorDecision[] {
  if (!Array.isArray(value) || value.length !== count)
    invalid("必须逐行保留导入决定");
  return value.map((entry) => {
    const row = fields(entry, ["action", "catalogId", "ratio"]);
    if (row.action === "pending" || row.action === "skip") {
      if (row.catalogId !== undefined || row.ratio !== undefined)
        invalid("未确认行不得携带色号映射");
      return { action: row.action };
    }
    if (row.action !== "confirm" || row.ratio === undefined)
      invalid("确认行须显式指定色号及参考比例（可为空）");
    return {
      action: "confirm",
      catalogId: digest(row.catalogId),
      ratio: referenceRatio(row.ratio),
    };
  });
}
export function pagination(input: Record<string, unknown>) {
  const number = (
    value: unknown,
    fallback: number,
    min: number,
    max: number,
  ) => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^\d{1,6}$/.test(value))
      invalid("分页参数无效");
    const parsed = Number(value);
    if (parsed < min || parsed > max) invalid("分页参数超出范围");
    return parsed;
  };
  return {
    limit: number(input.limit, 50, 1, 100),
    offset: number(input.offset, 0, 0, 50000),
  };
}
export function seriesFields(body: Record<string, unknown>) {
  const year = body.year ?? null;
  if (
    year !== null &&
    (typeof year !== "number" ||
      !Number.isInteger(year) ||
      year < 1900 ||
      year > 2200)
  )
    invalid("年份无效");
  return {
    name: name(body.name),
    year,
    season: body.season == null ? null : name(body.season, 80),
  };
}

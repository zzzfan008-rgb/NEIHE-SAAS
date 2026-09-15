import { createHash } from "node:crypto";
import type {
  CatalogColor,
  ColorImportPreviewRow,
  RawColorImportRow,
} from "../../src/types/colorImport";
import { parseAdobeSwatches } from "./adobeSwatches";
import { normalizePantoneCode, recommendTcxColors } from "./colorCatalog";
import { convertSwatchColor } from "./colorScience";
import { readXlsxColorRows } from "./xlsxColorRows";

function referenceRatio(value: string | number | null): number | null {
  if (value === null || (typeof value === "string" && !value.trim()))
    return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > 1)
      throw new Error("比例超出 0–100% 范围");
    return value;
  }
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?%?$/.test(text))
    throw new Error("比例必须是 0–1 数值或百分数字符串");
  const ratio = text.endsWith("%")
    ? Number(text.slice(0, -1)) / 100
    : Number(text);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1)
    throw new Error("比例超出 0–100% 范围");
  return ratio;
}

function checkPreviewTextBudget(textLengths: readonly number[]): void {
  if (textLengths.length > 5000) throw new Error("一次最多导入 5000 色");
  let upperBytes = 0;
  for (const length of textLengths) {
    // Reserve row/candidate metadata and worst-case JSON escaping per UTF-16 unit.
    upperBytes += 2500 + length * 6;
    if (upperBytes > 16 * 1024 * 1024) throw new Error("色板展开预览超出限制，请拆分文件");
  }
}

function previewRows(
  rows: RawColorImportRow[],
  catalog: readonly CatalogColor[],
  libraryKey: string,
): ColorImportPreviewRow[] {
  checkPreviewTextBudget(rows.map((row) => row.rawCode.length + row.sheetName.length
    + (typeof row.rawRatio === "string" ? row.rawRatio.length : 0)
    + row.errors.reduce((sum, error) => sum + error.length, 0)
    + (row.originalSwatch ? row.originalSwatch.name.length + row.originalSwatch.groupPath.reduce((sum, part) => sum + part.length, 0) : 0)));
  const entries = new Map(
    catalog
      .filter((entry) => entry.libraryKey === libraryKey)
      .map((entry) => [entry.code, entry]),
  );
  const approximateRows = rows.filter((row) => row.sourceHex && !row.errors.length && !entries.has(normalizePantoneCode(row.rawCode) ?? "")).length;
  const tcxCandidates = catalog.filter((entry) => entry.status === "ready" && entry.code.endsWith(" TCX")).length;
  if (approximateRows * tcxCandidates > 2_000_000) throw new Error("近似候选计算量超出限制，请拆分导入文件");
  const counts = new Map<string, number>();
  for (const row of rows) {
    const code = normalizePantoneCode(row.rawCode);
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return rows.map((row) => {
    const errors = [...row.errors];
    const code = normalizePantoneCode(row.rawCode);
    let ratio: number | null = null;
    try {
      ratio = referenceRatio(row.rawRatio);
    } catch (error) {
      errors.push((error as Error).message);
    }
    const entry = code ? entries.get(code) : undefined;
    let status: ColorImportPreviewRow["status"] = "matched";
    if (errors.length) status = "invalid";
    else if (!code) status = "missing-code";
    else if ((counts.get(code) ?? 0) > 1) status = "duplicate";
    else if (!entry) status = "unmatched";
    else if (entry.status !== "ready") status = "conflict";
    return {
      ...row,
      errors,
      code,
      ratio,
      status,
      matchedCatalogId: status === "matched" && entry ? entry.id : null,
      matchedColor:
        status === "matched" && entry
          ? {
              catalogId: entry.id,
              libraryKey: entry.libraryKey,
              code: entry.code,
              hex: entry.variants[0]?.display?.hex ?? null,
            }
          : null,
      candidates:
        !errors.length && !entry && row.sourceHex
          ? recommendTcxColors(row.sourceHex, catalog)
          : [],
    };
  });
}

/** Produces a preview only; confirmation and publication belong to the authenticated admin transaction. */
export async function parseColorImport(
  bytes: Buffer,
  format: "xlsx" | "ase",
  catalog: readonly CatalogColor[],
  libraryKey: string,
) {
  if (format !== "xlsx" && format !== "ase")
    throw new Error("仅支持 XLSX 和 ASE 导入");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(libraryKey))
    throw new Error("色库标识无效");
  let rows: RawColorImportRow[];
  if (format === "xlsx") rows = await readXlsxColorRows(bytes);
  else {
    const parsed = parseAdobeSwatches(bytes);
    if (parsed.format !== "ase")
      throw new Error("品牌导入必须使用 ASE，不能上传 ACB 主库");
    // Check before joining paths: small grouped ASE files can otherwise expand massively.
    checkPreviewTextBudget(parsed.colors.map((swatch) => swatch.name.length * 2
      + swatch.groupPath.reduce((sum, part) => sum + part.length, 0) * 2
      + Math.max(0, swatch.groupPath.length - 1) * 3));
    rows = parsed.colors.map((swatch) => {
      // Untagged ASE Lab has no verified white point; retain it for manual calibration.
      const display = convertSwatchColor(swatch.space, swatch.components);
      return {
        rowNumber: swatch.recordIndex + 1,
        sheetName: swatch.groupPath.join(" / "),
        rawCode: swatch.name,
        rawRatio: null,
        ...(display ? { sourceHex: display.hex } : {}),
        originalSwatch: swatch,
        errors: [],
      };
    });
  }
  return {
    fileHash: createHash("sha256").update(bytes).digest("hex"),
    format,
    rows: previewRows(rows, catalog, libraryKey),
  };
}

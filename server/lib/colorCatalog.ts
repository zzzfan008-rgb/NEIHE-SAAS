import { createHash } from "node:crypto";
import type {
  ApproximateColorCandidate,
  CatalogColor,
  CatalogVariant,
} from "../../src/types/colorImport";
import { parseAdobeSwatches } from "./adobeSwatches";
import { convertSwatchColor, deltaE2000, hexToLabD50 } from "./colorScience";

export interface CatalogSourceInput {
  libraryKey: string;
  fileName: string;
  version: string;
  bytes: Buffer;
  /** Explicit provenance declaration, never inferred from a temporary book title. */
  labWhitePoint?: "D50";
}
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const compare = (a: string, b: string) => (a < b ? -1 : Number(a > b));
const variantKey = (value: CatalogVariant) =>
  JSON.stringify([
    value.space,
    value.encoding,
    value.encodedComponents,
    value.labWhitePoint ?? null,
  ]);

export function normalizePantoneCode(input: string): string | null {
  if (input.length > 128) return null;
  const code = input
    .trim()
    .toUpperCase()
    .replace(/^PANTONE\s+/, "")
    .replace(/\.(?=[A-Z]+$)/, " ")
    .replace(/\s+/g, " ");
  return /^[A-Z0-9][A-Z0-9 ().+-]{0,95}$/.test(code) ? code : null;
}

export function buildColorCatalog(
  sources: readonly CatalogSourceInput[],
): CatalogColor[] {
  if (
    sources.length > 64 ||
    sources.reduce((total, source) => total + source.bytes.length, 0) >
      64 * 1024 * 1024
  )
    throw new Error("主库来源超出导入限制");
  const entries = new Map<string, CatalogColor>();
  const variants = new Map<string, CatalogVariant>();
  const provenanceKeys = new WeakMap<CatalogVariant, Set<string>>();
  let colorCount = 0;
  for (const source of sources) {
    if (
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source.libraryKey) ||
      !source.fileName ||
      source.fileName.length > 256 ||
      !source.version ||
      source.version.length > 128
    )
      throw new Error("主库来源标识无效");
    const fileHash = hash(source.bytes);
    for (const swatch of parseAdobeSwatches(source.bytes).colors) {
      if (++colorCount > 50_000)
        throw new Error("主库合计最多导入 50000 条记录");
      const code = normalizePantoneCode(swatch.name);
      if (!code) throw new Error(`主库来源 ${source.fileName} 包含无效色号`);
      const id = hash(JSON.stringify([source.libraryKey, code]));
      let entry = entries.get(id);
      if (!entry) {
        entry = {
          id,
          libraryKey: source.libraryKey,
          code,
          status: "unconverted",
          variants: [],
        };
        entries.set(id, entry);
      }
      const candidate: CatalogVariant = {
        space: swatch.space,
        encoding: swatch.encoding,
        encodedComponents: [...swatch.encodedComponents],
        components: [...swatch.components],
        ...(swatch.space === "Lab" && source.labWhitePoint
          ? { labWhitePoint: source.labWhitePoint }
          : {}),
        display: convertSwatchColor(
          swatch.space,
          swatch.components,
          source.labWhitePoint,
        ),
        sources: [],
      };
      const key = `${id}:${variantKey(candidate)}`;
      let variant = variants.get(key);
      if (!variant) {
        variant = candidate;
        variants.set(key, variant);
        provenanceKeys.set(variant, new Set());
        entry.variants.push(variant);
      }
      const provenance = {
        fileName: source.fileName,
        fileHash,
        version: source.version,
        recordIndex: swatch.recordIndex,
        rawName: swatch.rawName,
        ...(swatch.catalogCode ? { catalogCode: swatch.catalogCode } : {}),
      };
      const sourceKey = JSON.stringify(provenance);
      const knownSources = provenanceKeys.get(variant)!;
      if (!knownSources.has(sourceKey)) {
        knownSources.add(sourceKey);
        variant.sources.push(provenance);
      }
    }
  }
  for (const entry of entries.values()) {
    entry.variants.sort((a, b) => compare(variantKey(a), variantKey(b)));
    entry.variants.forEach((variant) =>
      variant.sources.sort((a, b) =>
        compare(JSON.stringify(a), JSON.stringify(b)),
      ),
    );
    if (entry.variants.length > 1) entry.status = "conflict";
    else entry.status = entry.variants[0].display ? "ready" : "unconverted";
  }
  return [...entries.values()].sort((a, b) => compare(a.id, b.id));
}

export function recommendTcxColors(
  inputHex: string,
  catalog: readonly CatalogColor[],
): ApproximateColorCandidate[] {
  const lab = hexToLabD50(inputHex);
  const candidates: ApproximateColorCandidate[] = [];
  for (const entry of catalog) {
    if (
      entry.status !== "ready" ||
      !entry.code.endsWith(" TCX") ||
      entry.variants.length !== 1
    )
      continue;
    const display = entry.variants[0].display;
    if (!display) continue;
    candidates.push({
      catalogId: entry.id,
      libraryKey: entry.libraryKey,
      code: entry.code,
      hex: display.hex,
      deltaE: deltaE2000(lab, display.labD50),
      approximate: true,
      conversionVersion: display.conversionVersion,
    });
  }
  return candidates
    .sort((a, b) => a.deltaE - b.deltaE || compare(a.catalogId, b.catalogId))
    .slice(0, 3);
}

import type { AdobeSwatch, SwatchColorSpace } from "./colorCatalog";

export type LabD50 = readonly [number, number, number];
export interface DisplayColor {
  hex: `#${string}`;
  labD50: LabD50;
  outOfGamut: boolean;
  conversionVersion: string;
  assumption: "declared-D50" | "untagged-sRGB";
}
export interface CatalogProvenance {
  fileName: string;
  fileHash: string;
  version: string;
  recordIndex: number;
  rawName: string;
  catalogCode?: string;
}
export interface CatalogVariant {
  space: SwatchColorSpace;
  encoding: AdobeSwatch["encoding"];
  encodedComponents: number[];
  components: number[];
  labWhitePoint?: "D50";
  display: DisplayColor | null;
  sources: CatalogProvenance[];
}
export interface CatalogColor {
  id: string;
  libraryKey: string;
  code: string;
  status: "ready" | "conflict" | "unconverted";
  variants: CatalogVariant[];
}
export interface ApproximateColorCandidate {
  catalogId: string;
  libraryKey: string;
  code: string;
  hex: `#${string}`;
  deltaE: number;
  approximate: true;
  conversionVersion: string;
}
export interface RawColorImportRow {
  rowNumber: number;
  sheetName: string;
  rawCode: string;
  rawRatio: string | number | null;
  sourceHex?: `#${string}`;
  originalSwatch?: AdobeSwatch;
  errors: string[];
}
export interface ColorImportCatalogReference {
  catalogId: string;
  libraryKey: string;
  code: string;
  hex: `#${string}` | null;
}
export interface ColorImportPreviewRow extends RawColorImportRow {
  code: string | null;
  ratio: number | null;
  status:
    | "matched"
    | "missing-code"
    | "unmatched"
    | "conflict"
    | "duplicate"
    | "invalid";
  matchedCatalogId: string | null;
  matchedColor?: ColorImportCatalogReference | null;
  candidates: ApproximateColorCandidate[];
}

import type { ColorImportPreviewRow } from "./colorImport";

export const MAX_BRAND_COLORS = 5000;
export interface ColorBrand {
  id: string;
  kind: "neihe" | "reference";
  name: string;
  revision: number;
}
export interface ColorSeries {
  id: string;
  brandId: string;
  name: string;
  year: number | null;
  season: string | null;
  revision: number;
}
export interface ColorGroup {
  id: string;
  brandId: string;
  seriesId: string | null;
  name: string;
  revision: number;
}
export interface BrandColorReference {
  catalogId: string;
  releaseId: string;
  ratio: number | null;
}
export interface BrandColorMember extends BrandColorReference {
  libraryKey: string;
  code: string;
  hex: `#${string}`;
  originalHex: `#${string}` | null;
}
export type ImportColorDecision =
  | { action: "pending" | "skip" }
  | { action: "confirm"; catalogId: string; ratio: number | null };
export interface ColorImportListItem {
  id: string;
  groupId: string;
  revision: number;
  createdAt: string;
}
export interface ManagedColorImport {
  id: string;
  groupId: string;
  releaseId: string;
  libraryKey: string;
  fileHash: string;
  revision: number;
  rows: ColorImportPreviewRow[];
  decisions: ImportColorDecision[];
  publishedRows: number[];
}
export interface ColorImportCommit {
  importId: string;
  groupId: string;
  groupRevision: number;
  importRevision: number;
  added: number;
}

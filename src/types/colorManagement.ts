import type { CatalogColor } from "./colorImport";

export const CATALOG_HUES = [
  "neutral",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "purple",
  "pink",
] as const;
export type CatalogHue = (typeof CATALOG_HUES)[number];
export interface CatalogReleaseState {
  releaseId: string | null;
  revision: number;
}
export interface CatalogColorSummary {
  id: string;
  libraryKey: string;
  code: string;
  status: CatalogColor["status"];
  hex: `#${string}` | null;
  hue: CatalogHue | null;
  outOfGamut: boolean | null;
}
export interface CatalogPage extends CatalogReleaseState {
  activeReleaseId: string | null;
  total: number;
  colors: CatalogColorSummary[];
  nextOffset: number | null;
}
export interface CatalogLibrarySummary {
  libraryKey: string;
  total: number;
  ready: number;
}
export interface CatalogLibrariesPage extends CatalogReleaseState {
  activeReleaseId: string | null;
  libraries: CatalogLibrarySummary[];
}
export interface CatalogSearch {
  releaseId?: string;
  libraryKey?: string;
  q?: string;
  status?: CatalogColor["status"];
  hue?: CatalogHue;
  limit: number;
  offset: number;
}

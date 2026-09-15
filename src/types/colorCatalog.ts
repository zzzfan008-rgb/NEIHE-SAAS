export type SwatchColorSpace = "RGB" | "CMYK" | "Lab" | "Gray";
export type SwatchColorType = "global" | "spot" | "normal" | "unspecified";

/** Parsed source data, not a confirmed Pantone match or a display-color conversion. */
export interface AdobeSwatch {
  recordIndex: number;
  rawName: string;
  name: string;
  groupPath: string[];
  space: SwatchColorSpace;
  /** RGB/CMYK/Gray: 0–1; Lab: L 0–100, a/b -128–127. */
  components: number[];
  /** Exact decoded file values; retain these when deriving display colors. */
  encodedComponents: number[];
  encoding: "acb-byte" | "ase-float32";
  colorType: SwatchColorType;
  catalogCode?: string;
}

export interface AdobeColorBookMetadata {
  id: number;
  rawTitle: string;
  rawPrefix: string;
  rawSuffix: string;
  rawDescription: string;
  title: string;
  prefix: string;
  suffix: string;
  description: string;
  pageSize: number;
  pageOffset: number;
}

export interface ParsedAdobeSwatches {
  format: "acb" | "ase";
  version: string;
  /** ACB records or ASE blocks, including padding/group records. */
  recordCount: number;
  paddingCount: number;
  colors: AdobeSwatch[];
  book?: AdobeColorBookMetadata;
}

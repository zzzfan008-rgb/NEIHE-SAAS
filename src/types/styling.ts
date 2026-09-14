export type StylingPreserve = "upper" | "lower" | "one-piece" | "whole";
export type StylingExtra = "outerwear" | "shoes" | "bag" | "accessories" | "hat";
export type StylingExtras = Record<StylingExtra, boolean>;
export interface OutfitAnalysis {
  categories: StylingPreserve[];
  description: string;
  hasPerson: boolean;
  existingExtras: StylingExtras;
  upperIsOuterwear: boolean;
  ambiguous: boolean;
}
export interface OutfitAnalysisRecord {
  id: string;
  sourceNodeId: string;
  images: string[];
  status: "pending" | "running" | "succeeded" | "failed" | "outcome_unknown";
  referenceFingerprint: string;
  result?: OutfitAnalysis;
  error?: string;
}

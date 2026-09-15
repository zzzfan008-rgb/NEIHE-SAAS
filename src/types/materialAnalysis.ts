import type { PantoneColorReference } from "./colorPreferences";

export interface MaterialCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MaterialAnalysisColor {
  hex: string;
  name?: string;
  pantone?: PantoneColorReference;
}

export interface MaterialAnalysisSuggestion {
  materialDescription: string;
  observedAttributes: string[];
  uncertainAttributes: string[];
  colors: MaterialAnalysisColor[];
}

export interface MaterialAnalysisCalibration {
  name: string;
  materialDescription: string;
  colors: MaterialAnalysisColor[];
}

export interface MaterialAnalysisModel {
  id: string;
  label: string;
  protocol: "gemini-generate-content";
  enabled: boolean;
  isDefault: boolean;
  revision: number;
}

export interface MaterialAnalysisRecord {
  id: string;
  revision: number;
  status: "draft" | "analyzing" | "analyzed" | "failed" | "outcome_unknown" | "saved";
  sourceImage: string;
  cropImage: string;
  crop: MaterialCropRect;
  modelId: string | null;
  suggestion: MaterialAnalysisSuggestion | null;
  calibration: MaterialAnalysisCalibration | null;
  error: string | null;
  assetId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MaterialAssetMetadata {
  analysisId?: string;
  modelId?: string;
  crop?: MaterialCropRect;
  materialDescription: string;
  colors: MaterialAnalysisColor[];
  analyzedAt?: string;
  confirmedAt: string;
}

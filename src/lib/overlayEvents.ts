import type { DocumentTarget } from "@/store/flowStore";

export const OPEN_COMPARE_EVENT = "garment:open-compare";
export const OPEN_ASSET_PICKER_EVENT = "garment:open-asset-picker";
export const OPEN_GENERATION_RECORD_EVENT = "garment:open-generation-record";

export interface AssetPickerRequest {
  target: DocumentTarget;
  nodeId: string;
}

export interface GenerationRecordRequest {
  resultId: string;
}

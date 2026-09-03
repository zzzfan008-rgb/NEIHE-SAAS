import type { DocumentTarget } from "@/store/flowStore";

export const OPEN_COMPARE_EVENT = "garment:open-compare";
export const OPEN_ASSET_PICKER_EVENT = "garment:open-asset-picker";

export interface AssetPickerRequest {
  target: DocumentTarget;
  nodeId: string;
}

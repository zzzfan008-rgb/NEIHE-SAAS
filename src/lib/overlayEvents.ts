import type { DocumentTarget } from "@/store/flowStore";
import type { ImageConversationSourceSelection } from "@/lib/imageConversationInputs";

export const OPEN_COMPARE_EVENT = "garment:open-compare";
export const OPEN_ASSET_PICKER_EVENT = "garment:open-asset-picker";
export const OPEN_GENERATION_RECORD_EVENT = "garment:open-generation-record";

export type AssetPickerRequest = { mode: "browse" } | {
  mode?: "pick";
  target: DocumentTarget;
  nodeId: string;
} | {
  mode: "conversation";
  target: DocumentTarget;
  purpose: "base" | "reference" | "new-base";
  onSelect: (selection: ImageConversationSourceSelection) => void;
};

export interface GenerationRecordRequest {
  resultId: string;
}

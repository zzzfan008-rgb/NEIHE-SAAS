import type { DocumentTarget } from "@/store/flowStore";
import type {
  ConversationImageInput,
  ImageConversationModeDraft,
  ImageConversationMode,
  ImageConversationOutputView,
} from "@/types/imageConversation";

export interface ImageConversationSourceSelection {
  sourceRef: string;
  previewRef: string;
  label: string;
  /** Present when this selection is a persisted generation output. */
  sourceResultId?: string;
}

export function appendConversationInput(
  mode: ImageConversationMode,
  inputs: ConversationImageInput[],
  selection: ImageConversationSourceSelection,
): ConversationImageInput[] | null {
  if (inputs.some((input) => input.sourceRef === selection.sourceRef)) return inputs;
  if (mode === "single" && inputs.length >= 1) return null;
  const max = mode === "fusion" ? 8 : mode === "mask" ? 7 : 1;
  if (inputs.length >= max) return null;
  return reindexConversationInputs([
    ...inputs,
    {
      role: inputs.length === 0 ? "base" : "reference",
      ordinal: inputs.length,
      sourceRef: selection.sourceRef,
    },
  ]);
}

export function buildConversationInputManifest(
  draft: ImageConversationModeDraft,
): ConversationImageInput[] {
  // Preview URLs are UI-only; only stable source identities cross the API boundary.
  return draft.inputs.map(({ role, ordinal, sourceRef }) => ({ role, ordinal, sourceRef }));
}

export function maskDraftPatchForInputChange(
  draft: ImageConversationModeDraft,
  inputs: ConversationImageInput[],
): Partial<ImageConversationModeDraft> {
  const previousBase = draft.inputs[0]?.sourceRef;
  const nextBase = inputs[0]?.sourceRef;
  if (previousBase === nextBase) return { inputs };
  return {
    inputs,
    maskSourceRef: undefined,
    ...(draft.sourceResultId === undefined ? {} : { sourceResultId: undefined }),
  };
}

export function conversationSourceForOutput(output: Pick<ImageConversationOutputView, "generationOutputId" | "imageRef">): {
  sourceRef: string;
  previewRef: string;
} | null {
  if (!output.imageRef) return null;
  return {
    sourceRef: output.generationOutputId
      ? `generation-output/${output.generationOutputId}`
      : output.imageRef,
    previewRef: output.imageRef,
  };
}

export function sourceResultIdFromReference(sourceRef: string | undefined): string | undefined {
  const match = /^generation-output\/([A-Za-z0-9_-]{1,128})$/.exec(sourceRef ?? "");
  return match?.[1];
}

export function conversationMaskNodeId(tabId: string): string {
  const safe = tabId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 90) || "target";
  return `image-conversation-${safe}`.slice(0, 128);
}

export function documentTargetsMatch(left: DocumentTarget, right: DocumentTarget): boolean {
  return left.tabId === right.tabId &&
    left.projectId === right.projectId &&
    left.documentEpoch === right.documentEpoch;
}

export function reindexConversationInputs(inputs: ConversationImageInput[]): ConversationImageInput[] {
  return inputs.map((input, index) => ({
    ...input,
    ordinal: index,
    role: index === 0 ? "base" : "reference",
  }));
}

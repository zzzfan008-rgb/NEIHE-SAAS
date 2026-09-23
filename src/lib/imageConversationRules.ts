import type {
  ConversationImageInput,
  ImageConversationContext,
  ImageConversationDraft,
  ImageConversationModelCapabilities,
  ImageConversationModeDrafts,
  ImageConversationMode,
  ImageConversationParameters,
  ImageConversationRequestSnapshot,
} from "../types/imageConversation";

export const MAX_CONVERSATION_OUTPUTS = 8;
export const MAX_FUSION_INPUTS = 8;
export const MAX_MASK_INPUTS = 7;
export const IMAGE_CONVERSATION_MODEL_IDS = [
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare",
] as const;
export const IMAGE_CONVERSATION_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;

const IMAGE_CONVERSATION_QUALITIES = ["low", "medium", "high", "xhigh", "max"] as const;
const IMAGE_CONVERSATION_SIZES = ["2K", "4K"] as const;

export function validateOutputCount(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_CONVERSATION_OUTPUTS
  ) {
    throw new Error(`output count must be an integer between 1 and ${MAX_CONVERSATION_OUTPUTS}`);
  }

  return value;
}

export function validateInputManifest(
  mode: ImageConversationMode,
  inputs: ConversationImageInput[],
): ConversationImageInput[] {
  if (!Array.isArray(inputs)) {
    throw new Error("conversation inputs are required");
  }

  if (inputs.some((input) => !isValidInput(input))) {
    throw new Error("conversation input manifest is invalid");
  }

  if (inputs[0]?.role !== "base") {
    throw new Error("the first conversation input must be the base image");
  }

  if (mode === "single" && (inputs.length !== 1 || inputs[0].role !== "base")) {
    throw new Error("single mode requires exactly one base image");
  }

  if (mode === "fusion" && (inputs.length < 2 || inputs.length > MAX_FUSION_INPUTS)) {
    throw new Error(`fusion mode requires 2-${MAX_FUSION_INPUTS} images`);
  }

  if (mode === "mask" && (inputs.length < 1 || inputs.length > MAX_MASK_INPUTS)) {
    throw new Error(`mask mode requires 1-${MAX_MASK_INPUTS} images`);
  }

  if (inputs.slice(1).some((input) => input.role !== "reference")) {
    throw new Error("only the first conversation input can be the base image");
  }

  // The ordinal is positional, not client-authored: the server must not trust a
  // manifest whose ordinals disagree with array order (they are persisted and
  // re-read with `ORDER BY ordinal`).
  inputs.forEach((input, index) => {
    if (input.ordinal !== index) {
      throw new Error("conversation input ordinals must match their order");
    }
  });
  return inputs;
}

export function validateConversationDraft(draft: ImageConversationDraft): true {
  if (!draft || typeof draft !== "object") {
    throw new Error("conversation draft is required");
  }

  if (typeof draft.prompt !== "string" || draft.prompt.trim().length === 0) {
    throw new Error("conversation prompt is required");
  }

  if (
    !draft.parameters ||
    typeof draft.parameters.modelId !== "string" ||
    draft.parameters.modelId.trim().length === 0
  ) {
    throw new Error("conversation model is required");
  }

  if (
    typeof draft.parameters.quality !== "string" ||
    draft.parameters.quality.trim().length === 0
  ) {
    throw new Error("conversation quality is required");
  }

  validateOutputCount(draft.parameters.outputCount);
  validateInputManifest(draft.mode, draft.inputs);
  return true;
}

export function validateModelCompatibility(
  mode: ImageConversationMode,
  parameters: ImageConversationParameters,
  capabilities: ImageConversationModelCapabilities,
): true {
  if (!capabilities.modes.includes(mode)) {
    throw new Error(`model does not support ${mode} mode`);
  }

  if (!capabilities.qualities.includes(parameters.quality)) {
    throw new Error(`model does not support quality ${parameters.quality}`);
  }

  if (parameters.size !== undefined && !capabilities.sizes.includes(parameters.size)) {
    throw new Error(`model does not support size ${parameters.size}`);
  }

  if (
    parameters.aspectRatio !== undefined &&
    !capabilities.aspectRatios.includes(parameters.aspectRatio)
  ) {
    throw new Error(`model does not support aspect ratio ${parameters.aspectRatio}`);
  }

  return true;
}

export function getImageConversationModelCapabilities(
  modelId: string,
): ImageConversationModelCapabilities | undefined {
  if (!(IMAGE_CONVERSATION_MODEL_IDS as readonly string[]).includes(modelId)) return undefined;
  return {
    modes: ["single", "fusion", "mask"],
    qualities: [...IMAGE_CONVERSATION_QUALITIES],
    sizes: [...IMAGE_CONVERSATION_SIZES],
    aspectRatios: [...IMAGE_CONVERSATION_ASPECT_RATIOS],
  };
}

export function getImageConversationModelsForMode(
  mode: ImageConversationMode,
): Array<(typeof IMAGE_CONVERSATION_MODEL_IDS)[number]> {
  return IMAGE_CONVERSATION_MODEL_IDS.filter((modelId) => (
    getImageConversationModelCapabilities(modelId)?.modes.includes(mode) ?? false
  ));
}

/**
 * Validate the server-facing image conversation parameters against the
 * selected mode and the models that are actually wired into this feature.
 * Keep this separate from validateConversationDraft so generic snapshot tests
 * can still exercise structural drafts without pretending a model is enabled.
 */
export function validateImageConversationParameters(
  mode: ImageConversationMode,
  parameters: ImageConversationParameters,
): true {
  if (!parameters || typeof parameters !== "object") {
    throw new Error("conversation parameters are required");
  }
  if (typeof parameters.modelId !== "string" || !parameters.modelId.trim()) {
    throw new Error("conversation model is required");
  }
  if (typeof parameters.quality !== "string" || !parameters.quality.trim()) {
    throw new Error("conversation quality is required");
  }
  if (parameters.size !== undefined && typeof parameters.size !== "string") {
    throw new Error("conversation size is invalid");
  }
  if (parameters.aspectRatio !== undefined && typeof parameters.aspectRatio !== "string") {
    throw new Error("conversation aspect ratio is invalid");
  }
  if (parameters.aspectRatioMode !== undefined &&
    parameters.aspectRatioMode !== "follow" && parameters.aspectRatioMode !== "fixed") {
    throw new Error("conversation aspect ratio mode is invalid");
  }
  validateOutputCount(parameters.outputCount);
  const capabilities = getImageConversationModelCapabilities(parameters.modelId);
  if (!capabilities) throw new Error("selected image model is invalid");
  validateModelCompatibility(mode, parameters, capabilities);
  if (mode === "mask" && parameters.aspectRatioMode === "fixed") {
    throw new Error("mask mode must follow the base image aspect ratio");
  }
  return true;
}

export function closestImageConversationAspectRatio(width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "1:1";
  const ratio = width / height;
  return IMAGE_CONVERSATION_ASPECT_RATIOS.reduce((best, candidate) => {
    const [candidateWidth, candidateHeight] = candidate.split(":").map(Number);
    const bestParts = best.split(":").map(Number);
    const candidateDistance = Math.abs(Math.log(ratio / (candidateWidth / candidateHeight)));
    const bestDistance = Math.abs(Math.log(ratio / (bestParts[0] / bestParts[1])));
    return candidateDistance < bestDistance ? candidate : best;
  }, "1:1");
}

export function createEmptyModeDrafts(): ImageConversationModeDrafts {
  return {
    single: { mode: "single", inputs: [], prompt: "" },
    fusion: { mode: "fusion", inputs: [], prompt: "" },
    mask: { mode: "mask", inputs: [], prompt: "" },
  };
}

export function createConversationRequestSnapshot(
  draft: ImageConversationDraft,
  context: ImageConversationContext,
): ImageConversationRequestSnapshot {
  validateConversationDraft(draft);

  return deepFreeze({
    mode: draft.mode,
    inputs: draft.inputs.map((input) => ({ ...input })),
    prompt: draft.prompt,
    parameters: { ...draft.parameters },
    context: {
      sourceResultId: context.sourceResultId,
      effectiveRequirements: { ...context.effectiveRequirements },
      appliedRelativeActions: [...context.appliedRelativeActions],
    },
  });
}

export function mergeEffectiveRequirements(
  previous: Record<string, unknown>,
  additions: Record<string, unknown>,
): Record<string, unknown> {
  return { ...previous, ...additions };
}

export function buildConversationContext(
  previous: ImageConversationContext,
  branch: Partial<ImageConversationContext>,
): ImageConversationContext {
  const actions = [
    ...previous.appliedRelativeActions,
    ...(branch.appliedRelativeActions ?? []),
  ];

  return {
    sourceResultId: branch.sourceResultId ?? previous.sourceResultId,
    effectiveRequirements: mergeEffectiveRequirements(
      previous.effectiveRequirements,
      branch.effectiveRequirements ?? {},
    ),
    appliedRelativeActions: [...new Set(actions)],
  };
}

function isValidInput(input: ConversationImageInput): boolean {
  return (
    !!input &&
    (input.role === "base" || input.role === "reference") &&
    Number.isInteger(input.ordinal) &&
    input.ordinal >= 0 &&
    typeof input.sourceRef === "string" &&
    input.sourceRef.trim().length > 0
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }

  return value;
}

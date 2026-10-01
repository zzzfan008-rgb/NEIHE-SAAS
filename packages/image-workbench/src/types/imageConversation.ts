export type ImageConversationMode = "single" | "fusion" | "mask";

export type ConversationImageInputRole = "base" | "reference";

export interface ConversationImageInput {
  role: ConversationImageInputRole;
  ordinal: number;
  sourceRef: string;
}

export interface ImageConversationParameters {
  modelId: string;
  quality: string;
  outputCount: number;
  size?: string;
  aspectRatio?: string;
  /** Follow the first/base input until the user explicitly chooses a ratio. */
  aspectRatioMode?: "follow" | "fixed";
}

export interface ImageConversationDraft {
  mode: ImageConversationMode;
  inputs: ConversationImageInput[];
  prompt: string;
  parameters: ImageConversationParameters;
}

export interface ImageConversationModelCapabilities {
  modes: ImageConversationMode[];
  qualities: string[];
  sizes: string[];
  aspectRatios: string[];
}

export interface ImageConversationModeDraft {
  mode: ImageConversationMode;
  inputs: ConversationImageInput[];
  prompt: string;
  /** The concrete generation output used as this mode's current base branch. */
  sourceResultId?: string;
  maskSourceRef?: string;
  parameters?: ImageConversationParameters;
}

export type ImageConversationModeDrafts = Record<
  ImageConversationMode,
  ImageConversationModeDraft
>;

export interface ImageConversationContext {
  sourceResultId?: string;
  effectiveRequirements: Record<string, unknown>;
  appliedRelativeActions: string[];
}

export type ImageConversationPlan =
  | {
      kind: "ready";
      outputCount: number;
      intents: Array<{
        ordinal: number;
        label: string;
        instruction: string;
        requirements: Record<string, unknown>;
      }>;
    }
  | {
      kind: "clarification";
      question: string;
      reason: "count_mismatch" | "ambiguous_requirement";
      requestedCount?: number;
      specifiedIntentCount?: number;
    }
  | {
      kind: "rejected";
      code: "count_exceeded" | "invalid_plan";
      message: string;
    };

export interface ImageConversationClarificationResponse {
  clientRequestId: string;
  /** Optional only for responses saved before question snapshots were introduced. */
  question?: string;
  answer: string;
  fingerprint: string;
  submittedAt: string;
}

export interface ImageConversationClarification {
  id: string;
  roundId: string;
  question: string;
  reason: "count_mismatch" | "ambiguous_requirement";
  requestedCount: number | null;
  specifiedIntentCount: number | null;
  status: "open" | "resolved";
  responses: ImageConversationClarificationResponse[];
  createdAt: string;
  updatedAt: string;
}

export interface ImageConversationRequestSnapshot extends ImageConversationDraft {
  context: ImageConversationContext;
}

export type ImageConversationStatus =
  | "active"
  | "completed"
  | "failed"
  | "archived";

export type ImageConversationRoundStatus =
  | "draft"
  | "planning"
  | "clarification_required"
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "unknown";

export type ImageConversationIntentStatus =
  | "pending"
  | "clarification"
  | "rejected"
  | "clarification_required"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "unknown";

export type ImageConversationOutputStatus = "pending" | "ready" | "failed" | "unknown";

export type ImageConversationSourceKind = "file" | "generation-output" | "asset";

export interface ImageConversationAttemptView {
  id: string;
  intentId: string;
  roundId: string;
  conversationId: string;
  attemptNumber: number;
  clientRequestId: string;
  generationRunId: string | null;
  retryOfAttemptId: string | null;
  status: "queued" | "running" | "succeeded" | "failed" | "outcome_unknown";
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImageConversationIntentView {
  id: string;
  roundId: string;
  conversationId: string;
  ordinal: number;
  label: string;
  instruction: string;
  requirements: Record<string, unknown>;
  status: ImageConversationIntentStatus | "outcome_unknown";
  createdAt: string;
  updatedAt: string;
  attempts: ImageConversationAttemptView[];
}

export interface ImageConversationOutputView {
  id: string;
  roundId: string;
  conversationId: string;
  intentId: string | null;
  ownerId: string;
  projectId: string;
  generationOutputId: string | null;
  imageRef: string | null;
  status: ImageConversationOutputStatus;
  prompt: string | null;
  error: string | null;
  createdAt: string;
}

export interface ImageConversationRoundView {
  id: string;
  conversationId: string;
  ownerId: string;
  projectId: string;
  ordinal: number;
  clientRequestId: string;
  mode: ImageConversationMode;
  sourceResultId: string | null;
  inputManifest: ConversationImageInput[];
  prompt: string;
  parameters: Record<string, unknown>;
  effectiveRequirements: Record<string, unknown>;
  incrementalRequirements: Record<string, unknown>;
  maskRef: string | null;
  status: ImageConversationRoundStatus | "outcome_unknown";
  createdAt: string;
  updatedAt: string;
  intents: ImageConversationIntentView[];
  clarification: ImageConversationClarification | null;
}

export interface ImageConversationView {
  id: string;
  ownerId: string;
  projectId: string;
  sourceRef: string;
  sourceKind: ImageConversationSourceKind;
  status: ImageConversationStatus;
  createdAt: string;
  updatedAt: string;
  sourcePreviews: Record<string, string>;
  rounds: ImageConversationRoundView[];
  outputs: ImageConversationOutputView[];
}

import { create } from "zustand";
import type { ImageConversationPlanRequest } from "@/lib/imageConversationClient";
import type { DocumentTarget } from "@/store/flowStore";
import {
  createEmptyModeDrafts,
} from "@/lib/imageConversationRules";
import type {
  ImageConversationMode,
  ImageConversationModeDraft,
  ImageConversationModeDrafts,
  ImageConversationParameters,
  ImageConversationView,
} from "@/types/imageConversation";

/**
 * Conversation UI state is deliberately separate from the canvas document.
 * This store is memory-only: drafts, history and loading state are never
 * written into the canvas document or browser storage.
 */
export interface ImageConversationTargetState {
  mode: ImageConversationMode;
  modeDrafts: ImageConversationModeDrafts;
  /** Tracks user-edited, unsubmitted drafts independently for each mode. */
  draftDirty: Record<ImageConversationMode, boolean>;
  /** Memory-only draft snapshots keyed by the active conversation or the unbound empty state. */
  draftsByConversation: Record<string, ImageConversationModeDrafts>;
  draftDirtyByConversation: Record<string, Record<ImageConversationMode, boolean>>;
  /** Stable source identity -> browser-loadable preview; never sent as the source identity. */
  sourcePreviews: Record<string, string>;
  /** Unsubmitted answers remain memory-only and are isolated by target and clarification round. */
  clarificationAnswers: Record<string, string>;
  conversation: ImageConversationView | null;
  loading: boolean;
  sending: boolean;
  pendingSubmissions: Record<string, { request: ImageConversationPlanRequest; draft: ImageConversationModeDraft }>;
  pendingRetries: Record<string, string>;
  error: string | null;
}

export interface ImageConversationStore {
  byTarget: Record<string, ImageConversationTargetState>;
  ensureTarget: (target: DocumentTarget) => void;
  setMode: (target: DocumentTarget, mode: ImageConversationMode) => void;
  updateDraft: (
    target: DocumentTarget,
    mode: ImageConversationMode,
    patch: Partial<ImageConversationModeDraft>,
  ) => void;
  replaceDraft: (
    target: DocumentTarget,
    mode: ImageConversationMode,
    draft: ImageConversationModeDraft,
    dirty?: boolean,
  ) => void;
  setSourcePreview: (target: DocumentTarget, sourceRef: string, previewRef: string) => void;
  setClarificationAnswer: (target: DocumentTarget, roundId: string, answer: string) => void;
  setConversation: (
    target: DocumentTarget,
    conversation: ImageConversationView | null,
  ) => void;
  setLoading: (target: DocumentTarget, loading: boolean) => void;
  setSending: (target: DocumentTarget, sending: boolean) => void;
  setError: (target: DocumentTarget, error: string | null) => void;
  setPendingSubmission: (target: DocumentTarget, conversationId: string, submission: ImageConversationTargetState["pendingSubmissions"][string] | null) => void;
  setPendingRetry: (target: DocumentTarget, intentId: string, requestId: string | null) => void;
  markSubmitted: (target: DocumentTarget, conversationId: string, draft: ImageConversationModeDraft) => void;
}

export const DEFAULT_IMAGE_CONVERSATION_PARAMETERS: ImageConversationParameters = {
  modelId: "gpt-image-2.5-sunburst",
  quality: "medium",
  outputCount: 1,
  size: "2K",
  aspectRatio: "1:1",
  aspectRatioMode: "follow",
};

export function imageConversationTargetKey(target: DocumentTarget): string {
  return JSON.stringify([target.tabId, target.projectId, target.documentEpoch]);
}

export function createImageConversationTargetState(): ImageConversationTargetState {
  const modeDrafts = createEmptyModeDrafts();
  for (const mode of ["single", "fusion", "mask"] as const) {
    modeDrafts[mode] = {
      ...modeDrafts[mode],
      parameters: { ...DEFAULT_IMAGE_CONVERSATION_PARAMETERS },
    };
  }
  return {
    mode: "single",
    modeDrafts,
    draftDirty: { single: false, fusion: false, mask: false },
    draftsByConversation: {},
    draftDirtyByConversation: {},
    sourcePreviews: {},
    clarificationAnswers: {},
    conversation: null,
    loading: false,
    sending: false,
    pendingSubmissions: {},
    pendingRetries: {},
    error: null,
  };
}

export function getImageConversationTargetState(
  state: Pick<ImageConversationStore, "byTarget">,
  target: DocumentTarget,
): ImageConversationTargetState | undefined {
  return state.byTarget[imageConversationTargetKey(target)];
}

function updateTargetState(
  state: ImageConversationStore,
  target: DocumentTarget,
  update: (current: ImageConversationTargetState) => ImageConversationTargetState,
): Pick<ImageConversationStore, "byTarget"> {
  const key = imageConversationTargetKey(target);
  const current = state.byTarget[key] ?? createImageConversationTargetState();
  return { byTarget: { ...state.byTarget, [key]: update(current) } };
}

const UNBOUND_DRAFT_KEY = "__unbound__";

function conversationDraftKey(conversation: ImageConversationView | null): string {
  return conversation?.id ?? UNBOUND_DRAFT_KEY;
}

function cloneModeDrafts(drafts: ImageConversationModeDrafts): ImageConversationModeDrafts {
  return {
    single: { ...drafts.single, inputs: drafts.single.inputs.map((input) => ({ ...input })), parameters: drafts.single.parameters ? { ...drafts.single.parameters } : undefined },
    fusion: { ...drafts.fusion, inputs: drafts.fusion.inputs.map((input) => ({ ...input })), parameters: drafts.fusion.parameters ? { ...drafts.fusion.parameters } : undefined },
    mask: { ...drafts.mask, inputs: drafts.mask.inputs.map((input) => ({ ...input })), parameters: drafts.mask.parameters ? { ...drafts.mask.parameters } : undefined },
  };
}

function emptyModeDraftsWithDefaults(): ImageConversationModeDrafts {
  return cloneModeDrafts(createImageConversationTargetState().modeDrafts);
}

export const useImageConversationStore = create<ImageConversationStore>((set) => ({
  byTarget: {},
  setPendingSubmission: (target, conversationId, submission) => set((state) => updateTargetState(state, target, (current) => {
    const pendingSubmissions = { ...current.pendingSubmissions };
    if (submission) pendingSubmissions[conversationId] = structuredClone(submission);
    else delete pendingSubmissions[conversationId];
    return { ...current, pendingSubmissions };
  })),
  setPendingRetry: (target, intentId, requestId) => set((state) => updateTargetState(state, target, (current) => {
    const pendingRetries = { ...current.pendingRetries };
    if (requestId) pendingRetries[intentId] = requestId;
    else delete pendingRetries[intentId];
    return { ...current, pendingRetries };
  })),
  markSubmitted: (target, conversationId, draft) => set((state) => updateTargetState(state, target, (current) => {
    const active = current.conversation?.id === conversationId;
    const drafts = active ? current.modeDrafts : current.draftsByConversation[conversationId];
    // A successful request acknowledges its snapshot, not edits made while awaiting it.
    if (JSON.stringify(drafts?.[draft.mode]) !== JSON.stringify(draft)) return current;
    const dirty = { ...(active ? current.draftDirty : current.draftDirtyByConversation[conversationId]), [draft.mode]: false };
    return {
      ...current,
      ...(active ? { draftDirty: dirty } : {}),
      draftDirtyByConversation: { ...current.draftDirtyByConversation, [conversationId]: dirty },
    };
  })),
  ensureTarget: (target) => set((state) => {
    const key = imageConversationTargetKey(target);
    return state.byTarget[key]
      ? state
      : { byTarget: { ...state.byTarget, [key]: createImageConversationTargetState() } };
  }),
  setMode: (target, mode) => set((state) => updateTargetState(state, target, (current) => ({
    ...current,
    mode,
    error: null,
  }))),
  updateDraft: (target, mode, patch) => set((state) => updateTargetState(state, target, (current) => ({
    ...current,
    modeDrafts: {
      ...current.modeDrafts,
      [mode]: { ...current.modeDrafts[mode], ...patch, mode },
    },
    draftDirty: { ...current.draftDirty, [mode]: true },
    draftsByConversation: {
      ...current.draftsByConversation,
      [conversationDraftKey(current.conversation)]: {
        ...current.modeDrafts,
        [mode]: { ...current.modeDrafts[mode], ...patch, mode },
      },
    },
    draftDirtyByConversation: {
      ...current.draftDirtyByConversation,
      [conversationDraftKey(current.conversation)]: { ...current.draftDirty, [mode]: true },
    },
    error: null,
  }))),
  replaceDraft: (target, mode, draft, dirty = false) => set((state) => updateTargetState(state, target, (current) => ({
    ...current,
    modeDrafts: { ...current.modeDrafts, [mode]: { ...draft, mode } },
    draftDirty: { ...current.draftDirty, [mode]: dirty },
    draftsByConversation: {
      ...current.draftsByConversation,
      [conversationDraftKey(current.conversation)]: {
        ...current.modeDrafts,
        [mode]: { ...draft, mode },
      },
    },
    draftDirtyByConversation: {
      ...current.draftDirtyByConversation,
      [conversationDraftKey(current.conversation)]: { ...current.draftDirty, [mode]: dirty },
    },
    error: null,
  }))),
  setSourcePreview: (target, sourceRef, previewRef) => set((state) => updateTargetState(state, target, (current) => ({
    ...current,
    sourcePreviews: { ...current.sourcePreviews, [sourceRef]: previewRef },
  }))),
  setClarificationAnswer: (target, roundId, answer) => set((state) => updateTargetState(state, target, (current) => ({
    ...current,
    clarificationAnswers: { ...current.clarificationAnswers, [roundId]: answer },
  }))),
  setConversation: (target, conversation) => set((state) => updateTargetState(state, target, (current) => {
    const previousKey = conversationDraftKey(current.conversation);
    const nextKey = conversationDraftKey(conversation);
    const draftsByConversation = {
      ...current.draftsByConversation,
      [previousKey]: cloneModeDrafts(current.modeDrafts),
    };
    const draftDirtyByConversation = {
      ...current.draftDirtyByConversation,
      [previousKey]: { ...current.draftDirty },
    };
    // Opening a source resolves asynchronously. If the user starts typing before
    // that resolution creates the conversation, the unbound draft belongs to the
    // conversation that is about to be activated and must not be replaced by an
    // empty conversation draft.
    const preserveUnboundDraft = previousKey === UNBOUND_DRAFT_KEY &&
      !draftsByConversation[nextKey] &&
      Object.values(current.draftDirty).some(Boolean);
    const nextDrafts = draftsByConversation[nextKey]
      ? cloneModeDrafts(draftsByConversation[nextKey])
      : conversation && !preserveUnboundDraft
        ? emptyModeDraftsWithDefaults()
        : cloneModeDrafts(current.modeDrafts);
    const nextDirty = draftDirtyByConversation[nextKey]
      ? { ...draftDirtyByConversation[nextKey] }
      : conversation && !preserveUnboundDraft
        ? { single: false, fusion: false, mask: false }
        : { ...current.draftDirty };
    return {
      ...current,
      conversation,
      modeDrafts: nextDrafts,
      draftDirty: nextDirty,
      draftsByConversation,
      draftDirtyByConversation,
    };
  })),
  setLoading: (target, loading) => set((state) => updateTargetState(state, target, (current) => ({
    ...current,
    loading,
  }))),
  setSending: (target, sending) => set((state) => updateTargetState(state, target, (current) => ({
    ...current,
    sending,
  }))),
  setError: (target, error) => set((state) => updateTargetState(state, target, (current) => ({
    ...current,
    error,
  }))),
}));

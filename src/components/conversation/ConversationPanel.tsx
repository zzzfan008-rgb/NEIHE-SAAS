import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { AlertTriangleIcon, ImageIcon, MessageCircleIcon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { MaskEditor } from "@/components/nodes/MaskEditor";
import { beginMaskWork, selectActiveDocumentTarget, selectActiveNodes, selectActiveReadOnly, selectActiveSelectedNodeIds, useFlowStore, type DocumentTarget, type FlowNode } from "@/store/flowStore";
import { uploadMaskDraft } from "@/lib/maskUpload";
import { syncImageConversationResults } from "@/lib/imageConversationResults";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OPEN_ASSET_PICKER_EVENT } from "@/lib/overlayEvents";
import {
  validateImageConversationParameters,
  validateConversationDraft,
} from "@/lib/imageConversationRules";
import {
  appendConversationInput,
  buildConversationInputManifest,
  conversationMaskNodeId,
  documentTargetsMatch,
  maskDraftPatchForInputChange,
  reindexConversationInputs,
  sourceResultIdFromReference,
  type ImageConversationSourceSelection,
} from "@/lib/imageConversationInputs";
import {
  createImageConversationRequestId,
  ImageConversationRequestError,
  createImageConversation,
  createOrResolveImageConversation,
  getImageConversation,
  reconcileImageConversationRound,
  planImageConversationRound,
  resolveImageConversation,
  retryImageConversationIntent,
  uploadImageConversationFile,
} from "@/lib/imageConversationClient";
import {
  createImageConversationTargetState,
  DEFAULT_IMAGE_CONVERSATION_PARAMETERS,
  getImageConversationTargetState,
  imageConversationTargetKey,
  useImageConversationStore,
} from "@/store/imageConversationStore";
import type {
  ImageConversationIntentView,
  ImageConversationMode,
  ImageConversationModeDraft,
  ImageConversationParameters,
  ImageConversationView,
} from "@/types/imageConversation";
import { ConversationComposer } from "./ConversationComposer";
import { ConversationHistory } from "./ConversationHistory";

type SelectedCanvasSource = ImageConversationSourceSelection;

const EMPTY_TARGET_STATE = createImageConversationTargetState();

export function ConversationPanel({ openRequest = 0 }: { openRequest?: number }) {
  const selection = useFlowStore(useShallow((state) => ({
    ...selectActiveDocumentTarget(state),
    nodes: selectActiveNodes(state),
    selectedNodeIds: selectActiveSelectedNodeIds(state),
    readOnly: selectActiveReadOnly(state),
  })));
  const target = useMemo(() => ({
    tabId: selection.tabId,
    projectId: selection.projectId,
    documentEpoch: selection.documentEpoch,
  }), [selection.documentEpoch, selection.projectId, selection.tabId]);
  const targetKey = imageConversationTargetKey(target);
  const targetState = useImageConversationStore((state) => state.byTarget[targetKey]) ?? EMPTY_TARGET_STATE;
  const ensureTarget = useImageConversationStore((state) => state.ensureTarget);
  const setMode = useImageConversationStore((state) => state.setMode);
  const updateDraft = useImageConversationStore((state) => state.updateDraft);
  const replaceDraft = useImageConversationStore((state) => state.replaceDraft);
  const setSourcePreview = useImageConversationStore((state) => state.setSourcePreview);
  const setClarificationAnswer = useImageConversationStore((state) => state.setClarificationAnswer);
  const setConversation = useImageConversationStore((state) => state.setConversation);
  const setSending = useImageConversationStore((state) => state.setSending);
  const setError = useImageConversationStore((state) => state.setError);
  const [uploading, setUploading] = useState(false);
  const [maskEditing, setMaskEditing] = useState(false);
  const [maskEditingTargetKey, setMaskEditingTargetKey] = useState<string | null>(null);
  const [pendingBaseChange, setPendingBaseChange] = useState<ImageConversationSourceSelection | null>(null);
  const [pendingSourceChoices, setPendingSourceChoices] = useState<SelectedCanvasSource[] | null>(null);
  const [pendingSourceSwitch, setPendingSourceSwitch] = useState<SelectedCanvasSource | null>(null);
  const [reconcilingRoundId, setReconcilingRoundId] = useState<string | null>(null);
  const [uploadPurpose, setUploadPurpose] = useState<"input" | "new">("input");
  const uploadRef = useRef<HTMLInputElement>(null);
  const activationVersion = useRef(0);
  const isCurrentConversation = (requestedTarget: DocumentTarget, conversationId: string | null, version: number) => (
    activationVersion.current === version &&
    documentTargetsMatch(requestedTarget, selectActiveDocumentTarget(useFlowStore.getState())) &&
    (getImageConversationTargetState(useImageConversationStore.getState(), requestedTarget)?.conversation?.id ?? null) === conversationId
  );

  useEffect(() => {
    ensureTarget(target);
  }, [ensureTarget, targetKey, target]);

  useEffect(() => {
    if (targetState.conversation) syncImageConversationResults(targetState.conversation);
  }, [targetState.conversation]);

  const selectedSources = useMemo(
    () => selectedCanvasSources(selection.nodes, selection.selectedNodeIds),
    [selection.nodes, selection.selectedNodeIds],
  );
  const mode = targetState.mode;
  const draft = targetState.modeDrafts[mode];
  const activeRound = targetState.conversation?.rounds.some((round) => (
    round.status === "planning" || round.status === "queued" || round.status === "running" ||
    round.status === "outcome_unknown"
  )) ?? false;
  const clarificationRound = [...(targetState.conversation?.rounds ?? [])]
    .reverse()
    .find((round) => round.status === "clarification_required" && round.clarification?.status === "open");
  const clarification = clarificationRound?.clarification ?? null;
  const clarificationAnswer = clarification
    ? targetState.clarificationAnswers[clarification.id] ?? ""
    : "";
  const requestDraft: ImageConversationModeDraft = clarificationRound ? {
    mode: clarificationRound.mode,
    prompt: clarificationRound.prompt,
    inputs: clarificationRound.inputManifest,
    parameters: imageConversationParametersFromRecord(clarificationRound.parameters),
    sourceResultId: clarificationRound.sourceResultId ?? undefined,
    maskSourceRef: clarificationRound.maskRef ?? undefined,
  } : draft;
  const sourceRef = targetState.conversation?.sourceRef ?? draft.inputs[0]?.sourceRef ?? null;
  const hasSource = draft.inputs.length > 0;
  const validationError = getDraftValidationError(requestDraft.mode, requestDraft);
  const clarificationError = clarification && !clarificationAnswer.trim()
    ? "请先回答澄清问题。"
    : null;
  const pendingSubmission = targetState.conversation && targetState.pendingSubmissions[targetState.conversation.id];
  const canSend = !selection.readOnly && !activeRound && !targetState.sending && !pendingSourceChoices && !pendingSourceSwitch && (Boolean(pendingSubmission) || (!validationError && !clarificationError));
  const maskInput = draft.inputs[0] ?? null;
  const maskPreview = maskInput
    ? targetState.sourcePreviews[maskInput.sourceRef] ?? maskInput.sourceRef
    : null;
  const maskEditorOpen = maskEditing && maskEditingTargetKey === targetKey && mode === "mask" && Boolean(maskPreview);

  const activateConversationFromSource = async (
    requestedTarget: DocumentTarget,
    source: SelectedCanvasSource,
    isCancelled: () => boolean = () => false,
  ) => {
    const version = ++activationVersion.current;
    const cancelled = () => isCancelled() || version !== activationVersion.current;
    setError(requestedTarget, null);
    try {
      const conversation = await resolveImageConversation(requestedTarget, source.sourceRef);
      if (cancelled()) return;
      const resolvedConversation = conversation ?? await createOrResolveImageConversation(requestedTarget, source.sourceRef);
      if (cancelled()) return;
      const currentTarget = selectActiveDocumentTarget(useFlowStore.getState());
      if (!documentTargetsMatch(requestedTarget, currentTarget)) return;
      setConversation(requestedTarget, resolvedConversation);
      restoreConversationPreviews(requestedTarget, resolvedConversation, setSourcePreview);
      setSourcePreview(requestedTarget, source.sourceRef, source.previewRef);
      const activatedState = getImageConversationTargetState(useImageConversationStore.getState(), requestedTarget);
      if (!Object.values(activatedState?.draftDirty ?? {}).some(Boolean)) {
        if (resolvedConversation.rounds.length > 0) {
          restoreConversationDraft(
            requestedTarget,
            resolvedConversation,
            setMode,
            replaceDraft,
            setSourcePreview,
          );
          // Opening a concrete output branches from that output, not its parent round's inputs.
          if (sourceResultIdFromReference(source.sourceRef)) {
            const restored = getImageConversationTargetState(useImageConversationStore.getState(), requestedTarget)!;
            replaceDraft(requestedTarget, restored.mode, {
              ...restored.modeDrafts[restored.mode],
              inputs: [{ role: "base", ordinal: 0, sourceRef: source.sourceRef }],
              sourceResultId: sourceResultIdFromReference(source.sourceRef),
              prompt: "",
              maskSourceRef: undefined,
            }, false);
          }
        } else {
          const nextMode = activatedState?.mode ?? "single";
          const nextDraft = activatedState?.modeDrafts[nextMode];
          if (nextDraft && nextDraft.inputs.length === 0) {
            replaceDraft(requestedTarget, nextMode, {
              ...nextDraft,
              inputs: [{ role: "base", ordinal: 0, sourceRef: source.sourceRef }],
              prompt: "",
              sourceResultId: source.sourceResultId,
              maskSourceRef: undefined,
            }, false);
          }
        }
      }
      setPendingSourceChoices(null);
      setPendingSourceSwitch(null);
    } catch (error) {
      if (cancelled()) return;
      const currentTarget = selectActiveDocumentTarget(useFlowStore.getState());
      if (!documentTargetsMatch(requestedTarget, currentTarget)) return;
      setError(requestedTarget, error instanceof Error ? error.message : "对话历史恢复失败");
    }
  };

  useEffect(() => {
    if (!openRequest) return;
    if (selectedSources.length > 1) {
      setPendingSourceSwitch(null);
      setPendingSourceChoices(selectedSources);
      return;
    }
    setPendingSourceSwitch(null);
    setPendingSourceChoices(null);
    if (selectedSources.length !== 1) return;
    const requestedTarget = target;
    const source = selectedSources[0];
    let cancelled = false;
    void activateConversationFromSource(requestedTarget, source, () => cancelled);
    return () => {
      cancelled = true;
    };
    // Deliberately only reacts to the explicit Dock-open request. Ordinary canvas selection must not load history.
  }, [openRequest]);

  useEffect(() => {
    setPendingSourceChoices(null);
    setPendingSourceSwitch(null);
  }, [targetKey]);

  useEffect(() => {
    const conversationId = targetState.conversation?.id;
    if (!conversationId || !activeRound) return;
    const requestedTarget = target;
    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const refreshed = await getImageConversation(requestedTarget, conversationId);
        if (cancelled || !isCurrentConversation(requestedTarget, conversationId, activationVersion.current)) return;
        const currentTarget = selectActiveDocumentTarget(useFlowStore.getState());
        if (!documentTargetsMatch(requestedTarget, currentTarget)) return;
        setConversation(requestedTarget, refreshed);
        restoreConversationPreviews(requestedTarget, refreshed, setSourcePreview);
      } catch (error) {
        if (cancelled || !isCurrentConversation(requestedTarget, conversationId, activationVersion.current)) return;
        const currentTarget = selectActiveDocumentTarget(useFlowStore.getState());
        if (!documentTargetsMatch(requestedTarget, currentTarget)) return;
        setError(requestedTarget, error instanceof Error ? error.message : "对话状态刷新失败");
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // Durable conversation polling keeps closed/reopened panels and response-loss recovery in sync.
  }, [activeRound, targetKey, targetState.conversation?.id]);

  const patchDraft = (patch: Partial<ImageConversationModeDraft>) => updateDraft(target, mode, patch);

  const updateBaseAspectRatio = (aspectRatio: string) => {
    const latestState = getImageConversationTargetState(useImageConversationStore.getState(), target);
    const latestMode = latestState?.mode ?? mode;
    const latestDraft = latestState?.modeDrafts[latestMode] ?? draft;
    const parameters = latestDraft.parameters ?? { ...DEFAULT_IMAGE_CONVERSATION_PARAMETERS };
    if (parameters.aspectRatioMode === "fixed") return;
    if (parameters.aspectRatio === aspectRatio && parameters.aspectRatioMode === "follow") return;
    updateDraft(target, latestMode, {
      parameters: { ...parameters, aspectRatio, aspectRatioMode: "follow" },
    });
  };

  useEffect(() => {
    if (!maskEditorOpen) return;
    return beginMaskWork();
  }, [maskEditorOpen]);

  useEffect(() => {
    if (mode !== "mask") setMaskEditing(false);
  }, [mode]);

  const addSourceToTarget = (sourceTarget: typeof target, source: ImageConversationSourceSelection) => {
    const latestState = getImageConversationTargetState(useImageConversationStore.getState(), sourceTarget)
      ?? createImageConversationTargetState();
    const latestMode = latestState.mode;
    const latestDraft = latestState.modeDrafts[latestMode];
    const nextInputs = appendConversationInput(latestMode, latestDraft.inputs, source);
    if (!nextInputs) {
      setError(sourceTarget, latestMode === "single" ? "单图修改只能保留一张底图。" : "当前模式已达到参考图上限。");
      return;
    }
    updateDraft(sourceTarget, latestMode, { inputs: nextInputs });
    if (latestDraft.inputs.length === 0) {
      updateDraft(sourceTarget, latestMode, {
        sourceResultId: source.sourceResultId ?? sourceResultIdFromReference(source.sourceRef),
      });
    }
    setSourcePreview(sourceTarget, source.sourceRef, source.previewRef);
  };

  const addSource = (source: ImageConversationSourceSelection) => {
    addSourceToTarget(target, source);
  };

  const activateSelectedSource = (source: SelectedCanvasSource) => {
    const latestState = getImageConversationTargetState(useImageConversationStore.getState(), target);
    const latestMode = latestState?.mode ?? mode;
    const latestDraft = latestState?.modeDrafts[latestMode] ?? draft;
    const currentBase = latestDraft.inputs[0]?.sourceRef;
    if (
      currentBase &&
      currentBase !== source.sourceRef &&
      latestState?.draftDirty[latestMode]
    ) {
      setPendingSourceSwitch(source);
      return;
    }
    void activateConversationFromSource(target, source);
  };

  const chooseSelectedSource = (source: SelectedCanvasSource) => {
    if (pendingSourceChoices) {
      activateSelectedSource(source);
      return;
    }
    addSource(source);
  };

  const confirmSelectedSourceSwitch = () => {
    const source = pendingSourceSwitch;
    if (!source) return;
    const latestState = getImageConversationTargetState(useImageConversationStore.getState(), target);
    const latestMode = latestState?.mode ?? mode;
    const latestDraft = latestState?.modeDrafts[latestMode] ?? draft;
    replaceDraft(target, latestMode, {
      ...latestDraft,
      inputs: [],
      prompt: "",
      sourceResultId: undefined,
      maskSourceRef: undefined,
    }, false);
    setPendingSourceSwitch(null);
    void activateConversationFromSource(target, source);
  };

  const openAssetPicker = (purpose: "base" | "reference" | "new-base") => {
    const requestedTarget = target;
    const conversationId = targetState.conversation?.id ?? null;
    const version = activationVersion.current;
    window.dispatchEvent(new CustomEvent(OPEN_ASSET_PICKER_EVENT, {
      detail: {
        mode: "conversation",
        target: requestedTarget,
        purpose,
        onSelect: (source: ImageConversationSourceSelection) => {
          if (!isCurrentConversation(requestedTarget, conversationId, version)) return;
          const currentTarget = selectActiveDocumentTarget(useFlowStore.getState());
          if (!documentTargetsMatch(requestedTarget, currentTarget)) return;
          if (purpose === "new-base") {
            void startNewConversationFromSource(requestedTarget, source);
          } else {
            addSourceToTarget(requestedTarget, source);
          }
        },
      },
    }));
  };

  const startNewConversationFromSource = async (
    requestedTarget: DocumentTarget,
    source: ImageConversationSourceSelection,
  ) => {
    const currentTarget = selectActiveDocumentTarget(useFlowStore.getState());
    if (!documentTargetsMatch(requestedTarget, currentTarget)) return;
    const version = ++activationVersion.current;
    setError(requestedTarget, null);
    try {
      const conversation = await createImageConversation(requestedTarget, source.sourceRef);
      if (version !== activationVersion.current) return;
      const afterCreateTarget = selectActiveDocumentTarget(useFlowStore.getState());
      if (!documentTargetsMatch(requestedTarget, afterCreateTarget)) return;
      setConversation(requestedTarget, conversation);
      restoreConversationPreviews(requestedTarget, conversation, setSourcePreview);
      const nextState = getImageConversationTargetState(useImageConversationStore.getState(), requestedTarget);
      const nextMode = nextState?.mode ?? mode;
      updateDraft(requestedTarget, nextMode, {
        inputs: [{ role: "base", ordinal: 0, sourceRef: source.sourceRef }],
        prompt: "",
        sourceResultId: undefined,
        maskSourceRef: undefined,
      });
      setSourcePreview(requestedTarget, source.sourceRef, source.previewRef);
    } catch (error) {
      if (version !== activationVersion.current || !documentTargetsMatch(requestedTarget, selectActiveDocumentTarget(useFlowStore.getState()))) return;
      setError(requestedTarget, error instanceof Error ? error.message : "开始新修改失败");
    }
  };

  const openUpload = (purpose: "input" | "new") => {
    setUploadPurpose(purpose);
    uploadRef.current?.click();
  };

  const addInput = () => {
    const nextSource = selectedSources.find((source) => !draft.inputs.some((input) => input.sourceRef === source.sourceRef));
    if (nextSource) {
      addSource(nextSource);
      return;
    }
    openAssetPicker(draft.inputs.length > 0 ? "reference" : "base");
  };

  const handleUpload = async (file?: File) => {
    if (!file) return;
    const requestedTarget = target;
    const conversationId = targetState.conversation?.id ?? null;
    const version = activationVersion.current;
    setUploading(true);
    setError(requestedTarget, null);
    try {
      const uploaded = await uploadImageConversationFile(file);
      if (!isCurrentConversation(requestedTarget, conversationId, version)) return;
      const currentTarget = selectActiveDocumentTarget(useFlowStore.getState());
      if (!documentTargetsMatch(requestedTarget, currentTarget)) return;
      const source = { sourceRef: uploaded.url, previewRef: uploaded.url, label: file.name };
      if (uploadPurpose === "new") {
        await startNewConversationFromSource(requestedTarget, source);
      } else {
        addSourceToTarget(requestedTarget, source);
      }
    } catch (error) {
      if (!isCurrentConversation(requestedTarget, conversationId, version)) return;
      setError(requestedTarget, error instanceof Error ? error.message : "图片上传失败");
    } finally {
      setUploading(false);
    }
  };

  const removeInput = (ordinal: number) => {
    const remaining = draft.inputs.filter((input) => input.ordinal !== ordinal);
    patchDraft(maskDraftPatchForInputChange(draft, reindexConversationInputs(remaining)));
  };

  const moveInput = (ordinal: number, direction: "up" | "down") => {
    if (mode !== "fusion") return;
    const index = draft.inputs.findIndex((input) => input.ordinal === ordinal);
    const nextIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || nextIndex < 0 || nextIndex >= draft.inputs.length) return;
    const next = [...draft.inputs];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    const reordered = reindexConversationInputs(next);
    patchDraft({
      inputs: reordered,
      sourceResultId: sourceResultIdFromReference(reordered[0]?.sourceRef),
    });
  };

  const submit = async () => {
    const requestedTarget = target;
    const store = useImageConversationStore.getState();
    const initialState = getImageConversationTargetState(store, requestedTarget);
    if (initialState?.sending) return;
    let conversationId = initialState?.conversation?.id ?? null;
    const version = activationVersion.current;
    const pending = conversationId ? initialState?.pendingSubmissions[conversationId] : undefined;
    const errorMessage = getDraftValidationError(requestDraft.mode, requestDraft);
    if (errorMessage && !pending) {
      setError(target, errorMessage);
      return;
    }
    if (activeRound) {
      setError(target, "当前对话已有生成中的轮次，请等待本轮结束后再发送。");
      return;
    }
    if (clarificationError && !pending) {
      setError(target, clarificationError);
      return;
    }
    const inputManifest = buildConversationInputManifest(requestDraft);
    const parameters = requestDraft.parameters ?? { ...DEFAULT_IMAGE_CONVERSATION_PARAMETERS };
    const sourceResultId = requestDraft.sourceResultId
      ?? sourceResultIdFromReference(inputManifest[0]?.sourceRef)
      ?? null;
    setSending(target, true);
    setError(target, null);
    try {
      let conversation = initialState?.conversation;
      if (!conversation) {
        conversation = await createOrResolveImageConversation(requestedTarget, inputManifest[0].sourceRef);
      }
      const currentTarget = selectActiveDocumentTarget(useFlowStore.getState());
      if (!documentTargetsMatch(requestedTarget, currentTarget)) return;
      if (!isCurrentConversation(requestedTarget, conversationId, version)) return;
      if (!conversationId) setConversation(requestedTarget, conversation);
      conversationId = conversation.id;
      const submission = pending ?? { draft: structuredClone(requestDraft), request: {
        clientRequestId: createImageConversationRequestId(),
        mode: requestDraft.mode,
        inputManifest,
        prompt: requestDraft.prompt,
        parameters,
        sourceResultId,
        effectiveRequirements: {},
        incrementalRequirements: {},
        maskRef: requestDraft.mode === "mask" ? requestDraft.maskSourceRef ?? null : null,
        ...(clarification
          ? {
              clarificationRoundId: clarification.roundId,
              clarificationAnswer: clarificationAnswer.trim(),
            }
          : {}),
      } };
      store.setPendingSubmission(requestedTarget, conversation.id, submission);
      const planned = await planImageConversationRound(requestedTarget, conversation.id, submission.request);
      syncImageConversationResults({ ...conversation, rounds: [planned.round] });
      store.setPendingSubmission(requestedTarget, conversation.id, null);
      if (!submission.request.clarificationRoundId) store.markSubmitted(requestedTarget, conversation.id, submission.draft);
      const requestedTab = useFlowStore.getState().tabs.find((tab) => tab.id === requestedTarget.tabId);
      if (!requestedTab || !documentTargetsMatch(requestedTarget, {
        tabId: requestedTab.id, projectId: requestedTab.projectId, documentEpoch: requestedTab.documentEpoch,
      })) return;
      const latestConversation = getImageConversationTargetState(useImageConversationStore.getState(), requestedTarget)?.conversation;
      if (latestConversation?.id !== conversation.id) return;
      // Cache accepted work for the original live document even when another tab is active.
      setConversation(requestedTarget, {
        ...latestConversation,
        rounds: [...latestConversation.rounds.filter((round) => round.id !== planned.round.id), planned.round].sort((a, b) => a.ordinal - b.ordinal),
      });
      if (clarification && getImageConversationTargetState(useImageConversationStore.getState(), requestedTarget)?.clarificationAnswers[clarification.id] === submission.request.clarificationAnswer) {
        setClarificationAnswer(requestedTarget, clarification.id, "");
      }
      if (!isCurrentConversation(requestedTarget, conversation.id, version)) return;
      const refreshed = await getImageConversation(requestedTarget, conversation.id);
      if (!isCurrentConversation(requestedTarget, conversation.id, version)) return;
      setConversation(requestedTarget, refreshed);
      restoreConversationPreviews(requestedTarget, refreshed, setSourcePreview);
    } catch (error) {
      if (conversationId && error instanceof ImageConversationRequestError && error.requestSettled) {
        store.setPendingSubmission(requestedTarget, conversationId, null);
      }
      if (!isCurrentConversation(requestedTarget, conversationId, version)) return;
      setError(requestedTarget, error instanceof Error ? error.message : "对话修改发送失败");
    } finally {
      setSending(requestedTarget, false);
    }
  };

  const continueFromOutput = (source: ImageConversationSourceSelection) => {
    const currentState = getImageConversationTargetState(useImageConversationStore.getState(), target);
    const currentDraft = currentState?.modeDrafts[currentState.mode] ?? draft;
    const currentBase = currentDraft.inputs[0]?.sourceRef;
    if (
      currentBase &&
      currentBase !== source.sourceRef &&
      currentState?.draftDirty[currentState.mode]
    ) {
      setPendingBaseChange(source);
      return;
    }
    applyContinueFromOutput(source);
  };

  const applyContinueFromOutput = (source: ImageConversationSourceSelection) => {
    const latestState = getImageConversationTargetState(useImageConversationStore.getState(), target);
    const latestMode = latestState?.mode ?? mode;
    const latestDraft = latestState?.modeDrafts[latestMode] ?? draft;
    const inputs = [{ role: "base" as const, ordinal: 0, sourceRef: source.sourceRef }];
    updateDraft(target, latestMode, {
      ...maskDraftPatchForInputChange(latestDraft, inputs),
      prompt: "",
      sourceResultId: source.sourceResultId ?? sourceResultIdFromReference(source.sourceRef),
    });
    setSourcePreview(target, source.sourceRef, source.previewRef);
    setPendingBaseChange(null);
  };

  const addReferenceFromOutput = (source: ImageConversationSourceSelection) => {
    addSource(source);
  };

  const openMaskEditor = () => {
    if (!maskInput || !maskPreview) return;
    setMaskEditingTargetKey(targetKey);
    setMaskEditing(true);
  };

  const saveConversationMask = async (dataUrl: string) => {
    if (!maskInput || !maskPreview) throw new Error("请先选择局部重绘底图");
    const conversationId = targetState.conversation?.id ?? null;
    const version = activationVersion.current;
    const uploaded = await uploadMaskDraft({
      dataUrl,
      sourceRef: maskPreview,
      projectId: target.projectId,
      nodeId: conversationMaskNodeId(target.tabId),
    });
    const currentTarget = selectActiveDocumentTarget(useFlowStore.getState());
    if (!documentTargetsMatch(target, currentTarget) || !isCurrentConversation(target, conversationId, version)) {
      throw new Error("当前图片或项目已变化，蒙版未绑定到新文档");
    }
    const latestState = getImageConversationTargetState(useImageConversationStore.getState(), target);
    if (latestState?.modeDrafts.mask.inputs[0]?.sourceRef !== maskInput.sourceRef) {
      throw new Error("底图已变化，请重新绘制蒙版");
    }
    updateDraft(target, "mask", { maskSourceRef: uploaded.url });
    setMaskEditing(false);
  };

  const retryIntent = async (intent: ImageConversationIntentView) => {
    const conversation = targetState.conversation;
    const store = useImageConversationStore.getState();
    if (!conversation || getImageConversationTargetState(store, target)?.sending) return;
    const requestedTarget = target;
    const version = activationVersion.current;
    const requestId = getImageConversationTargetState(store, target)?.pendingRetries[intent.id] ?? createImageConversationRequestId();
    store.setPendingRetry(requestedTarget, intent.id, requestId);
    setSending(requestedTarget, true);
    setError(requestedTarget, null);
    try {
      const retried = await retryImageConversationIntent(
        requestedTarget,
        conversation.id,
        intent.id,
        requestId,
      );
      syncImageConversationResults({ ...conversation, rounds: [retried.round] });
      store.setPendingRetry(requestedTarget, intent.id, null);
      if (!isCurrentConversation(requestedTarget, conversation.id, version)) return;
      const latestConversation = getImageConversationTargetState(useImageConversationStore.getState(), requestedTarget)?.conversation ?? conversation;
      setConversation(requestedTarget, { ...latestConversation, rounds: latestConversation.rounds.map((round) => round.id === retried.round.id ? retried.round : round) });
      const currentTarget = selectActiveDocumentTarget(useFlowStore.getState());
      if (!documentTargetsMatch(requestedTarget, currentTarget)) return;
      const refreshed = await getImageConversation(requestedTarget, conversation.id);
      if (!isCurrentConversation(requestedTarget, conversation.id, version)) return;
      setConversation(requestedTarget, refreshed);
      restoreConversationPreviews(requestedTarget, refreshed, setSourcePreview);
    } catch (error) {
      if (error instanceof ImageConversationRequestError && error.requestSettled) store.setPendingRetry(requestedTarget, intent.id, null);
      if (!isCurrentConversation(requestedTarget, conversation.id, version)) return;
      setError(requestedTarget, error instanceof Error ? error.message : "重试失败");
    } finally {
      setSending(requestedTarget, false);
    }
  };

  const reconcileRound = async (roundId: string) => {
    if (reconcilingRoundId || targetState.sending) return;
    const requestedTarget = target;
    const conversation = targetState.conversation;
    if (!conversation) return;
    const version = activationVersion.current;
    setReconcilingRoundId(roundId);
    setError(requestedTarget, null);
    try {
      const refreshed = await reconcileImageConversationRound(requestedTarget, conversation.id, roundId);
      if (!isCurrentConversation(requestedTarget, conversation.id, version)) return;
      const currentTarget = selectActiveDocumentTarget(useFlowStore.getState());
      if (!documentTargetsMatch(requestedTarget, currentTarget)) return;
      setConversation(requestedTarget, refreshed);
      restoreConversationPreviews(requestedTarget, refreshed, setSourcePreview);
    } catch (error) {
      if (!isCurrentConversation(requestedTarget, conversation.id, version)) return;
      setError(requestedTarget, error instanceof Error ? error.message : "结果核对失败");
    } finally {
      setReconcilingRoundId(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--gc-panel)] text-[var(--gc-text)]" data-testid="image-conversation-panel">
      <header className="shrink-0 border-b border-[var(--gc-border)] px-3 py-3">
        <div className="flex items-start gap-2">
          <MessageCircleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--gc-accent)]" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">对话修改</h2>
            <p className="mt-1 truncate text-[11px] text-[var(--gc-text-muted)]">
              {sourceRef ? `当前来源：${sourceLabel(sourceRef)}` : selectedSources.length > 0 ? `已选择 ${selectedSources.length} 张图片，等待指定底图` : "尚未选择底图"}
            </p>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
          <Button type="button" variant="ghost" size="xs" onClick={() => openUpload("new")} disabled={selection.readOnly || uploading}>
            <UploadIcon aria-hidden="true" />开始新修改·上传
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={() => openAssetPicker("new-base")} disabled={selection.readOnly || uploading}>
            <ImageIcon aria-hidden="true" />开始新修改·素材
          </Button>
        </div>
      </header>

      <Tabs value={mode} onValueChange={(value) => setMode(target, value as ImageConversationMode)} className="min-h-0 flex-1 gap-0">
        <TabsList variant="line" className="grid h-10 shrink-0 grid-cols-3 rounded-none border-b border-[var(--gc-border)] px-2">
          <TabsTrigger value="single" className="text-xs">单图修改</TabsTrigger>
          <TabsTrigger value="fusion" className="text-xs">多图融合</TabsTrigger>
          <TabsTrigger value="mask" className="text-xs">局部重绘</TabsTrigger>
        </TabsList>
        <TabsContent value={mode} className="flex min-h-0 flex-1 flex-col gap-0">
          {targetState.error && (
            <div role="alert" className="mx-3 mt-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs leading-5 text-amber-200">
              <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span>{targetState.error}</span>
            </div>
          )}

          {pendingSourceChoices ? (
            <MultiSourceChoiceState
              sources={pendingSourceChoices}
              onChoose={chooseSelectedSource}
              onCancel={() => setPendingSourceChoices(null)}
            />
          ) : targetState.conversation || hasSource ? (
            <ConversationHistory
              conversation={targetState.conversation}
              target={target}
              onView={(imageRef) => useFlowStore.getState().openViewer({ url: imageRef, title: "对话修改结果" })}
              onContinue={continueFromOutput}
              onAddReference={addReferenceFromOutput}
              onRetry={(intent) => void retryIntent(intent)}
              onReconcile={(roundId) => void reconcileRound(roundId)}
              reconcilingRoundId={reconcilingRoundId}
            />
          ) : (
            <EmptyConversationState
              selectedSources={selectedSources}
              onChoose={chooseSelectedSource}
              onUpload={() => openUpload("new")}
              onOpenAssets={() => openAssetPicker("new-base")}
            />
          )}

          {(validationError || clarificationError) && hasSource && (
            <p className="shrink-0 px-3 pb-2 text-[10px] leading-4 text-amber-300">{validationError ?? clarificationError}</p>
          )}
          <ConversationComposer
            mode={mode}
            draft={draft}
            sourcePreviews={targetState.sourcePreviews}
            clarification={clarification ? {
              question: clarification.question,
              answer: clarificationAnswer,
              onAnswerChange: (answer) => setClarificationAnswer(target, clarification.id, answer),
            } : undefined}
            disabled={selection.readOnly || uploading || Boolean(pendingSourceChoices) || Boolean(pendingSourceSwitch)}
            canSend={canSend}
            sending={targetState.sending}
            onDraftChange={patchDraft}
            onRemoveInput={removeInput}
            onMoveInput={moveInput}
            onAddInput={addInput}
            onUpload={() => openUpload("input")}
            onBaseAspectRatioChange={updateBaseAspectRatio}
            onEditMask={openMaskEditor}
            onSubmit={() => void submit()}
          />
        </TabsContent>
      </Tabs>

      <input
        ref={uploadRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="sr-only"
        aria-label="上传对话修改图片"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          void handleUpload(file);
        }}
      />
      {maskEditorOpen && maskPreview && (
        <MaskEditor
          source={maskPreview}
          initialMask={draft.maskSourceRef}
          onSave={saveConversationMask}
          onClose={() => setMaskEditing(false)}
        />
      )}
      <AlertDialog
        open={pendingBaseChange !== null}
        onOpenChange={(open) => { if (!open) setPendingBaseChange(null); }}
      >
        <AlertDialogContent overlayClassName="z-[90]" className="z-[91]">
          <AlertDialogHeader>
            <AlertDialogTitle>更换当前模式底图？</AlertDialogTitle>
            <AlertDialogDescription>
              当前模式有尚未发送的文字、选图或蒙版。取消会保留草稿；确认更换会清空当前模式草稿，并使用“{pendingBaseChange?.label ?? "新结果"}”作为底图。其他模式和已提交历史不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消切换</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (pendingBaseChange) applyContinueFromOutput(pendingBaseChange); }}>
              更换底图并清空当前模式草稿
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={pendingSourceSwitch !== null}
        onOpenChange={(open) => { if (!open) setPendingSourceSwitch(null); }}
      >
        <AlertDialogContent overlayClassName="z-[90]" className="z-[91]">
          <AlertDialogHeader>
            <AlertDialogTitle>更换当前模式底图？</AlertDialogTitle>
            <AlertDialogDescription>
              当前模式有尚未发送的文字、选图或蒙版。取消会保留当前对话和草稿；确认切换会清空当前模式草稿，并使用“{pendingSourceSwitch?.label ?? "所选图片"}”作为新的底图。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消切换</AlertDialogCancel>
            <AlertDialogAction onClick={confirmSelectedSourceSwitch}>
              切换并清空当前模式草稿
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function MultiSourceChoiceState({
  sources,
  onChoose,
  onCancel,
}: {
  sources: SelectedCanvasSource[];
  onChoose: (source: SelectedCanvasSource) => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-5 py-8">
      <div className="w-full max-w-sm space-y-4">
        <div className="space-y-1 text-center">
          <h3 className="text-sm font-medium">选择对话修改的起点</h3>
          <p className="text-xs leading-5 text-[var(--gc-text-muted)]">
            当前选中了 {sources.length} 张图片。请指定一张底图；不会自动融合或发送生成请求。
          </p>
        </div>
        <div className="space-y-2 rounded-lg border border-[var(--gc-border)] bg-[var(--gc-control)] p-2">
          {sources.map((source) => (
            <Button
              key={source.sourceRef}
              type="button"
              variant="ghost"
              className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-xs"
              onClick={() => onChoose(source)}
            >
              <ImageIcon aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate">{source.label}</span>
            </Button>
          ))}
        </div>
        <Button type="button" variant="outline" className="w-full" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}

function EmptyConversationState({
  selectedSources,
  onChoose,
  onUpload,
  onOpenAssets,
}: {
  selectedSources: SelectedCanvasSource[];
  onChoose: (source: SelectedCanvasSource) => void;
  onUpload: () => void;
  onOpenAssets: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-5 py-8">
      <div className="w-full max-w-sm space-y-4 text-center">
        <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-[var(--gc-accent)]/12 text-[var(--gc-accent)]">
          <ImageIcon aria-hidden="true" className="size-5" />
        </div>
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium">从一张图片开始修改</h3>
          <p className="text-xs leading-5 text-[var(--gc-text-muted)]">
            先指定底图，再输入修改要求。普通画布选择不会自动切换或发送对话。
          </p>
        </div>
        {selectedSources.length > 0 && (
          <div className="space-y-2 rounded-lg border border-[var(--gc-border)] bg-[var(--gc-control)] p-2 text-left">
            <p className="px-1 text-[10px] font-medium text-[var(--gc-text-muted)]">当前选择</p>
            {selectedSources.map((source) => (
              <Button key={source.sourceRef} type="button" variant="ghost" className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-xs" onClick={() => onChoose(source)}>
                <ImageIcon aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="truncate">{source.label}</span>
              </Button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant="outline" onClick={onUpload}>
            <UploadIcon aria-hidden="true" />本地上传
          </Button>
          <Button type="button" variant="outline" onClick={onOpenAssets}>
            <ImageIcon aria-hidden="true" />素材库
          </Button>
        </div>
      </div>
    </div>
  );
}

function selectedCanvasSources(nodes: FlowNode[], selectedNodeIds: string[]): SelectedCanvasSource[] {
  const selected = new Set(selectedNodeIds);
  const sources: SelectedCanvasSource[] = [];
  for (const node of nodes) {
    if (!selected.has(node.id)) continue;
    const data = node.data as Record<string, unknown>;
    const stableSource = typeof data.imageConversationSourceRef === "string" && data.imageConversationSourceRef.trim()
      ? data.imageConversationSourceRef
      : null;
    const refs = (stableSource
      ? [stableSource]
      : [
          ...(typeof data.imageUrl === "string" ? [data.imageUrl] : []),
          ...(Array.isArray(data.images) ? data.images.filter((value): value is string => typeof value === "string") : []),
          ...(Array.isArray(data.outputImages) ? data.outputImages.filter((value): value is string => typeof value === "string") : []),
        ]).filter((ref) => ref.startsWith("/api/files/") || ref.startsWith("asset/") || ref.startsWith("generation-output/"));
    refs.forEach((sourceRef, index) => {
      if (!sources.some((source) => source.sourceRef === sourceRef)) {
        const previewRef = sourceRef.startsWith("/api/files/")
          ? sourceRef
          : typeof data.imageUrl === "string" && data.imageUrl.startsWith("/api/files/")
            ? data.imageUrl
            : sourceRef;
        sources.push({
          sourceRef,
          previewRef,
          label: `${node.data.label || "画布图片"}${refs.length > 1 ? ` · ${index + 1}` : ""}`,
          sourceResultId: sourceResultIdFromReference(sourceRef),
        });
      }
    });
  }
  return sources;
}

function restoreConversationDraft(
  target: DocumentTarget,
  conversation: ImageConversationView,
  setMode: (target: DocumentTarget, mode: ImageConversationMode) => void,
  replaceDraft: (
    target: DocumentTarget,
    mode: ImageConversationMode,
    draft: ImageConversationModeDraft,
    dirty?: boolean,
  ) => void,
  setSourcePreview: (target: DocumentTarget, sourceRef: string, previewRef: string) => void,
): void {
  const round = conversation.rounds.at(-1);
  if (!round) return;
  setMode(target, round.mode);
  replaceDraft(target, round.mode, {
    mode: round.mode,
    inputs: round.inputManifest.map((input) => ({ ...input })),
    prompt: round.prompt,
    sourceResultId: round.sourceResultId
      ?? sourceResultIdFromReference(round.inputManifest[0]?.sourceRef),
    parameters: imageConversationParametersFromRecord(round.parameters),
    maskSourceRef: round.maskRef ?? undefined,
  }, false);
  for (const input of round.inputManifest) {
    const previewRef = conversation.sourcePreviews[input.sourceRef]
      ?? (input.sourceRef.startsWith("/api/files/") ? input.sourceRef : undefined)
      ?? conversation.outputs.find((output) => (
        output.generationOutputId && input.sourceRef === `generation-output/${output.generationOutputId}`
      ))?.imageRef;
    if (previewRef) setSourcePreview(target, input.sourceRef, previewRef);
  }
}

function restoreConversationPreviews(
  target: DocumentTarget,
  conversation: ImageConversationView,
  setSourcePreview: (target: DocumentTarget, sourceRef: string, previewRef: string) => void,
): void {
  for (const [sourceRef, previewRef] of Object.entries(conversation.sourcePreviews ?? {})) {
    setSourcePreview(target, sourceRef, previewRef);
  }
}

function imageConversationParametersFromRecord(
  value: Record<string, unknown>,
): ImageConversationParameters {
  const defaults = DEFAULT_IMAGE_CONVERSATION_PARAMETERS;
  return {
    modelId: typeof value.modelId === "string" && value.modelId.trim() ? value.modelId : defaults.modelId,
    quality: typeof value.quality === "string" && value.quality.trim() ? value.quality : defaults.quality,
    outputCount: typeof value.outputCount === "number" && Number.isInteger(value.outputCount)
      ? value.outputCount
      : defaults.outputCount,
    size: typeof value.size === "string" ? value.size : defaults.size,
    aspectRatio: typeof value.aspectRatio === "string" ? value.aspectRatio : defaults.aspectRatio,
    aspectRatioMode: value.aspectRatioMode === "fixed" ? "fixed" : "follow",
  };
}

function getDraftValidationError(mode: ImageConversationMode, draft: ImageConversationModeDraft): string | null {
  try {
    validateConversationDraft({
      mode,
      inputs: draft.inputs,
      prompt: draft.prompt,
      parameters: draft.parameters ?? { ...DEFAULT_IMAGE_CONVERSATION_PARAMETERS },
    });
    const parameters = draft.parameters ?? { ...DEFAULT_IMAGE_CONVERSATION_PARAMETERS };
    validateImageConversationParameters(mode, parameters);
    if (mode === "mask" && draft.maskSourceRef === undefined) return "局部重绘需要先绘制并保存蒙版。";
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "当前输入还不能发送";
  }
}

function sourceLabel(sourceRef: string): string {
  const match = /\/([^/]+?)(?:\.[a-z0-9]+)?(?:\?.*)?$/i.exec(sourceRef);
  return match?.[1] ?? sourceRef;
}

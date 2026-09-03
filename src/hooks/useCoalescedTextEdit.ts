import {
  useCallback,
  useEffect,
  useRef,
  type ChangeEvent,
  type CompositionEvent,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import {
  cancelCoalescedTextEdit,
  flushActiveTextEdit,
  setCoalescedTextEditComposing,
  updateCoalescedTextEdit,
  type CoalescedTextEditDescriptor,
  type CoalescedTextEditToken,
} from "@/store/flowStore";

type TextControl = HTMLInputElement | HTMLTextAreaElement;

interface CoalescedTextEditOptions {
  multiline?: boolean;
}

/** Preserve the keydown→compositionend→keyup identity of an IME-confirming Enter. */
export function createCompositionEnterGuard() {
  let pendingEnterKeyUp = false;
  return {
    markKeyDown(key: string, composing: boolean) {
      if (key === "Enter") pendingEnterKeyUp = composing;
    },
    consumeKeyUp(key: string) {
      if (key !== "Enter" || !pendingEnterKeyUp) return false;
      pendingEnterKeyUp = false;
      return true;
    },
    reset() {
      pendingEnterKeyUp = false;
    },
  };
}

/** Shared input boundary for history, IME composition and lifecycle-safe commits. */
export function useCoalescedTextEdit(
  descriptor: CoalescedTextEditDescriptor | null,
  options: CoalescedTextEditOptions = {},
) {
  const tokenRef = useRef<CoalescedTextEditToken | null>(null);
  const composingRef = useRef(false);
  const compositionEnterGuardRef = useRef<ReturnType<typeof createCompositionEnterGuard> | null>(null);
  if (!compositionEnterGuardRef.current) {
    compositionEnterGuardRef.current = createCompositionEnterGuard();
  }
  const descriptorKind = descriptor?.kind;
  const descriptorNodeId = descriptor?.kind === "node-data" ? descriptor.nodeId : undefined;
  const descriptorField = descriptor?.kind === "node-data" ? descriptor.field : undefined;

  const updateValue = useCallback((value: string) => {
    if (!descriptor) return false;
    const token = updateCoalescedTextEdit(
      descriptor,
      value,
      tokenRef.current,
      { composing: composingRef.current },
    );
    tokenRef.current = token;
    return token !== null;
  }, [descriptorKind, descriptorNodeId, descriptorField]);

  const flush = useCallback(() => {
    const token = tokenRef.current;
    tokenRef.current = null;
    composingRef.current = false;
    compositionEnterGuardRef.current?.reset();
    return token ? flushActiveTextEdit(token) : false;
  }, []);

  const cancel = useCallback(() => {
    const token = tokenRef.current;
    tokenRef.current = null;
    composingRef.current = false;
    compositionEnterGuardRef.current?.reset();
    return token ? cancelCoalescedTextEdit(token) : false;
  }, []);

  // A component may be reused for another node after a selection/tab change.
  // Commit the old immutable target before accepting events for the new field.
  useEffect(() => () => {
    const token = tokenRef.current;
    tokenRef.current = null;
    composingRef.current = false;
    compositionEnterGuardRef.current?.reset();
    if (token) flushActiveTextEdit(token);
  }, [descriptorKind, descriptorNodeId, descriptorField]);

  const onChange = useCallback((event: ChangeEvent<TextControl>) => {
    updateValue(event.currentTarget.value);
  }, [updateValue]);

  const onBlur = useCallback((_event: FocusEvent<TextControl>) => {
    flush();
  }, [flush]);

  const onCompositionStart = useCallback((_event: CompositionEvent<TextControl>) => {
    compositionEnterGuardRef.current?.reset();
    composingRef.current = true;
    const token = tokenRef.current;
    if (token) setCoalescedTextEditComposing(token, true);
  }, []);

  const onCompositionEnd = useCallback((event: CompositionEvent<TextControl>) => {
    updateValue(event.currentTarget.value);
    composingRef.current = false;
    const token = tokenRef.current;
    if (token) setCoalescedTextEditComposing(token, false);
  }, [updateValue]);

  const onKeyDown = useCallback((event: KeyboardEvent<TextControl>) => {
    const composing = event.nativeEvent.isComposing || composingRef.current;
    compositionEnterGuardRef.current?.markKeyDown(event.key, composing);
    if (
      event.key === "Enter" &&
      !options.multiline &&
      !composing
    ) {
      flush();
    }
  }, [flush, options.multiline]);

  const onKeyUp = useCallback((event: KeyboardEvent<TextControl>) => {
    // Browsers usually dispatch compositionend before the keyup belonging to
    // the Enter that confirmed an IME candidate. It is not a multiline boundary.
    if (compositionEnterGuardRef.current?.consumeKeyUp(event.key)) return;
    if (
      event.key === "Enter" &&
      options.multiline &&
      !event.nativeEvent.isComposing &&
      !composingRef.current
    ) {
      // keyup observes the textarea value after the newline was inserted.
      updateValue(event.currentTarget.value);
      flush();
    }
  }, [flush, options.multiline, updateValue]);

  return {
    updateValue,
    flush,
    cancel,
    bind: {
      onChange,
      onBlur,
      onCompositionStart,
      onCompositionEnd,
      onKeyDown,
      onKeyUp,
    },
  };
}

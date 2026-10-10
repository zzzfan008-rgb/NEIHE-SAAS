import type { CompositionEvent, FocusEvent, KeyboardEvent as ReactKeyboardEvent } from "react";

// UI-only, keyed by the actual editor. Never enters document state or history.
const composingEditors = new WeakSet<EventTarget>();

interface KeyboardLike {
  target: EventTarget | null;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

export function isImeKeyEvent(event: KeyboardLike): boolean {
  const native = event.nativeEvent ?? event;
  return native.isComposing === true || native.keyCode === 229 ||
    (event.target !== null && composingEditors.has(event.target));
}

function isTextEditor(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === "TEXTAREA") return true;
  return target instanceof HTMLInputElement &&
    !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(target.type);
}

function isolateEditorKey(event: ReactKeyboardEvent<HTMLElement>) {
  if (!isTextEditor(event.target)) return;
  // Preserve ordinary dismiss and the existing project-save shortcut. All other
  // text editing belongs to the editor, not React Flow's document-level listeners.
  if (!isImeKeyEvent(event) && (event.key === "Escape" ||
    ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s"))) return;
  // Bubble phase: local editor handlers already ran. Never cancel native IME.
  event.stopPropagation();
}

/** Spread onto the existing workspace root; React portals share this boundary. */
export const textInputKeyboardBoundary = {
  onCompositionStartCapture(event: CompositionEvent<HTMLElement>) {
    if (isTextEditor(event.target)) composingEditors.add(event.target);
  },
  onCompositionEndCapture(event: CompositionEvent<HTMLElement>) {
    composingEditors.delete(event.target);
  },
  onBlurCapture(event: FocusEvent<HTMLElement>) {
    composingEditors.delete(event.target);
  },
  onKeyDown: isolateEditorKey,
  // Let keyup release shortcuts started outside the editor before focus moved.
  // React Flow's keyup listeners only clear pressed state; they do not cancel IME.
};

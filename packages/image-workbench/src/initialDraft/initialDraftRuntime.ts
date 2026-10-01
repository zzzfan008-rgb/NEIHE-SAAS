interface InitialDraftDocumentTarget {
  tabId: string;
  projectId: string;
  documentEpoch: number;
}

type InitialDraftSaveBarrier = (target: InitialDraftDocumentTarget) => Promise<void>;

let saveBarrier: InitialDraftSaveBarrier | null = null;
let interactionBlocking = false;

export function registerInitialDraftSaveBarrier(barrier: InitialDraftSaveBarrier): () => void {
  saveBarrier = barrier;
  return () => {
    if (saveBarrier === barrier) saveBarrier = null;
  };
}

export async function waitForInitialDraftSyncBeforeFormalSave(
  target: InitialDraftDocumentTarget,
): Promise<void> {
  await saveBarrier?.(target);
}

export function setInitialDraftInteractionBlocking(blocking: boolean): void {
  interactionBlocking = blocking;
}

export function isInitialDraftInteractionBlocking(): boolean {
  return interactionBlocking;
}

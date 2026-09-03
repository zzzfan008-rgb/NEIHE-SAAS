let workbenchTutorialBlocking = false;

export const OPEN_TUTORIAL_EVENT = "garment-canvas:open-tutorial";

export function setWorkbenchTutorialBlocking(blocking: boolean): void {
  workbenchTutorialBlocking = blocking;
}

export function isWorkbenchTutorialBlocking(): boolean {
  return workbenchTutorialBlocking;
}

import { useEffect } from 'react';
import { analyzePosePrompt, poseReferenceKey } from '../store/poseReferenceRuntime';
import type { DocumentTarget } from '../store/flowStore';

/** Keep legacy pose auto-inference without exposing its prompt on the canvas. */
export default function PosePromptAutoInference({ target, nodeId, source, connected, readOnly }: {
  target: DocumentTarget; nodeId: string; source: string; connected: boolean; readOnly: boolean;
}) {
  const key = poseReferenceKey(target, nodeId, source);
  useEffect(() => {
    if (connected && !readOnly) void analyzePosePrompt(target, nodeId, source);
  }, [key, nodeId, source, connected, readOnly]);
  return null;
}

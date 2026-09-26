import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider, useAuth } from '../../src/auth/AuthContext';
import PosePromptInferenceDialog from '../../src/components/PosePromptInferenceDialog';
import { Button } from '../../src/components/ui/button';
import { useFlowStore, selectActiveDocumentTarget } from '../../src/store/flowStore';
import '../../src/index.css';

useFlowStore.getState().loadFlow({ projectId: 'pose-e2e', projectName: '姿势测试', nodes: [{
  id: 'pose', type: 'image-input', position: { x: 0, y: 0 },
  data: { kind: 'image-input', label: '姿势参考', status: 'idle', imageRole: 'reference', poseReference: true, imageUrl: '/api/files/pose-e2e.png', posePrompt: '原有用户编辑', posePromptImage: '/api/files/pose-e2e.png' },
}], edges: [] });
useFlowStore.setState({ saveProjectInTab: async () => true });

function Fixture() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (!user) return <p>未登录</p>;
  return <><Button ref={triggerRef} onClick={() => setOpen(true)}>反推人物姿势</Button>
    <Button onClick={() => void logout()}>退出登录</Button>
    {open && <PosePromptInferenceDialog target={selectActiveDocumentTarget(useFlowStore.getState())} nodeId="pose" source="/api/files/pose-e2e.png" triggerRef={triggerRef} onClose={() => setOpen(false)} />}</>;
}
createRoot(document.getElementById('root')!).render(<AuthProvider><Fixture /></AuthProvider>);

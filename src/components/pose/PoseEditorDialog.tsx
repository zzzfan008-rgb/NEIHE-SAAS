import { lazy, Suspense, useCallback, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PoseEditor2D } from "@/components/pose/PoseEditor2D";
import { posePointOptions, posePointLabel, type PoseEditorGroupFilter, type PoseEditorLayer } from "@/components/pose/poseEditorLabels";
import { addPosePerson, mirrorPoseDocument, movePosePoint, removePosePerson, setPosePoint, type PosePointPath } from "@/lib/poseEditorModel";
import { canRedoPoseEditorHistory, canUndoPoseEditorHistory, commitPoseEditorHistory, createPoseEditorHistory, redoPoseEditorHistory, undoPoseEditorHistory } from "@/lib/poseEditorHistory";
import { markPose3DStale, resetPose3DFromCurrent2D } from "@/lib/pose3dModel";
import type { PoseDocumentV1, PosePointV1 } from "@/types/poseDocument";

const PoseEditor3D = lazy(() => import("@/components/pose/PoseEditor3D").then(({ PoseEditor3D: component }) => ({ default: component })));
type PoseEditorDialogProps = {
  open: boolean;
  source: string;
  initialDocument: PoseDocumentV1;
  onSave: (document: PoseDocumentV1, mode: 'apply' | 'save-as') => Promise<void>;
  onClose: () => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
};

type PoseEditorMode = '2d' | '3d';

const LAYER_LABELS: Array<[PoseEditorLayer, string]> = [
  ["body", "身体"], ["hands", "双手"], ["feet", "脚部"], ["face", "面部"],
];

function pointPathKey(path: PosePointPath): string {
  return `${path.personId}|${path.group}|${"index" in path ? path.index : "center"}`;
}

function makePath(personId: string, group: PoseEditorGroupFilter, value: string): PosePointPath | null {
  if (group === "all") return null;
  if (group === "neck" || group === "midHip") return { personId, group };
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? { personId, group, index } : null;
}

export function PoseEditorDialog({ open, source, initialDocument, onSave, onClose, triggerRef }: PoseEditorDialogProps) {
  const [history, setHistory] = useState(() => createPoseEditorHistory(initialDocument));
  const [draftDocument, setDraftDocument] = useState<PoseDocumentV1 | null>(null);
  const draftRef = useRef<PoseDocumentV1 | null>(null);
  const threeDDraftRef = useRef<PoseDocumentV1 | null>(null);
  const pose3DPersonRef = useRef<string | null>(initialDocument.pose3d && !initialDocument.pose3d.stale ? initialDocument.people[0]?.id ?? null : null);
  const [mode, setMode] = useState<PoseEditorMode>('2d');
  const [activePersonId, setActivePersonId] = useState(initialDocument.people[0]?.id ?? "");
  const [group, setGroup] = useState<PoseEditorGroupFilter>("body");
  const [activePoint, setActivePoint] = useState<PosePointPath | null>(
    initialDocument.people[0] ? { personId: initialDocument.people[0].id, group: "body", index: 0 } : null,
  );
  const [layers, setLayers] = useState<Record<PoseEditorLayer, boolean>>({ body: true, hands: true, feet: true, face: true });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const initialSerialized = useRef(JSON.stringify(initialDocument));
  const document = draftDocument ?? history.present;
  const person = document.people.find((candidate) => candidate.id === activePersonId) ?? document.people[0];
  const faceCount = person?.faceTopology === "face70" ? 70 : 68;
  const pointOptions = useMemo(() => person ? posePointOptions(person.id, group, faceCount) : [], [person, group, faceCount]);
  const activeOption = pointOptions.find(({ path }) => pointPathKey(path) === (activePoint ? pointPathKey(activePoint) : ""));
  const activePointValue = activeOption && "index" in activeOption.path ? String(activeOption.path.index) : "center";
  const point = activePoint && person?.id === activePoint.personId
    ? activePoint.group === "neck" || activePoint.group === "midHip"
      ? person[activePoint.group]
      : activePoint.group === "leftHand"
        ? person.hands.left[activePoint.index]
        : activePoint.group === "rightHand"
          ? person.hands.right[activePoint.index]
          : person[activePoint.group][activePoint.index]
    : null;
  const isDirty = JSON.stringify(document) !== initialSerialized.current;

  const commit = useCallback((next: PoseDocumentV1) => {
    const stale = markPose3DStale(next);
    draftRef.current = null;
    threeDDraftRef.current = null;
    setDraftDocument(null);
    setHistory((current) => commitPoseEditorHistory(current, stale));
  }, []);

  const commitPose3D = useCallback((next: PoseDocumentV1) => {
    draftRef.current = null;
    threeDDraftRef.current = null;
    setDraftDocument(null);
    setHistory((current) => commitPoseEditorHistory(current, next));
  }, []);

  const undo = useCallback(() => {
    draftRef.current = null;
    threeDDraftRef.current = null;
    setDraftDocument(null);
    setHistory((current) => undoPoseEditorHistory(current));
  }, []);

  const redo = useCallback(() => {
    draftRef.current = null;
    threeDDraftRef.current = null;
    setDraftDocument(null);
    setHistory((current) => redoPoseEditorHistory(current));
  }, []);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) return;
    if (isDirty || saving) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  const finishClose = () => {
    setConfirmDiscard(false);
    onClose();
  };

  const beginPointDrag = () => {
    draftRef.current = history.present;
    setDraftDocument(history.present);
  };

  const draftPoint = (path: PosePointPath, next: PosePointV1) => {
    const base = draftRef.current ?? history.present;
    const draft = markPose3DStale(setPosePoint(base, path, next));
    draftRef.current = draft;
    setDraftDocument(draft);
  };

  const finishPointDrag = () => {
    const next = draftRef.current;
    if (!next) return;
    commit(next);
  };

  const updatePoint = (next: PosePointV1) => {
    if (!activePoint) return;
    try {
      commit(setPosePoint(document, activePoint, next));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "关键点更新失败");
    }
  };

  const beginPose3DDraft = () => {
    threeDDraftRef.current = history.present;
    setDraftDocument(history.present);
  };

  const draftPose3D = (next: PoseDocumentV1) => {
    threeDDraftRef.current = next;
    setDraftDocument(next);
  };

  const finishPose3DDraft = () => {
    const next = threeDDraftRef.current;
    if (!next) return;
    if (JSON.stringify(next) !== JSON.stringify(history.present)) commitPose3D(next);
    else {
      threeDDraftRef.current = null;
      setDraftDocument(null);
    }
  };

  const switchMode = (nextMode: string) => {
    if (nextMode !== '2d' && nextMode !== '3d') return;
    if (nextMode === '3d' && person) {
      const personChanged = pose3DPersonRef.current !== null && pose3DPersonRef.current !== person.id;
      const needsRebuild = !document.pose3d || document.pose3d.stale || personChanged;
      if (needsRebuild) {
        try {
          const nextDocument = resetPose3DFromCurrent2D(document, person.id);
          pose3DPersonRef.current = person.id;
          commitPose3D(nextDocument);
          setError(null);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "3D 姿势建立失败");
          return;
        }
      } else {
        pose3DPersonRef.current = person.id;
      }
    }
    setMode(nextMode);
  };

  const selectPerson = (id: string | null) => {
    if (!id) return;
    setActivePersonId(id);
    setActivePoint(makePath(id, group, group === "neck" || group === "midHip" ? "center" : "0"));
  };

  const save = async (saveMode: 'apply' | 'save-as') => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(document, saveMode);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存姿势失败");
    } finally {
      setSaving(false);
    }
  };

  const handleEditorKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          aria-label={mode === '2d' ? '2D 姿势编辑' : '3D 姿势编辑'}
          finalFocus={triggerRef}
          onKeyDown={handleEditorKeyDown}
          className="nodrag nopan flex max-w-none flex-col overflow-hidden bg-[var(--gc-panel)] text-[var(--gc-text)]"
          style={{ width: "min(1320px, calc(100vw - 32px))", maxWidth: "none", maxHeight: "calc(100vh - 32px)" }}
        >
          <DialogHeader>
            <DialogTitle>{mode === '2d' ? '2D 姿势编辑' : '3D 姿势编辑'}</DialogTitle>
            <DialogDescription id="pose-editor-description">
              2D 用于精确点位与面部、手部编辑；3D 用于当前人物的骨架 IK 调整。保存会在画布新增姿势参考，不覆盖来源图片。
            </DialogDescription>
          </DialogHeader>
          <Tabs value={mode} onValueChange={switchMode} className="flex min-h-0 flex-1 flex-col gap-2">
            <TabsList aria-label="姿势编辑模式" className="w-fit">
              <TabsTrigger value="2d">2D 点位</TabsTrigger>
              <TabsTrigger value="3d">3D IK</TabsTrigger>
            </TabsList>
            <TabsContent value="2d" className="min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden">
              <div className="grid min-h-full grid-cols-1 grid-rows-[minmax(320px,1fr)_auto] gap-3 xl:grid-cols-[minmax(0,1fr)_300px] xl:grid-rows-1">
                <PoseEditor2D
                  imageUrl={source}
                  document={document}
                  activePersonId={person?.id ?? activePersonId}
                  activePoint={activePoint}
                  layers={layers}
                  zoom={zoom}
                  pan={pan}
                  onZoomChange={setZoom}
                  onPanChange={setPan}
                  onSelectPoint={setActivePoint}
                  onBeginPointDrag={beginPointDrag}
                  onDraftPoint={draftPoint}
                  onFinishPointDrag={finishPointDrag}
                  onNudgePoint={(path, dx, dy) => commit(movePosePoint(document, path, dx, dy))}
                  onSetMissingPoint={(path, coordinates) => commit(setPosePoint(document, path, { ...coordinates, confidence: 1, origin: "manual" }))}
                />
                <aside aria-label="姿势编辑工具" className="flex min-h-0 flex-col gap-3 rounded-lg border border-[var(--gc-border)] bg-[var(--gc-canvas)] p-3 xl:overflow-y-auto">
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" disabled={!canUndoPoseEditorHistory(history)} onClick={undo}>撤销</Button>
                    <Button size="sm" variant="outline" disabled={!canRedoPoseEditorHistory(history)} onClick={redo}>重做</Button>
                    <Button size="sm" variant="outline" onClick={() => commit(mirrorPoseDocument(document))}>左右镜像</Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <label htmlFor="pose-editor-person" className="shrink-0 text-xs">人物</label>
                    <Select value={person?.id ?? ""} onValueChange={selectPerson}>
                      <SelectTrigger id="pose-editor-person" aria-label="选择人物"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {document.people.map((candidate, index) => <SelectItem key={candidate.id} value={candidate.id}>人物 {index + 1}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Button size="sm" variant="outline" aria-label="添加人物" disabled={document.people.length >= 8} onClick={() => {
                      try {
                        const next = addPosePerson(document);
                        commit(next);
                        setActivePersonId(next.people[next.people.length - 1].id);
                        setActivePoint(null);
                      } catch (cause) { setError(cause instanceof Error ? cause.message : "添加人物失败"); }
                    }}>＋</Button>
                    <Button size="sm" variant="outline" aria-label="删除当前人物" disabled={document.people.length <= 1 || !person} onClick={() => {
                      if (!person) return;
                      try {
                        const next = removePosePerson(document, person.id);
                        commit(next);
                        setActivePersonId(next.people[0].id);
                        setActivePoint(null);
                      } catch (cause) { setError(cause instanceof Error ? cause.message : "删除人物失败"); }
                    }}>－</Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-xs">画布宽度<Input aria-label="画布宽度" type="number" readOnly value={document.canvas.width} /></label>
                    <label className="text-xs">画布高度<Input aria-label="画布高度" type="number" readOnly value={document.canvas.height} /></label>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-medium">显示图层</p>
                    {LAYER_LABELS.map(([layer, label]) => (
                      <label key={layer} className="flex items-center justify-between gap-2 text-xs">
                        {label}
                        <Switch checked={layers[layer]} aria-label={`显示${label}图层`} onCheckedChange={(checked) => setLayers((current) => ({ ...current, [layer]: checked }))} />
                      </label>
                    ))}
                  </div>
                  <label className="space-y-1 text-xs">
                    关键点分组
                    <Select value={group} onValueChange={(value) => {
                      if (!value) return;
                      const nextGroup = value as PoseEditorGroupFilter;
                      setGroup(nextGroup);
                      setActivePoint(person ? makePath(person.id, nextGroup, "0") : null);
                    }}>
                      <SelectTrigger aria-label="选择关键点分组"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="body">身体（COCO-17）</SelectItem>
                        <SelectItem value="neck">颈部中心</SelectItem>
                        <SelectItem value="midHip">骨盆中心</SelectItem>
                        <SelectItem value="feet">脚部（6）</SelectItem>
                        <SelectItem value="face">面部（{faceCount}）</SelectItem>
                        <SelectItem value="leftHand">左手（21）</SelectItem>
                        <SelectItem value="rightHand">右手（21）</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="space-y-1 text-xs">
                    关键点
                    <Select value={activePointValue} onValueChange={(value) => { if (person && value) setActivePoint(makePath(person.id, group, value)); }}>
                      <SelectTrigger aria-label="选择关键点"><SelectValue placeholder="选择点位" /></SelectTrigger>
                      <SelectContent>
                        {pointOptions.map(({ path, label }) => <SelectItem key={pointPathKey(path)} value={"index" in path ? String(path.index) : "center"}>{label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </label>
                  {activePoint && <p className="text-xs text-[var(--gc-text-muted)]">当前：{posePointLabel(activePoint)} · {point ? point.origin === "detected" ? "检测" : "手动" : "未设置"}</p>}
                  {point && activePoint && (
                    <div className="grid grid-cols-2 gap-2">
                      <label className="text-xs">X<Input aria-label="关键点 X 坐标" type="number" min={0} max={document.canvas.width} step={1} value={point.x} onChange={(event) => {
                        const x = Number(event.currentTarget.value);
                        if (Number.isFinite(x) && x >= 0 && x <= document.canvas.width) updatePoint({ ...point, x, origin: "manual", confidence: 1 });
                      }} /></label>
                      <label className="text-xs">Y<Input aria-label="关键点 Y 坐标" type="number" min={0} max={document.canvas.height} step={1} value={point.y} onChange={(event) => {
                        const y = Number(event.currentTarget.value);
                        if (Number.isFinite(y) && y >= 0 && y <= document.canvas.height) updatePoint({ ...point, y, origin: "manual", confidence: 1 });
                      }} /></label>
                    </div>
                  )}
                  <Button size="sm" variant="outline" disabled={!activePoint || !point} onClick={() => updatePoint(null)}>删除当前关键点</Button>
                </aside>
              </div>
            </TabsContent>
            <TabsContent value="3d" className="min-h-0 flex-1 data-[state=inactive]:hidden">
              <Suspense fallback={<div className="flex min-h-[320px] items-center justify-center rounded-lg border border-[var(--gc-border)] bg-[var(--gc-canvas)] text-sm text-[var(--gc-text-muted)]">正在加载 3D 姿势编辑器…</div>}>
                <PoseEditor3D
                key={`${activePersonId}-${document.pose3d?.stale ? 'stale' : 'fresh'}`}
                imageUrl={source}
                document={document}
                activePersonId={person?.id ?? activePersonId}
                onBeginDraft={beginPose3DDraft}
                onDraft={draftPose3D}
                onFinishDraft={finishPose3DDraft}
                onCommit={commitPose3D}
                />
              </Suspense>
            </TabsContent>
          </Tabs>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--gc-border)] pt-3">
            <Button variant="outline" disabled={saving} onClick={() => handleOpenChange(false)}>取消</Button>
            <Button variant="outline" disabled={saving || !isDirty} onClick={() => void save('save-as')}>{saving ? "正在保存…" : "另存为姿势参考"}</Button>
            <Button disabled={saving || !isDirty} onClick={() => void save('apply')}>{saving ? "正在保存…" : "应用到当前节点"}</Button>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃未保存的姿势编辑？</AlertDialogTitle>
            <AlertDialogDescription>当前修改尚未保存到画布。关闭后这些修改将丢失。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>继续编辑</AlertDialogCancel>
            <AlertDialogAction onClick={finishClose}>放弃修改</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

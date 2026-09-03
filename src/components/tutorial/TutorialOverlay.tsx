import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  GitBranchIcon,
  HistoryIcon,
  ImagePlusIcon,
  PaintbrushIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  WORKBENCH_TUTORIAL_KEY,
  WORKBENCH_TUTORIAL_VERSION,
  parseTutorialReceiptState,
  type TutorialOutcome,
} from "@/tutorials/tutorialContract";
import {
  OPEN_TUTORIAL_EVENT,
  setWorkbenchTutorialBlocking,
} from "@/tutorials/tutorialRuntime";

const STEPS = [
  {
    title: "选择一个清晰的创作起点",
    description: "上传服装素材，或从文本描述开始。工作台会在独立项目页签中保留你的创作上下文。",
    icon: ImagePlusIcon,
    detail: "教程完成后，空白画布上的快捷入口仍会保留，方便随时开始新任务。",
  },
  {
    title: "连接节点并调整生成参数",
    description: "在画布上组织处理步骤，在右侧属性面板中调整模型、尺寸、数量和具体要求。",
    icon: GitBranchIcon,
    detail: "节点与连线共同描述执行顺序；保存前可以持续修改，不会因为教程状态改变项目内容。",
  },
  {
    title: "用局部修改完成服装细节设计",
    description: "涂抹需要修改的大致区域，再描述要添加、替换、删除或调整的内容，不需要选择技术处理模式。",
    icon: PaintbrushIcon,
    detail: "红色涂抹区是修改中心而不是裁切框；系统会结合整幅服装自动延展完整轮廓，并严格保护融合区以外的原图。",
  },
  {
    title: "在 Results 中检查每次运行",
    description: "运行任务后，到 Results 查看输出、失败或未知状态，并恢复跨项目的历史任务。",
    icon: HistoryIcon,
    detail: "Results 也提供结果查看与对比；教程只负责引导，不会清理或改写任何运行记录。",
  },
] as const;

type LoadState = "loading" | "ready" | "error" | "hidden";

export function TutorialOverlay() {
  const popupRef = useRef<HTMLDivElement>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [attempt, setAttempt] = useState(0);
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState<TutorialOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setWorkbenchTutorialBlocking(loadState !== "hidden");
    return () => setWorkbenchTutorialBlocking(false);
  }, [loadState]);

  useEffect(() => {
    const openTutorial = () => {
      setStep(0);
      setError(null);
      setLoadState("ready");
    };
    window.addEventListener(OPEN_TUTORIAL_EVENT, openTutorial);
    return () => window.removeEventListener(OPEN_TUTORIAL_EVENT, openTutorial);
  }, []);

  useEffect(() => {
    let ignore = false;
    setLoadState("loading");
    setError(null);
    fetch("/api/tutorials/workbench-onboarding")
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return parseTutorialReceiptState(await response.json());
      })
      .then((state) => {
        if (!ignore) setLoadState(state.acknowledged ? "hidden" : "ready");
      })
      .catch(() => {
        if (!ignore) {
          setLoadState("error");
          setError("教程状态读取失败。为避免遗漏重要更新，教程会保持显示。请重试连接。");
        }
      });
    return () => {
      ignore = true;
    };
  }, [attempt]);

  const acknowledge = useCallback(async (outcome: TutorialOutcome) => {
    if (submitting) return;
    setSubmitting(outcome);
    setError(null);
    try {
      const response = await fetch("/api/tutorials/workbench-onboarding/acknowledge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tutorialKey: WORKBENCH_TUTORIAL_KEY,
          tutorialVersion: WORKBENCH_TUTORIAL_VERSION,
          outcome,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const state = parseTutorialReceiptState(await response.json());
      if (!state.acknowledged) throw new Error("教程确认未生效");
      setLoadState("hidden");
    } catch {
      setError("教程状态保存失败，当前页面不会把教程标记为已完成。请重试。");
    } finally {
      setSubmitting(null);
    }
  }, [submitting]);

  if (loadState === "hidden") return null;

  const current = STEPS[step];
  const StepIcon = current.icon;
  const isFinalStep = step === STEPS.length - 1;

  return (
    <Dialog.Root open onOpenChange={() => undefined}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm" />
        <Dialog.Popup
          ref={popupRef}
          initialFocus={popupRef}
          tabIndex={-1}
          className="gc-panel fixed left-1/2 top-1/2 z-[71] w-[min(42rem,calc(100vw-4rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-[var(--gc-border)] bg-[var(--gc-panel)] shadow-2xl shadow-black/60 outline-hidden"
        >
        <header className="flex items-start justify-between gap-6 border-b border-[var(--gc-border)] px-7 py-5">
          <div>
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--gc-accent)]">
              <span>Workspace guide</span>
              <span aria-label={`教程版本 ${WORKBENCH_TUTORIAL_VERSION}`} className="rounded-full border border-[var(--gc-border)] px-2 py-0.5 tracking-normal text-[var(--gc-text-muted)]">
                {WORKBENCH_TUTORIAL_VERSION}
              </span>
            </div>
            <Dialog.Title className="mt-2 text-xl font-semibold text-[var(--gc-text)]">
              欢迎使用服装设计工作台
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-xs leading-relaxed text-[var(--gc-text-muted)]">
              用四个步骤熟悉从创作入口到局部修改和结果检查的完整流程。
            </Dialog.Description>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={loadState !== "ready" || Boolean(submitting)}
            aria-label="关闭教程"
            onClick={() => void acknowledge("dismissed")}
            className="shrink-0 text-[var(--gc-text-muted)] hover:bg-[var(--gc-panel-hover)] hover:text-[var(--gc-text)]"
          >
            <XIcon aria-hidden="true" className="size-4" />
          </Button>
        </header>

        <div className="grid grid-cols-[168px_minmax(0,1fr)]">
          <nav aria-label="教程进度" className="border-r border-[var(--gc-border)] bg-[var(--gc-panel-soft)] px-4 py-6">
            <ol className="space-y-2">
              {STEPS.map((item, index) => (
                <li key={item.title}>
                  <div
                    aria-current={index === step ? "step" : undefined}
                    className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-xs ${
                      index === step
                        ? "bg-[var(--gc-panel-hover)] text-[var(--gc-text)]"
                        : "text-[var(--gc-text-muted)]"
                    }`}
                  >
                    <span className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                      index < step
                        ? "border-[var(--gc-accent)] bg-[var(--gc-accent)] text-black"
                        : "border-[var(--gc-border)]"
                    }`}>
                      {index < step ? <CheckIcon aria-hidden="true" className="size-3" /> : index + 1}
                    </span>
                    <span>步骤 {index + 1}</span>
                  </div>
                </li>
              ))}
            </ol>
          </nav>

          <div className="flex min-h-80 flex-col px-8 py-7">
            {loadState === "loading" ? (
              <div role="status" className="flex flex-1 items-center justify-center text-xs text-[var(--gc-text-muted)]">
                正在读取教程状态…
              </div>
            ) : loadState === "error" ? (
              <div className="flex flex-1 flex-col items-center justify-center text-center">
                <p role="alert" className="max-w-sm text-xs leading-relaxed text-amber-300">{error}</p>
                <Button type="button" variant="outline" className="mt-5" onClick={() => setAttempt((value) => value + 1)}>
                  重试读取
                </Button>
              </div>
            ) : (
              <>
                <div className="flex size-12 items-center justify-center rounded-xl border border-[var(--gc-border)] bg-[var(--gc-panel-soft)] text-[var(--gc-accent)]">
                  <StepIcon aria-hidden="true" className="size-6" />
                </div>
                <p className="mt-6 text-[10px] font-medium uppercase tracking-[0.18em] text-[var(--gc-text-muted)]">
                  Step {step + 1} / {STEPS.length}
                </p>
                <h2 className="mt-2 text-lg font-semibold text-[var(--gc-text)]">{current.title}</h2>
                <p className="mt-3 text-sm leading-6 text-[var(--gc-text-muted)]">{current.description}</p>
                <p className="mt-4 rounded-lg border border-[var(--gc-border)] bg-[var(--gc-panel-soft)] px-4 py-3 text-xs leading-5 text-[var(--gc-text-muted)]">
                  {current.detail}
                </p>

                {error && <p role="alert" className="mt-4 text-xs text-amber-300">{error}</p>}

                <footer className="mt-auto flex items-center justify-between gap-3 pt-7">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={step === 0 || Boolean(submitting)}
                    onClick={() => setStep((value) => Math.max(0, value - 1))}
                  >
                    <ArrowLeftIcon aria-hidden="true" className="size-4" />
                    上一步
                  </Button>
                  {isFinalStep ? (
                    <Button type="button" disabled={Boolean(submitting)} onClick={() => void acknowledge("completed")}>
                      <CheckIcon aria-hidden="true" className="size-4" />
                      {submitting === "completed" ? "正在保存…" : "完成教程"}
                    </Button>
                  ) : (
                    <Button type="button" disabled={Boolean(submitting)} onClick={() => setStep((value) => Math.min(STEPS.length - 1, value + 1))}>
                      下一步
                      <ArrowRightIcon aria-hidden="true" className="size-4" />
                    </Button>
                  )}
                </footer>
              </>
            )}
          </div>
        </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

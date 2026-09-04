import { useCallback, useEffect, useMemo, useState } from "react";
import { LayoutTemplateIcon, LoaderCircleIcon, RotateCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { selectActiveProjectIsPristine, useFlowStore } from "@/store/flowStore";
import { thumbnailImageUrl } from "@/lib/images";
import { BUILTIN_TEMPLATE_COVERS } from "@/lib/templatePresentation";
import type { WorkflowTemplate } from "@/types/workflow";
import { inferTemplateLaunchMode, launchStarterTemplate } from "@/lib/templateLaunch";

const EMPTY_TEMPLATE_COVER = "/assets/project-center/empty-project-cover.jpg";
const STARTER_TEMPLATE_GRID_CLASS = "grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] gap-3";
const STARTER_TEMPLATE_SECONDARY_TEXT_CLASS = "text-[color-mix(in_srgb,var(--gc-text)_76%,var(--gc-panel))]";

function templateCover(template: WorkflowTemplate): string {
  return BUILTIN_TEMPLATE_COVERS[template.id] ?? template.thumbnail ?? EMPTY_TEMPLATE_COVER;
}

function TemplateCover({ template }: { template: WorkflowTemplate }) {
  const [failed, setFailed] = useState(false);
  const source = failed ? EMPTY_TEMPLATE_COVER : templateCover(template);
  return (
    <img
      src={thumbnailImageUrl(source)}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="aspect-[16/10] w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
    />
  );
}

function TemplateCard({ template, onSelect }: { template: WorkflowTemplate; onSelect: () => void }) {
  return (
    <Card size="sm" className="group gap-0 overflow-hidden border border-[var(--gc-border)] bg-[var(--gc-control)] py-0 text-[var(--gc-text)] ring-0 transition-colors hover:border-[var(--gc-accent)]">
      <button
        type="button"
        onClick={onSelect}
        className="block w-full text-left"
        aria-label={`使用内置模板：${template.name}`}
      >
        <div className="relative overflow-hidden">
          <TemplateCover template={template} />
          <span className="absolute right-3 top-3 rounded border border-white/30 bg-black/55 px-1.5 py-0.5 text-[8px] text-white backdrop-blur-sm">
            内置
          </span>
        </div>
        <span className="block p-3">
          <span className="block truncate text-xs font-semibold text-[var(--gc-text)]">{template.name}</span>
          <span className={`mt-1 block min-h-8 line-clamp-2 text-[10px] leading-4 ${STARTER_TEMPLATE_SECONDARY_TEXT_CLASS}`}>
            {template.description || "从此工作流模板创建一个新项目"}
          </span>
        </span>
      </button>
    </Card>
  );
}

function TemplateSkeletons() {
  return (
    <div aria-label="正在加载内置模板" className={STARTER_TEMPLATE_GRID_CLASS}>
      {Array.from({ length: 6 }, (_, index) => (
        <Card key={index} size="sm" className="gap-3 border border-[var(--gc-border)] bg-[var(--gc-control)] py-0 ring-0">
          <Skeleton className="aspect-[16/10] w-full rounded-none bg-[var(--gc-panel-hover)]" />
          <div className="space-y-2 px-3 pb-3">
            <Skeleton className="h-3 w-2/3 bg-[var(--gc-panel-hover)]" />
            <Skeleton className="h-2.5 w-full bg-[var(--gc-panel-hover)]" />
            <Skeleton className="h-2.5 w-4/5 bg-[var(--gc-panel-hover)]" />
          </div>
        </Card>
      ))}
    </div>
  );
}

export function TaskLauncher() {
  const pristine = useFlowStore(selectActiveProjectIsPristine);
  const [templates, setTemplates] = useState<WorkflowTemplate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/templates", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = await response.json() as unknown;
      if (!Array.isArray(value)) throw new Error("模板数据格式无效");
      setTemplates(value as WorkflowTemplate[]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (pristine && templates === null && !loading && !error) void load();
  }, [error, load, loading, pristine, templates]);

  const builtinTemplates = useMemo(
    () => (templates ?? []).filter((template) => template.builtIn),
    [templates],
  );

  if (!pristine) return null;

  return (
    <section
      aria-label="开始第一个创作任务"
      className="pointer-events-auto absolute inset-0 z-20 flex items-center justify-center bg-[var(--gc-canvas)] p-8 backdrop-blur-[2px]"
    >
      <div className="gc-panel pointer-events-auto w-full max-w-4xl rounded-2xl border border-[var(--gc-border)] bg-[var(--gc-panel)]/95 p-6 shadow-2xl shadow-black/40 backdrop-blur-md">
        <div className="text-center">
          <div className="mx-auto flex size-9 items-center justify-center rounded-xl border border-[var(--gc-accent)]/40 bg-[var(--gc-control)] text-[var(--gc-accent)]">
            <LayoutTemplateIcon aria-hidden="true" className="size-4" />
          </div>
          <p className="mt-3 text-[10px] font-medium uppercase tracking-[0.22em] text-[var(--gc-accent)]">
            First creation
          </p>
          <h1 className="mt-2 text-lg font-semibold text-[var(--gc-text)]">从一个明确的任务开始</h1>
          <p className={`mt-1 text-xs leading-relaxed ${STARTER_TEMPLATE_SECONDARY_TEXT_CLASS}`}>
            选择一个内置模板，直接进入当前未保存项目；项目内容会自动保存并可在之后继续编辑。
          </p>
        </div>

        <div className="mt-5 max-h-[min(58vh,34rem)] overflow-y-auto pr-1">
          {loading && <TemplateSkeletons />}
          {!loading && !error && builtinTemplates.length > 0 && (
            <div className={STARTER_TEMPLATE_GRID_CLASS}>
              {builtinTemplates.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  onSelect={() => launchStarterTemplate(template, inferTemplateLaunchMode(template))}
                />
              ))}
            </div>
          )}
          {!loading && !error && templates && builtinTemplates.length === 0 && (
            <div role="alert" className="rounded-xl border border-amber-400/30 bg-amber-950/20 px-4 py-8 text-center text-xs text-amber-200">
              内置模板暂不可用，请联系管理员重新初始化模板。
            </div>
          )}
          {error && (
            <div role="alert" className="flex flex-col items-center justify-center gap-3 rounded-xl border border-red-400/30 bg-red-950/20 px-4 py-8 text-center text-xs text-red-200">
              <span>内置模板加载失败（{error}）</span>
              <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
                <RotateCwIcon data-icon="inline-start" aria-hidden="true" className="size-3.5" />
                重试加载
              </Button>
            </div>
          )}
        </div>

        {loading && (
          <p role="status" className={`mt-3 flex items-center justify-center gap-2 text-[10px] ${STARTER_TEMPLATE_SECONDARY_TEXT_CLASS}`}>
            <LoaderCircleIcon aria-hidden="true" className="size-3.5 animate-spin" />
            正在准备内置模板…
          </p>
        )}
      </div>
    </section>
  );
}

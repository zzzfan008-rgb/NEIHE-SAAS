import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FolderOpenIcon,
  LayoutTemplateIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { thumbnailImageUrl } from "@/lib/images";
import { inferTemplateLaunchMode, launchTemplateInNewTab } from "@/lib/templateLaunch";
import { BUILTIN_TEMPLATE_COVERS } from "@/lib/templatePresentation";
import {
  projectTabLifecycle,
  useFlowStore,
  type ProjectTab,
} from "@/store/flowStore";
import type { PersistedWorkflow, WorkflowTemplate } from "@/types/workflow";
import { SaveTemplateForm } from "./TemplatesDock";

type ProjectCenterTab = "recent" | "templates" | "my-templates";

interface ProjectSummary {
  id: string;
  name: string;
  ownerName?: string;
  readOnly?: boolean;
  updatedAt: string;
}

interface ProjectDetail extends ProjectSummary {
  flow: PersistedWorkflow;
}

const NEW_PROJECT_COVER = "/assets/project-center/new-project-cover.jpg";
const EMPTY_PROJECT_COVER = "/assets/project-center/empty-project-cover.jpg";
const SAVE_TEMPLATE_COVER = "/assets/project-center/save-template-cover.png";
const PROJECT_CENTER_CARD_GRID_CLASS = "grid grid-cols-3 xl:grid-cols-4 gap-4";
const PROJECT_CENTER_TITLE_CLASS = "min-w-0 flex-1 line-clamp-2 min-h-8 text-xs font-semibold text-[var(--gc-text)]";

function flowPreviewImage(flow: { nodes: unknown[] }): string | undefined {
  for (const rawNode of [...flow.nodes].reverse()) {
    if (!rawNode || typeof rawNode !== "object") continue;
    const data = (rawNode as { data?: unknown }).data;
    if (!data || typeof data !== "object") continue;
    const record = data as Record<string, unknown>;
    const arrays = [record.outputImages, record.images, record.referenceImages];
    for (const value of arrays) {
      if (!Array.isArray(value)) continue;
      const image = [...value].reverse().find((item): item is string => typeof item === "string" && item.length > 0);
      if (image) return image;
    }
    for (const key of ["imageUrl", "fabricImageUrl", "sourceImageUrl"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return undefined;
}

function formatUpdatedAt(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ProjectCover({
  src,
  alt,
  fallback = EMPTY_PROJECT_COVER,
}: {
  src?: string;
  alt: string;
  fallback?: string;
}) {
  const [failed, setFailed] = useState(false);
  const image = failed || !src ? fallback : thumbnailImageUrl(src);
  return (
    <img
      src={image}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="aspect-[16/10] w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
    />
  );
}

function CardFrame({ children }: { children: ReactNode }) {
  return (
    <Card size="sm" className="group gap-0 overflow-hidden border border-[var(--gc-border)] bg-[var(--gc-panel-soft)] py-0 text-[var(--gc-text)] ring-0 transition-colors hover:border-[var(--gc-accent)]">
      {children}
    </Card>
  );
}

function TemplateSkeletons() {
  return (
    <div aria-label="正在加载模板" className={PROJECT_CENTER_CARD_GRID_CLASS}>
      {Array.from({ length: 8 }, (_, index) => (
        <Card key={index} size="sm" className="gap-3 border border-[var(--gc-border)] bg-[var(--gc-panel-soft)] py-0 ring-0">
          <Skeleton className="aspect-[16/10] w-full rounded-none bg-[var(--gc-panel-hover)]" />
          <div className="space-y-2 px-3 pb-3">
            <Skeleton className="h-3 w-2/3 bg-[var(--gc-panel-hover)]" />
            <Skeleton className="h-2.5 w-full bg-[var(--gc-panel-hover)]" />
          </div>
        </Card>
      ))}
    </div>
  );
}

export function ProjectCenter({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [activeSection, setActiveSection] = useState<ProjectCenterTab>("recent");
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectsLoadError, setProjectsLoadError] = useState<string | null>(null);
  const [templatesLoadError, setTemplatesLoadError] = useState<string | null>(null);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [templateToDelete, setTemplateToDelete] = useState<WorkflowTemplate | null>(null);
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(null);
  const projectsLoadVersion = useRef(0);
  const templatesLoadVersion = useRef(0);
  const openRequestVersion = useRef(0);
  const projectsHaveLoaded = useRef(false);
  const templatesHaveLoaded = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const saveTemplateButtonRef = useRef<HTMLButtonElement>(null);
  const tabs = useFlowStore((state) => state.tabs);
  const activeTabId = useFlowStore((state) => state.activeTabId);
  const createBlankTab = useFlowStore((state) => state.createBlankTab);
  const initialDraft = tabs.find((tab) => projectTabLifecycle(tab) === "initial_draft");

  const loadProjects = useCallback(async () => {
    const version = ++projectsLoadVersion.current;
    if (!projectsHaveLoaded.current) setProjectsLoading(true);
    setProjectsLoadError(null);
    try {
      const projectsResponse = await fetch("/api/projects");
      if (!projectsResponse.ok) throw new Error(`项目 HTTP ${projectsResponse.status}`);
      const summaries = await projectsResponse.json() as ProjectSummary[];
      if (version !== projectsLoadVersion.current) return;
      setProjects(summaries);
      projectsHaveLoaded.current = true;
    } catch (loadError) {
      if (version === projectsLoadVersion.current) {
        setProjectsLoadError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    } finally {
      if (version === projectsLoadVersion.current) setProjectsLoading(false);
    }
  }, []);

  const loadTemplates = useCallback(async () => {
    const version = ++templatesLoadVersion.current;
    if (!templatesHaveLoaded.current) setTemplatesLoading(true);
    setTemplatesLoadError(null);
    try {
      const templatesResponse = await fetch("/api/templates");
      if (!templatesResponse.ok) throw new Error(`模板 HTTP ${templatesResponse.status}`);
      const loadedTemplates = await templatesResponse.json() as WorkflowTemplate[];
      if (version !== templatesLoadVersion.current) return;
      setTemplates(loadedTemplates);
      templatesHaveLoaded.current = true;
    } catch (loadError) {
      if (version === templatesLoadVersion.current) {
        setTemplatesLoadError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    } finally {
      if (version === templatesLoadVersion.current) setTemplatesLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setError(null);
    await Promise.allSettled([loadProjects(), loadTemplates()]);
  }, [loadProjects, loadTemplates]);

  useEffect(() => {
    if (!open) {
      projectsLoadVersion.current += 1;
      templatesLoadVersion.current += 1;
      openRequestVersion.current += 1;
      setQuery("");
      setSaveTemplateOpen(false);
      setTemplateToDelete(null);
      return;
    }
    void load();
  }, [load, open]);

  const visibleError = [error, projectsLoadError, templatesLoadError].filter(Boolean).join("；");

  const openProject = useCallback(async (project: ProjectSummary) => {
    const requestVersion = ++openRequestVersion.current;
    const alreadyOpen = useFlowStore.getState().tabs.find((tab) => tab.projectId === project.id);
    if (alreadyOpen) {
      useFlowStore.getState().switchTab(alreadyOpen.id);
      onOpenChange(false);
      return;
    }
    try {
      setError(null);
      const response = await fetch(`/api/projects/${project.id}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const detail = await response.json() as ProjectDetail;
      if (requestVersion !== openRequestVersion.current) return;
      if (!Array.isArray(detail.flow?.nodes) || !Array.isArray(detail.flow?.edges)) {
        throw new Error("项目数据损坏或不兼容");
      }
      useFlowStore.getState().openFlowTab({
        projectId: detail.id,
        projectName: detail.name,
        nodes: detail.flow.nodes as never,
        edges: detail.flow.edges as never,
        readOnly: detail.readOnly ?? false,
      });
      onOpenChange(false);
    } catch (openError) {
      if (requestVersion !== openRequestVersion.current) return;
      setError(openError instanceof Error ? openError.message : String(openError));
    }
  }, [onOpenChange]);

  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const filteredProjects = useMemo(
    () => projects.filter((project) => !normalizedQuery || project.name.toLocaleLowerCase("zh-CN").includes(normalizedQuery)),
    [normalizedQuery, projects],
  );
  const filteredTemplates = useMemo(
    () => templates.filter((template) => {
      if (!template.builtIn) return false;
      if (!normalizedQuery) return true;
      return `${template.name} ${template.description}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery);
    }),
    [normalizedQuery, templates],
  );
  const filteredMyTemplates = useMemo(
    () => templates.filter((template) => {
      if (template.builtIn) return false;
      if (!normalizedQuery) return true;
      return `${template.name} ${template.description}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery);
    }),
    [normalizedQuery, templates],
  );

  const createProject = () => {
    createBlankTab();
    onOpenChange(false);
  };

  const continueDraft = (draft: ProjectTab) => {
    useFlowStore.getState().switchTab(draft.id);
    onOpenChange(false);
  };

  const openTemplate = (template: WorkflowTemplate) => {
    launchTemplateInNewTab(template, inferTemplateLaunchMode(template));
    onOpenChange(false);
  };

  const removeTemplate = async () => {
    if (!templateToDelete || templateToDelete.builtIn) return;
    setDeletingTemplateId(templateToDelete.id);
    setError(null);
    try {
      const response = await fetch(`/api/templates/${templateToDelete.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`删除模板 HTTP ${response.status}`);
      setTemplates((current) => current.filter((template) => template.id !== templateToDelete.id));
      setTemplateToDelete(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setDeletingTemplateId(null);
    }
  };

  const selectSection = (value: unknown) => {
    if (value !== "recent" && value !== "templates" && value !== "my-templates") return;
    setActiveSection(value);
    setQuery("");
  };

  const searchPlaceholder = activeSection === "recent"
    ? "搜索最近项目"
    : activeSection === "templates"
      ? "搜索内置模板"
      : "搜索我的模板";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        initialFocus={searchRef}
        showCloseButton={false}
        overlayClassName="z-[60] bg-black/75 backdrop-blur-sm"
        className="gc-panel z-[61] flex h-[min(760px,calc(100vh-5rem))] w-[min(1180px,calc(100vw-5rem))] min-w-[944px] max-w-none flex-col gap-0 overflow-hidden rounded-2xl border border-[var(--gc-border)] bg-[var(--gc-panel)] p-0 text-[var(--gc-text)] shadow-2xl shadow-black/70 ring-0"
      >
          <header className="flex items-center gap-6 border-b border-[var(--gc-border)] px-7 py-5">
            <div className="min-w-48">
              <DialogTitle className="text-base font-semibold text-[var(--gc-text)]">项目中心</DialogTitle>
              <DialogDescription className="mt-1 text-[10px] text-[var(--gc-text-muted)]">
                新建、继续或从模板开始
              </DialogDescription>
            </div>
            <label className="relative ml-auto block w-80">
              <SearchIcon aria-hidden="true" className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[var(--gc-text-muted)]" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
                className="h-9 w-full rounded-lg border border-[var(--gc-border)] bg-[var(--gc-control)] pl-9 pr-3 text-xs text-[var(--gc-text)] placeholder:text-[var(--gc-text-muted)] focus:border-[var(--gc-accent)] focus:outline-hidden"
              />
            </label>
            <DialogClose
              type="button"
              aria-label="关闭项目中心"
              className="flex size-8 items-center justify-center rounded-lg text-[var(--gc-text-muted)] hover:bg-[var(--gc-panel-hover)] hover:text-[var(--gc-text)]"
            >
              <XIcon aria-hidden="true" className="size-4" />
            </DialogClose>
          </header>

          <Tabs value={activeSection} onValueChange={selectSection} className="min-h-0 flex-1 flex-col gap-0">
            <TabsList variant="line" aria-label="项目中心分类" className="h-12 w-full shrink-0 justify-start gap-7 rounded-none border-b border-[var(--gc-border)] px-7 py-0">
              <TabsTrigger value="recent" className="h-12 flex-none rounded-none px-0 text-xs text-[var(--gc-text-muted)] data-active:text-[var(--gc-accent)] after:bg-[var(--gc-accent)]">
                <FolderOpenIcon aria-hidden="true" className="size-3.5" />
                最近项目
              </TabsTrigger>
              <TabsTrigger value="templates" className="h-12 flex-none rounded-none px-0 text-xs text-[var(--gc-text-muted)] data-active:text-[var(--gc-accent)] after:bg-[var(--gc-accent)]">
                <LayoutTemplateIcon aria-hidden="true" className="size-3.5" />
                内置模板
              </TabsTrigger>
              <TabsTrigger value="my-templates" className="h-12 flex-none rounded-none px-0 text-xs text-[var(--gc-text-muted)] data-active:text-[var(--gc-accent)] after:bg-[var(--gc-accent)]">
                <UserRoundIcon aria-hidden="true" className="size-3.5" />
                我的模板
              </TabsTrigger>
            </TabsList>

            {visibleError && (
              <div role="alert" className="mx-7 mt-5 flex items-center justify-between rounded-lg border border-red-500/30 bg-red-950/20 px-4 py-3 text-[10px] text-red-300">
                <span>加载失败：{visibleError}</span>
                <Button type="button" variant="outline" size="xs" onClick={() => void load()}>重试</Button>
              </div>
            )}

            <TabsContent value="recent" className="min-h-0 overflow-y-auto p-7">
              {projectsLoading ? (
                <TemplateSkeletons />
              ) : (
                <div className={PROJECT_CENTER_CARD_GRID_CLASS}>
                  <CardFrame>
                    <button type="button" onClick={createProject} className="block w-full text-left">
                      <div className="relative overflow-hidden">
                        <ProjectCover src={NEW_PROJECT_COVER} fallback={NEW_PROJECT_COVER} alt="新建项目" />
                        <span className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-full border border-white/30 bg-black/50 text-white backdrop-blur-sm">
                          <PlusIcon aria-hidden="true" className="size-4" />
                        </span>
                      </div>
                      <span className="block p-3">
                        <span className="block text-xs font-semibold text-[var(--gc-accent)]">新建项目</span>
                        <span className="mt-1 block text-[10px] text-[var(--gc-text-muted)]">从空白服装画布开始</span>
                      </span>
                    </button>
                  </CardFrame>

                  {initialDraft && (
                    <CardFrame>
                      <button type="button" onClick={() => continueDraft(initialDraft)} className="block w-full text-left">
                        <ProjectCover
                          src={flowPreviewImage(initialDraft)}
                          alt={initialDraft.projectName}
                        />
                        <span className="block p-3">
                          <span className="flex items-center gap-2">
                            <span className={PROJECT_CENTER_TITLE_CLASS}>继续草稿</span>
                            <span className="rounded border border-[var(--gc-accent)]/40 px-1.5 py-0.5 text-[8px] text-[var(--gc-accent)]">自动保存</span>
                          </span>
                          <span className="mt-1 block truncate text-[10px] text-[var(--gc-text-muted)]">{initialDraft.projectName}</span>
                        </span>
                      </button>
                    </CardFrame>
                  )}

                  {filteredProjects.map((project) => {
                    const openTab = tabs.find((tab) => tab.projectId === project.id);
                    return (
                      <CardFrame key={project.id}>
                        <button
                          type="button"
                          onClick={() => void openProject(project)}
                          className="block w-full text-left"
                        >
                          <ProjectCover alt={project.name} />
                          <span className="block p-3">
                            <span className="flex items-center gap-2">
                              <span className={PROJECT_CENTER_TITLE_CLASS}>{project.name}</span>
                              {openTab && <span className="shrink-0 text-[8px] text-[var(--gc-accent)]">{openTab.id === activeTabId ? "当前" : "已打开"}</span>}
                            </span>
                            <span className="mt-1 block truncate text-[10px] text-[var(--gc-text-muted)]">
                              {project.readOnly && project.ownerName ? `${project.ownerName} · 只读 · ` : ""}
                              最后编辑 {formatUpdatedAt(project.updatedAt)}
                            </span>
                          </span>
                        </button>
                      </CardFrame>
                    );
                  })}
                </div>
              )}
              {!projectsLoading && filteredProjects.length === 0 && !initialDraft && (
                <p className="py-10 text-center text-xs text-[var(--gc-text-muted)]">暂无已保存项目，可以从“新建项目”开始。</p>
              )}
            </TabsContent>

            <TabsContent value="templates" className="min-h-0 overflow-y-auto p-7">
              {templatesLoading ? (
                <TemplateSkeletons />
              ) : (
                <div className={PROJECT_CENTER_CARD_GRID_CLASS}>
                  {filteredTemplates.map((template) => {
                    const image = BUILTIN_TEMPLATE_COVERS[template.id] ?? template.thumbnail ?? flowPreviewImage(template.flow);
                    return (
                      <CardFrame key={template.id}>
                        <button
                          type="button"
                          onClick={() => openTemplate(template)}
                          className="block w-full text-left"
                        >
                          <ProjectCover src={image} alt={template.name} />
                          <span className="block p-3">
                            <span className="flex items-center gap-2">
                              <span className={PROJECT_CENTER_TITLE_CLASS}>{template.name}</span>
                              <span className="shrink-0 rounded border border-[var(--gc-accent)]/40 px-1.5 py-0.5 text-[8px] text-[var(--gc-accent)]">
                                内置
                              </span>
                            </span>
                            <span className="mt-1 line-clamp-2 min-h-8 text-[10px] leading-4 text-[var(--gc-text-muted)]">
                              {template.description || "从此工作流模板创建一个新项目"}
                            </span>
                          </span>
                        </button>
                      </CardFrame>
                    );
                  })}
                </div>
              )}
              {!templatesLoading && filteredTemplates.length === 0 && (
                <p className="py-10 text-center text-xs text-[var(--gc-text-muted)]">没有符合条件的内置模板。</p>
              )}
            </TabsContent>

            <TabsContent value="my-templates" className="min-h-0 overflow-y-auto p-7">
              {templatesLoading ? <TemplateSkeletons /> : (
                <div className={PROJECT_CENTER_CARD_GRID_CLASS}>
                  <CardFrame>
                    <button
                      ref={saveTemplateButtonRef}
                      type="button"
                      onClick={() => setSaveTemplateOpen(true)}
                      className="block w-full text-left"
                    >
                      <div className="relative overflow-hidden">
                        <ProjectCover src={SAVE_TEMPLATE_COVER} fallback={SAVE_TEMPLATE_COVER} alt="保存当前画布为模板" />
                        <span className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-full border border-white/30 bg-black/50 text-white backdrop-blur-sm">
                          <PlusIcon aria-hidden="true" className="size-4" />
                        </span>
                      </div>
                      <span className="block p-3">
                        <span className="block text-xs font-semibold text-[var(--gc-accent)]">保存当前画布为模板</span>
                        <span className="mt-1 block text-[10px] text-[var(--gc-text-muted)]">复用当前节点、连接和参数配置</span>
                      </span>
                    </button>
                  </CardFrame>

                  {filteredMyTemplates.map((template) => {
                    const image = BUILTIN_TEMPLATE_COVERS[template.id] ?? template.thumbnail ?? flowPreviewImage(template.flow);
                    return (
                      <CardFrame key={template.id}>
                        <div className="relative overflow-hidden">
                          <button type="button" onClick={() => openTemplate(template)} className="block w-full text-left">
                            <ProjectCover src={image} alt={template.name} />
                          </button>
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              aria-label={`管理模板 ${template.name}`}
                              className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-full border border-white/30 bg-black/60 text-white backdrop-blur-sm hover:bg-black/80"
                            >
                              <MoreHorizontalIcon aria-hidden="true" className="size-4" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              align="end"
                              className="w-36 border border-[var(--gc-border)] bg-[var(--gc-panel)] text-[var(--gc-text)] ring-0"
                            >
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => setTemplateToDelete(template)}
                                className="text-xs"
                              >
                                <Trash2Icon aria-hidden="true" className="size-3.5" />
                                删除模板
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                        <div className="p-3">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => openTemplate(template)}
                              className={`${PROJECT_CENTER_TITLE_CLASS} text-left hover:text-[var(--gc-accent)]`}
                            >
                              {template.name}
                            </button>
                            <span className="shrink-0 rounded border border-[var(--gc-accent)]/40 px-1.5 py-0.5 text-[8px] text-[var(--gc-accent)]">我的</span>
                          </div>
                          <p className="mt-1 line-clamp-2 min-h-8 text-[10px] leading-4 text-[var(--gc-text-muted)]">
                            {template.description || "从此工作流模板创建一个新项目"}
                          </p>
                        </div>
                      </CardFrame>
                    );
                  })}
                </div>
              )}
              {!templatesLoading && filteredMyTemplates.length === 0 && (
                <p className="py-10 text-center text-xs text-[var(--gc-text-muted)]">还没有自建模板，可以先保存当前画布。</p>
              )}
            </TabsContent>
          </Tabs>

          <SaveTemplateForm
            open={saveTemplateOpen}
            onOpenChange={setSaveTemplateOpen}
            onSaved={() => void loadTemplates()}
            finalFocusRef={saveTemplateButtonRef}
          />

          <AlertDialog open={templateToDelete !== null} onOpenChange={(nextOpen) => {
            if (!nextOpen && deletingTemplateId === null) setTemplateToDelete(null);
          }}>
            <AlertDialogContent
              overlayClassName="z-[70] bg-black/75 backdrop-blur-sm"
              className="z-[71] border border-[var(--gc-border)] bg-[var(--gc-panel)] text-[var(--gc-text)] ring-0"
            >
              <AlertDialogHeader>
                <AlertDialogTitle>删除“{templateToDelete?.name}”？</AlertDialogTitle>
                <AlertDialogDescription className="text-xs text-[var(--gc-text-muted)]">
                  删除后无法恢复；由此模板创建的项目不会受到影响。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter className="border-[var(--gc-border)] bg-[var(--gc-panel-soft)]">
                <AlertDialogCancel disabled={deletingTemplateId !== null}>保留模板</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={deletingTemplateId !== null}
                  onClick={() => void removeTemplate()}
                >
                  {deletingTemplateId !== null && <LoaderCircleIcon aria-hidden="true" className="size-3.5 animate-spin" />}
                  {deletingTemplateId !== null ? "删除中…" : "确认删除"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

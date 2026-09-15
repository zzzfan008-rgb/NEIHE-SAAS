import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  ColorRequestError,
  type ColorDirectoryPage,
} from "@/lib/colorManagementClient";
import {
  useColorManagementRequest,
  useColorManagementQuery as useColorQuery,
} from "./ColorManagementSession";
import type { ColorBrand, ColorSeries, ColorGroup } from "@/types/brandColors";
import {
  ColorMetadataDialog,
  type ColorMetadataTarget,
  type ColorMetadataEditorState,
} from "./ColorMetadataDialog";
import { ColorGroupEditor } from "./ColorGroupEditor";
import {
  ColorImportPanel,
  type ColorImportEditorState,
} from "./ColorImportPanel";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { MaterialModelSettings, type MaterialModelEditorState } from "./MaterialModelSettings";

type DirectoryItem = ColorBrand | ColorSeries | ColorGroup;
export interface ColorEditorState {
  dirty: boolean;
  busy: boolean;
  outcomeUnknown: boolean;
}
type PendingNavigation = {
  description: string;
  run: () => void;
};
function Directory<T extends DirectoryItem>({
  title,
  path,
  revision,
  selected,
  onPick,
}: {
  title: string;
  path: string;
  revision: number;
  selected: string | null;
  onPick: (item: T) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const page = useColorQuery<ColorDirectoryPage<T>>(
    `${path}${path.includes("?") ? "&" : "?"}limit=25&offset=${offset}`,
    revision + attempt,
  );
  useEffect(() => {
    setOffset(0);
    setAttempt(0);
  }, [path]);
  useEffect(() => {
    if (offset > 0 && page.data?.items.length === 0)
      setOffset(Math.max(0, offset - 25));
  }, [offset, page.data]);
  return (
    <section
      aria-label={title}
      className="flex h-full min-h-0 flex-1 flex-col gap-2"
    >
      <h3 className="font-medium">{title}</h3>
      {page.error && (
        <div className="space-y-1">
          <p role="alert" className="text-red-400">
            {page.error}
          </p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => setAttempt((value) => value + 1)}
          >
            重试{title}
          </Button>
        </div>
      )}
      {!page.data && !page.error && <p role="status">读取中…</p>}
      {page.data?.items.length === 0 && (
        <p className="text-(--gc-text-muted)">暂无{title}</p>
      )}
      <div className="min-h-0 flex-1 space-y-1 overflow-auto">
        {page.data?.items.map((item) => (
          <Button
            key={item.id}
            type="button"
            size="sm"
            variant={selected === item.id ? "secondary" : "ghost"}
            aria-pressed={selected === item.id}
            className="h-auto w-full justify-start whitespace-normal break-all py-2 text-left text-xs"
            onClick={() => onPick(item)}
          >
            {item.name}
          </Button>
        ))}
      </div>
      <div className="flex justify-between gap-1">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={!offset}
          onClick={() => setOffset(Math.max(0, offset - 25))}
        >
          上一页{title}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={page.data?.nextOffset == null}
          onClick={() => setOffset(page.data!.nextOffset!)}
        >
          下一页{title}
        </Button>
      </div>
    </section>
  );
}
export function ColorManagementPanel({
  onEditorStateChange,
}: {
  onEditorStateChange?: (state: ColorEditorState) => void;
} = {}) {
  const colorRequest = useColorManagementRequest();
  const [brand, setBrand] = useState<ColorBrand | null>(null);
  const [series, setSeries] = useState<ColorSeries | null>(null);
  const [group, setGroup] = useState<ColorGroup | null>(null);
  const [revision, setRevision] = useState(0);
  const [editorRevision, setEditorRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<"group" | "imports">("group");
  const [importRevision, setImportRevision] = useState(0);
  const [importState, setImportState] = useState<ColorImportEditorState>({
    dirty: false,
    busy: false,
    outcomeUnknown: false,
  });
  const [metadataState, setMetadataState] = useState<ColorMetadataEditorState>({
    dirty: false, busy: false, outcomeUnknown: false,
  });
  const [modelState, setModelState] = useState<MaterialModelEditorState>({
    dirty: false, busy: false, outcomeUnknown: false,
  });
  const [pendingNavigation, setPendingNavigation] =
    useState<PendingNavigation | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [metadata, setMetadata] = useState<ColorMetadataTarget | null>(null);
  const [deletion, setDeletion] = useState<{
    kind: "brands" | "series" | "groups";
    item: DirectoryItem;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteErrorStatus, setDeleteErrorStatus] = useState<number | null>(null);
  const [deleteOutcomeUnknown, setDeleteOutcomeUnknown] = useState(false);
  const editorBusy = saving || deleting || importState.busy || metadataState.busy || modelState.busy;
  const hasDirtyEditor = editorDirty || importState.dirty || metadataState.dirty || modelState.dirty;
  const hasUnknownOutcome = outcomeUnknown || deleteOutcomeUnknown || importState.outcomeUnknown || metadataState.outcomeUnknown || modelState.outcomeUnknown;
  useEffect(
    () =>
      onEditorStateChange?.({
        dirty: hasDirtyEditor,
        busy: editorBusy,
        outcomeUnknown: hasUnknownOutcome,
      }),
    [editorBusy, hasDirtyEditor, hasUnknownOutcome, onEditorStateChange],
  );
  useEffect(() => {
    if (!group && workspaceTab === "imports") setWorkspaceTab("group");
  }, [group, workspaceTab]);
  useEffect(
    () => () =>
      onEditorStateChange?.({
        dirty: false,
        busy: false,
        outcomeUnknown: false,
      }),
    [onEditorStateChange],
  );
  const refresh = () => {
    setOutcomeUnknown(false);
    setDeleteOutcomeUnknown(false);
    setImportState({ dirty: false, busy: false, outcomeUnknown: false });
    setRevision((n) => n + 1);
    setEditorRevision((value) => value + 1);
    setImportRevision((value) => value + 1);
    setWorkspaceTab("group");
    setGroup(null);
    setSeries(null);
    setBrand(null);
  };
  const requestNavigation = (description: string, run: () => void) => {
    if (editorBusy) {
      setNavigationError("颜色管理操作正在提交，请等待请求完成后再切换。");
      return;
    }
    setNavigationError(null);
    if (hasDirtyEditor || hasUnknownOutcome) {
      setPendingNavigation({ description, run });
      return;
    }
    run();
  };
  const discardAndNavigate = () => {
    if (hasUnknownOutcome) return;
    const pending = pendingNavigation;
    setPendingNavigation(null);
    setEditorDirty(false);
    setOutcomeUnknown(false);
    setImportState({ dirty: false, busy: false, outcomeUnknown: false });
    setEditorRevision((value) => value + 1);
    setImportRevision((value) => value + 1);
    pending?.run();
  };
  return (
    <div
      className="flex min-h-0 flex-1 flex-col p-4 text-xs text-(--gc-text)"
      role="region"
      aria-label="色彩管理工作区"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-(--gc-text-muted)">
          品牌色只引用 Pantone；主库由运维随版本导入，不在此修改。
        </p>
        <div className="flex gap-2">
          <Button type="button" size="xs" variant="outline" disabled={editorBusy} onClick={() => setModelsOpen(true)}>分析模型</Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={editorBusy}
          onClick={() => requestNavigation("刷新目录", refresh)}
        >
          刷新目录
        </Button>
        </div>
      </div>
      {navigationError && (
        <p role="alert" className="mb-3 text-red-400">
          {navigationError}
        </p>
      )}
      <fieldset
        disabled={editorBusy}
        className="grid min-h-0 min-w-0 flex-1 grid-cols-[208px_minmax(0,1fr)] gap-4 border-0 p-0"
      >
        <aside className="flex min-h-0 flex-col gap-3 border-r border-(--gc-border) pr-3">
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              size="xs"
              onClick={() =>
                requestNavigation("新建品牌", () =>
                  setMetadata({ kind: "brands", item: null }),
                )
              }
            >
              新建品牌
            </Button>
            {brand && (
              <>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    requestNavigation("编辑品牌", () =>
                      setMetadata({ kind: "brands", item: brand }),
                    )
                  }
                >
                  编辑品牌
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={brand.kind === "neihe"}
                  onClick={() =>
                    requestNavigation("删除品牌", () => {
                      setError(null);
                      setDeleteErrorStatus(null);
                      setDeletion({ kind: "brands", item: brand });
                    })
                  }
                >
                  删除品牌
                </Button>
              </>
            )}
          </div>
          <Directory<ColorBrand>
            title="品牌"
            path="/brands"
            revision={revision}
            selected={brand?.id ?? null}
            onPick={(item) => {
              if (item.id === brand?.id) return;
              requestNavigation(`切换到品牌 ${item.name}`, () => {
                setBrand(item);
                setSeries(null);
                setGroup(null);
              });
            }}
          />
          {brand && (
            <>
              <div className="flex flex-wrap gap-1 border-t border-(--gc-border) pt-3">
                <Button
                  type="button"
                  size="xs"
                  onClick={() =>
                    requestNavigation("新建系列", () =>
                      setMetadata({
                        kind: "series",
                        item: null,
                        brandId: brand.id,
                      }),
                    )
                  }
                >
                  新建系列
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    if (!series) return;
                    requestNavigation("切换到全部系列", () => {
                      setSeries(null);
                      setGroup(null);
                    });
                  }}
                >
                  全部系列
                </Button>
                {series && (
                  <>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        requestNavigation("编辑系列", () =>
                          setMetadata({
                            kind: "series",
                            item: series,
                            brandId: brand.id,
                          }),
                        )
                      }
                    >
                      编辑系列
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        requestNavigation("删除系列", () => {
                          setError(null);
                          setDeleteErrorStatus(null);
                          setDeletion({ kind: "series", item: series });
                        })
                      }
                    >
                      删除系列
                    </Button>
                  </>
                )}
              </div>
              <Directory<ColorSeries>
                key={brand.id}
                title="系列"
                path={`/series?brandId=${brand.id}`}
                revision={revision}
                selected={series?.id ?? null}
                onPick={(item) => {
                  if (item.id === series?.id) return;
                  requestNavigation(`切换到系列 ${item.name}`, () => {
                    setSeries(item);
                    setGroup(null);
                  });
                }}
              />
            </>
          )}
        </aside>
        {brand ? (
          <main
            className="flex min-h-0 min-w-0 flex-col gap-3"
            aria-label="品牌色组管理"
          >
            <div className="flex items-center gap-2">
              <h3 className="min-w-0 flex-1 truncate font-medium">
                {brand.name} /{" "}
                {series
                  ? `${series.name}${series.year ? ` · ${series.year}` : ""}${series.season ? ` · ${series.season}` : ""}`
                  : "全部系列"}
              </h3>
              <Button
                type="button"
                size="xs"
                onClick={() =>
                  requestNavigation("新建色组", () => {
                    setGroup(null);
                    setEditorRevision((value) => value + 1);
                  })
                }
              >
                新建色组
              </Button>
              {group && (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    requestNavigation("删除色组", () => {
                      setError(null);
                      setDeleteErrorStatus(null);
                      setDeletion({ kind: "groups", item: group });
                    })
                  }
                >
                  删除色组
                </Button>
              )}
            </div>
            <div
              className={workspaceTab === "imports" ? "h-20 shrink-0" : "h-32 shrink-0"}
            >
              <Directory<ColorGroup>
                key={`${brand.id}:${series?.id ?? "all"}`}
                title="主题色组"
                path={`/groups?brandId=${brand.id}${series ? `&seriesId=${series.id}` : ""}`}
                revision={revision}
                selected={group?.id ?? null}
                onPick={(item) => {
                  if (item.id === group?.id) return;
                  requestNavigation(`切换到色组 ${item.name}`, () => setGroup(item));
                }}
              />
            </div>
            <Tabs
              value={workspaceTab}
              onValueChange={(value) => {
                if (value !== "group" && value !== "imports") return;
                if (value === workspaceTab || (value === "imports" && !group)) return;
                requestNavigation(
                  value === "imports" ? "打开导入校准" : "返回色组编排",
                  () => setWorkspaceTab(value),
                );
              }}
              className="min-h-0 flex-1"
            >
              <TabsList variant="line" aria-label="色组工作区">
                <TabsTrigger value="group">色组编排</TabsTrigger>
                <TabsTrigger value="imports" disabled={!group}>
                  导入校准
                </TabsTrigger>
              </TabsList>
              <TabsContent value="group" className="min-h-0">
                <ColorGroupEditor
                  key={`${brand.id}:${series?.id ?? ""}:${group?.id ?? "new"}:${group?.revision ?? 0}:${editorRevision}`}
                  group={group}
                  brandId={brand.id}
                  seriesId={series?.id ?? null}
                  onBusyChange={setSaving}
                  onDirtyChange={setEditorDirty}
                  onOutcomeUnknownChange={setOutcomeUnknown}
                  onRefreshDirectory={refresh}
                  onSaved={(saved) => {
                    setEditorDirty(false);
                    setOutcomeUnknown(false);
                    setNavigationError(null);
                    setGroup(saved);
                    setRevision((n) => n + 1);
                  }}
                />
              </TabsContent>
              <TabsContent
                value="imports"
                className="flex min-h-0 flex-col overflow-hidden"
              >
                {group && (
                  <ColorImportPanel
                    key={`${group.id}:${importRevision}`}
                    group={group}
                    onGroupRevisionChange={(groupRevision) => {
                      setGroup((current) =>
                        current && current.id === group.id
                          ? { ...current, revision: groupRevision }
                          : current,
                      );
                      setRevision((value) => value + 1);
                    }}
                    onEditorStateChange={setImportState}
                  />
                )}
              </TabsContent>
            </Tabs>
          </main>
        ) : (
          <p className="m-auto text-(--gc-text-muted)">
            选择左侧品牌，维护系列和主题色组。
          </p>
        )}
      </fieldset>
      <Dialog open={modelsOpen} onOpenChange={(open) => {
        if (open) { setModelsOpen(true); return; }
        if (modelState.busy || modelState.outcomeUnknown) return;
        if (modelState.dirty) {
          setPendingNavigation({ description: "关闭模型配置", run: () => setModelsOpen(false) });
          return;
        }
        setModelsOpen(false);
      }}>
        <DialogContent overlayClassName="z-[80]" className="z-[81] w-[min(800px,calc(100vw-3rem))] max-w-none sm:max-w-none">
          <DialogTitle>材质分析模型</DialogTitle>
          <DialogDescription>配置普通用户在“素材库 → 面料 → 上传并分析”中可选择的模型。</DialogDescription>
          <MaterialModelSettings onStateChange={setModelState} />
        </DialogContent>
      </Dialog>
      {metadata && (
        <ColorMetadataDialog
          target={metadata}
          onStateChange={setMetadataState}
          onClose={() => setMetadata(null)}
          onRefresh={() => {
            setMetadata(null);
            refresh();
          }}
          onSaved={(item) => {
            if (metadata.kind === "brands") {
              setBrand(item as ColorBrand);
              setSeries(null);
              setGroup(null);
            } else {
              setSeries(item as ColorSeries);
              setGroup(null);
            }
            setMetadata(null);
            setRevision((n) => n + 1);
          }}
        />
      )}
      <AlertDialog
        open={pendingNavigation !== null}
        onOpenChange={(open) => {
          if (!open) setPendingNavigation(null);
        }}
      >
        <AlertDialogContent
          overlayClassName="z-[100]"
          className="z-[101] bg-(--gc-panel) text-(--gc-text)"
        >
          <AlertDialogTitle>放弃未保存的色彩管理修改？</AlertDialogTitle>
          <AlertDialogDescription>
            {pendingNavigation?.description ?? "当前操作"}会丢弃尚未保存的色组、导入校准、目录或模型配置修改。
            {hasUnknownOutcome && (
              <span className="mt-2 block">
                上一次写入结果可能未知；继续前请先核对服务器记录，避免重复提交。
              </span>
            )}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>继续编辑</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={hasUnknownOutcome} onClick={discardAndNavigate}>
              放弃修改
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={deletion !== null}
        onOpenChange={(open) => {
          if (!open && !deleting && !deleteOutcomeUnknown) {
            setDeletion(null);
            setError(null);
            setDeleteErrorStatus(null);
          }
        }}
      >
        <AlertDialogContent
          overlayClassName="z-80"
          className="z-80 bg-(--gc-panel) text-(--gc-text)"
        >
          <AlertDialogTitle>删除 {deletion?.item.name}？</AlertDialogTitle>
          <AlertDialogDescription>
            目录将不再对用户显示。品牌和系列下仍有内容时，必须先处理下级目录。
          </AlertDialogDescription>
          {error && (
            <p role="alert" className="text-red-400">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            {(deleteErrorStatus === 409 || deleteOutcomeUnknown) && (
              <Button
                type="button"
                variant="outline"
                disabled={deleting}
                onClick={() => {
                  setDeletion(null);
                  setError(null);
                  setDeleteErrorStatus(null);
                  refresh();
                }}
              >
                关闭并刷新
              </Button>
            )}
            <AlertDialogCancel disabled={deleting || deleteOutcomeUnknown}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting || deleteOutcomeUnknown}
              onClick={() => {
                if (!deletion || deleting || deleteOutcomeUnknown) return;
                setDeleting(true);
                setError(null);
                setDeleteOutcomeUnknown(false);
                setDeleteErrorStatus(null);
                const target = deletion;
                void colorRequest(
                  `/${target.kind}/${target.item.id}`,
                  "DELETE",
                  { revision: target.item.revision },
                )
                  .then(() => {
                    if (target.kind === "brands") {
                      setBrand(null);
                      setSeries(null);
                    } else if (target.kind === "series") setSeries(null);
                    setGroup(null);
                    setDeletion(null);
                    setRevision((n) => n + 1);
                  })
                  .catch((reason: unknown) => {
                    setDeleteOutcomeUnknown(reason instanceof ColorRequestError && reason.outcomeUnknown);
                    setError(
                      reason instanceof Error ? reason.message : "删除失败",
                    );
                    setDeleteErrorStatus(
                      reason instanceof ColorRequestError
                        ? (reason.status ?? null)
                        : null,
                    );
                  })
                  .finally(() => setDeleting(false));
              }}
            >
              {deleting ? "删除中…" : "确认删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

import {
  selectActiveCompareIds,
  selectActiveSelectedResultId,
  selectActiveNodes,
  useFlowStore,
} from "@/store/flowStore";
import { OPEN_COMPARE_EVENT, OPEN_GENERATION_RECORD_EVENT } from "@/lib/overlayEvents";
import { thumbnailImageUrl } from "@/lib/images";
import { cn } from "@/lib/utils";
import { isNodeRunActive } from "@/types/workflow";
import { STATUS_TEXT } from "@/components/nodes/NodeFrame";
import { requestCanvasLanding } from "@/lib/canvasLanding";
import { Button } from "@/components/ui/button";

interface ResultsPanelProps {
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  className?: string;
}

/** 左侧浮层中的跨项目最近生成。 */
export function ResultsPanel({
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  className,
}: ResultsPanelProps) {
  // 生成历史是跨项目的全局记录；即使项目页签未恢复，也必须能在刷新后找回。
  const recentResults = useFlowStore((s) => s.recentResults);
  const selectedResultId = useFlowStore(selectActiveSelectedResultId);
  const switchTab = useFlowStore((s) => s.switchTab);
  const compareIds = useFlowStore(selectActiveCompareIds);
  const toggleCompareId = useFlowStore((s) => s.toggleCompareId);
  const openViewer = useFlowStore((s) => s.openViewer);
  const activeTabReadOnly = useFlowStore(
    (s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.readOnly ?? false,
  );
  const resultCardClass = "aspect-square min-w-0 w-full";
  const resultActionClass =
    "h-auto min-h-6 rounded-sm px-1 py-1 text-[10px] font-medium leading-none text-[var(--gc-media-overlay-text)] hover:bg-white/15 hover:text-white focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-[var(--gc-accent)] disabled:cursor-not-allowed disabled:opacity-45";
  const isVideo = (ref: string) => /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(ref) || ref.startsWith("data:video/");

  const selectResultRecord = (r: (typeof recentResults)[number]) => {
    if (r.projectId) {
      const state = useFlowStore.getState();
      const targetTab = state.tabs.find((tab) => tab.projectId === r.projectId);
      if (targetTab && targetTab.id !== state.activeTabId) switchTab(targetTab.id);
    }
    useFlowStore.getState().setSelectedResultId(r.id);
  };

  const viewResult = (r: (typeof recentResults)[number]) => {
    selectResultRecord(r);
    if (isVideo(r.image)) return;
    openViewer({
      url: r.image,
      title: r.nodeLabel,
      prompt: r.prompt,
      meta: `${r.model ?? ""} · ${(((r.finishedAt ?? r.startedAt) - r.startedAt) / 1000).toFixed(1)}s · ${new Date(r.finishedAt ?? r.startedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
    });
  };

  const openResultRecord = (r: (typeof recentResults)[number]) => {
    selectResultRecord(r);
    window.dispatchEvent(new CustomEvent(OPEN_GENERATION_RECORD_EVENT, {
      detail: { resultId: r.id },
    }));
  };

  const continueWithResult = (r: (typeof recentResults)[number]) => {
    const state = useFlowStore.getState();
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    if (!tab || tab.readOnly) return;
    const nodes = selectActiveNodes(state);
    const minX = Math.min(0, ...nodes.map((node) => node.position.x));
    const position = { x: minX - 320, y: nodes.length * 40 };
    const nodeId = isVideo(r.image)
      ? state.addNode("video-input", position, {
          label: r.nodeLabel,
          videoUrl: r.image,
          mimeType: r.image.startsWith("data:video/webm") || /\.webm(?:[?#]|$)/i.test(r.image)
            ? "video/webm"
            : r.image.startsWith("data:video/quicktime") || /\.mov(?:[?#]|$)/i.test(r.image)
              ? "video/quicktime"
              : "video/mp4",
        })
      : state.addAssetNode({ name: r.nodeLabel, image: r.image }, position);
    if (nodeId) {
      requestCanvasLanding({ tabId: tab.id, nodeId, fitView: false });
    }
  };

  return (
    <section
      aria-label="最近生成"
      className={cn("gc-panel flex min-h-0 flex-col bg-[var(--gc-panel)]", className)}
    >
      <div className="flex min-w-0 items-center gap-2 border-b border-[var(--gc-border)] px-3 py-2">
        <span className="text-[10px] font-medium uppercase tracking-widest text-[var(--gc-text-muted)]">
          最近生成
        </span>
        <span className="text-[10px] text-[var(--gc-text-muted)]">{recentResults.length} 条</span>
        <span className="ml-auto flex min-w-0 shrink-0 items-center gap-3">
          {compareIds.length >= 2 && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={(e) => {
                e.stopPropagation();
                window.dispatchEvent(new CustomEvent(OPEN_COMPARE_EVENT));
              }}
              className="border-[var(--gc-accent)]/60 bg-[var(--gc-accent)]/10 text-[10px] font-medium text-[var(--gc-accent)] hover:bg-[var(--gc-accent)]/20"
            >
              对比 {compareIds.length} 张
            </Button>
          )}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {recentResults.length === 0 ? (
          <p className="mx-auto max-w-[18rem] py-5 text-center text-[10px] leading-5 text-[var(--gc-text-muted)]">
            运行 AI 节点后，最近生成会显示在这里
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {recentResults.map((r) =>
              isNodeRunActive(r.status) ? (
                <Button
                  key={r.id}
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => openResultRecord(r)}
                  aria-label={`${STATUS_TEXT[r.status]}：${r.nodeLabel}`}
                  className={`flex ${resultCardClass} flex-col items-center justify-center gap-2 rounded-md border bg-[var(--gc-control)] px-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--gc-accent)] ${
                    selectedResultId === r.id
                      ? "border-[var(--gc-accent)]"
                      : "border-[var(--gc-border)] hover:border-[var(--gc-accent)]/60"
                  }`}
                  title={STATUS_TEXT[r.status]}
                >
                  <span className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--gc-accent)]/30 border-t-[var(--gc-accent)]" />
                  <span className="text-[10px] text-[var(--gc-accent)]">
                    {STATUS_TEXT[r.status]}
                  </span>
                  <span className="w-full truncate text-center text-[9px] text-[var(--gc-text-muted)]">
                    {r.nodeLabel}
                  </span>
                </Button>
              ) : r.status !== "success" ? (
                <Button
                  key={r.id}
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => openResultRecord(r)}
                  aria-label={`${STATUS_TEXT[r.status]}：${r.nodeLabel}`}
                  className={`flex ${resultCardClass} flex-col items-center justify-center gap-1 rounded-md border bg-[var(--gc-control)] px-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--gc-accent)] ${
                    selectedResultId === r.id
                      ? r.status === "cancelled" ? "border-[var(--gc-text-muted)]" : "border-red-400"
                      : r.status === "cancelled"
                        ? "border-[var(--gc-border)] hover:border-[var(--gc-text-muted)]"
                        : "border-red-900/50 hover:border-red-400/60"
                  }`}
                  title={r.error ?? STATUS_TEXT[r.status]}
                >
                  <span className={`text-[10px] ${r.status === "cancelled" ? "text-[var(--gc-text-muted)]" : "text-red-400"}`}>
                    {STATUS_TEXT[r.status]}
                  </span>
                  <span className="w-full truncate text-center text-[9px] text-[var(--gc-text-muted)]">
                    {r.nodeLabel}
                  </span>
                </Button>
              ) : (
                <article
                  key={r.id}
                  className={`group relative ${resultCardClass} overflow-hidden rounded-md border bg-[var(--gc-control)] ${
                    compareIds.includes(r.id)
                      ? "border-[var(--gc-accent)] ring-2 ring-[var(--gc-accent)]/70"
                      : selectedResultId === r.id
                        ? "border-[var(--gc-accent)] ring-1 ring-[var(--gc-accent)]"
                        : "border-[var(--gc-border)] hover:border-[var(--gc-accent)]/60"
                  }`}
                >
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        if (e.ctrlKey || e.metaKey) toggleCompareId(r.id);
                        else openResultRecord(r);
                      }}
                      aria-label={`查看生成记录：${r.nodeLabel}`}
                      className="absolute inset-0 h-full w-full cursor-pointer rounded-none p-0 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-[var(--gc-accent)]"
                    >
                      {isVideo(r.image) ? (
                        <video
                          src={r.image}
                          muted
                          playsInline
                          preload="metadata"
                          aria-hidden="true"
                          className="pointer-events-none h-full w-full object-cover"
                        />
                      ) : (
                        <img
                          src={r.thumbnail ?? thumbnailImageUrl(r.image)}
                          alt={r.nodeLabel}
                          loading="lazy"
                          decoding="async"
                          className="h-full w-full object-cover transition-transform group-hover:scale-105"
                        />
                      )}
                    </Button>
                    {compareIds.includes(r.id) && (
                        <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--gc-accent)] text-[9px] font-bold text-[var(--gc-primary-foreground)]">
                        {compareIds.indexOf(r.id) + 1}
                      </span>
                    )}
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 grid grid-cols-2 gap-1 bg-[color-mix(in_srgb,var(--gc-shell)_82%,transparent)] p-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isVideo(r.image)) openResultRecord(r);
                          else viewResult(r);
                        }}
                        className={resultActionClass}
                        aria-label={`${isVideo(r.image) ? "播放视频" : "查看图片"} ${r.nodeLabel}`}
                        title={isVideo(r.image) ? "播放视频" : "查看图片"}
                      >
                        {isVideo(r.image) ? "播放" : "查看"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleCompareId(r.id);
                        }}
                        className={resultActionClass}
                        aria-label={`${compareIds.includes(r.id) ? "取消" : "加入"}对比 ${r.nodeLabel}`}
                        aria-pressed={compareIds.includes(r.id)}
                        title={compareIds.includes(r.id) ? "取消对比" : "加入对比"}
                      >
                        {compareIds.includes(r.id) ? "取消" : "对比"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        render={(
                          <a
                            href={r.image}
                            download
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`下载 ${r.nodeLabel}`}
                            title="下载"
                          >
                            下载
                          </a>
                        )}
                        className={resultActionClass}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          continueWithResult(r);
                        }}
                        disabled={activeTabReadOnly}
                        className={resultActionClass}
                        aria-label={`将 ${r.nodeLabel} 设为输入，继续处理`}
                        title={activeTabReadOnly ? "当前项目只读" : "设为输入"}
                      >
                        输入
                      </Button>
                    </div>
                  </article>
              ),
            )}
            {hasMore && onLoadMore && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onLoadMore}
                disabled={loadingMore}
                className={`${resultCardClass} rounded-md border-dashed border-[var(--gc-border)] bg-transparent text-[10px] text-[var(--gc-text-muted)] hover:border-[var(--gc-accent)] hover:text-[var(--gc-accent)]`}
              >
                {loadingMore ? "加载中…" : "加载更多"}
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

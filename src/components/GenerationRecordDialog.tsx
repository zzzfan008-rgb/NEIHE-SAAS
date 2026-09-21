import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { STATUS_TEXT } from "@/components/nodes/NodeFrame";
import { thumbnailImageUrl } from "@/lib/images";
import { useFlowStore } from "@/store/flowStore";
import { TryOnPoseReviewSummary } from '@/components/TryOnPoseReviewSummary';
import { readMultiImageReferenceManifest } from '@/lib/multiImageTryOn';

function isVideoReference(ref: string): boolean {
  return /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(ref) || ref.startsWith("data:video/");
}

export function GenerationRecordDialog({
  resultId,
  onOpenChange,
}: {
  resultId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const record = useFlowStore((state) => (
    resultId ? state.recentResults.find((candidate) => candidate.id === resultId) : undefined
  ));
  if (!record) return null;

  const multiImageManifest = record.parameters?.sceneInputMode === "multi-reference-edit"
    ? readMultiImageReferenceManifest(record.parameters.referenceManifest) : undefined;

  const finishedAt = record.finishedAt ?? Date.now();
  const duration = Math.max(0, (finishedAt - record.startedAt) / 1000).toFixed(1);
  const statusClass = record.status === "success"
    ? "text-emerald-400"
    : record.status === "error"
      ? "text-red-400"
      : record.status === "cancelled"
        ? "text-[var(--gc-text-muted)]"
        : "text-[var(--gc-accent)]";

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        overlayClassName="bg-[color-mix(in_srgb,var(--gc-shell)_82%,transparent)] backdrop-blur-xs"
        className="flex max-h-[82vh] w-[min(760px,calc(100vw-3rem))] max-w-none flex-col gap-0 overflow-hidden rounded-lg border border-[var(--gc-border)] bg-[var(--gc-panel)] p-0 text-[var(--gc-text)] ring-0"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-[var(--gc-border)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm font-medium text-[var(--gc-text)]">
              {record.nodeLabel}
            </DialogTitle>
            <DialogDescription className="sr-only">生成记录详情</DialogDescription>
            <p className="mt-1 truncate text-[10px] text-[var(--gc-text-muted)]">
              {record.projectName ?? "当前项目"}
            </p>
          </div>
          <span className={`shrink-0 pt-0.5 text-[10px] ${statusClass}`}>{STATUS_TEXT[record.status]}</span>
          <DialogClose render={<Button type="button" variant="ghost" size="icon-sm" aria-label="关闭生成记录" />}>
            <XIcon aria-hidden="true" />
          </DialogClose>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {record.image && (
            isVideoReference(record.image) ? (
              <video
                src={record.image}
                controls
                playsInline
                preload="metadata"
                aria-label={`播放 ${record.nodeLabel}`}
                className="max-h-[42vh] w-full rounded-md border border-[var(--gc-border)] bg-black object-contain"
              />
            ) : (
              <img
                src={record.thumbnail ?? thumbnailImageUrl(record.image)}
                alt={record.nodeLabel}
                loading="lazy"
                decoding="async"
                className="max-h-[42vh] w-full rounded-md border border-[var(--gc-border)] bg-[var(--gc-control)] object-contain"
              />
            )
          )}

          <dl className={`${record.image ? "mt-4" : ""} grid grid-cols-2 gap-x-6 gap-y-2 text-[10px]`}>
            <div className="flex justify-between gap-3 border-b border-[var(--gc-border)]/70 pb-2">
              <dt className="text-[var(--gc-text-muted)]">状态</dt>
              <dd className={statusClass}>{STATUS_TEXT[record.status]}</dd>
            </div>
            <div className="flex justify-between gap-3 border-b border-[var(--gc-border)]/70 pb-2">
              <dt className="text-[var(--gc-text-muted)]">模型</dt>
              <dd className="truncate font-mono text-[var(--gc-text)]">{record.model ?? "-"}</dd>
            </div>
            <div className="flex justify-between gap-3 border-b border-[var(--gc-border)]/70 pb-2">
              <dt className="text-[var(--gc-text-muted)]">开始时间</dt>
              <dd className="text-[var(--gc-text)]">{new Date(record.startedAt).toLocaleString("zh-CN")}</dd>
            </div>
            <div className="flex justify-between gap-3 border-b border-[var(--gc-border)]/70 pb-2">
              <dt className="text-[var(--gc-text-muted)]">{record.finishedAt ? "耗时" : "已等待"}</dt>
              <dd className="text-[var(--gc-text)]">{duration}s</dd>
            </div>
            <div className="flex justify-between gap-3 border-b border-[var(--gc-border)]/70 pb-2">
              <dt className="text-[var(--gc-text-muted)]">生成数量</dt>
              <dd className="text-[var(--gc-text)]">
                {record.requestedCount ? `${record.successfulCount ?? 0}/${record.requestedCount}` : "-"}
              </dd>
            </div>
            <div className="flex justify-between gap-3 border-b border-[var(--gc-border)]/70 pb-2">
              <dt className="text-[var(--gc-text-muted)]">服务请求</dt>
              <dd className="text-[var(--gc-text)]">{record.providerRequests ?? "-"}</dd>
            </div>
            {record.providerOutputSize && (
              <div className="col-span-2 flex justify-between gap-3 border-b border-[var(--gc-border)]/70 pb-2">
                <dt className="text-[var(--gc-text-muted)]">上游实际尺寸</dt>
                <dd className="font-mono text-[var(--gc-text)]">{record.providerOutputSize}</dd>
              </div>
            )}
          </dl>

          <TryOnPoseReviewSummary executionMeta={record.executionMeta} stage={record.parameters?.workflowStage} />

          {record.prompt && (
            <section className="mt-4">
              <h3 className="text-[10px] text-[var(--gc-text-muted)]">提示词</h3>
              <p className="mt-1 whitespace-pre-wrap rounded-md border border-[var(--gc-border)] bg-[var(--gc-control)] p-3 text-[10px] leading-5 text-[var(--gc-text)]">
                {record.prompt}
              </p>
            </section>
          )}

          {record.referenceImages && record.referenceImages.length > 0 && (
            <section className="mt-4">
              <h3 className="text-[10px] text-[var(--gc-text-muted)]">参考图 · {record.referenceImages.length} 张</h3>
              {multiImageManifest && <p className="mt-1 text-[10px] text-[var(--gc-text-muted)]">
                原始素材映射到 {multiImageManifest.at(-1)?.number} 张模型参考图；同编号素材拼接为一张。悬停可查看拼图位置。
              </p>}
              <div className="mt-2 grid grid-cols-6 gap-2">
                {record.referenceImages.map((image, index) => (
                  <img
                    key={`${image}-${index}`}
                    src={thumbnailImageUrl(image)}
                    alt={multiImageManifest?.[index] ? `参考图 ${multiImageManifest[index].number} · ${multiImageManifest[index].role}` : `参考图 ${index + 1}`}
                    title={multiImageManifest?.[index] ? `参考图 ${multiImageManifest[index].number} · ${multiImageManifest[index].role}` : undefined}
                    loading="lazy"
                    decoding="async"
                    className="aspect-square w-full rounded-sm border border-[var(--gc-border)] object-cover"
                  />
                ))}
              </div>
            </section>
          )}

          {record.parameters && Object.keys(record.parameters).length > 0 && (
            <details className="mt-4 rounded-md border border-[var(--gc-border)] bg-[var(--gc-control)] p-3 text-[10px] text-[var(--gc-text-muted)]">
              <summary className="cursor-pointer text-[var(--gc-text)]">生成参数</summary>
              <pre className="mt-2 whitespace-pre-wrap break-all font-mono leading-5">{JSON.stringify(record.parameters, null, 2)}</pre>
            </details>
          )}

          {record.executionMeta && Object.keys(record.executionMeta).length > 0 && (
            <details className="mt-4 rounded-md border border-[var(--gc-border)] bg-[var(--gc-control)] p-3 text-[10px] text-[var(--gc-text-muted)]">
              <summary className="cursor-pointer text-[var(--gc-text)]">换装评审与执行信息</summary>
              <pre className="mt-2 whitespace-pre-wrap break-all font-mono leading-5">{JSON.stringify(record.executionMeta, null, 2)}</pre>
            </details>
          )}

          {record.error && (
            <section className="mt-4 rounded-md border border-red-900/50 bg-red-950/20 p-3">
              <h3 className="text-[10px] text-red-400">错误信息</h3>
              <p className="mt-1 whitespace-pre-wrap text-[10px] leading-5 text-red-300">{record.error}</p>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

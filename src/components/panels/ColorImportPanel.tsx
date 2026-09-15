import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ColorRequestError, type ColorDirectoryPage } from "@/lib/colorManagementClient";
import type {
  ColorGroup,
  ColorImportListItem,
  ManagedColorImport,
} from "@/types/brandColors";
import type { CatalogLibrariesPage } from "@/types/colorManagement";
import {
  useColorManagementQuery,
  useColorManagementRequest,
} from "./ColorManagementSession";
import { ColorImportReview } from "./ColorImportReview";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const PREVIEW_PAGE_SIZE = 25;

type ImportFormat = "xlsx" | "ase";
export interface ColorImportEditorState {
  dirty: boolean;
  busy: boolean;
  outcomeUnknown: boolean;
}

function fileFormat(file: File): ImportFormat | null {
  const extension = file.name.toLowerCase().match(/\.([^.]+)$/)?.[1];
  return extension === "xlsx" || extension === "ase" ? extension : null;
}

function validateFile(file: File) {
  if (!fileFormat(file)) return "仅支持 XLSX 与 ASE 文件。";
  if (!file.size) return "导入文件不能为空。";
  if (file.size > MAX_FILE_BYTES) return "导入文件不得超过 10 MiB。";
  return null;
}

function readBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取导入文件"));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const comma = value.indexOf(",");
      if (comma < 0) reject(new Error("无法编码导入文件"));
      else resolve(value.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

async function fileSha256(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}


export function ColorImportPanel({
  group,
  onGroupRevisionChange,
  onEditorStateChange,
}: {
  group: ColorGroup;
  onGroupRevisionChange: (revision: number) => void;
  onEditorStateChange?: (state: ColorImportEditorState) => void;
}) {
  const colorRequest = useColorManagementRequest();
  const [libraryKey, setLibraryKey] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [record, setRecord] = useState<ManagedColorImport | null>(null);
  const [listRevision, setListRevision] = useState(0);
  const [importOffset, setImportOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [unknownUpload, setUnknownUpload] = useState<{
    fileHash: string;
    groupId: string;
    libraryKey: string;
  } | null>(null);
  const [reviewState, setReviewState] = useState<ColorImportEditorState>({
    dirty: false,
    busy: false,
    outcomeUnknown: false,
  });
  const interactionBusy = busy || reviewState.busy;
  const hasUnknownOutcome = outcomeUnknown || reviewState.outcomeUnknown;
  const reviewBlocksReplacement =
    reviewState.dirty || reviewState.busy || reviewState.outcomeUnknown;
  const [error, setError] = useState<string | null>(null);
  const uploadLock = useRef(false);
  const libraries = useColorManagementQuery<CatalogLibrariesPage>(
    "/catalog/libraries",
  );
  const imports = useColorManagementQuery<ColorDirectoryPage<ColorImportListItem>>(
    `/imports?groupId=${encodeURIComponent(group.id)}&limit=25&offset=${importOffset}`,
    listRevision,
  );
  useEffect(() => {
    const first = libraries.data?.libraries.find((library) => library.ready > 0);
    if (!libraryKey && first) setLibraryKey(first.libraryKey);
  }, [libraries.data, libraryKey]);
  useEffect(() => {
    setImportOffset(0);
    setRecord(null);
  }, [group.id]);
  useEffect(() => {
    if (importOffset > 0 && imports.data?.items.length === 0)
      setImportOffset(Math.max(0, importOffset - PREVIEW_PAGE_SIZE));
  }, [importOffset, imports.data]);
  useEffect(
    () =>
      onEditorStateChange?.({
        dirty: reviewState.dirty,
        busy: interactionBusy,
        outcomeUnknown: hasUnknownOutcome,
      }),
    [
      hasUnknownOutcome,
      interactionBusy,
      onEditorStateChange,
      reviewState.dirty,
    ],
  );
  useEffect(
    () => () =>
      onEditorStateChange?.({ dirty: false, busy: false, outcomeUnknown: false }),
    [onEditorStateChange],
  );

  const selectFile = (next: File | null) => {
    setFile(next);
    setOutcomeUnknown(false);
    setUnknownUpload(null);
    setError(next ? validateFile(next) : null);
  };
  const upload = async () => {
    if (
      uploadLock.current ||
      busy ||
      outcomeUnknown ||
      reviewBlocksReplacement ||
      !file
)
      return;
    const format = fileFormat(file);
    const fileError = validateFile(file);
    if (!format || fileError) {
      setError(fileError ?? "导入文件格式无效");
      return;
    }
    if (!libraryKey) {
      setError("请选择目标 Pantone 色库。");
      return;
    }
    let requestFingerprint: {
      fileHash: string;
      groupId: string;
      libraryKey: string;
    } | null = null;
    uploadLock.current = true;
    setBusy(true);
    setError(null);
    try {
      requestFingerprint = {
        fileHash: await fileSha256(file),
        groupId: group.id,
        libraryKey,
      };
      const base64 = await readBase64(file);
      const created = await colorRequest<ManagedColorImport>("/imports", "POST", {
        groupId: group.id,
        libraryKey,
        format,
        base64,
      });
      setRecord(created);
      setUnknownUpload(null);
      setFile(null);
      setImportOffset(0);
      setListRevision((value) => value + 1);
    } catch (reason) {
      const unknown = reason instanceof ColorRequestError && reason.outcomeUnknown;
      setOutcomeUnknown(unknown);
      setUnknownUpload(unknown ? requestFingerprint : null);
      const message = reason instanceof Error ? reason.message : "上传失败";
      setError(
        unknown
          ? `上传结果可能未知：${message}。请刷新私有导入记录后核对。`
          : message,
      );
    } finally {
      uploadLock.current = false;
      setBusy(false);
    }
  };
  const openImport = async (id: string) => {
    if (interactionBusy || reviewState.dirty || reviewState.outcomeUnknown) return;
    setBusy(true);
    setError(null);
    try {
      const loaded = await colorRequest<ManagedColorImport>(
        `/imports/${encodeURIComponent(id)}`,
      );
      if (
        outcomeUnknown &&
        (!unknownUpload ||
          loaded.fileHash !== unknownUpload.fileHash ||
          loaded.groupId !== unknownUpload.groupId ||
          loaded.libraryKey !== unknownUpload.libraryKey)
      ) {
        setError(
          "所选记录与未知上传不匹配；上传锁保持，请按文件、色组和色库继续核对。",
        );
        return;
      }
      setRecord(loaded);
      setOutcomeUnknown(false);
      setUnknownUpload(null);
      setFile(null);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取导入记录失败");
    } finally {
      setBusy(false);
    }
  };
  const reconcile = () => {
    setError("正在核对私有导入记录；打开对应记录后才会解除上传锁。");
    setRecord(null);
    setImportOffset(0);
    setListRevision((value) => value + 1);
  };
  const allowRetryAfterEmptyList = () => {
    setOutcomeUnknown(false);
    setUnknownUpload(null);
    setError(null);
  };
  const visibleImports = imports.data?.items.filter(
    (item) => item.groupId === group.id,
  );

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col gap-3 overflow-hidden"
      aria-label="颜色导入管理"
    >
      {!record && (
      <div className="grid grid-cols-[minmax(0,1fr)_180px_auto] items-end gap-2 rounded border border-(--gc-border) p-3">
        <label className="min-w-0 space-y-1">
          <span className="block">选择 XLSX 或 ASE 文件</span>
          <Input
            type="file"
            accept=".xlsx,.ase"
            disabled={interactionBusy || outcomeUnknown || reviewBlocksReplacement}
            onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
          />
        </label>
        <label className="space-y-1">
          <span className="block">目标 Pantone 色库</span>
          <Select
            value={libraryKey || null}
            disabled={
              interactionBusy ||
              outcomeUnknown ||
              reviewBlocksReplacement ||
              !libraries.data
            }
            onValueChange={(value) => setLibraryKey(value ?? "")}
          >
            <SelectTrigger aria-label="目标 Pantone 色库" className="w-full text-xs">
              <SelectValue>{libraryKey || "选择色库"}</SelectValue>
            </SelectTrigger>
            <SelectContent
              positionerClassName="z-[90]"
              className="z-[90] border-(--gc-border) bg-(--gc-panel) text-(--gc-text)"
            >
              {libraries.data?.libraries
                .filter((library) => library.ready > 0)
                .map((library) => (
                  <SelectItem key={library.libraryKey} value={library.libraryKey}>
                    {library.libraryKey} · {library.ready}/{library.total}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </label>
        <Button
          type="button"
          size="sm"
          disabled={
            interactionBusy ||
            outcomeUnknown ||
            reviewBlocksReplacement ||
            !file ||
            Boolean(file && validateFile(file))
          }
          onClick={upload}
        >
          {busy ? "处理中…" : "上传并生成预览"}
        </Button>
      </div>
      )}

      {(error || libraries.error || imports.error) && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-red-400">
            {error ?? libraries.error ?? imports.error}
          </p>
          {outcomeUnknown && (
            <Button type="button" size="xs" variant="outline" onClick={reconcile}>
              刷新导入记录并核对
            </Button>
          )}
          {!outcomeUnknown && imports.error && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => setListRevision((value) => value + 1)}
            >
              重试导入记录
            </Button>
          )}
        </div>
      )}

      <section aria-label="私有导入记录" className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h4 className="font-medium">当前色组的私有导入</h4>
          <div className="flex gap-2">
            {record && (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={reviewBlocksReplacement}
                onClick={() => setRecord(null)}
              >
                返回上传与导入列表
              </Button>
            )}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => setListRevision((value) => value + 1)}
          >
            刷新导入记录
          </Button>
          </div>
        </div>
        {!imports.data && !imports.error && <p role="status">读取导入记录…</p>}
        {imports.data && visibleImports?.length === 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-(--gc-text-muted)">暂无私有导入记录。</p>
            {outcomeUnknown && (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={allowRetryAfterEmptyList}
              >
                确认没有记录，允许重新上传
              </Button>
            )}
          </div>
        )}
        <div className="flex min-h-8 gap-1 overflow-x-auto py-1">
          {visibleImports?.map((item) => (
            <Button
              key={item.id}
              type="button"
              size="xs"
              variant={record?.id === item.id ? "secondary" : "outline"}
              className="shrink-0"
              disabled={interactionBusy || reviewState.dirty || reviewState.outcomeUnknown}
              aria-label={`打开导入 ${item.id}`}
              onClick={() => void openImport(item.id)}
            >
              {item.id} · r{item.revision}
            </Button>
          ))}
        </div>
        <div className="flex justify-between gap-2">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={importOffset === 0 || busy}
            onClick={() =>
              setImportOffset(Math.max(0, importOffset - PREVIEW_PAGE_SIZE))
            }
          >
            上一页导入记录
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={imports.data?.nextOffset == null || busy}
            onClick={() => setImportOffset(imports.data!.nextOffset!)}
          >
            下一页导入记录
          </Button>
        </div>
      </section>

      {record ? (
        <ColorImportReview
          record={record}
          groupRevision={group.revision}
          onRecordChange={setRecord}
          onGroupRevisionChange={onGroupRevisionChange}
          onEditorStateChange={setReviewState}
        />
      ) : (
        <p className="m-auto text-(--gc-text-muted)">
          上传文件或打开当前色组的私有导入记录。
        </p>
      )}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ColorRequestError } from "@/lib/colorManagementClient";
import type {
  ColorGroup,
  ColorImportCommit,
  ImportColorDecision,
  ManagedColorImport,
} from "@/types/brandColors";
import type { ColorImportPreviewRow } from "@/types/colorImport";
import {
  ColorCatalogPicker,
  type CatalogSelection,
} from "./ColorCatalogPicker";
import { useColorManagementRequest } from "./ColorManagementSession";
import type { ColorImportEditorState } from "./ColorImportPanel";

const PAGE_SIZE = 25;
const DECIMAL_RATIO = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const STATUS_LABEL: Record<ColorImportPreviewRow["status"], string> = {
  matched: "已匹配",
  "missing-code": "缺少色号",
  unmatched: "未匹配",
  conflict: "存在冲突",
  duplicate: "重复",
  invalid: "无效",
};

type DecisionDraft =
  | { action: "pending" | "skip" }
  | { action: "confirm"; catalogId: string; ratioText: string };

function draftDecision(decision: ImportColorDecision): DecisionDraft {
  return decision.action === "confirm"
    ? {
        action: "confirm",
        catalogId: decision.catalogId,
        ratioText: decision.ratio === null ? "" : String(decision.ratio),
      }
    : decision;
}

function parseRatio(text: string) {
  const value = text.trim();
  if (!value) return null;
  if (!DECIMAL_RATIO.test(value)) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1
    ? number
    : undefined;
}

function serialized(decisions: readonly DecisionDraft[]) {
  return JSON.stringify(decisions);
}

export function ColorImportReview({
  record,
  groupRevision,
  onRecordChange,
  onGroupRevisionChange,
  onEditorStateChange,
}: {
  record: ManagedColorImport;
  groupRevision: number;
  onRecordChange: (record: ManagedColorImport) => void;
  onGroupRevisionChange: (revision: number) => void;
  onEditorStateChange?: (state: ColorImportEditorState) => void;
}) {
  const colorRequest = useColorManagementRequest();
  const [decisions, setDecisions] = useState<DecisionDraft[]>(() =>
    record.decisions.map(draftDecision),
  );
  const [baseline, setBaseline] = useState(() =>
    serialized(record.decisions.map(draftDecision)),
  );
  const [offset, setOffset] = useState(0);
  const [pickerRow, setPickerRow] = useState<number | null>(null);
  const [selectedColors, setSelectedColors] = useState<
    Record<number, CatalogSelection>
  >({});
  const [busy, setBusy] = useState(false);
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmReplay, setConfirmReplay] = useState<{
    revision: number;
    groupRevision: number;
  } | null>(null);
  const submitLock = useRef(false);
  const synchronizedRecordKey = useRef(`${record.id}:${record.revision}`);
  const dirty = serialized(decisions) !== baseline;
  const published = useMemo(
    () => new Set(record.publishedRows),
    [record.publishedRows],
  );
  const selectedCatalogIds = useMemo(
    () =>
      new Set(
        decisions.flatMap((decision) =>
          decision.action === "confirm" ? [decision.catalogId] : [],
        ),
      ),
    [decisions],
  );
  const hasPublishable = decisions.some(
    (decision, index) => decision.action === "confirm" && !published.has(index),
  );
  const editsLocked = busy || outcomeUnknown || errorStatus === 409;

  useEffect(() => {
    const key = `${record.id}:${record.revision}`;
    if (synchronizedRecordKey.current === key) return;
    synchronizedRecordKey.current = key;
    const next = record.decisions.map(draftDecision);
    setDecisions(next);
    setBaseline(serialized(next));
    setOffset(0);
    setPickerRow(null);
    setSelectedColors({});
    setOutcomeUnknown(false);
    setConfirmReplay(null);
    setError(null);
    setErrorStatus(null);
    setStatus(null);
  }, [record.id, record.revision, record.decisions]);
  useEffect(
    () => onEditorStateChange?.({ dirty, busy, outcomeUnknown }),
    [busy, dirty, onEditorStateChange, outcomeUnknown],
  );
  useEffect(
    () => () =>
      onEditorStateChange?.({
        dirty: false,
        busy: false,
        outcomeUnknown: false,
      }),
    [onEditorStateChange],
  );

  const applyRecord = (next: ManagedColorImport, message?: string) => {
    synchronizedRecordKey.current = `${next.id}:${next.revision}`;
    const drafts = next.decisions.map(draftDecision);
    setDecisions(drafts);
    setBaseline(serialized(drafts));
    setOutcomeUnknown(false);
    setConfirmReplay(null);
    setError(null);
    setErrorStatus(null);
    if (message) setStatus(message);
    onRecordChange(next);
  };
  const setDecision = (index: number, decision: DecisionDraft) => {
    if (published.has(index) || busy || outcomeUnknown || errorStatus === 409)
      return;
    setStatus(null);
    setError(null);
    setErrorStatus(null);
    setDecisions((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? decision : item)),
    );
  };
  const decisionPayload = () => {
    const values: ImportColorDecision[] = [];
    for (const decision of decisions) {
      if (decision.action !== "confirm") {
        values.push(decision);
        continue;
      }
      const ratio = parseRatio(decision.ratioText);
      if (ratio === undefined) return null;
      values.push({ action: "confirm", catalogId: decision.catalogId, ratio });
    }
    return values;
  };
  const save = async () => {
    if (
      submitLock.current ||
      busy ||
      outcomeUnknown ||
      errorStatus === 409 ||
      !dirty
    )
      return;
    const payload = decisionPayload();
    if (!payload) {
      setError("参考比例须为 0–1 的数值或空值，不会自动补齐。");
      return;
    }
    submitLock.current = true;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const updated = await colorRequest<ManagedColorImport>(
        `/imports/${encodeURIComponent(record.id)}`,
        "PATCH",
        { revision: record.revision, decisions: payload },
      );
      applyRecord(updated, "校准决定已保存。");
    } catch (reason) {
      const unknown =
        reason instanceof ColorRequestError && reason.outcomeUnknown;
      setOutcomeUnknown(unknown);
      setErrorStatus(
        reason instanceof ColorRequestError ? reason.status : null,
      );
      const message = reason instanceof Error ? reason.message : "保存校准失败";
      setError(
        unknown
          ? `保存结果可能未知：${message}。请重新读取导入记录后核对。`
          : message,
      );
    } finally {
      submitLock.current = false;
      setBusy(false);
    }
  };
  const finishConfirm = (commit: ColorImportCommit) => {
    const nextPublished = new Set(record.publishedRows);
    decisions.forEach((decision, index) => {
      if (decision.action === "confirm") nextPublished.add(index);
    });
    const payload = decisionPayload();
    if (!payload) return;
    applyRecord(
      {
        ...record,
        revision: commit.importRevision,
        decisions: payload,
        publishedRows: [...nextPublished].sort((a, b) => a - b),
      },
      `本次添加 ${commit.added} 色。`,
    );
    onGroupRevisionChange(commit.groupRevision);
  };
  const confirm = async (requestBody?: {
    revision: number;
    groupRevision: number;
  }) => {
    if (
      submitLock.current ||
      busy ||
      dirty ||
      !hasPublishable ||
      errorStatus === 409 ||
      (outcomeUnknown && !requestBody)
    )
      return;
    const body = requestBody ?? { revision: record.revision, groupRevision };
    submitLock.current = true;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const commit = await colorRequest<ColorImportCommit>(
        `/imports/${encodeURIComponent(record.id)}/confirm`,
        "POST",
        body,
      );
      finishConfirm(commit);
    } catch (reason) {
      const unknown =
        reason instanceof ColorRequestError && reason.outcomeUnknown;
      setOutcomeUnknown(unknown);
      setConfirmReplay(unknown ? body : null);
      setErrorStatus(
        reason instanceof ColorRequestError ? reason.status : null,
      );
      const message = reason instanceof Error ? reason.message : "发布确认失败";
      setError(
        unknown
          ? `确认结果可能未知：${message}。只能重放相同请求或读取回执，不能改用新 revision。`
          : message,
      );
    } finally {
      submitLock.current = false;
      setBusy(false);
    }
  };
  const reload = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const [nextRecord, nextGroup] = await Promise.all([
        colorRequest<ManagedColorImport>(
          `/imports/${encodeURIComponent(record.id)}`,
        ),
        colorRequest<ColorGroup>(
          `/groups/${encodeURIComponent(record.groupId)}`,
        ),
      ]);
      applyRecord(nextRecord, "已重新读取服务器记录。");
      onGroupRevisionChange(nextGroup.revision);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "重新读取失败");
    } finally {
      setBusy(false);
    }
  };
  const rows = record.rows.slice(offset, offset + PAGE_SIZE);

  return (
    <section
      role="region"
      aria-label="导入预览"
      className="flex min-h-0 flex-1 flex-col gap-2 rounded border border-(--gc-border) p-3"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h4 className="truncate font-medium">导入 {record.id}</h4>
          <p className="text-(--gc-text-muted)">
            {record.libraryKey} · {record.rows.length} 行 · 已发布{" "}
            {record.publishedRows.length} 行
          </p>
        </div>
        <p className="shrink-0 text-(--gc-text-muted)">
          {offset + 1}–{Math.min(offset + PAGE_SIZE, record.rows.length)} /{" "}
          {record.rows.length}
        </p>
      </div>

      {error && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-red-400">
            {error}
          </p>
          {confirmReplay && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void confirm(confirmReplay)}
            >
              重放相同确认请求
            </Button>
          )}
          {!confirmReplay && (outcomeUnknown || errorStatus === 409) && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void reload()}
            >
              重新读取导入与色组
            </Button>
          )}
        </div>
      )}
      {status && <p role="status">{status}</p>}

      <div
        role="region"
        aria-label="导入颜色行列表"
        className="min-h-0 flex-1 space-y-2 overflow-auto"
      >
        {rows.map((row, pageIndex) => {
          const index = offset + pageIndex;
          const decision = decisions[index]!;
          const isPublished = published.has(index);
          const chosen =
            selectedColors[index] ??
            (decision.action === "confirm"
              ? (row.candidates.find(
                  (candidate) => candidate.catalogId === decision.catalogId,
                ) ??
                (row.matchedColor?.catalogId === decision.catalogId
                  ? row.matchedColor
                  : undefined))
              : undefined);
          const selectedByAnotherRow = (catalogId: string) =>
            selectedCatalogIds.has(catalogId) &&
            !(
              decision.action === "confirm" && decision.catalogId === catalogId
            );
          return (
            <article
              key={`${row.sheetName}:${row.rowNumber}`}
              aria-label={`导入行 ${row.rowNumber}`}
              className="space-y-2 rounded border border-(--gc-border) p-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-all font-medium">
                    {row.rawCode || row.code || "无色号"}
                  </p>
                  <p className="break-all text-(--gc-text-muted)">
                    {row.sheetName} · 行 {row.rowNumber} · 原始比例{" "}
                    {row.rawRatio === null || row.rawRatio === ""
                      ? "空"
                      : String(row.rawRatio)}
                  </p>
                  {row.sourceHex && <p>原始 HEX：{row.sourceHex}</p>}
                  {row.errors.map((message) => (
                    <p key={message} className="text-red-400">
                      {message}
                    </p>
                  ))}
                </div>
                <p className="shrink-0">
                  {STATUS_LABEL[row.status]}
                  {isPublished ? " · 已发布" : ""}
                </p>
              </div>
              {row.matchedColor && (
                <div
                  aria-label={`精确匹配导入行 ${row.rowNumber}`}
                  className="flex items-center gap-2 text-(--gc-text-muted)"
                >
                  <span
                    aria-hidden="true"
                    className="size-5 shrink-0 rounded border border-(--gc-border)"
                    style={{
                      backgroundColor: row.matchedColor.hex ?? "transparent",
                    }}
                  />
                  <span>
                    精确匹配 · {row.matchedColor.code} ·{" "}
                    {row.matchedColor.libraryKey} ·{" "}
                    {row.matchedColor.hex ?? "不可转换"}
                  </span>
                </div>
              )}

              <div className="flex flex-wrap gap-1">
                <Button
                  type="button"
                  size="xs"
                  variant={
                    decision.action === "pending" ? "secondary" : "outline"
                  }
                  aria-pressed={decision.action === "pending"}
                  disabled={isPublished || editsLocked}
                  onClick={() => setDecision(index, { action: "pending" })}
                >
                  保持待处理导入行 {row.rowNumber}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant={decision.action === "skip" ? "secondary" : "outline"}
                  aria-pressed={decision.action === "skip"}
                  disabled={isPublished || editsLocked}
                  onClick={() => setDecision(index, { action: "skip" })}
                >
                  跳过导入行 {row.rowNumber}
                </Button>
                {row.matchedCatalogId && (
                  <Button
                    type="button"
                    size="xs"
                    variant={
                      decision.action === "confirm" &&
                      decision.catalogId === row.matchedCatalogId
                        ? "secondary"
                        : "outline"
                    }
                    aria-pressed={
                      decision.action === "confirm" &&
                      decision.catalogId === row.matchedCatalogId
                    }
                    disabled={
                      isPublished ||
                      editsLocked ||
                      selectedByAnotherRow(row.matchedCatalogId)
                    }
                    onClick={() =>
                      setDecision(index, {
                        action: "confirm",
                        catalogId: row.matchedCatalogId!,
                        ratioText: row.ratio === null ? "" : String(row.ratio),
                      })
                    }
                  >
                    确认导入行 {row.rowNumber}
                  </Button>
                )}
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={isPublished || editsLocked}
                  onClick={() =>
                    setPickerRow(pickerRow === index ? null : index)
                  }
                >
                  从主库选择导入行 {row.rowNumber}
                </Button>
              </div>

              {row.candidates.map((candidate) => (
                <Button
                  key={candidate.catalogId}
                  type="button"
                  size="xs"
                  variant={
                    decision.action === "confirm" &&
                    decision.catalogId === candidate.catalogId
                      ? "secondary"
                      : "outline"
                  }
                  disabled={
                    isPublished ||
                    editsLocked ||
                    selectedByAnotherRow(candidate.catalogId)
                  }
                  onClick={() => {
                    setSelectedColors((current) => ({
                      ...current,
                      [index]: {
                        catalogId: candidate.catalogId,
                        releaseId: record.releaseId,
                        libraryKey: candidate.libraryKey,
                        code: candidate.code,
                        hex: candidate.hex,
                      },
                    }));
                    setDecision(index, {
                      action: "confirm",
                      catalogId: candidate.catalogId,
                      ratioText: row.ratio === null ? "" : String(row.ratio),
                    });
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="mr-1 size-4 shrink-0 rounded border border-(--gc-border)"
                    style={{ backgroundColor: candidate.hex }}
                  />
                  使用近似候选 {candidate.code} 于导入行 {row.rowNumber} ·{" "}
                  {candidate.libraryKey} · {candidate.hex}
                  <span className="ml-1">
                    近似 · ΔE {candidate.deltaE.toFixed(2)}
                  </span>
                </Button>
              ))}

              {decision.action === "confirm" && (
                <div className="grid grid-cols-[minmax(0,1fr)_10rem] items-end gap-2">
                  <p className="min-w-0 break-all">
                    {chosen
                      ? `已选 ${chosen.code} · ${chosen.libraryKey} · ${chosen.hex ?? "不可转换"}`
                      : `已选主库身份 ${decision.catalogId}`}
                  </p>
                  <label className="space-y-1">
                    <span className="block">确认比例</span>
                    <Input
                      aria-label={`导入行 ${row.rowNumber} 比例`}
                      value={decision.ratioText}
                      disabled={isPublished || editsLocked}
                      onChange={(event) =>
                        setDecision(index, {
                          ...decision,
                          ratioText: event.target.value,
                        })
                      }
                    />
                  </label>
                </div>
              )}

              {pickerRow === index && !isPublished && (
                <div className="h-48 min-h-0 rounded border border-(--gc-border) p-2">
                  <ColorCatalogPicker
                    libraryKey={record.libraryKey}
                    releaseId={record.releaseId}
                    disabled={editsLocked}
                    selectedCatalogIds={selectedCatalogIds}
                    onSelect={(selection) => {
                      setSelectedColors((current) => ({
                        ...current,
                        [index]: selection,
                      }));
                      setDecision(index, {
                        action: "confirm",
                        catalogId: selection.catalogId,
                        ratioText: row.ratio === null ? "" : String(row.ratio),
                      });
                      setPickerRow(null);
                    }}
                  />
                </div>
              )}
            </article>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={offset === 0 || busy}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            上一页预览
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={offset + PAGE_SIZE >= record.rows.length || busy}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            下一页预览
          </Button>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={editsLocked || !dirty}
            onClick={() => void save()}
          >
            {busy ? "提交中…" : "保存校准决定"}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={editsLocked || dirty || !hasPublishable}
            onClick={() => void confirm()}
          >
            发布已确认颜色
          </Button>
        </div>
      </div>
    </section>
  );
}

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { POSE_REVIEW_LABELS, readTryOnPoseReview, type PoseReviewField, type PoseReviewStatus } from '@/lib/tryOnPoseReview';

const STATUS_LABELS: Record<PoseReviewStatus, string> = {
  match: '一致', mismatch: '存在偏差', indeterminate: '无法判断', 'not-observable': '不可观察',
};
const REFERENCE_LABELS = { original: '人物照片', 'neutral-outfit': '中性服装照片', skeleton: '骨架图', depth: '深度图', unspecified: '未标注' };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function TryOnPoseReviewSummary({ executionMeta, stage }: { executionMeta: unknown; stage: unknown }) {
  const tryOn = record(record(executionMeta)?.tryOn);
  if (tryOn?.stage !== 'scene-stabilize' && stage !== 'scene-stabilize') return null;
  const selection = record(tryOn?.candidateSelection);
  const review = readTryOnPoseReview(selection?.poseReview);
  const selectedIndex = selection?.selectedIndex;
  const scores = Array.isArray(selection?.scores) ? selection.scores.map(record) : [];
  const recommended = review?.candidates.find(candidate => candidate.index === selectedIndex && candidate.status === 'match' &&
    scores.some(score => score?.index === candidate.index && score.hardFail === false));
  let summary = '无法判断 · 未完成有效的独立姿势评审，请人工核对';
  if (recommended) summary = `自动推荐 · 候选 ${recommended.index + 1}`;
  else if (review?.candidates.some(candidate => candidate.status === 'mismatch')) summary = '存在偏差 · 未自动推荐，请人工核对姿势';
  else if (review && scores.some(score => score?.hardFail === true)) summary = '存在偏差 · 其他质量检查未通过，未自动推荐';
  else if (review) summary = '无法判断 · 未满足自动推荐条件，请人工核对';

  return (
    <Card role="region" aria-label="独立姿势评审" size="sm" className="mt-4 rounded-md border border-[var(--gc-border)] bg-[var(--gc-control)] text-[var(--gc-text)] ring-0">
      <CardHeader>
        <CardTitle className="text-xs">独立姿势评审</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-[11px] leading-5 break-words">
        <p role="status">{summary}</p>
        <p className="text-[var(--gc-text-muted)]">模型判断仍需人工确认；质量总分不代表姿势精确一致。左右按画面方向。</p>
        {review && <p>参考类型：{REFERENCE_LABELS[review.referenceType]}</p>}
        {typeof selection?.poseReviewError === 'string' && <p className="text-[var(--gc-text-muted)]">评审未完成：{selection.poseReviewError}</p>}
        {review && <ul aria-label="姿势候选评审" className="space-y-4">
          {review.candidates.map(candidate => (
            <li key={candidate.index}>
              <h4 className="mb-1 font-medium">候选 {candidate.index + 1} · {STATUS_LABELS[candidate.status]}</h4>
              <dl className="space-y-2">
                {(Object.keys(POSE_REVIEW_LABELS) as PoseReviewField[]).map(field => (
                  <div key={field} className="border-t border-[var(--gc-border)] pt-2">
                    <dt>{POSE_REVIEW_LABELS[field]} · {STATUS_LABELS[candidate.checks[field].status]}</dt>
                    <dd className="text-[var(--gc-text-muted)]">参考：{candidate.checks[field].reference}<br />候选：{candidate.checks[field].candidate}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>}
      </CardContent>
    </Card>
  );
}

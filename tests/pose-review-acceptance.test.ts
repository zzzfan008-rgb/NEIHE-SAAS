import assert from 'node:assert/strict';
import { POSE_REVIEW_LABELS, parsePoseReviewCandidates, type PoseReviewField, type PoseReviewStatus } from '../src/lib/tryOnPoseReview';

console.log('姿势评审正负对照验收合同');

const fields = Object.keys(POSE_REVIEW_LABELS) as PoseReviewField[];
type Check = { status: PoseReviewStatus; reference: string; candidate: string };
type Candidate = { index: number; checks: Record<PoseReviewField, Check> };

function sample(index: number, candidateEvidence: string, overrides: Partial<Record<PoseReviewField, Partial<Check>>> = {}): Candidate {
  return {
    index,
    checks: Object.fromEntries(fields.map(field => [field, {
      status: 'match',
      reference: `参考的${POSE_REVIEW_LABELS[field]}：可见交叉屈膝姿势`,
      candidate: candidateEvidence,
      ...overrides[field],
    }])) as Record<PoseReviewField, Check>,
  };
}

/** Local fixture gate: reference evidence belongs to one reference, never each candidate. */
function assertReferenceEvidenceConsistent(candidates: Candidate[]): void {
  for (const field of fields) {
    const facts = new Set(candidates.map(candidate => candidate.checks[field].reference));
    assert.equal(facts.size, 1, `${POSE_REVIEW_LABELS[field]} 的参考侧依据相互矛盾`);
  }
}

// Positive contract: a clearly identical pose can pass; depth gaze is deliberately not-observable.
const sameImage = sample(0, '候选与参考为同一张姿势图，交叉屈膝关系可见', {
  gaze: { status: 'mismatch', reference: '不应从深度图推断视线', candidate: '不应参与通过判断' },
});
const positive = parsePoseReviewCandidates([sameImage], 1, 'depth')[0];
assert.equal(positive.status, 'match');
assert.equal(positive.checks.gaze.status, 'not-observable');

// Negative contract: an observed split stance must defeat every quality score or aggregate claim.
const splitStance = sample(0, '候选双脚分开、两腿伸直，无前后交叠', {
  screenRightLeg: { status: 'mismatch', reference: '参考画面右腿屈膝并横向交叉在前', candidate: '候选画面右腿伸直且分开' },
  weightAndCrossing: { status: 'mismatch', reference: '参考双腿交叠，画面右腿在前', candidate: '候选双脚分开，无交叠或前后关系' },
});
const negative = parsePoseReviewCandidates([splitStance], 1, 'original')[0];
assert.equal(negative.status, 'mismatch');
assert.equal(negative.checks.screenRightLeg.status, 'mismatch');
assert.equal(negative.checks.weightAndCrossing.status, 'mismatch');

// Multi-candidate contract: candidate evidence may differ, but facts about one reference may not.
const candidateA = sample(0, '候选 A 与参考同为交叉姿势');
const candidateB = sample(1, '候选 B 双脚分开，缺少交叉');
assertReferenceEvidenceConsistent([candidateA, candidateB]);
assert.throws(() => assertReferenceEvidenceConsistent([
  candidateA,
  sample(1, '候选 B', { headAndTorso: { reference: '参考躯干正向直立', candidate: '候选 B 躯干直立' } }),
]), /头部与躯干/);

// Opaque photo eyes are not observable and therefore cannot be an automatic pass.
const opaqueGaze = sample(0, '候选姿势与参考一致', {
  gaze: { status: 'indeterminate', reference: '参考佩戴墨镜，视线不可见', candidate: '候选视线可见但无法与参考核对' },
});
assert.equal(parsePoseReviewCandidates([opaqueGaze], 1, 'original')[0].status, 'indeterminate');

console.log('通过姿势评审正负对照验收合同');

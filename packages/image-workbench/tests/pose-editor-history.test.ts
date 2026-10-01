import assert from "node:assert/strict";
import { createEmptyPoseDocument, setPosePoint } from "../src/lib/poseEditorModel";
import {
  canRedoPoseEditorHistory,
  canUndoPoseEditorHistory,
  commitPoseEditorHistory,
  createPoseEditorHistory,
  redoPoseEditorHistory,
  resetPoseEditorHistory,
  undoPoseEditorHistory,
} from "../src/lib/poseEditorHistory";
import type { PosePointPath } from "../src/lib/poseEditorModel";

const image = "/api/files/editor-history.png";
const personId = "00000000-0000-4000-8000-000000000001";
const original = createEmptyPoseDocument({
  image,
  width: 800,
  height: 600,
  idFactory: () => personId,
});
const shoulder: PosePointPath = { personId, group: "body", index: 5 };
const edited = setPosePoint(original, shoulder, { x: 120, y: 140, confidence: 1, origin: "manual" });
const mirrored = setPosePoint(edited, shoulder, { x: 680, y: 140, confidence: 1, origin: "manual" });

function test(name: string, run: () => void): void {
  run();
  console.log(`  ✓ ${name}`);
}

console.log("姿势编辑器撤销重做测试");

test("单个编辑动作可撤销和重做", () => {
  const changed = commitPoseEditorHistory(createPoseEditorHistory(original), edited);
  assert.equal(canUndoPoseEditorHistory(changed), true);
  assert.equal(canRedoPoseEditorHistory(changed), false);
  const undone = undoPoseEditorHistory(changed);
  assert.deepEqual(undone.present, original);
  assert.equal(canRedoPoseEditorHistory(undone), true);
  assert.deepEqual(redoPoseEditorHistory(undone).present, edited);
});

test("撤销后新增动作清空 redo 分支", () => {
  const changed = commitPoseEditorHistory(createPoseEditorHistory(original), edited);
  const branched = commitPoseEditorHistory(undoPoseEditorHistory(changed), mirrored);
  assert.deepEqual(branched.present, mirrored);
  assert.equal(canRedoPoseEditorHistory(branched), false);
});

test("相同快照不重复入栈，reset 本身仍可撤销", () => {
  const changed = commitPoseEditorHistory(createPoseEditorHistory(original), edited);
  const noOp = commitPoseEditorHistory(changed, edited);
  assert.equal(noOp.past.length, 1);
  const reset = resetPoseEditorHistory(noOp, original);
  assert.deepEqual(reset.present, original);
  assert.deepEqual(undoPoseEditorHistory(reset).present, edited);
});

test("历史保留上限并在到达上限后丢弃最旧快照", () => {
  let history = createPoseEditorHistory(original, 2);
  const first = setPosePoint(original, shoulder, { x: 100, y: 100, confidence: 1, origin: "manual" });
  const second = setPosePoint(original, shoulder, { x: 200, y: 200, confidence: 1, origin: "manual" });
  history = commitPoseEditorHistory(history, first);
  history = commitPoseEditorHistory(history, second);
  history = commitPoseEditorHistory(history, edited);
  assert.equal(history.past.length, 2);
  assert.deepEqual(undoPoseEditorHistory(history).present, second);
});

import assert from 'node:assert/strict';
import { createEmptyPoseDocument, setPosePoint } from '../src/lib/poseEditorModel';
import { solveTwoBoneIk, poseVectorLength, subtractPoseVectors } from '../src/lib/poseIk';
import {
  createPose3DFromDocument,
  ensurePose3DDocument,
  getPose3DChainTarget,
  markPose3DStale,
  projectPose3DToDocument,
  solvePose3DChain,
} from '../src/lib/pose3dModel';
import type { PosePointV1 } from '../src/types/poseDocument';

const personId = '00000000-0000-4000-8000-000000000001';
const image = '/api/files/pose-ik-source.png';

function test(name: string, run: () => void): void {
  run();
  console.log(`  ✓ ${name}`);
}

function manualPoint(x: number, y: number): PosePointV1 {
  return { x, y, confidence: 1, origin: 'manual' };
}

function createDocument() {
  const initial = createEmptyPoseDocument({
    image,
    width: 1000,
    height: 1000,
    idFactory: () => personId,
  });
  return [
    [5, manualPoint(400, 400)],
    [7, manualPoint(350, 500)],
    [9, manualPoint(250, 600)],
    [6, manualPoint(600, 400)],
    [8, manualPoint(650, 500)],
    [10, manualPoint(700, 600)],
    [11, manualPoint(720, 700)],
    [12, manualPoint(450, 650)],
    [13, manualPoint(420, 800)],
    [14, manualPoint(400, 900)],
  ].reduce((document, [index, point]) => setPosePoint(document, { personId, group: 'body', index: index as number }, point as PosePointV1), initial);
}

console.log('3D 姿势 IK 与投影模型测试');

test('可达目标保持两段骨骼长度并沿偏好方向弯曲', () => {
  const result = solveTwoBoneIk({
    root: { x: 0, y: 0, z: 0 },
    joint: { x: 1, y: 0, z: 0 },
    end: { x: 2, y: 0, z: 0 },
    target: { x: 1, y: 1, z: 0 },
    bendDirection: { x: 0, y: 0, z: 1 },
  });
  assert.equal(result.status, 'ok');
  assert.ok(Math.abs(poseVectorLength(subtractPoseVectors(result.joint, result.root)) - 1) < 1e-8);
  assert.ok(Math.abs(poseVectorLength(subtractPoseVectors(result.end, result.joint)) - 1) < 1e-8);
  assert.ok(Math.abs(result.end.x - 1) < 1e-8);
  assert.ok(Math.abs(result.end.y - 1) < 1e-8);
  assert.ok(result.joint.z > 0);
});

test('超出可达范围时夹紧末端并报告 unreachable', () => {
  const result = solveTwoBoneIk({
    root: { x: 0, y: 0, z: 0 },
    joint: { x: 1, y: 0, z: 0 },
    end: { x: 2, y: 0, z: 0 },
    target: { x: 4, y: 0, z: 0 },
  });
  assert.equal(result.status, 'unreachable');
  assert.ok(Math.abs(result.requestedDistance - 4) < 1e-8);
  assert.ok(Math.abs(poseVectorLength(result.achievedTarget) - 2) < 1e-8);
});

test('零长度或非有限输入返回 invalid 而不产生伪造解', () => {
  const result = solveTwoBoneIk({
    root: { x: 0, y: 0, z: 0 },
    joint: { x: 0, y: 0, z: 0 },
    end: { x: 1, y: 0, z: 0 },
    target: { x: 1, y: 0, z: 0 },
  });
  assert.equal(result.status, 'invalid');
  assert.match(result.reason ?? '', /长度/);
});

test('缺少 IK 链条点位时返回 invalid 且不修改文档', () => {
  const document = ensurePose3DDocument(createDocument(), personId);
  const result = solvePose3DChain(document, personId, 'right-leg', { x: 0, y: 0, z: 0 });
  assert.equal(result.status, 'invalid');
  assert.match(result.reason ?? '', /缺少必要关键点/);
  assert.deepEqual(result.document, document);
});

test('2D 姿势可建立 BODY_25，并在默认输出相机下保持屏幕坐标', () => {
  const document = createDocument();
  const pose3d = createPose3DFromDocument(document, personId);
  assert.equal(pose3d.body25.length, 25);
  assert.ok(pose3d.body25[5]);
  assert.ok(Math.abs(pose3d.body25[5]!.x + 0.2) < 1e-8);
  assert.ok(Math.abs(pose3d.body25[5]!.y - 0.2) < 1e-8);
  assert.equal(pose3d.body25[5]!.z, 0);
  assert.equal(pose3d.body25[5]!.origin, 'manual');
  const projected = projectPose3DToDocument(document, pose3d, personId);
  assert.ok(projected.people[0].body[5]);
  assert.ok(Math.abs(projected.people[0].body[5]!.x - 400) < 1e-8);
  assert.ok(Math.abs(projected.people[0].body[5]!.y - 400) < 1e-8);
  assert.equal(projected.pose3d?.stale, false);
});

test('3D 输出投影让手脸附件跟随对应锚点且保留未关联数据', () => {
  let document = createDocument();
  document = setPosePoint(document, { personId, group: 'body', index: 0 }, manualPoint(500, 200));
  document = setPosePoint(document, { personId, group: 'leftHand', index: 0 }, manualPoint(230, 610));
  document = setPosePoint(document, { personId, group: 'rightHand', index: 0 }, manualPoint(730, 610));
  document = setPosePoint(document, { personId, group: 'face', index: 0 }, manualPoint(510, 190));
  document = setPosePoint(document, { personId, group: 'feet', index: 0 }, manualPoint(180, 900));
  const pose3d = createPose3DFromDocument(document, personId);
  const shiftedPose3D = {
    ...pose3d,
    body25: pose3d.body25.map((point, index) => {
      if (!point || ![0, 7, 19].includes(index)) return point;
      return { ...point, x: point.x + 0.1 };
    }),
  };
  const projected = projectPose3DToDocument(document, shiftedPose3D, personId);
  const person = projected.people[0];
  assert.ok(person.face[0]);
  assert.ok(person.hands.left[0]);
  assert.ok(person.hands.right[0]);
  assert.ok(person.feet[0]);
  assert.ok(Math.abs(person.face[0]!.x - 560) < 1e-8);
  assert.ok(Math.abs(person.hands.left[0]!.x - 280) < 1e-8);
  assert.ok(Math.abs(person.hands.right[0]!.x - 730) < 1e-8);
  assert.ok(Math.abs(person.feet[0]!.x - 230) < 1e-8);
  assert.equal(person.face[0]!.origin, 'manual');
  assert.equal(person.hands.left[0]!.origin, 'manual');
  const partialPose3D = { ...pose3d, body25: pose3d.body25.map((point, index) => index === 19 ? null : point) };
  const partialProjected = projectPose3DToDocument(document, partialPose3D, personId);
  assert.equal(partialProjected.people[0].feet[0]!.x, 180);
});

test('3D IK 更新当前人物并让输出 2D 预览跟随', () => {
  const document = ensurePose3DDocument(createDocument(), personId);
  const currentTarget = getPose3DChainTarget(document.pose3d, 'left-arm');
  assert.ok(currentTarget);
  const result = solvePose3DChain(document, personId, 'left-arm', {
    x: currentTarget!.x + 0.15,
    y: currentTarget!.y + 0.1,
    z: currentTarget!.z,
  });
  assert.notEqual(result.status, 'invalid');
  assert.ok(result.document.pose3d);
  assert.ok(result.document.people[0].body[9]);
  assert.notEqual(result.document.people[0].body[9]!.x, document.people[0].body[9]!.x);
  assert.equal(result.document.pose3d!.stale, false);
});

test('2D 修改会标记已有 3D 姿势过期，重新进入 3D 可重建', () => {
  const document = ensurePose3DDocument(createDocument(), personId);
  const stale = markPose3DStale(document);
  assert.equal(stale.pose3d?.stale, true);
  const rebuilt = ensurePose3DDocument(stale, personId);
  assert.equal(rebuilt.pose3d?.stale, false);
  assert.ok(rebuilt.pose3d?.body25[7]);
});

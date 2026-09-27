import assert from 'node:assert/strict';
import { createEmptyPoseDocument, setPosePoint } from '../src/lib/poseEditorModel';
import { solveTwoBoneIk, poseVectorLength, subtractPoseVectors } from '../src/lib/poseIk';
import {
  BODY25_CONNECTIONS,
  createPose3DFromDocument,
  ensurePose3DDocument,
  getPose3DChainTarget,
  markPose3DStale,
  projectPose3DToDocument,
  solvePose3DChain,
} from '../src/lib/pose3dModel';
import type { PosePointV1 } from '../src/types/poseDocument';
import { validatePoseDocument } from '../src/lib/poseTopology';

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

test('多人物保存后只复用所属人物的 3D 骨架', () => {
  const document = createDocument();
  const second = structuredClone(document.people[0]);
  second.id = '00000000-0000-4000-8000-000000000002';
  second.body[5] = manualPoint(100, 200);
  document.people.push(second);
  const saved = JSON.parse(JSON.stringify(ensurePose3DDocument(document, second.id)));
  const restored = ensurePose3DDocument(saved, personId);
  assert.ok(Math.abs(restored.pose3d!.body25[5]!.x + 0.2) < 1e-8);
  assert.deepEqual(restored.people, saved.people);
  assert.equal(saved.pose3d.personId, second.id);
  assert.equal(restored.pose3d!.personId, personId);
  assert.equal(markPose3DStale(saved).pose3d!.personId, second.id);
  assert.throws(() => validatePoseDocument({ ...saved, pose3d: { ...saved.pose3d, personId: 'not-a-uuid' } }));
  assert.throws(() => projectPose3DToDocument(saved, saved.pose3d, personId), /人物/);
  const wrongTarget = solvePose3DChain(saved, personId, 'left-arm', { x: 0, y: 0, z: 0 });
  assert.equal(wrongTarget.status, 'invalid');
  assert.deepEqual(wrongTarget.document, saved);
  const reused = ensurePose3DDocument(saved, second.id);
  assert.deepEqual(reused.pose3d, saved.pose3d);
});

test('旧版未绑定的多人物骨架按当前人物重建', () => {
  const document = createDocument();
  const legacy = createPose3DFromDocument(document, personId);
  Reflect.deleteProperty(legacy, 'personId');
  legacy.body25[5]!.x = 1;
  document.pose3d = legacy;
  const single = ensurePose3DDocument(document, personId);
  assert.equal(single.pose3d!.body25[5]!.x, 1);
  const second = structuredClone(document.people[0]);
  second.id = '00000000-0000-4000-8000-000000000002';
  document.people.push(second);
  assert.ok(Math.abs(ensurePose3DDocument(document, personId).pose3d!.body25[5]!.x + 0.2) < 1e-8);
});

test('双腿 IK 让对应脚趾脚跟按实际脚踝位移随动，包括不可达目标', () => {
  for (const side of ['left', 'right'] as const) {
    for (const distance of [0.1, 3]) {
      let document = createDocument();
      for (const index of [15, 16]) document = setPosePoint(document, { personId, group: 'body', index }, manualPoint(500, 950));
      for (let index = 0; index < 6; index++) document = setPosePoint(document, { personId, group: 'feet', index }, manualPoint(510 + index, 960));
      document = ensurePose3DDocument(document, personId);
      const chainId = `${side}-leg` as const;
      const ankleIndex = side === 'left' ? 14 : 11;
      const footIndices = side === 'left' ? [19, 20, 21] : [22, 23, 24];
      const before = document.pose3d!;
      const ankle = before.body25[ankleIndex]!;
      const result = solvePose3DChain(document, personId, chainId, { x: ankle.x + distance, y: ankle.y, z: 0.1 });
      assert.notEqual(result.status, 'invalid');
      if (distance === 3) assert.equal(result.status, 'unreachable');
      const after = result.document.pose3d!;
      assert.notEqual(after.body25[ankleIndex]!.x, ankle.x);
      for (let index = 19; index < 25; index++) {
        if (!footIndices.includes(index)) {
          assert.deepEqual(after.body25[index], before.body25[index]);
          continue;
        }
        for (const axis of ['x', 'y', 'z'] as const) {
          const delta = after.body25[ankleIndex]![axis] - ankle[axis];
          assert.ok(Math.abs(after.body25[index]![axis] - before.body25[index]![axis] - delta) < 1e-8);
        }
      }
    }
  }
});

test('BODY-25 面部连线遵循鼻子、双眼、双耳拓扑', () => {
  assert.deepEqual(BODY25_CONNECTIONS.filter(([a, b]) => (a >= 15 && a <= 18) || (b >= 15 && b <= 18)), [
    [0, 15], [15, 17], [0, 16], [16, 18],
  ]);
});

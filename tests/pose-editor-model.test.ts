import assert from "node:assert/strict";
import {
  createEmptyPoseDocument,
  getPosePoint,
  hasEditableSkeletonSource,
  mirrorPoseDocument,
  movePosePoint,
  screenToPosePoint,
  setPosePoint,
  addPosePerson,
  removePosePerson,
} from "../src/lib/poseEditorModel";
import type { PosePointPath, PosePointV1 } from "../src/lib/poseEditorModel";

const image = "/api/files/editor-source.png";
const personId = "00000000-0000-4000-8000-000000000001";
const createDocument = () => createEmptyPoseDocument({
  image,
  width: 1600,
  height: 900,
  idFactory: () => personId,
});
const manualPoint = (x: number, y: number): PosePointV1 => ({ x, y, confidence: 1, origin: "manual" });
const path = (group: PosePointPath["group"], index?: number): PosePointPath =>
  group === "neck" || group === "midHip"
    ? { personId, group }
    : { personId, group, index: index! };

function test(name: string, run: () => void): void {
  run();
  console.log(`  ✓ ${name}`);
}

console.log("姿势编辑器数据操作测试");

test("手动空姿势使用固定拓扑、完整点槽和本地图片来源", () => {
  const document = createDocument();
  assert.equal(document.version, 1);
  assert.deepEqual(document.canvas, { width: 1600, height: 900 });
  assert.equal(document.source.kind, "manual");
  assert.equal(document.source.analysisImage, image);
  assert.equal(document.imageBinding, image);
  assert.equal(document.people.length, 1);
  assert.equal(document.people[0].body.length, 17);
  assert.equal(document.people[0].feet.length, 6);
  assert.equal(document.people[0].face.length, 70);
  assert.equal(document.people[0].hands.left.length, 21);
  assert.equal(document.people[0].hands.right.length, 21);
  assert.ok(document.people[0].body.every((point) => point === null));
});

test("人物增删保持拓扑与至少一个人物约束", () => {
  let nextId = 2;
  const idFactory = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
  let document = addPosePerson(createDocument(), idFactory);
  assert.equal(document.people.length, 2);
  assert.equal(document.people[1].body.length, 17);
  for (let index = 0; index < 6; index += 1) document = addPosePerson(document, idFactory);
  assert.equal(document.people.length, 8);
  assert.throws(() => addPosePerson(document, idFactory), /最多支持 8 个姿势人物/);
  const withoutSecond = removePosePerson(document, personId);
  assert.equal(withoutSecond.people.length, 7);
  assert.equal(withoutSecond.people.some((person) => person.id === personId), false);
  assert.throws(() => removePosePerson(createDocument(), personId), /至少保留一个姿势人物/);
});


test("编辑关节点将补点标记为人工点并保留其他数据", () => {
  const initial = createDocument();
  const next = setPosePoint(initial, path("body", 5), manualPoint(220, 260));
  assert.deepEqual(getPosePoint(next, path("body", 5)), manualPoint(220, 260));
  assert.equal(getPosePoint(initial, path("body", 5)), null);
  assert.equal(next.people[0].body[4], null);
});

test("拖动手腕按同一位移带动同侧已有手部点，不虚构缺失点", () => {
  const initial = createDocument();
  const withPoints = [
    [path("body", 9), manualPoint(300, 400)],
    [path("leftHand", 0), manualPoint(320, 410)],
    [path("leftHand", 1), manualPoint(325, 415)],
    [path("rightHand", 0), manualPoint(900, 400)],
  ] as const;
  const seeded = withPoints.reduce(
    (document, [pointPath, point]) => setPosePoint(document, pointPath, point),
    initial,
  );
  const moved = movePosePoint(seeded, path("body", 9), 12, -8);
  assert.deepEqual(getPosePoint(moved, path("body", 9)), manualPoint(312, 392));
  assert.deepEqual(getPosePoint(moved, path("leftHand", 0)), manualPoint(332, 402));
  assert.deepEqual(getPosePoint(moved, path("leftHand", 1)), manualPoint(337, 407));
  assert.deepEqual(getPosePoint(moved, path("rightHand", 0)), manualPoint(900, 400));
});

test("镜像反转图像坐标并交换身体、足部、面部和左右手语义", () => {
  const initial = createDocument();
  const seeded = [
    [path("body", 5), manualPoint(200, 100)],
    [path("body", 6), manualPoint(1400, 120)],
    [path("feet", 0), manualPoint(300, 800)],
    [path("feet", 3), manualPoint(1300, 810)],
    [path("face", 36), manualPoint(400, 150)],
    [path("face", 45), manualPoint(1200, 155)],
    [path("leftHand", 4), manualPoint(250, 300)],
    [path("rightHand", 4), manualPoint(1350, 305)],
  ] as const;
  const source = seeded.reduce(
    (document, [pointPath, point]) => setPosePoint(document, pointPath, point),
    initial,
  );
  const mirrored = mirrorPoseDocument(source);
  assert.deepEqual(getPosePoint(mirrored, path("body", 5)), manualPoint(200, 120));
  assert.deepEqual(getPosePoint(mirrored, path("body", 6)), manualPoint(1400, 100));
  assert.deepEqual(getPosePoint(mirrored, path("feet", 0)), manualPoint(300, 810));
  assert.deepEqual(getPosePoint(mirrored, path("feet", 3)), manualPoint(1300, 800));
  assert.deepEqual(getPosePoint(mirrored, path("face", 36)), manualPoint(400, 155));
  assert.deepEqual(getPosePoint(mirrored, path("face", 45)), manualPoint(1200, 150));
  assert.deepEqual(getPosePoint(mirrored, path("leftHand", 4)), manualPoint(250, 305));
  assert.deepEqual(getPosePoint(mirrored, path("rightHand", 4)), manualPoint(1350, 300));
});

test("画布坐标变换适配 letterbox、缩放和平移，并拒绝画布外点", () => {
  const point = screenToPosePoint({
    clientX: 500,
    clientY: 250,
    rect: { left: 0, top: 0, width: 1000, height: 500 },
    canvas: { width: 1600, height: 900 },
    zoom: 1,
    pan: { x: 0, y: 0 },
  });
  assert.ok(point);
  assert.ok(Math.abs(point.x - 800) < 0.001);
  assert.ok(Math.abs(point.y - 450) < 0.001);
  assert.equal(screenToPosePoint({
    clientX: 2,
    clientY: 250,
    rect: { left: 0, top: 0, width: 1000, height: 500 },
    canvas: { width: 1600, height: 900 },
    zoom: 1,
    pan: { x: 0, y: 0 },
  }), null);
});

test("只有与图片引用绑定的有效 skeleton 标记提供骨骼编辑入口", () => {
  assert.equal(hasEditableSkeletonSource(image, { kind: "skeleton", image }), true);
  assert.equal(hasEditableSkeletonSource(image, { kind: "depth", image }), false);
  assert.equal(hasEditableSkeletonSource(image, { kind: "skeleton", image: "/api/files/other.png" }), false);
  assert.equal(hasEditableSkeletonSource(image, undefined), false);
  assert.equal(hasEditableSkeletonSource("https://example.invalid/image.png", { kind: "skeleton", image: "https://example.invalid/image.png" }), false);
});

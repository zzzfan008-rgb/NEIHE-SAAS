import assert from 'node:assert/strict';
import {
  BODY_18_TO_COCO_17,
  BODY_25_TO_COCO_17,
  POSE_PALETTE,
  canvasToNormalized,
  exportOpenPoseJson,
  importOpenPoseJson,
  normalizedToCanvas,
  poseDocumentFromDWPose,
  validatePoseDocument,
} from '../src/lib/poseTopology';
import type { DWPosePoseV1 } from '../src/types/poseReference';
import type { PoseDocumentV1 } from '../src/types/poseDocument';

const image = '/api/files/pose-source.png';
const id = '00000000-0000-4000-8000-000000000001';
const idFactory = () => id;
const emptyDWPose = (): DWPosePoseV1 => ({
  schemaVersion: 1,
  canvas: { width: 30, height: 50 },
  people: [{ keypoints: Array.from({ length: 133 }, () => null) }],
});
const triple = (x = 0, y = 0, confidence = 0) => [x, y, confidence];
const openPosePerson = (bodyCount: 18 | 25, face: number[] = [], left: number[] = [], right: number[] = []) => ({
  pose_keypoints_2d: Array.from({ length: bodyCount }, (_, index) => triple(index, index + 1, 0.9)).flat(),
  face_keypoints_2d: face,
  hand_left_keypoints_2d: left,
  hand_right_keypoints_2d: right,
});

const source = { analysisImage: image, kind: 'image' as const, model: 'dwpose-wholebody', checkpoint: 'a'.repeat(64), recordId: id };
const detected = poseDocumentFromDWPose(emptyDWPose(), { source, imageBinding: image, idFactory });
assert.equal(detected.canvas.width, 30);
assert.equal(detected.people[0].body.length, 17);
assert.equal(detected.people[0].feet.length, 6);
assert.equal(detected.people[0].face.length, 70);
assert.equal(detected.people[0].hands.left.length, 21);
assert.equal(detected.people[0].hands.right.length, 21);
assert.equal(detected.people[0].topology, 'coco-wholebody-133');
assert.equal(detected.people[0].faceTopology, 'face68');
assert.equal(detected.people[0].face[68], null);
assert.equal(detected.people[0].face[69], null);

const raw = emptyDWPose();
raw.people[0].keypoints[0] = { x: 0.5, y: 0.4, confidence: 0.85 };
raw.people[0].keypoints[5] = { x: 0.4, y: 0.3, confidence: 0.8 };
raw.people[0].keypoints[6] = { x: 0.6, y: 0.3, confidence: 0.7 };
raw.people[0].keypoints[11] = { x: 0.45, y: 0.7, confidence: 0.9 };
raw.people[0].keypoints[12] = { x: 0.55, y: 0.7, confidence: 0.8 };
const mapped = poseDocumentFromDWPose(raw, { source, imageBinding: image, idFactory });
assert.deepEqual(mapped.people[0].body[0], { x: 15, y: 20, confidence: 0.85, origin: 'detected' });
assert.deepEqual(mapped.people[0].neck, { x: 15, y: 15, confidence: 0.7, origin: 'detected' });
assert.deepEqual(mapped.people[0].midHip, { x: 15, y: 35, confidence: 0.8, origin: 'detected' });
assert.deepEqual(canvasToNormalized(normalizedToCanvas({ x: 0.5, y: 0.4, confidence: 0.85 }, 30, 50), 30, 50), {
  x: 0.5, y: 0.4, confidence: 0.85,
});

const face68 = Array.from({ length: 68 }, (_, index) => triple(index % 30, index % 50, 0.8)).flat();
const hand21 = Array.from({ length: 21 }, (_, index) => triple(index + 3, index + 4, 0.75)).flat();
const imported25 = importOpenPoseJson({
  canvas_width: 30,
  canvas_height: 50,
  people: [openPosePerson(25, face68, hand21, hand21)],
}, { analysisImage: image, imageBinding: image, idFactory });
const person25 = imported25.people[0];
assert.equal(person25.topology, 'openpose-body-25');
assert.deepEqual(BODY_25_TO_COCO_17, [0, 16, 15, 18, 17, 5, 2, 6, 3, 7, 4, 12, 9, 13, 10, 14, 11]);
assert.deepEqual(person25.body[1], { x: 16, y: 17, confidence: 0.9, origin: 'detected' });
assert.deepEqual(person25.neck, { x: 1, y: 2, confidence: 0.9, origin: 'detected' });
assert.deepEqual(person25.midHip, { x: 8, y: 9, confidence: 0.9, origin: 'detected' });
assert.equal(person25.feet.length, 6);
assert.deepEqual(person25.feet[0], { x: 19, y: 20, confidence: 0.9, origin: 'detected' });
assert.equal(person25.face.length, 70);
assert.equal(person25.faceTopology, 'face68');
assert.equal(person25.face[68], null);
assert.equal(person25.hands.left.length, 21);

const body18 = Array.from({ length: 18 }, (_, index) => triple(index + 1, index + 2, 0.9)).flat();
const imported18 = importOpenPoseJson({
  canvas_width: 30,
  canvas_height: 50,
  people: [openPosePerson(18, [], [], []), { pose_keypoints_2d: body18 }],
}, { analysisImage: image, imageBinding: image, idFactory: (() => {
  let next = 1;
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`;
})() });
assert.equal(imported18.people.length, 2);
assert.equal(imported18.people[0].topology, 'openpose-body-18');
assert.deepEqual(BODY_18_TO_COCO_17, [0, 15, 14, 17, 16, 5, 2, 6, 3, 7, 4, 11, 8, 12, 9, 13, 10]);
assert.equal(imported18.people[0].neck?.x, 1);
assert.deepEqual(imported18.people[0].feet, Array.from({ length: 6 }, () => null));
assert.equal(imported18.people[0].face.length, 70);
assert.equal(imported18.people[0].hands.right.length, 21);

const exported = exportOpenPoseJson(imported25);
assert.equal(exported.canvas_width, 30);
assert.equal(exported.people[0].pose_keypoints_2d.length, 75);
assert.equal(exported.people[0].face_keypoints_2d.length, 210);
assert.equal(exported.people[0].hand_left_keypoints_2d.length, 63);
assert.deepEqual(exported.people[0].pose_keypoints_2d.slice(3, 6), [1, 2, 0.9]);
assert.deepEqual(exported.people[0].pose_keypoints_2d.slice(24, 27), [8, 9, 0.9]);
assert.deepEqual(exported.people[0].face_keypoints_2d.slice(-6), [0, 0, 0, 0, 0, 0]);

assert.equal(POSE_PALETTE.length, 18);
assert.doesNotThrow(() => validatePoseDocument(detected));
const invalid = structuredClone(detected) as PoseDocumentV1;
invalid.people[0].body[0] = { x: 31, y: 10, confidence: 1, origin: 'manual' };
assert.throws(() => validatePoseDocument(invalid), /坐标无效/);
assert.throws(() => importOpenPoseJson({
  canvas_width: 30, canvas_height: 50, people: [{ pose_keypoints_2d: [1, 2] }],
}, { analysisImage: image, imageBinding: image, idFactory }), /数组长度/);
assert.throws(() => importOpenPoseJson({
  canvas_width: 30, canvas_height: 50, people: [openPosePerson(25)],
}, { analysisImage: 'https://example.com/pose.png', imageBinding: null, idFactory }), /本地/);
console.log('Pose topology: DWPose/OpenPose mapping, fixed slots, coordinate transforms, export and validation passed');

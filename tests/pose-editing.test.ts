import assert from 'node:assert/strict';
import sharp from 'sharp';
import { renderPoseDocument } from '../server/lib/poseEditing';
import { validateImageDataUrl } from '../server/lib/imageValidation';
import type { PoseDocumentV1, PosePersonV1 } from '../src/types/poseDocument';

const point = (x: number, y: number) => ({ x, y, confidence: 1, origin: 'manual' as const });
const person: PosePersonV1 = {
  id: '00000000-0000-4000-8000-000000000001',
  topology: 'coco-wholebody-133',
  neck: point(15, 10),
  midHip: point(15, 30),
  body: Array.from({ length: 17 }, () => null),
  feet: Array.from({ length: 6 }, () => null),
  face: Array.from({ length: 70 }, () => null),
  faceTopology: 'face68',
  hands: { left: Array.from({ length: 21 }, () => null), right: Array.from({ length: 21 }, () => null) },
};
person.body[5] = point(10, 12);
person.body[6] = point(20, 12);
person.body[11] = point(12, 30);
person.body[12] = point(18, 30);
person.body[13] = point(13, 40);
person.body[15] = point(12, 48);
person.feet[0] = point(10, 49);
person.hands.left[0] = point(5, 15);
person.hands.left[1] = point(4, 12);
person.face[0] = point(15, 5);
const document: PoseDocumentV1 = {
  version: 1,
  canvas: { width: 30, height: 50 },
  people: [person],
  source: { analysisImage: '/api/files/source.png', kind: 'manual', model: 'manual' },
  imageBinding: '/api/files/source.png',
};

const rendered = await renderPoseDocument(document);
assert.match(rendered.image, /^data:image\/png;base64,/);
assert.equal(rendered.poseDocument.imageBinding, null);
assert.equal(rendered.poseDocument.source.analysisImage, '/api/files/source.png');
const { buffer } = validateImageDataUrl(rendered.image);
const metadata = await sharp(buffer).metadata();
assert.deepEqual({ width: metadata.width, height: metadata.height, format: metadata.format }, { width: 30, height: 50, format: 'png' });
const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
assert.ok(Array.from({ length: info.width * info.height }, (_, index) => data[index * 4 + 3]).some((alpha) => alpha > 0), 'rendered skeleton must contain visible pixels');
await assert.rejects(() => renderPoseDocument({ ...document, imageBinding: 'https://example.com/image.png' }), /本地/);
console.log('Pose renderer: validated transparent skeleton preview and cleared image binding passed');

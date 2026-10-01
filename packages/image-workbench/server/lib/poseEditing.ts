import sharp from 'sharp';
import {
  BODY_CONNECTIONS,
  FOOT_CONNECTIONS,
  HAND_CONNECTIONS,
  POSE_PALETTE,
  validatePoseDocument,
} from '../../src/lib/poseTopology';
import type { PoseDocumentV1, PosePersonV1, PosePointV1 } from '../../src/types/poseDocument';

const MAX_RENDERED_IMAGE_BYTES = 20 * 1024 * 1024;

function line(a: PosePointV1, b: PosePointV1, color: string, width: number): string {
  if (!a || !b) return '';
  return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
}

function dot(point: PosePointV1, color: string, radius: number): string {
  if (!point) return '';
  return `<circle cx="${point.x}" cy="${point.y}" r="${radius}" fill="${color}"/>`;
}

function renderPerson(person: PosePersonV1, strokeWidth: number, radius: number): string {
  const parts: string[] = [];
  BODY_CONNECTIONS.forEach(([a, b], index) => parts.push(line(person.body[a], person.body[b], POSE_PALETTE[index], strokeWidth)));
  FOOT_CONNECTIONS.forEach(([ankle, foot], index) => parts.push(line(person.body[ankle], person.feet[foot], POSE_PALETTE[(index + 10) % POSE_PALETTE.length], strokeWidth)));
  person.hands.left.forEach((point, index) => parts.push(dot(point, POSE_PALETTE[index % POSE_PALETTE.length], radius)));
  person.hands.right.forEach((point, index) => parts.push(dot(point, POSE_PALETTE[(index + 6) % POSE_PALETTE.length], radius)));
  HAND_CONNECTIONS.forEach(([a, b], index) => {
    parts.push(line(person.hands.left[a], person.hands.left[b], POSE_PALETTE[index % POSE_PALETTE.length], Math.max(1, strokeWidth * 0.65)));
    parts.push(line(person.hands.right[a], person.hands.right[b], POSE_PALETTE[(index + 6) % POSE_PALETTE.length], Math.max(1, strokeWidth * 0.65)));
  });
  person.face.forEach((point) => parts.push(dot(point, '#ffffff', Math.max(1, radius * 0.65))));
  person.body.forEach((point, index) => parts.push(dot(point, POSE_PALETTE[index % POSE_PALETTE.length], radius)));
  parts.push(dot(person.neck, '#ffffff', radius));
  parts.push(dot(person.midHip, '#ffffff', radius));
  return parts.join('');
}

export async function renderPoseDocument(value: unknown): Promise<{ image: string; poseDocument: PoseDocumentV1 }> {
  const poseDocument = validatePoseDocument(value);
  const { width, height } = poseDocument.canvas;
  const strokeWidth = Math.max(1.5, Math.min(width, height) * 0.006);
  const radius = Math.max(2, Math.min(width, height) * 0.009);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${poseDocument.people.map((person) => renderPerson(person, strokeWidth, radius)).join('')}</svg>`;
  const image = await sharp(Buffer.from(svg), { limitInputPixels: 40_000_000 }).png().toBuffer();
  if (!image.length || image.length > MAX_RENDERED_IMAGE_BYTES) throw new Error('姿势预览图超过大小限制');
  return {
    image: `data:image/png;base64,${image.toString('base64')}`,
    poseDocument: { ...poseDocument, imageBinding: null },
  };
}

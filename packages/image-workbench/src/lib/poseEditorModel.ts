import type { PoseDocumentV1, PosePersonV1, PosePointV1 } from "../types/poseDocument";
import { validatePoseDocument } from "./poseTopology";
import { validPoseReferenceSource } from "../types/poseReference";

export type PosePointPath =
  | { personId: string; group: "neck" }
  | { personId: string; group: "midHip" }
  | { personId: string; group: "body"; index: number }
  | { personId: string; group: "feet"; index: number }
  | { personId: string; group: "face"; index: number }
  | { personId: string; group: "leftHand"; index: number }
  | { personId: string; group: "rightHand"; index: number };


export interface PoseEditorViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}


const BODY_MIRROR = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15] as const;
const FOOT_MIRROR = [3, 4, 5, 0, 1, 2] as const;
const HAND_MIRROR = Array.from({ length: 21 }, (_, index) => index);

function faceMirrorMap(faceTopology: "face68" | "face70" | undefined): number[] {
  const indices = Array.from({ length: 70 }, (_, index) => index);
  const pair = (left: number, right: number) => {
    indices[left] = right;
    indices[right] = left;
  };

  for (let index = 0; index <= 8; index += 1) pair(index, 16 - index);
  for (let index = 0; index <= 4; index += 1) pair(17 + index, 26 - index);
  pair(31, 35);
  pair(32, 34);
  pair(36, 45);
  pair(37, 44);
  pair(38, 43);
  pair(39, 42);
  pair(40, 47);
  pair(41, 46);
  pair(48, 54);
  pair(49, 53);
  pair(50, 52);
  pair(55, 59);
  pair(56, 58);
  pair(60, 64);
  pair(61, 63);
  pair(65, 67);
  if (faceTopology !== "face68") pair(68, 69);
  return indices;
}

function reflectedPoint(point: PosePointV1, width: number): PosePointV1 {
  return point === null ? null : {
    x: width - point.x,
    y: point.y,
    confidence: 1,
    origin: "manual",
  };
}

function mirrorPoints(points: PosePointV1[], indices: readonly number[], width: number): PosePointV1[] {
  return indices.map((sourceIndex) => reflectedPoint(points[sourceIndex], width));
}

function findPerson(document: PoseDocumentV1, personId: string): PosePersonV1 {
  const person = document.people.find((candidate) => candidate.id === personId);
  if (!person) throw new Error("姿势人物不存在");
  return person;
}

function pointAt(person: PosePersonV1, path: PosePointPath): PosePointV1 {
  if (path.group === "neck" || path.group === "midHip") return person[path.group];
  const collection = path.group === "leftHand"
    ? person.hands.left
    : path.group === "rightHand"
      ? person.hands.right
      : person[path.group];
  if (!Number.isInteger(path.index) || path.index < 0 || path.index >= collection.length) {
    throw new Error("姿势关键点索引无效");
  }
  return collection[path.index];
}

function updatePoint(
  document: PoseDocumentV1,
  path: PosePointPath,
  update: (current: PosePointV1) => PosePointV1,
): PoseDocumentV1 {
  const source = validatePoseDocument(document);
  let found = false;
  const people = source.people.map((person) => {
    if (person.id !== path.personId) return person;
    found = true;
    if (path.group === "neck" || path.group === "midHip") {
      return { ...person, [path.group]: update(person[path.group]) };
    }
    if (path.group === "leftHand" || path.group === "rightHand") {
      const side = path.group === "leftHand" ? "left" : "right";
      const points = person.hands[side].slice();
      if (!Number.isInteger(path.index) || path.index < 0 || path.index >= points.length) {
        throw new Error("姿势关键点索引无效");
      }
      points[path.index] = update(points[path.index]);
      return { ...person, hands: { ...person.hands, [side]: points } };
    }
    const points = person[path.group].slice();
    if (!Number.isInteger(path.index) || path.index < 0 || path.index >= points.length) {
      throw new Error("姿势关键点索引无效");
    }
    points[path.index] = update(points[path.index]);
    return { ...person, [path.group]: points };
  });
  if (!found) throw new Error("姿势人物不存在");
  return validatePoseDocument({ ...source, people });
}

function manualPoint(x: number, y: number): PosePointV1 {
  return { x, y, confidence: 1, origin: "manual" };
}

export function createEmptyPoseDocument(options: {
  image: string;
  width: number;
  height: number;
  idFactory?: () => string;
}): PoseDocumentV1 {
  const { image, width, height } = options;
  const idFactory = options.idFactory ?? (() => {
    if (typeof globalThis.crypto?.randomUUID !== "function") {
      throw new Error("当前环境无法生成姿势人物标识");
    }
    return globalThis.crypto.randomUUID();
  });
  const emptyPoints = (length: number) => Array.from({ length }, () => null);
  return validatePoseDocument({
    version: 1,
    canvas: { width, height },
    people: [{
      id: idFactory(),
      topology: "coco-wholebody-133",
      neck: null,
      midHip: null,
      body: emptyPoints(17),
      feet: emptyPoints(6),
      face: emptyPoints(70),
      faceTopology: "face70",
      hands: { left: emptyPoints(21), right: emptyPoints(21) },
    }],
    source: { analysisImage: image, kind: "manual", model: "manual" },
    imageBinding: image,
  });
}
export function hasEditableSkeletonSource(image: unknown, source: unknown): boolean {
  return typeof image === "string" &&
    /^\/api\/files\/[\w.-]+$/.test(image) &&
    validPoseReferenceSource(source, image) &&
    source.kind === "skeleton";
}


export function getPosePoint(value: unknown, path: PosePointPath): PosePointV1 {
  const document = validatePoseDocument(value);
  return pointAt(findPerson(document, path.personId), path);
}

export function addPosePerson(value: unknown, idFactory?: () => string): PoseDocumentV1 {
  const document = validatePoseDocument(value);
  if (document.people.length >= 8) throw new Error("最多支持 8 个姿势人物");
  const template = createEmptyPoseDocument({
    image: document.source.analysisImage,
    width: document.canvas.width,
    height: document.canvas.height,
    ...(idFactory ? { idFactory } : {}),
  });
  return validatePoseDocument({ ...document, people: [...document.people, template.people[0]] });
}

export function removePosePerson(value: unknown, personId: string): PoseDocumentV1 {
  const document = validatePoseDocument(value);
  if (document.people.length <= 1) throw new Error("至少保留一个姿势人物");
  const people = document.people.filter((person) => person.id !== personId);
  if (people.length === document.people.length) throw new Error("姿势人物不存在");
  return validatePoseDocument({ ...document, people });
}

export function setPosePoint(value: unknown, path: PosePointPath, point: PosePointV1): PoseDocumentV1 {
  const nextPoint = point === null ? null : { ...point };
  return updatePoint(validatePoseDocument(value), path, () => nextPoint);
}

export function movePosePoint(value: unknown, path: PosePointPath, dx: number, dy: number): PoseDocumentV1 {
  if (![dx, dy].every(Number.isFinite)) throw new Error("姿势关键点位移无效");
  const document = validatePoseDocument(value);
  const current = pointAt(findPerson(document, path.personId), path);
  if (!current) throw new Error("无法拖动尚未设置的姿势关键点");
  const moved = updatePoint(document, path, (point) => point === null
    ? null
    : manualPoint(
      Math.max(0, Math.min(document.canvas.width, point.x + dx)),
      Math.max(0, Math.min(document.canvas.height, point.y + dy)),
    ));
  if (path.group !== "body" || (path.index !== 9 && path.index !== 10)) return moved;

  const side = path.index === 9 ? "left" : "right";
  const handPathGroup = side === "left" ? "leftHand" : "rightHand";
  const person = findPerson(moved, path.personId);
  return person.hands[side].reduce((next, handPoint, index) => {
    if (!handPoint) return next;
    return updatePoint(next, { personId: path.personId, group: handPathGroup, index }, (point) => point === null
      ? null
      : manualPoint(
        Math.max(0, Math.min(document.canvas.width, point.x + dx)),
        Math.max(0, Math.min(document.canvas.height, point.y + dy)),
      ));
  }, moved);
}

export function mirrorPoseDocument(value: unknown): PoseDocumentV1 {
  const document = validatePoseDocument(value);
  const width = document.canvas.width;
  const people = document.people.map((person) => ({
    ...person,
    neck: reflectedPoint(person.neck, width),
    midHip: reflectedPoint(person.midHip, width),
    body: mirrorPoints(person.body, BODY_MIRROR, width),
    feet: mirrorPoints(person.feet, FOOT_MIRROR, width),
    face: mirrorPoints(person.face, faceMirrorMap(person.faceTopology), width),
    hands: {
      left: mirrorPoints(person.hands.right, HAND_MIRROR, width),
      right: mirrorPoints(person.hands.left, HAND_MIRROR, width),
    },
  }));
  const pose3d = document.pose3d ? { ...document.pose3d, stale: true } : undefined;
  return validatePoseDocument({
    ...document,
    people,
    ...(pose3d ? { pose3d } : {}),
  });
}

export function screenToPosePoint(options: {
  clientX: number;
  clientY: number;
  rect: PoseEditorViewport;
  canvas: { width: number; height: number };
  zoom: number;
  pan: { x: number; y: number };
}): { x: number; y: number } | null {
  const { clientX, clientY, rect, canvas, zoom, pan } = options;
  if (![clientX, clientY, rect.left, rect.top, rect.width, rect.height, canvas.width, canvas.height, zoom, pan.x, pan.y]
    .every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || canvas.width <= 0 || canvas.height <= 0 || zoom <= 0) {
    return null;
  }
  const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height) * zoom;
  const left = rect.left + (rect.width - canvas.width * scale) / 2 + pan.x;
  const top = rect.top + (rect.height - canvas.height * scale) / 2 + pan.y;
  const x = (clientX - left) / scale;
  const y = (clientY - top) / scale;
  if (x < 0 || y < 0 || x > canvas.width || y > canvas.height) return null;
  return { x, y };
}

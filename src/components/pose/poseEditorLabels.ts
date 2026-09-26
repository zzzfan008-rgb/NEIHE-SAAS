import type { PosePointPath } from "@/lib/poseEditorModel";

export type PoseEditorLayer = "body" | "hands" | "feet" | "face";
export type PoseEditorPointGroup = PosePointPath["group"];
export type PoseEditorGroupFilter = PoseEditorPointGroup | "all";

const BODY_LABELS = [
  "鼻", "左眼", "右眼", "左耳", "右耳", "左肩", "右肩", "左肘", "右肘", "左腕", "右腕", "左髋", "右髋", "左膝", "右膝", "左踝", "右踝",
];
const FOOT_LABELS = ["左脚大趾", "左脚小趾", "左脚跟", "右脚大趾", "右脚小趾", "右脚跟"];
const FACE_SEGMENTS: Array<{ start: number; end: number; label: string }> = [
  { start: 0, end: 16, label: "面部轮廓" },
  { start: 17, end: 21, label: "左眉" },
  { start: 22, end: 26, label: "右眉" },
  { start: 27, end: 35, label: "鼻部" },
  { start: 36, end: 41, label: "左眼" },
  { start: 42, end: 47, label: "右眼" },
  { start: 48, end: 59, label: "外唇" },
  { start: 60, end: 67, label: "内唇" },
  { start: 68, end: 68, label: "左瞳孔" },
  { start: 69, end: 69, label: "右瞳孔" },
];

export function posePointLayer(path: PosePointPath): PoseEditorLayer {
  if (path.group === "feet") return "feet";
  if (path.group === "face") return "face";
  if (path.group === "leftHand" || path.group === "rightHand") return "hands";
  return "body";
}

export function posePointLabel(path: PosePointPath): string {
  if (path.group === "neck") return "颈部中心";
  if (path.group === "midHip") return "骨盆中心";
  if (path.group === "leftHand" || path.group === "rightHand") {
    const side = path.group === "leftHand" ? "左手" : "右手";
    return `${side} ${path.index + 1} / 21`;
  }
  if (path.group === "body") return BODY_LABELS[path.index] ?? `身体点 ${path.index + 1}`;
  if (path.group === "feet") return FOOT_LABELS[path.index] ?? `脚部点 ${path.index + 1}`;
  const segment = FACE_SEGMENTS.find(({ start, end }) => path.index >= start && path.index <= end);
  if (!segment) return `人脸点 ${path.index + 1}`;
  if (segment.start === segment.end) return segment.label;
  return `${segment.label} ${path.index - segment.start + 1}`;
}

export function posePointOptions(
  personId: string,
  group: PoseEditorGroupFilter,
  faceCount = 68,
): Array<{ path: PosePointPath; label: string }> {
  const groups: PoseEditorPointGroup[] = group === "all"
    ? ["body", "neck", "midHip", "feet", "face", "leftHand", "rightHand"]
    : [group];
  const options: Array<{ path: PosePointPath; label: string }> = [];
  for (const pointGroup of groups) {
    if (pointGroup === "neck" || pointGroup === "midHip") {
      const path: PosePointPath = { personId, group: pointGroup };
      options.push({ path, label: posePointLabel(path) });
      continue;
    }
    const count = pointGroup === "body" ? BODY_LABELS.length
      : pointGroup === "feet" ? FOOT_LABELS.length
        : pointGroup === "face" ? faceCount
          : 21;
    for (let index = 0; index < count; index += 1) {
      const path: PosePointPath = { personId, group: pointGroup, index };
      options.push({ path, label: posePointLabel(path) });
    }
  }
  return options;
}

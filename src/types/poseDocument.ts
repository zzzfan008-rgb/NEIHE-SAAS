export type PosePointOriginV1 = 'detected' | 'manual';
export type PosePointV1 = {
  x: number;
  y: number;
  confidence: number;
  origin: PosePointOriginV1;
} | null;
export type PosePoint3DV1 = {
  x: number;
  y: number;
  z: number;
  confidence: number;
  origin: PosePointOriginV1;
} | null;
export type PoseTopologyV1 = 'coco-wholebody-133' | 'openpose-body-18' | 'openpose-body-25';
export type PoseSourceKindV1 = 'image' | 'depth' | 'openpose-json' | 'manual';

export interface PoseSourceV1 {
  analysisImage: string;
  kind: PoseSourceKindV1;
  model: string;
  checkpoint?: string;
  recordId?: string;
}

export interface PosePersonV1 {
  id: string;
  topology: PoseTopologyV1;
  neck: PosePointV1;
  midHip: PosePointV1;
  body: PosePointV1[];
  feet: PosePointV1[];
  face: PosePointV1[];
  faceTopology?: 'face68' | 'face70';
  hands: {
    left: PosePointV1[];
    right: PosePointV1[];
  };
}

export interface PoseCameraV1 {
  target: { x: number; y: number; z: number };
  yawDeg: number;
  pitchDeg: number;
  scale: number;
}

export interface Pose3DV1 {
  body25: PosePoint3DV1[];
  camera: PoseCameraV1;
  stale?: boolean;
}

export interface PoseDocumentV1 {
  version: 1;
  canvas: { width: number; height: number };
  people: PosePersonV1[];
  source: PoseSourceV1;
  imageBinding: string | null;
  pose3d?: Pose3DV1;
}

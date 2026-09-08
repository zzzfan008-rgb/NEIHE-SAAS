import type {
  SeedanceOutputFormat,
  SeedanceVideoModelId,
  VideoAspectRatio,
  VideoGenerationMode,
  VideoResolution,
} from "../types/workflow";

export const SEEDANCE_VIDEO_MODELS = [
  "doubao-seedance-2-5-260628",
  "doubao-seedance-2-0-260128",
  "doubao-seedance-2-0-fast-260128",
  "doubao-seedance-2-0-mini-260615",
] as const satisfies readonly SeedanceVideoModelId[];

export const SEEDANCE_VIDEO_MODES = [
  "text-to-video",
  "first-frame-to-video",
  "keyframes-to-video",
  "multimodal-reference",
  "video-edit",
  "video-extend",
] as const satisfies readonly VideoGenerationMode[];

export const SEEDANCE_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export const SEEDANCE_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"] as const;
export const SEEDANCE_OUTPUT_FORMATS = ["mp4", "mov"] as const satisfies readonly SeedanceOutputFormat[];

export interface SeedanceModelCapability {
  label: string;
  maxDuration: number;
  maxImages: number;
  maxVideos: number;
  maxAudios: number;
  supports1080p: boolean;
  supportsAudioOnly: boolean;
  supportsEdit: boolean;
  supportsMov: boolean;
}

export const SEEDANCE_MODEL_CAPABILITIES: Readonly<Record<SeedanceVideoModelId, SeedanceModelCapability>> = {
  "doubao-seedance-2-5-260628": {
    label: "Seedance 2.5",
    maxDuration: 30,
    maxImages: 30,
    maxVideos: 10,
    maxAudios: 10,
    supports1080p: true,
    supportsAudioOnly: true,
    supportsEdit: true,
    supportsMov: true,
  },
  "doubao-seedance-2-0-260128": {
    label: "Seedance 2.0 标准版",
    maxDuration: 15,
    maxImages: 9,
    maxVideos: 3,
    maxAudios: 3,
    supports1080p: true,
    supportsAudioOnly: false,
    supportsEdit: false,
    supportsMov: false,
  },
  "doubao-seedance-2-0-fast-260128": {
    label: "Seedance 2.0 Fast",
    maxDuration: 15,
    maxImages: 9,
    maxVideos: 3,
    maxAudios: 3,
    supports1080p: false,
    supportsAudioOnly: false,
    supportsEdit: false,
    supportsMov: false,
  },
  "doubao-seedance-2-0-mini-260615": {
    label: "Seedance 2.0 Mini",
    maxDuration: 15,
    maxImages: 9,
    maxVideos: 3,
    maxAudios: 3,
    supports1080p: false,
    supportsAudioOnly: false,
    supportsEdit: false,
    supportsMov: false,
  },
};

export function isSeedanceVideoModel(value: unknown): value is SeedanceVideoModelId {
  return SEEDANCE_VIDEO_MODELS.includes(value as SeedanceVideoModelId);
}

export function isSeedance25(model: SeedanceVideoModelId): boolean {
  return model === "doubao-seedance-2-5-260628";
}

export function seedanceModeRequiresAdaptive(model: SeedanceVideoModelId, mode: VideoGenerationMode): boolean {
  return isSeedance25(model) && [
    "first-frame-to-video",
    "keyframes-to-video",
    "video-edit",
    "video-extend",
  ].includes(mode);
}

export function seedanceModeSupported(model: SeedanceVideoModelId, mode: VideoGenerationMode): boolean {
  return mode !== "video-edit" && mode !== "video-extend"
    ? true
    : SEEDANCE_MODEL_CAPABILITIES[model].supportsEdit;
}

export function normalizedSeedanceSettings(input: {
  model: SeedanceVideoModelId;
  mode: VideoGenerationMode;
  resolution: VideoResolution;
  ratio: string;
  duration: number;
  outputFormat: SeedanceOutputFormat;
}): {
  model: SeedanceVideoModelId;
  mode: VideoGenerationMode;
  resolution: VideoResolution;
  ratio: VideoAspectRatio;
  duration: number;
  outputFormat: SeedanceOutputFormat;
} {
  const capability = SEEDANCE_MODEL_CAPABILITIES[input.model];
  const mode = seedanceModeSupported(input.model, input.mode) ? input.mode : "text-to-video";
  const ratio = SEEDANCE_RATIOS.includes(input.ratio as VideoAspectRatio)
    ? input.ratio as VideoAspectRatio
    : "adaptive";
  return {
    ...input,
    mode,
    resolution: input.resolution === "1080p" && !capability.supports1080p ? "720p" : input.resolution,
    ratio: seedanceModeRequiresAdaptive(input.model, mode) ? "adaptive" : ratio,
    duration: mode === "video-edit"
      ? -1
      : input.duration === -1 ? -1 : Math.min(capability.maxDuration, Math.max(4, input.duration)),
    outputFormat: capability.supportsMov ? input.outputFormat : "mp4",
  };
}

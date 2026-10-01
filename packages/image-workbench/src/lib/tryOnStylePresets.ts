export type TryOnQualityMode = "fast" | "balanced" | "best";

export interface TryOnStylePresetDefinition {
  id: string;
  name: string;
  description: string;
  prompt: string;
  referenceAsset?: string;
}

export const DEFAULT_TRY_ON_STYLE_PRESET_ID = "faithful";

export const BUILT_IN_TRY_ON_STYLE_PRESETS: readonly TryOnStylePresetDefinition[] = [
  {
    id: DEFAULT_TRY_ON_STYLE_PRESET_ID,
    name: "忠实还原",
    description: "服从场景参考的原始光线与色彩，不额外增加风格化。",
    prompt: "保持场景参考的真实光线、色彩和镜头质感，不增加额外滤镜或风格化处理。",
  },
  {
    id: "commerce",
    name: "高端电商",
    description: "均匀主光、干净层次和准确商品色彩。",
    prompt: "使用高端服装电商摄影质感：商品颜色准确、主光均匀、阴影柔和、材质层次清晰。",
    referenceAsset: "/assets/try-on-styles/commerce.webp",
  },
  {
    id: "soft-editorial",
    name: "柔光画报",
    description: "大面积柔光和克制的时装画报色调。",
    prompt: "使用克制的时装画报质感：大面积柔光、细腻肤色、低反差阴影和自然层次。",
    referenceAsset: "/assets/try-on-styles/soft-editorial.webp",
  },
  {
    id: "runway",
    name: "硬光秀场",
    description: "方向明确的硬光和清晰立体轮廓。",
    prompt: "使用现代秀场摄影质感：方向明确的硬光、清晰轮廓、受控高光和真实深阴影。",
    referenceAsset: "/assets/try-on-styles/runway.webp",
  },
  {
    id: "street",
    name: "自然街拍",
    description: "自然日光、真实环境反射和轻微抓拍感。",
    prompt: "使用自然街拍摄影质感：真实日光、环境反射、自然动态范围和轻微抓拍感。",
    referenceAsset: "/assets/try-on-styles/street.webp",
  },
  {
    id: "cinematic",
    name: "电影质感",
    description: "克制电影调色、层次化光影和自然颗粒。",
    prompt: "使用写实电影摄影质感：克制调色、层次化光影、自然高光过渡和极轻微胶片颗粒。",
    referenceAsset: "/assets/try-on-styles/cinematic.webp",
  },
] as const;

export function builtInTryOnStylePreset(id: string | undefined): TryOnStylePresetDefinition | undefined {
  return BUILT_IN_TRY_ON_STYLE_PRESETS.find((preset) => preset.id === id);
}

export function tryOnCandidateCount(
  stage: "scene-stabilize" | "garment-refine",
  mode: TryOnQualityMode,
): number {
  if (mode === "fast") return 1;
  if (mode === "balanced") return 2;
  return stage === "scene-stabilize" ? 3 : 2;
}

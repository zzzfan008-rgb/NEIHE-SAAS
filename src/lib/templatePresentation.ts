/**
 * Curated preview covers for built-in workflows. Keeping this map in code
 * gives the launcher and project center one consistent visual story without
 * changing the template API contract or relying on stale stored thumbnails.
 */
export const BUILTIN_TEMPLATE_COVERS: Record<string, string> = {
  "builtin-sketch-upscale": "/assets/project-center/templates/sketch-upscale.webp",
  "builtin-text-to-image": "/assets/project-center/templates/text-to-image.webp",
  "builtin-sketch-recolor": "/assets/project-center/templates/sketch-recolor.webp",
  "builtin-text-recolor": "/assets/project-center/templates/text-recolor.webp",
  "builtin-pattern-style-transfer": "/assets/project-center/templates/pattern-style-transfer.webp",
  "builtin-person-scene-transfer": "/assets/project-center/templates/person-scene-transfer.webp",
};

export interface PantoneColorReference {
  catalogId: string;
  releaseId: string;
  libraryKey: string;
  code: string;
  hex: `#${string}`;
}

export function pantoneColorKey(reference: Pick<PantoneColorReference, "catalogId">): string {
  return `pantone:${reference.catalogId}`;
}

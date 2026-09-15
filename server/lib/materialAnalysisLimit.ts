const MAX_ACTIVE_ANALYSES_PER_OWNER = 2;
const activeByOwner = new Map<string, number>();

export class MaterialAnalysisCapacityError extends Error {
  constructor() {
    super(`每个账号最多同时运行 ${MAX_ACTIVE_ANALYSES_PER_OWNER} 个材质分析`);
    this.name = "MaterialAnalysisCapacityError";
  }
}

export async function withMaterialAnalysisSlot<T>(
  ownerId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const active = activeByOwner.get(ownerId) ?? 0;
  if (active >= MAX_ACTIVE_ANALYSES_PER_OWNER)
    throw new MaterialAnalysisCapacityError();
  activeByOwner.set(ownerId, active + 1);
  try {
    return await operation();
  } finally {
    const remaining = (activeByOwner.get(ownerId) ?? 1) - 1;
    if (remaining > 0) activeByOwner.set(ownerId, remaining);
    else activeByOwner.delete(ownerId);
  }
}

import type { PoolClient } from "pg";
import { isLocalMediaReference } from "./fileStore";
import { query } from "./database";

export class ImageReferenceAccessError extends Error {
  constructor(message = "画布包含无权访问的图片，请重新选择图片后再试") {
    super(message);
    this.name = "ImageReferenceAccessError";
  }
}

function collectLocalImageIds(value: unknown, output = new Set<string>()): Set<string> {
  if (typeof value === "string" && value.startsWith("/api/files/")) {
    if (!isLocalMediaReference(value)) throw new ImageReferenceAccessError("本地媒体引用格式无效");
    output.add(value.slice("/api/files/".length));
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectLocalImageIds(item, output));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectLocalImageIds(item, output));
  }
  return output;
}

/**
 * Provider worker 会直接读取本地文件，因此在入队/保存边界复用文件路由的访问规则。
 * 缺失、已删除或属于其他用户且未共享的本地文件一律拒绝。
 */
export async function assertImageReferencesAccessible(
  value: unknown,
  userId: string,
  client?: PoolClient,
  options?: { fileLock?: "share" | "update" },
): Promise<void> {
  const ids = [...collectLocalImageIds(value)];
  if (ids.length === 0) return;
  const refs = ids.map((id) => `/api/files/${id}`);
  // 项目保存与运行授权都按 assets → files 取锁，避免多个引用交叉等待。
  const referencedAssets = await query<{ id: string; image: string; scope: "global" | "private" | "shared" }>(`
    SELECT id, image, scope FROM assets
    WHERE image = ANY($1::text[])
      AND deleted_at IS NULL
    ORDER BY id
    FOR SHARE
  `, [refs], client);
  const sharedRefs = new Set(
    referencedAssets
      .filter((row) => row.scope === "global" || row.scope === "shared")
      .map((row) => row.image),
  );
  // 项目保存随后会修改蒙版文件元数据，必须从一开始就按相同 id 顺序取得强锁；
  // 不能先 SHARE 再逐行升级，否则不同项目的交叉引用会形成锁升级死锁。
  const fileLock = options?.fileLock === "update" ? "FOR UPDATE" : "FOR SHARE";
  const rows = await query<{ id: string; owner_id: string | null }>(`
    SELECT f.id, f.owner_id
    FROM files f
    WHERE f.id = ANY($1::text[])
      AND f.deleted_at IS NULL
    ORDER BY f.id
    ${fileLock}
  `, [ids], client);
  if (rows.length !== ids.length) {
    throw new ImageReferenceAccessError();
  }
  if (rows.some((row) => (
    row.owner_id !== null &&
    row.owner_id !== userId &&
    !sharedRefs.has(`/api/files/${row.id}`)
  ))) {
    throw new ImageReferenceAccessError();
  }
}

import {
  validateDrawingDocument,
  type DrawingDocument,
} from "@/components/drawing/drawingModel";

export interface DrawingRecoveryDraft {
  ownerId: string;
  tabId: string;
  projectId: string;
  documentEpoch: number;
  nodeId: string;
  baseContentRef: string | null;
  baseContentHash: string | null;
  draftRevision: number;
  document: DrawingDocument;
  updatedAt: string;
}

export type DrawingDraftTarget = Pick<
  DrawingRecoveryDraft,
  "ownerId" | "tabId" | "projectId" | "documentEpoch" | "nodeId" | "baseContentRef" | "baseContentHash"
>;

export interface DrawingDraftBackend {
  get(key: string): Promise<DrawingRecoveryDraft | undefined>;
  put(key: string, draft: DrawingRecoveryDraft): Promise<void>;
  delete(key: string): Promise<void>;
  listOwner(ownerId: string): Promise<DrawingRecoveryDraft[]>;
}

export class DrawingDraftStorageError extends Error {
  constructor(message = "浏览器无法保存画板恢复草稿，请释放存储空间后重试") {
    super(message);
    this.name = "DrawingDraftStorageError";
  }
}

export function drawingDraftKey(target: Pick<DrawingRecoveryDraft, "ownerId" | "tabId" | "projectId" | "documentEpoch" | "nodeId">): string {
  return [target.ownerId, target.tabId, target.projectId, target.documentEpoch, target.nodeId].join("\u0000");
}

function validIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 200 && !value.includes("\u0000");
}

function validateDraft(draft: DrawingRecoveryDraft): void {
  if (![draft.ownerId, draft.tabId, draft.projectId, draft.nodeId].every(validIdentity)) {
    throw new DrawingDraftStorageError("画板恢复草稿的归属信息无效");
  }
  if (!Number.isSafeInteger(draft.documentEpoch) || draft.documentEpoch < 0 ||
      !Number.isSafeInteger(draft.draftRevision) || draft.draftRevision < 0) {
    throw new DrawingDraftStorageError("画板恢复草稿版本无效");
  }
  validateDrawingDocument(draft.document);
}

export function createDrawingDraftStore(backend: DrawingDraftBackend) {
  return {
    async save(draft: DrawingRecoveryDraft): Promise<void> {
      validateDraft(draft);
      try { await backend.put(drawingDraftKey(draft), structuredClone(draft)); }
      catch { throw new DrawingDraftStorageError(); }
    },
    async findRecovery(target: DrawingDraftTarget): Promise<{
      status: "matching" | "base-mismatch";
      draft: DrawingRecoveryDraft;
    } | null> {
      let draft: DrawingRecoveryDraft | undefined;
      try { draft = await backend.get(drawingDraftKey(target)); }
      catch { throw new DrawingDraftStorageError("浏览器暂时无法读取画板恢复草稿"); }
      if (!draft || draft.ownerId !== target.ownerId) return null;
      const matching = draft.baseContentRef === target.baseContentRef && draft.baseContentHash === target.baseContentHash;
      return { status: matching ? "matching" : "base-mismatch", draft };
    },
    async discard(target: Pick<DrawingRecoveryDraft, "ownerId" | "tabId" | "projectId" | "documentEpoch" | "nodeId">): Promise<void> {
      try { await backend.delete(drawingDraftKey(target)); }
      catch { throw new DrawingDraftStorageError("浏览器暂时无法删除画板恢复草稿"); }
    },
    async listOwner(ownerId: string): Promise<DrawingRecoveryDraft[]> {
      if (!validIdentity(ownerId)) return [];
      try { return (await backend.listOwner(ownerId)).map((draft) => structuredClone(draft)); }
      catch { throw new DrawingDraftStorageError("浏览器暂时无法读取画板恢复草稿"); }
    },
    async clearOwner(ownerId: string): Promise<void> {
      const drafts = await this.listOwner(ownerId);
      try { await Promise.all(drafts.map((draft) => backend.delete(drawingDraftKey(draft)))); }
      catch { throw new DrawingDraftStorageError("退出登录时未能完整清理画板恢复草稿"); }
    },
  };
}

export function createMemoryDrawingDraftBackend(options?: { failWrites?: boolean }): DrawingDraftBackend {
  const values = new Map<string, DrawingRecoveryDraft>();
  return {
    async get(key) { return values.get(key); },
    async put(key, draft) {
      if (options?.failWrites) throw new DOMException("quota", "QuotaExceededError");
      values.set(key, structuredClone(draft));
    },
    async delete(key) { values.delete(key); },
    async listOwner(ownerId) { return [...values.values()].filter((draft) => draft.ownerId === ownerId); },
  };
}

const DB_NAME = "garment-canvas-drawing-drafts";
const STORE_NAME = "drafts";
const OWNER_INDEX = "ownerId";

function openDraftDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.createObjectStore(STORE_NAME);
      store.createIndex(OWNER_INDEX, OWNER_INDEX, { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function createIndexedDbDrawingDraftBackend(factory: IDBFactory = indexedDB): DrawingDraftBackend {
  return {
    async get(key) {
      const database = await openDraftDatabase(factory);
      try { return await idbRequest(database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key)); }
      finally { database.close(); }
    },
    async put(key, draft) {
      const database = await openDraftDatabase(factory);
      try {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put(draft, key);
        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
      } finally { database.close(); }
    },
    async delete(key) {
      const database = await openDraftDatabase(factory);
      try { await idbRequest(database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(key)); }
      finally { database.close(); }
    },
    async listOwner(ownerId) {
      const database = await openDraftDatabase(factory);
      try {
        return await idbRequest(database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).index(OWNER_INDEX).getAll(ownerId));
      } finally { database.close(); }
    },
  };
}

export function browserDrawingDraftStore() {
  return createDrawingDraftStore(createIndexedDbDrawingDraftBackend());
}

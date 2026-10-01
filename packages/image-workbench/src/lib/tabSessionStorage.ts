export const PROJECT_TABS_STORAGE_KEY = "garment-canvas-project-tabs";
export const PROJECT_TAB_STORAGE_KEY_PREFIX = "garment-canvas-project-tab:";
export const PROJECT_TABS_STORAGE_SCHEMA_VERSION = 2 as const;

let projectTabSessionPersistenceSuspended = false;

/**
 * 当前页面已经解绑旧账号工作区；在整页重载前禁止任何 debounce/pagehide
 * 回调把旧内存草稿重新写回新 owner 的 sessionStorage。
 */
export function suspendProjectTabSessionPersistence(): void {
  projectTabSessionPersistenceSuspended = true;
}

export function isProjectTabSessionPersistenceSuspended(): boolean {
  return projectTabSessionPersistenceSuspended;
}

export interface ProjectTabsStorageManifest {
  schemaVersion: typeof PROJECT_TABS_STORAGE_SCHEMA_VERSION;
  activeTabId: string;
  tabIds: string[];
}

type StorageReader = Pick<Storage, "getItem">;
type StorageRemover = Pick<Storage, "removeItem"> &
  Partial<Pick<Storage, "getItem" | "key" | "length">>;

export function projectTabStorageKey(tabId: string): string {
  try {
    return `${PROJECT_TAB_STORAGE_KEY_PREFIX}${encodeURIComponent(tabId)}`;
  } catch {
    // JSON may contain lone UTF-16 surrogates that encodeURIComponent rejects.
    // A raw "%u" prefix cannot collide with its normal output (literal "%" is
    // encoded as "%25"), while fixed code units preserve even malformed IDs.
    let codeUnits = "%u";
    for (let index = 0; index < tabId.length; index += 1) {
      codeUnits += tabId.charCodeAt(index).toString(16).padStart(4, "0");
    }
    return `${PROJECT_TAB_STORAGE_KEY_PREFIX}${codeUnits}`;
  }
}

export function parseProjectTabsStorageManifest(
  raw: string | null,
): ProjectTabsStorageManifest | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<ProjectTabsStorageManifest>;
    if (
      value.schemaVersion !== PROJECT_TABS_STORAGE_SCHEMA_VERSION ||
      typeof value.activeTabId !== "string" ||
      !value.activeTabId ||
      !Array.isArray(value.tabIds)
    ) return undefined;
    const tabIds = value.tabIds.filter(
      (tabId, index, list): tabId is string => (
        typeof tabId === "string" && tabId.length > 0 && list.indexOf(tabId) === index
      ),
    );
    if (tabIds.length === 0) return undefined;
    return {
      schemaVersion: PROJECT_TABS_STORAGE_SCHEMA_VERSION,
      activeTabId: tabIds.includes(value.activeTabId) ? value.activeTabId : tabIds[0],
      tabIds,
    };
  } catch {
    return undefined;
  }
}

export function readProjectTabsStorageManifest(
  storage: StorageReader,
): ProjectTabsStorageManifest | undefined {
  try {
    return parseProjectTabsStorageManifest(storage.getItem(PROJECT_TABS_STORAGE_KEY));
  } catch {
    return undefined;
  }
}

function legacyProjectTabIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as { tabs?: unknown };
    if (!Array.isArray(value.tabs)) return [];
    return value.tabs.flatMap((tab): string[] => {
      if (!tab || typeof tab !== "object") return [];
      const id = (tab as { id?: unknown }).id;
      return typeof id === "string" && id.length > 0 ? [id] : [];
    });
  } catch {
    return [];
  }
}

/** Remove enumerable per-tab fragments that are not reachable from a manifest. */
export function clearUnreferencedProjectTabSessionStorage(
  storage: StorageRemover,
  referencedTabIds: ReadonlySet<string>,
): void {
  const referencedKeys = new Set([...referencedTabIds].map(projectTabStorageKey));
  const orphanKeys: string[] = [];
  try {
    const keyAt = storage.key;
    const length = storage.length;
    if (typeof keyAt !== "function" || typeof length !== "number") return;
    for (let index = 0; index < length; index += 1) {
      const key = keyAt.call(storage, index);
      if (
        key?.startsWith(PROJECT_TAB_STORAGE_KEY_PREFIX) &&
        !referencedKeys.has(key)
      ) orphanKeys.push(key);
    }
  } catch {
    return;
  }
  for (const key of orphanKeys) {
    try { storage.removeItem(key); } catch { /* best effort */ }
  }
}

/**
 * Remove the manifest, its referenced tabs, and enumerable orphan tab keys.
 * The boolean is a security boundary: false means deletion could not be verified.
 */
export function clearProjectTabSessionStorage(storage: StorageRemover): boolean {
  const keys = new Set<string>();
  let complete = true;
  if (typeof storage.getItem === "function") {
    let root: string | null = null;
    try { root = storage.getItem(PROJECT_TABS_STORAGE_KEY); } catch { complete = false; }
    const manifest = parseProjectTabsStorageManifest(root);
    const referencedTabIds = manifest?.tabIds ?? legacyProjectTabIds(root);
    for (const tabId of referencedTabIds) keys.add(projectTabStorageKey(tabId));
  } else complete = false;
  try {
    const keyAt = storage.key;
    const length = storage.length;
    if (typeof keyAt === "function" && typeof length === "number") {
      for (let index = 0; index < length; index += 1) {
        const key = keyAt.call(storage, index);
        if (key?.startsWith(PROJECT_TAB_STORAGE_KEY_PREFIX)) keys.add(key);
      }
    } else complete = false;
  } catch {
    // Referenced manifest keys are still cleared when enumeration is unavailable.
    complete = false;
  }
  for (const key of keys) {
    try { storage.removeItem(key); } catch { complete = false; }
  }
  try { storage.removeItem(PROJECT_TABS_STORAGE_KEY); } catch { complete = false; }
  if (typeof storage.getItem === "function") {
    try {
      if (storage.getItem(PROJECT_TABS_STORAGE_KEY) !== null) complete = false;
      for (const key of keys) {
        if (storage.getItem(key) !== null) complete = false;
      }
    } catch {
      complete = false;
    }
  }
  try {
    const keyAt = storage.key;
    const length = storage.length;
    if (typeof keyAt === "function" && typeof length === "number") {
      for (let index = 0; index < length; index += 1) {
        if (keyAt.call(storage, index)?.startsWith(PROJECT_TAB_STORAGE_KEY_PREFIX)) {
          complete = false;
          break;
        }
      }
    } else complete = false;
  } catch {
    complete = false;
  }
  return complete;
}

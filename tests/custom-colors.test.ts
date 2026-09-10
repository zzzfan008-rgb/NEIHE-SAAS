import assert from "node:assert/strict";
import { createCustomColorsStore } from "../src/store/customColors";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

console.log("账号隔离色彩偏好测试");
const storage = new MemoryStorage();
const store = createCustomColorsStore(storage);

store.getState().bindOwner("owner-a");
store.getState().add("#abc");
store.getState().rememberRecent("rgb(255, 0, 0)");
store.getState().toggleFavorite("hsl(240,100%,50%)");
assert.deepEqual(store.getState().colors, ["#AABBCC"]);
assert.deepEqual(store.getState().recent, ["#FF0000"]);
assert.deepEqual(store.getState().favorites, ["#0000FF"]);

store.getState().bindOwner(null);
assert.deepEqual(store.getState().colors, []);
assert.deepEqual(store.getState().recent, []);
assert.deepEqual(store.getState().favorites, []);

store.getState().bindOwner("owner-b");
assert.deepEqual(store.getState().colors, []);
store.getState().add("#123456");
store.getState().bindOwner("owner-a");
assert.deepEqual(store.getState().colors, ["#AABBCC"]);
assert.deepEqual(store.getState().recent, ["#FF0000"]);
assert.deepEqual(store.getState().favorites, ["#0000FF"]);
console.log("  ✓ A → logout → B → A 不枚举或覆盖其他账号偏好");

store.getState().remove("#aabbcc");
assert.deepEqual(store.getState().colors, []);
console.log("  ✓ 所有写入统一规范化，删除大小写无关");

const remote = new Map<string, { favorites: string[]; initialized: boolean }>([
  ["owner-a", { favorites: ["#112233"], initialized: true }],
  ["owner-b", { favorites: [], initialized: true }],
]);
const gateway = {
  load: async (ownerId: string) => remote.get(ownerId) ?? { favorites: [], initialized: false },
  initialize: async (ownerId: string, favorites: readonly string[]) => {
    if (!remote.get(ownerId)?.initialized) {
      remote.set(ownerId, { favorites: [...favorites], initialized: true });
    }
    return [...(remote.get(ownerId)?.favorites ?? [])];
  },
  setFavorite: async (ownerId: string, color: string, favorite: boolean, bootstrapFavorites: readonly string[]) => {
    const current = remote.get(ownerId);
    const base = current?.initialized ? current.favorites : [...bootstrapFavorites];
    const favorites = favorite
      ? [...base.filter((candidate) => candidate !== color), color]
      : base.filter((candidate) => candidate !== color);
    remote.set(ownerId, { favorites, initialized: true });
    return [...favorites];
  },
};
const syncedStorage = new MemoryStorage();
const synced = createCustomColorsStore(syncedStorage, gateway);

synced.getState().bindOwner("owner-a");
await synced.getState().refreshFavorites();
assert.deepEqual(synced.getState().favorites, ["#112233"]);
await synced.getState().toggleFavorite("#445566");
assert.deepEqual(remote.get("owner-a")?.favorites, ["#112233", "#445566"]);

synced.getState().bindOwner("owner-b");
await synced.getState().refreshFavorites();
assert.deepEqual(synced.getState().favorites, []);
await synced.getState().toggleFavorite("#ABCDEF");
assert.deepEqual(remote.get("owner-b")?.favorites, ["#ABCDEF"]);
assert.deepEqual(remote.get("owner-a")?.favorites, ["#112233", "#445566"]);
console.log("  ✓ 服务端收藏在登录后加载，修改按账号同步且互不覆盖");

const legacyStorage = new MemoryStorage();
const legacy = createCustomColorsStore(legacyStorage);
legacy.getState().bindOwner("legacy-owner");
await legacy.getState().toggleFavorite("#778899");
const migrated = createCustomColorsStore(legacyStorage, gateway);
migrated.getState().bindOwner("legacy-owner");
await migrated.getState().refreshFavorites();
assert.deepEqual(migrated.getState().favorites, ["#778899"]);
assert.deepEqual(remote.get("legacy-owner")?.favorites, ["#778899"]);
console.log("  ✓ 首次跨设备同步保留并上传旧版账号本机收藏");

let releaseInitialization!: () => void;
const initializationBlocked = new Promise<void>((resolve) => { releaseInitialization = resolve; });
let markInitializationStarted!: () => void;
const initializationStarted = new Promise<void>((resolve) => { markInitializationStarted = resolve; });
const migrationRemote = new Map<string, { favorites: string[]; initialized: boolean }>();
const migrationStorage = new MemoryStorage();
const migrationSeed = createCustomColorsStore(migrationStorage);
migrationSeed.getState().bindOwner("migration-race-owner");
await migrationSeed.getState().toggleFavorite("#111111");
const migrationRace = createCustomColorsStore(migrationStorage, {
  load: async () => ({ favorites: [], initialized: false }),
  initialize: async (ownerId, favorites) => {
    markInitializationStarted();
    await initializationBlocked;
    if (!migrationRemote.get(ownerId)?.initialized) {
      migrationRemote.set(ownerId, { favorites: [...favorites], initialized: true });
    }
    return [...(migrationRemote.get(ownerId)?.favorites ?? [])];
  },
  setFavorite: async (ownerId, color, favorite, bootstrapFavorites) => {
    const current = migrationRemote.get(ownerId);
    const base = current?.initialized ? current.favorites : [...bootstrapFavorites];
    const favorites = favorite
      ? [...base.filter((candidate) => candidate !== color), color]
      : base.filter((candidate) => candidate !== color);
    migrationRemote.set(ownerId, { favorites, initialized: true });
    return [...favorites];
  },
});
migrationRace.getState().bindOwner("migration-race-owner");
const migrationRefresh = migrationRace.getState().refreshFavorites();
await initializationStarted;
const migrationToggle = migrationRace.getState().toggleFavorite("#222222");
releaseInitialization();
await Promise.all([migrationRefresh, migrationToggle]);
assert.deepEqual(migrationRemote.get("migration-race-owner")?.favorites, ["#111111", "#222222"]);
assert.deepEqual(migrationRace.getState().favorites, ["#111111", "#222222"]);
console.log("  ✓ 本机收藏初始化与同时发生的新收藏不会互相覆盖");

const failedWrites = createCustomColorsStore(new MemoryStorage(), {
  load: async () => ({ favorites: [], initialized: true }),
  initialize: async (_ownerId, favorites) => [...favorites],
  setFavorite: async () => { throw new Error("offline"); },
});
failedWrites.getState().bindOwner("failed-owner");
await failedWrites.getState().refreshFavorites();
const failedFirst = failedWrites.getState().toggleFavorite("#333333");
const failedSecond = failedWrites.getState().toggleFavorite("#444444");
await Promise.all([failedFirst, failedSecond]);
assert.deepEqual(failedWrites.getState().favorites, []);
assert.equal(failedWrites.getState().favoritesSyncError, "offline");
console.log("  ✓ 连续写入全部失败时回滚到最后一次服务端确认状态");

type RemotePayload = { favorites: string[]; initialized: boolean };
const pendingLoads: Array<(payload: RemotePayload) => void> = [];
let markFirstLoadStarted!: () => void;
let markSecondLoadStarted!: () => void;
const firstLoadStarted = new Promise<void>((resolve) => { markFirstLoadStarted = resolve; });
const secondLoadStarted = new Promise<void>((resolve) => { markSecondLoadStarted = resolve; });
const refreshOrder = createCustomColorsStore(new MemoryStorage(), {
  load: async () => new Promise<RemotePayload>((resolve) => {
    pendingLoads.push(resolve);
    if (pendingLoads.length === 1) markFirstLoadStarted();
    if (pendingLoads.length === 2) markSecondLoadStarted();
  }),
  initialize: async (_ownerId, favorites) => [...favorites],
  setFavorite: async (_ownerId, _color, _favorite, bootstrapFavorites) => [...bootstrapFavorites],
});
refreshOrder.getState().bindOwner("refresh-owner");
const olderRefresh = refreshOrder.getState().refreshFavorites();
await firstLoadStarted;
const newerRefresh = refreshOrder.getState().refreshFavorites();
await secondLoadStarted;
pendingLoads[1]({ favorites: ["#BBBBBB"], initialized: true });
await newerRefresh;
pendingLoads[0]({ favorites: ["#AAAAAA"], initialized: true });
await olderRefresh;
assert.deepEqual(refreshOrder.getState().favorites, ["#BBBBBB"]);
console.log("  ✓ 并发刷新只应用同账号最后发起的响应");

let markQueuedWriteStarted!: () => void;
let releaseQueuedWrite!: () => void;
const queuedWriteStarted = new Promise<void>((resolve) => { markQueuedWriteStarted = resolve; });
const queuedWriteBlocked = new Promise<void>((resolve) => { releaseQueuedWrite = resolve; });
let refreshDuringWriteLoads = 0;
let queuedRemote: string[] = [];
const refreshDuringWrite = createCustomColorsStore(new MemoryStorage(), {
  load: async () => {
    refreshDuringWriteLoads += 1;
    return { favorites: [...queuedRemote], initialized: true };
  },
  initialize: async (_ownerId, favorites) => [...favorites],
  setFavorite: async (_ownerId, color, favorite) => {
    if (color === "#111111") {
      markQueuedWriteStarted();
      await queuedWriteBlocked;
    }
    queuedRemote = favorite
      ? [...queuedRemote.filter((candidate) => candidate !== color), color]
      : queuedRemote.filter((candidate) => candidate !== color);
    return [...queuedRemote];
  },
});
refreshDuringWrite.getState().bindOwner("queued-refresh-owner");
const queuedFirstWrite = refreshDuringWrite.getState().toggleFavorite("#111111");
await queuedWriteStarted;
const staleRefresh = refreshDuringWrite.getState().refreshFavorites();
const queuedSecondWrite = refreshDuringWrite.getState().toggleFavorite("#222222");
releaseQueuedWrite();
await Promise.all([queuedFirstWrite, queuedSecondWrite, staleRefresh]);
assert.equal(refreshDuringWriteLoads, 0);
assert.deepEqual(refreshDuringWrite.getState().favorites, ["#111111", "#222222"]);
console.log("  ✓ 刷新等待既有写入时若出现新写入，不会再请求或应用旧快照");

let releaseFirstWrite!: () => void;
const firstWriteBlocked = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
const persistedSnapshots: string[][] = [];
const periodicRefreshStore = createCustomColorsStore(new MemoryStorage(), {
  load: async () => ({ favorites: [], initialized: true }),
  initialize: async (_ownerId, favorites) => [...favorites],
  setFavorite: async (_ownerId, color, favorite, bootstrapFavorites) => {
    const favorites = favorite
      ? [...bootstrapFavorites.filter((candidate) => candidate !== color), color]
      : bootstrapFavorites.filter((candidate) => candidate !== color);
    persistedSnapshots.push(favorites);
    if (persistedSnapshots.length === 1) await firstWriteBlocked;
    return favorites;
  },
});
periodicRefreshStore.getState().bindOwner("stable-owner");
const firstWrite = periodicRefreshStore.getState().toggleFavorite("#111111");
await Promise.resolve();
const secondWrite = periodicRefreshStore.getState().toggleFavorite("#222222");
periodicRefreshStore.getState().bindOwner("stable-owner");
releaseFirstWrite();
await Promise.all([firstWrite, secondWrite]);
assert.deepEqual(persistedSnapshots.at(-1), ["#111111", "#222222"]);
console.log("  ✓ 同账号会话刷新不会中断排队中的收藏写入");

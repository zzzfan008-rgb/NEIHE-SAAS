import { create } from "zustand";
import { createStore, type StateCreator, type StoreApi } from "zustand/vanilla";
import { parseColorValue } from "@/lib/colorPalette";

const STORAGE_PREFIX = "garment-canvas-color-preferences:v1:";
const MAX_CUSTOM_COLORS = 128;
const MAX_RECENT_COLORS = 24;

interface StoredColorPreferences {
  colors: string[];
  recent: string[];
  favorites: string[];
}

export interface FavoriteColorsGateway {
  load: (ownerId: string) => Promise<{ favorites: unknown; initialized: boolean }>;
  initialize: (ownerId: string, favorites: readonly string[]) => Promise<unknown>;
  setFavorite: (
    ownerId: string, color: string, favorite: boolean, bootstrapFavorites: readonly string[],
  ) => Promise<unknown>;
}

export interface CustomColorsState extends StoredColorPreferences {
  ownerId: string | null;
  favoritesSyncing: boolean;
  favoritesSyncError?: string;
  bindOwner: (ownerId: string | null) => void;
  add: (value: string) => void;
  remove: (value: string) => void;
  rememberRecent: (value: string) => void;
  refreshFavorites: () => Promise<void>;
  toggleFavorite: (value: string) => Promise<void>;
}

type ColorStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const emptyPreferences = (): StoredColorPreferences => ({ colors: [], recent: [], favorites: [] });
const storageKey = (ownerId: string) => `${STORAGE_PREFIX}${encodeURIComponent(ownerId)}`;

function normalizeList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    try {
      const color = parseColorValue(candidate);
      if (!seen.has(color)) { seen.add(color); output.push(color); }
    } catch { /* discard corrupt preferences */ }
    if (output.length >= max) break;
  }
  return output;
}

function load(storage: ColorStorage | null, ownerId: string): StoredColorPreferences {
  if (!storage) return emptyPreferences();
  try {
    const parsed = JSON.parse(storage.getItem(storageKey(ownerId)) ?? "{}") as Record<string, unknown>;
    return {
      colors: normalizeList(parsed.colors, MAX_CUSTOM_COLORS),
      recent: normalizeList(parsed.recent, MAX_RECENT_COLORS),
      favorites: normalizeList(parsed.favorites, MAX_CUSTOM_COLORS),
    };
  } catch {
    return emptyPreferences();
  }
}

function save(storage: ColorStorage | null, ownerId: string | null, preferences: StoredColorPreferences): void {
  if (!storage || !ownerId) return;
  try { storage.setItem(storageKey(ownerId), JSON.stringify(preferences)); } catch { /* in-memory fallback */ }
}

function syncErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "收藏同步失败，请重试";
}

interface FavoriteColorsResponse {
  ownerId?: unknown;
  favorites?: unknown;
  initialized?: unknown;
  error?: unknown;
}

function responseFavorites(body: FavoriteColorsResponse, ownerId: string): unknown {
  if (body.ownerId !== ownerId) throw new Error("登录账号已切换，请刷新后重试");
  return body.favorites;
}

const browserGateway: FavoriteColorsGateway | null = typeof window === "undefined" ? null : {
  load: async (ownerId) => {
    const response = await fetch("/api/auth/color-preferences", {
      cache: "no-store",
      headers: { "X-Expected-User-Id": ownerId },
    });
    const body = await response.json().catch(() => ({})) as FavoriteColorsResponse;
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "无法读取收藏颜色");
    return { favorites: responseFavorites(body, ownerId), initialized: body.initialized === true };
  },
  initialize: async (ownerId, favorites) => {
    const response = await fetch("/api/auth/color-preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Expected-User-Id": ownerId },
      body: JSON.stringify({ favorites }),
    });
    const body = await response.json().catch(() => ({})) as FavoriteColorsResponse;
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "无法初始化收藏颜色");
    return responseFavorites(body, ownerId);
  },
  setFavorite: async (ownerId, color, favorite, bootstrapFavorites) => {
    const response = await fetch("/api/auth/color-preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Expected-User-Id": ownerId },
      body: JSON.stringify({ color, favorite, bootstrapFavorites }),
    });
    const body = await response.json().catch(() => ({})) as FavoriteColorsResponse;
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "无法保存收藏颜色");
    return responseFavorites(body, ownerId);
  },
};

const initializer = (
  storage: ColorStorage | null,
  gateway: FavoriteColorsGateway | null,
 ): StateCreator<CustomColorsState> => (set, get) => {
  let ownerGeneration = 0;
  let favoritesRevision = 0;
  let favoriteWriteQueue = Promise.resolve();
  let favoritesRefreshToken = 0;
  let confirmedFavorites: string[] = [];

  const persist = (preferences: StoredColorPreferences) => {
    save(storage, get().ownerId, preferences);
  };
  const commit = (patch: Partial<StoredColorPreferences>) => {
    const state = get();
    if (!state.ownerId) return;
    const next = {
      colors: patch.colors ?? state.colors,
      recent: patch.recent ?? state.recent,
      favorites: patch.favorites ?? state.favorites,
    };
    persist(next);
    set(next);
  };
  const replaceFavorites = (favorites: string[]) => {
    const state = get();
    if (!state.ownerId) return;
    const next = { colors: state.colors, recent: state.recent, favorites };
    persist(next);
    set({ favorites });
  };

  const refreshFavorites = async () => {
    const ownerId = get().ownerId;
    if (!ownerId || !gateway) return;
    const generation = ownerGeneration;
    const refreshToken = ++favoritesRefreshToken;
    const writesBeforeRefresh = favoriteWriteQueue;
    const revision = favoritesRevision;
    set({ favoritesSyncing: true, favoritesSyncError: undefined });
    await writesBeforeRefresh.catch(() => undefined);
    if (get().ownerId !== ownerId || ownerGeneration !== generation
        || favoritesRefreshToken !== refreshToken || favoriteWriteQueue !== writesBeforeRefresh
        || favoritesRevision !== revision) return;
    try {
      const remote = await gateway.load(ownerId);
      if (get().ownerId !== ownerId || ownerGeneration !== generation || favoritesRefreshToken !== refreshToken) return;
      const localFavorites = get().favorites;
      const remoteFavorites = normalizeList(remote.favorites, MAX_CUSTOM_COLORS);
      const synchronizedFavorites = !remote.initialized && localFavorites.length > 0
        ? normalizeList(await gateway.initialize(ownerId, localFavorites), MAX_CUSTOM_COLORS)
        : remoteFavorites;
      if (get().ownerId !== ownerId || ownerGeneration !== generation
          || favoritesRefreshToken !== refreshToken || favoritesRevision !== revision) return;
      confirmedFavorites = [...synchronizedFavorites];
      replaceFavorites(synchronizedFavorites);
      set({ favoritesSyncing: false, favoritesSyncError: undefined });
    } catch (error) {
      if (get().ownerId === ownerId && ownerGeneration === generation
          && favoritesRefreshToken === refreshToken && favoritesRevision === revision) {
        set({ favoritesSyncing: false, favoritesSyncError: syncErrorMessage(error) });
      }
    }
  };

  return {
    ownerId: null,
    ...emptyPreferences(),
    favoritesSyncing: false,
    favoritesSyncError: undefined,
    bindOwner: (ownerId) => {
      if (ownerId && get().ownerId === ownerId) return;
      ownerGeneration += 1;
      favoritesRefreshToken += 1;
      favoritesRevision = 0;
      favoriteWriteQueue = Promise.resolve();
      if (!ownerId) {
        confirmedFavorites = [];
        set({ ownerId: null, ...emptyPreferences(), favoritesSyncing: false, favoritesSyncError: undefined });
        return;
      }
      const preferences = load(storage, ownerId);
      confirmedFavorites = [...preferences.favorites];
      set({ ownerId, ...preferences, favoritesSyncing: false, favoritesSyncError: undefined });
    },
    add: (value) => {
      const color = parseColorValue(value);
      const colors = get().colors;
      if (!colors.includes(color)) commit({ colors: [...colors, color].slice(-MAX_CUSTOM_COLORS) });
    },
    remove: (value) => {
      const color = parseColorValue(value);
      commit({ colors: get().colors.filter((candidate) => candidate !== color) });
    },
    rememberRecent: (value) => {
      const color = parseColorValue(value);
      commit({ recent: [color, ...get().recent.filter((candidate) => candidate !== color)].slice(0, MAX_RECENT_COLORS) });
    },
    refreshFavorites,
    toggleFavorite: async (value) => {
      const color = parseColorValue(value);
      const state = get();
      if (!state.ownerId) return;
      const previous = state.favorites;
      const favorite = !previous.includes(color);
      if (favorite && previous.length >= MAX_CUSTOM_COLORS) {
        set({ favoritesSyncError: `收藏颜色最多保存 ${MAX_CUSTOM_COLORS} 项` });
        return;
      }
      const favorites = favorite
        ? [...previous, color]
        : previous.filter((candidate) => candidate !== color);
      favoritesRevision += 1;
      const operationRevision = favoritesRevision;
      const generation = ownerGeneration;
      const ownerId = state.ownerId;
      commit({ favorites });
      set({ favoritesSyncing: Boolean(gateway), favoritesSyncError: undefined });
      if (!gateway) return;

      const operation = favoriteWriteQueue.catch(() => undefined).then(async () => {
        if (get().ownerId !== ownerId || ownerGeneration !== generation) return;
        try {
          const savedFavorites = normalizeList(
            await gateway.setFavorite(ownerId, color, favorite, previous),
            MAX_CUSTOM_COLORS,
          );
          if (get().ownerId === ownerId && ownerGeneration === generation) {
            confirmedFavorites = [...savedFavorites];
            if (favoritesRevision === operationRevision) {
              replaceFavorites(savedFavorites);
              set({ favoritesSyncing: false, favoritesSyncError: undefined });
            }
          }
        } catch (error) {
          if (get().ownerId === ownerId && ownerGeneration === generation && favoritesRevision === operationRevision) {
            replaceFavorites([...confirmedFavorites]);
            set({ favoritesSyncing: false, favoritesSyncError: syncErrorMessage(error) });
          }
        }
      });
      favoriteWriteQueue = operation;
      await operation;
    },
  };
};

export function createCustomColorsStore(
  storage: ColorStorage | null,
  gateway: FavoriteColorsGateway | null = null,
): StoreApi<CustomColorsState> {
  return createStore<CustomColorsState>(initializer(storage, gateway));
}

const browserStorage = typeof window === "undefined" ? null : window.localStorage;
export const useCustomColors = create<CustomColorsState>(initializer(browserStorage, browserGateway));

import { create } from "zustand";
import { createStore, type StateCreator, type StoreApi } from "zustand/vanilla";
import { parseColorValue } from "@/lib/colorPalette";
import type { PantoneColorReference } from "@/types/colorPreferences";

const STORAGE_PREFIX = "garment-canvas-color-preferences:v1:";
const MAX_CUSTOM_COLORS = 128;
const MAX_RECENT_COLORS = 24;

interface StoredColorPreferences {
  colors: string[];
  recent: string[];
  favorites: string[];
  pantoneFavorites: PantoneColorReference[];
}

interface FavoriteGatewayResult {
  favorites: unknown;
  pantoneFavorites?: unknown;
}

export interface FavoriteColorsGateway {
  load: (ownerId: string) => Promise<{
    favorites: unknown; pantoneFavorites?: unknown; initialized: boolean;
  }>;
  initialize: (
    ownerId: string, favorites: readonly string[],
    pantoneFavorites?: readonly PantoneColorReference[],
  ) => Promise<unknown>;
  setFavorite: (
    ownerId: string, color: string, favorite: boolean, bootstrapFavorites: readonly string[],
    bootstrapPantoneFavorites: readonly PantoneColorReference[],
  ) => Promise<unknown>;
  setPantoneFavorite?: (
    ownerId: string, color: PantoneColorReference, favorite: boolean,
    bootstrapFavorites: readonly string[], bootstrapPantoneFavorites: readonly PantoneColorReference[],
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
  togglePantoneFavorite: (value: PantoneColorReference) => Promise<void>;
}

type ColorStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const emptyPreferences = (): StoredColorPreferences => ({
  colors: [], recent: [], favorites: [], pantoneFavorites: [],
});
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

function normalizePantoneList(value: unknown, max: number): PantoneColorReference[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const output: PantoneColorReference[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const color = candidate as Record<string, unknown>;
    if (typeof color.catalogId !== "string" || !/^[0-9a-f]{64}$/.test(color.catalogId)
      || typeof color.releaseId !== "string" || !color.releaseId.trim()
      || typeof color.libraryKey !== "string" || !color.libraryKey.trim()
      || typeof color.code !== "string" || !color.code.trim()
      || typeof color.hex !== "string") continue;
    try {
      const normalized: PantoneColorReference = {
        catalogId: color.catalogId,
        releaseId: color.releaseId.trim(),
        libraryKey: color.libraryKey.trim(),
        code: color.code.trim(),
        hex: parseColorValue(color.hex),
      };
      if (!seen.has(normalized.catalogId)) {
        seen.add(normalized.catalogId);
        output.push(normalized);
      }
    } catch { /* discard corrupt preferences */ }
    if (output.length >= max) break;
  }
  return output;
}

function gatewayPreferences(
  value: unknown,
  fallback: Pick<StoredColorPreferences, "favorites" | "pantoneFavorites">,
): Pick<StoredColorPreferences, "favorites" | "pantoneFavorites"> {
  if (Array.isArray(value)) {
    return {
      favorites: normalizeList(value, MAX_CUSTOM_COLORS),
      pantoneFavorites: fallback.pantoneFavorites,
    };
  }
  const result: FavoriteGatewayResult = value && typeof value === "object"
    ? value as FavoriteGatewayResult : { favorites: [] };
  return {
    favorites: normalizeList(result.favorites, MAX_CUSTOM_COLORS),
    pantoneFavorites: Object.prototype.hasOwnProperty.call(result, "pantoneFavorites")
      ? normalizePantoneList(result.pantoneFavorites, MAX_CUSTOM_COLORS)
      : fallback.pantoneFavorites,
  };
}

function load(storage: ColorStorage | null, ownerId: string): StoredColorPreferences {
  if (!storage) return emptyPreferences();
  try {
    const parsed = JSON.parse(storage.getItem(storageKey(ownerId)) ?? "{}") as Record<string, unknown>;
    return {
      colors: normalizeList(parsed.colors, MAX_CUSTOM_COLORS),
      recent: normalizeList(parsed.recent, MAX_RECENT_COLORS),
      favorites: normalizeList(parsed.favorites, MAX_CUSTOM_COLORS),
      pantoneFavorites: normalizePantoneList(parsed.pantoneFavorites, MAX_CUSTOM_COLORS),
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
  pantoneFavorites?: unknown;
  initialized?: unknown;
  error?: unknown;
}

function responsePreferences(body: FavoriteColorsResponse, ownerId: string): FavoriteGatewayResult {
  if (body.ownerId !== ownerId) throw new Error("登录账号已切换，请刷新后重试");
  return {
    favorites: body.favorites,
    ...(Object.prototype.hasOwnProperty.call(body, "pantoneFavorites")
      ? { pantoneFavorites: body.pantoneFavorites } : {}),
  };
}

const browserGateway: FavoriteColorsGateway | null = typeof window === "undefined" ? null : {
  load: async (ownerId) => {
    const response = await fetch("/api/auth/color-preferences", {
      cache: "no-store",
      headers: { "X-Expected-User-Id": ownerId },
    });
    const body = await response.json().catch(() => ({})) as FavoriteColorsResponse;
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "无法读取收藏颜色");
    return { ...responsePreferences(body, ownerId), initialized: body.initialized === true };
  },
  initialize: async (ownerId, favorites, pantoneFavorites = []) => {
    const response = await fetch("/api/auth/color-preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Expected-User-Id": ownerId },
      body: JSON.stringify({ favorites, pantoneFavorites }),
    });
    const body = await response.json().catch(() => ({})) as FavoriteColorsResponse;
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "无法初始化收藏颜色");
    return responsePreferences(body, ownerId);
  },
  setFavorite: async (ownerId, color, favorite, bootstrapFavorites, bootstrapPantoneFavorites) => {
    const response = await fetch("/api/auth/color-preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Expected-User-Id": ownerId },
      body: JSON.stringify({ color, favorite, bootstrapFavorites, bootstrapPantoneFavorites }),
    });
    const body = await response.json().catch(() => ({})) as FavoriteColorsResponse;
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "无法保存收藏颜色");
    return responsePreferences(body, ownerId);
  },
  setPantoneFavorite: async (ownerId, color, favorite, bootstrapFavorites, bootstrapPantoneFavorites) => {
    const response = await fetch("/api/auth/color-preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Expected-User-Id": ownerId },
      body: JSON.stringify({ pantone: color, favorite, bootstrapFavorites, bootstrapPantoneFavorites }),
    });
    const body = await response.json().catch(() => ({})) as FavoriteColorsResponse;
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "无法保存 Pantone 收藏");
    return responsePreferences(body, ownerId);
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
  let confirmedPantoneFavorites: PantoneColorReference[] = [];

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
      pantoneFavorites: patch.pantoneFavorites ?? state.pantoneFavorites,
    };
    persist(next);
    set(next);
  };
  const replaceFavorites = (
    favorites: string[], pantoneFavorites: PantoneColorReference[],
  ) => {
    const state = get();
    if (!state.ownerId) return;
    const next = { colors: state.colors, recent: state.recent, favorites, pantoneFavorites };
    persist(next);
    set({ favorites, pantoneFavorites });
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
      const local = {
        favorites: get().favorites,
        pantoneFavorites: get().pantoneFavorites,
      };
      const remotePreferences = gatewayPreferences(remote, local);
      const synchronized = !remote.initialized
        && (local.favorites.length > 0 || local.pantoneFavorites.length > 0)
        ? gatewayPreferences(
            await gateway.initialize(ownerId, local.favorites, local.pantoneFavorites),
            local,
          )
        : remotePreferences;
      if (get().ownerId !== ownerId || ownerGeneration !== generation
          || favoritesRefreshToken !== refreshToken || favoritesRevision !== revision) return;
      confirmedFavorites = [...synchronized.favorites];
      confirmedPantoneFavorites = [...synchronized.pantoneFavorites];
      replaceFavorites(synchronized.favorites, synchronized.pantoneFavorites);
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
        confirmedPantoneFavorites = [];
        set({ ownerId: null, ...emptyPreferences(), favoritesSyncing: false, favoritesSyncError: undefined });
        return;
      }
      const preferences = load(storage, ownerId);
      confirmedFavorites = [...preferences.favorites];
      confirmedPantoneFavorites = [...preferences.pantoneFavorites];
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
      const previousPantone = state.pantoneFavorites;
      const favorite = !previous.includes(color);
      if (favorite && previous.length + previousPantone.length >= MAX_CUSTOM_COLORS) {
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
          const saved = gatewayPreferences(
            await gateway.setFavorite(ownerId, color, favorite, previous, previousPantone),
            { favorites: previous, pantoneFavorites: previousPantone },
          );
          if (get().ownerId === ownerId && ownerGeneration === generation) {
            confirmedFavorites = [...saved.favorites];
            confirmedPantoneFavorites = [...saved.pantoneFavorites];
            if (favoritesRevision === operationRevision) {
              replaceFavorites(saved.favorites, saved.pantoneFavorites);
              set({ favoritesSyncing: false, favoritesSyncError: undefined });
            }
          }
        } catch (error) {
          if (get().ownerId === ownerId && ownerGeneration === generation && favoritesRevision === operationRevision) {
            replaceFavorites([...confirmedFavorites], [...confirmedPantoneFavorites]);
            set({ favoritesSyncing: false, favoritesSyncError: syncErrorMessage(error) });
          }
        }
      });
      favoriteWriteQueue = operation;
      await operation;
    },
    togglePantoneFavorite: async (value) => {
      const [color] = normalizePantoneList([value], 1);
      const state = get();
      if (!color || !state.ownerId) return;
      const previous = state.pantoneFavorites;
      const previousHex = state.favorites;
      const favorite = !previous.some((candidate) => candidate.catalogId === color.catalogId);
      if (favorite && previous.length + previousHex.length >= MAX_CUSTOM_COLORS) {
        set({ favoritesSyncError: `收藏颜色最多保存 ${MAX_CUSTOM_COLORS} 项` });
        return;
      }
      if (gateway && !gateway.setPantoneFavorite) {
        set({ favoritesSyncError: "当前服务不支持 Pantone 收藏，请刷新后重试" });
        return;
      }
      const pantoneFavorites = favorite
        ? [...previous, color]
        : previous.filter((candidate) => candidate.catalogId !== color.catalogId);
      favoritesRevision += 1;
      const operationRevision = favoritesRevision;
      const generation = ownerGeneration;
      const ownerId = state.ownerId;
      commit({ pantoneFavorites });
      set({ favoritesSyncing: Boolean(gateway), favoritesSyncError: undefined });
      if (!gateway?.setPantoneFavorite) return;

      const operation = favoriteWriteQueue.catch(() => undefined).then(async () => {
        if (get().ownerId !== ownerId || ownerGeneration !== generation) return;
        try {
          const saved = gatewayPreferences(
            await gateway.setPantoneFavorite!(
              ownerId, color, favorite, previousHex, previous,
            ),
            { favorites: previousHex, pantoneFavorites: previous },
          );
          if (get().ownerId === ownerId && ownerGeneration === generation) {
            confirmedFavorites = [...saved.favorites];
            confirmedPantoneFavorites = [...saved.pantoneFavorites];
            if (favoritesRevision === operationRevision) {
              replaceFavorites(saved.favorites, saved.pantoneFavorites);
              set({ favoritesSyncing: false, favoritesSyncError: undefined });
            }
          }
        } catch (error) {
          if (get().ownerId === ownerId && ownerGeneration === generation
              && favoritesRevision === operationRevision) {
            replaceFavorites([...confirmedFavorites], [...confirmedPantoneFavorites]);
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

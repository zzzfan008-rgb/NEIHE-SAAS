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

export interface CustomColorsState extends StoredColorPreferences {
  ownerId: string | null;
  bindOwner: (ownerId: string | null) => void;
  add: (value: string) => void;
  remove: (value: string) => void;
  rememberRecent: (value: string) => void;
  toggleFavorite: (value: string) => void;
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

const initializer = (storage: ColorStorage | null): StateCreator<CustomColorsState> => (set, get) => {
  const commit = (patch: Partial<StoredColorPreferences>) => {
    const state = get();
    if (!state.ownerId) return;
    const next = {
      colors: patch.colors ?? state.colors,
      recent: patch.recent ?? state.recent,
      favorites: patch.favorites ?? state.favorites,
    };
    save(storage, state.ownerId, next);
    set(next);
  };
  return {
    ownerId: null,
    ...emptyPreferences(),
    bindOwner: (ownerId) => {
      if (!ownerId) { set({ ownerId: null, ...emptyPreferences() }); return; }
      set({ ownerId, ...load(storage, ownerId) });
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
    toggleFavorite: (value) => {
      const color = parseColorValue(value);
      const favorites = get().favorites;
      commit({ favorites: favorites.includes(color)
        ? favorites.filter((candidate) => candidate !== color)
        : [...favorites, color].slice(-MAX_CUSTOM_COLORS) });
    },
  };
};

export function createCustomColorsStore(storage: ColorStorage | null): StoreApi<CustomColorsState> {
  return createStore<CustomColorsState>(initializer(storage));
}

const browserStorage = typeof window === "undefined" ? null : window.localStorage;
export const useCustomColors = create<CustomColorsState>(initializer(browserStorage));

import { create } from "zustand";
import { isAiGatewayId, type AiGatewayId, type AiGatewaySettings } from "../types/aiGateway";

interface GatewayState {
  ownerId: string | null;
  settings: AiGatewaySettings | null;
  changing: boolean;
  error: string | null;
  bindOwner: (ownerId: string | null) => void;
  refresh: () => Promise<void>;
  switchGateway: (gateway: AiGatewayId) => Promise<void>;
}

let ownerEpoch = 0;
function validSettings(value: AiGatewaySettings): boolean {
  return isAiGatewayId(value.activeGateway) && Number.isSafeInteger(value.revision) && value.revision >= 0
    && Array.isArray(value.gateways) && value.gateways.length === 2
    && value.gateways.every((item) => isAiGatewayId(item.id) && typeof item.configured === "boolean");
}

export const useAiGatewayStore = create<GatewayState>((set, get) => ({
  ownerId: null, settings: null, changing: false, error: null,
  bindOwner(ownerId) {
    if (get().ownerId === ownerId) return;
    ownerEpoch += 1;
    set({ ownerId, settings: null, changing: false, error: null });
  },
  async refresh() {
    if (!get().ownerId) return;
    const epoch = ownerEpoch;
    try {
      const response = await fetch("/api/ai-gateway", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("供应商状态读取失败，请稍后重试");
      const settings = await response.json() as AiGatewaySettings;
      if (!validSettings(settings)) throw new Error("供应商状态无效");
      if (epoch !== ownerEpoch) return;
      if (settings.revision >= (get().settings?.revision ?? -1)) {
        set({ settings, ...(!get().settings ? { error: null } : {}) });
      }
    } catch (error) {
      if (epoch === ownerEpoch && !get().settings) set({ error: error instanceof Error ? error.message : "供应商状态读取失败" });
    }
  },
  async switchGateway(activeGateway) {
    const { settings, changing, ownerId } = get();
    if (!ownerId || !settings || changing || settings.activeGateway === activeGateway) return;
    const epoch = ownerEpoch;
    set({ changing: true, error: null });
    try {
      const response = await fetch("/api/ai-gateway", {
        method: "PUT", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ activeGateway, revision: settings.revision }),
      });
      const body = await response.json() as AiGatewaySettings & { error?: string };
      if (!response.ok) throw new Error(body.error || "供应商切换失败");
      if (!validSettings(body)) throw new Error("供应商状态无效");
      if (epoch !== ownerEpoch) return;
      if (body.revision >= (get().settings?.revision ?? -1)) set({ settings: body });
      if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel("gc-ai-gateway");
        channel.postMessage("changed");
        channel.close();
      }
    } catch (error) {
      if (epoch === ownerEpoch) {
        set({ error: error instanceof Error ? error.message : "供应商切换失败" });
        await get().refresh();
      }
    } finally { if (epoch === ownerEpoch) set({ changing: false }); }
  },
}));

export function useActiveAiGateway(): AiGatewayId {
  return useAiGatewayStore((state) => state.settings?.activeGateway ?? "apiyi");
}

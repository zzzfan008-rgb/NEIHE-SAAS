import { useEffect } from "react";
import { ChevronDownIcon } from "lucide-react";
import { useAuth } from "@/auth/AuthContext";
import { useAiGatewayStore } from "@/store/aiGatewayStore";
import { AI_GATEWAY_LABELS, isAiGatewayId } from "@/types/aiGateway";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export function AiGatewayMenu() {
  const { user } = useAuth();
  const { settings, changing, error, bindOwner, refresh, switchGateway } = useAiGatewayStore();
  useEffect(() => {
    bindOwner(user?.id ?? null);
    if (!user) return;
    const update = () => { void refresh(); };
    update();
    const timer = window.setInterval(update, 10_000);
    window.addEventListener("focus", update);
    const onVisible = () => { if (!document.hidden) update(); };
    document.addEventListener("visibilitychange", onVisible);
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("gc-ai-gateway");
    if (channel) channel.onmessage = update;
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", onVisible);
      channel?.close();
      bindOwner(null);
    };
  }, [user?.id, bindOwner, refresh]);

  if (user?.role !== "admin") return null;
  const label = changing ? "切换中…" : settings ? AI_GATEWAY_LABELS[settings.activeGateway] : "读取中…";
  return <>
    <DropdownMenu onOpenChange={(open) => { if (open) void refresh(); }}>
      <DropdownMenuTrigger
        aria-label={`全局供应商：${label}`} title={`全局供应商：${label}`} aria-busy={changing}
        className="flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full border border-(--gc-border) px-3 py-1.5 text-[10px] text-(--gc-text-muted) outline-hidden transition-colors hover:border-(--gc-accent) focus-visible:ring-2 focus-visible:ring-(--gc-accent)/50 disabled:opacity-50"
      >
        <span>供应商：{label}</span><ChevronDownIcon aria-hidden="true" className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 border border-(--gc-border) bg-(--gc-panel) text-(--gc-text)">
        <DropdownMenuGroup>
          <DropdownMenuLabel>全局供应商</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={settings?.activeGateway ?? ""} onValueChange={(value) => {
            if (isAiGatewayId(value)) void switchGateway(value);
          }}>
            {settings?.gateways.map((gateway) => <DropdownMenuRadioItem key={gateway.id} value={gateway.id} closeOnClick disabled={changing || !gateway.configured} className="min-h-8 text-xs">
              {gateway.label}{!gateway.configured && <span className="ml-auto text-[10px] text-(--gc-text-muted)">未配置</span>}
            </DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-[10px] leading-relaxed text-(--gc-text-muted)">切换适用于所有账号的新任务；已提交任务继续使用原供应商。</p>
      </DropdownMenuContent>
    </DropdownMenu>
    {error && <span role="alert" className="max-w-64 text-[10px] text-red-500">{error}</span>}
    <span role="status" className="sr-only">{settings && `全局供应商为 ${AI_GATEWAY_LABELS[settings.activeGateway]}`}</span>
  </>;
}

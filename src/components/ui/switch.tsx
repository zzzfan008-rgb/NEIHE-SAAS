import * as React from "react";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-[var(--gc-border)] bg-[var(--gc-control)] p-0.5 outline-none transition-colors",
        "data-checked:border-[var(--gc-accent)] data-checked:bg-[var(--gc-accent)]",
        "focus-visible:ring-2 focus-visible:ring-[var(--gc-accent)]/50 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="block size-3.5 rounded-full bg-[var(--gc-text-muted)] shadow-sm transition-transform data-checked:translate-x-4 data-checked:bg-[var(--gc-panel)]"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };

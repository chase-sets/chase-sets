import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "../../lib/utils";

export function Switch({
  label,
  description,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled
}: {
  label: string;
  description?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="ds-panel flex cursor-pointer items-center justify-between gap-4 rounded-[var(--radius-lg)] border border-[var(--muted)] p-3">
      <span className="grid gap-1">
        <span className="text-sm font-medium">{label}</span>
        {description ? <span className="text-xs text-[var(--muted-foreground)]">{description}</span> : null}
      </span>
      <SwitchPrimitive.Root
        checked={checked}
        defaultChecked={defaultChecked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className={(state) => cn(
          "ds-focus relative inline-flex h-7 w-12 items-center rounded-full bg-[var(--muted)] transition",
          state.checked && "bg-[var(--primary)]",
          state.disabled && "opacity-60"
        )}
      >
        <SwitchPrimitive.Thumb
          className={(state) => cn(
            "block h-5 w-5 translate-x-1 rounded-full bg-[var(--card)] shadow-[var(--shadow-sm)] transition",
            state.checked && "translate-x-6"
          )}
        />
      </SwitchPrimitive.Root>
    </label>
  );
}

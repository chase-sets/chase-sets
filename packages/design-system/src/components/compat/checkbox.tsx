import { Check } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { cn } from "../../lib/utils";

export function Checkbox({
  label,
  description,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="ds-panel flex cursor-pointer items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--muted)] p-3">
      <CheckboxPrimitive.Root
        checked={checked}
        defaultChecked={defaultChecked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className={(state) =>
          cn(
            "ds-focus mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-[var(--border)] bg-[var(--card)]",
            state.checked && "border-[var(--primary)] bg-[var(--primary)]",
            state.disabled && "opacity-60",
          )
        }
      >
        <CheckboxPrimitive.Indicator>
          <Check className="h-3.5 w-3.5 text-[var(--primary-foreground)]" aria-hidden="true" />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <span className="grid gap-1">
        <span className="text-sm font-medium">{label}</span>
        {description ? <span className="text-xs text-[var(--muted-foreground)]">{description}</span> : null}
      </span>
    </label>
  );
}

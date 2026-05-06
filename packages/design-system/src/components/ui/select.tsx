import { Check, ChevronDown } from "lucide-react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { cn } from "../../lib/utils";

export interface SelectItem {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface SelectProps {
  items: SelectItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  label?: string;
}

export function Select({
  items,
  value,
  defaultValue,
  onValueChange,
  placeholder = "Select an option",
  disabled,
  label
}: SelectProps) {
  const itemLabels = Object.fromEntries(items.map((item) => [item.value, item.label]));

  return (
    <SelectPrimitive.Root
      items={itemLabels}
      value={value}
      defaultValue={defaultValue}
      disabled={disabled}
      onValueChange={(nextValue) => {
        if (nextValue !== null) {
          onValueChange?.(nextValue);
        }
      }}
    >
      <SelectPrimitive.Trigger
        aria-label={label}
        className={(state) => cn(
          "ds-focus inline-flex h-11 w-full items-center justify-between gap-2 rounded-[var(--radius)] border border-[var(--input)] bg-[var(--card)] px-3.5 py-2 text-left text-sm font-semibold text-[var(--foreground)] shadow-[inset_0_1px_0_var(--surface-line),var(--shadow-sm)] transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50",
          state.open && "border-[var(--ring)] bg-[var(--secondary)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--ring)_18%,transparent),var(--shadow-md)]"
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown className="h-4 w-4 opacity-70 transition-transform duration-200 data-[popup-open]:rotate-180" aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          align="start"
          alignItemWithTrigger={false}
          collisionPadding={16}
          sideOffset={8}
          className="z-50 min-w-[var(--anchor-width)] max-w-[calc(100vw-2rem)]"
        >
          <SelectPrimitive.Popup className="ds-panel max-h-80 overflow-hidden rounded-[var(--radius-lg)] border border-[color-mix(in_srgb,var(--primary)_34%,var(--border))] bg-[var(--popover)] p-2 text-[var(--popover-foreground)] shadow-[var(--shadow-overlay)] outline-none">
            <SelectPrimitive.List className="grid max-h-72 gap-1 overflow-y-auto">
              {items.map((item) => (
                <SelectPrimitive.Item
                  key={item.value}
                  value={item.value}
                  disabled={item.disabled}
                  label={item.label}
                  className={(state) => cn(
                    "grid cursor-default select-none grid-cols-[1.5rem_minmax(0,1fr)] items-start gap-2 rounded-[var(--radius)] px-3 py-2.5 text-sm outline-none transition-colors hover:bg-[color-mix(in_srgb,var(--primary)_14%,var(--secondary))] hover:text-[var(--foreground)]",
                    state.highlighted && !state.selected && "bg-[color-mix(in_srgb,var(--primary)_14%,var(--secondary))] text-[var(--foreground)]",
                    state.disabled && "pointer-events-none opacity-45"
                  )}
                >
                  <span className="mt-0.5 grid h-5 w-5 place-items-center rounded-full border border-[var(--muted)] bg-[var(--card)]">
                    <SelectPrimitive.ItemIndicator className="grid h-5 w-5 place-items-center rounded-full border border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-foreground)] shadow-[var(--shadow-sm)]">
                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    </SelectPrimitive.ItemIndicator>
                  </span>
                  <SelectPrimitive.ItemText>
                    <span className="grid min-w-0 gap-0.5">
                      <span className="font-semibold leading-5">{item.label}</span>
                      {item.description ? (
                        <span className="text-xs leading-5 text-[var(--muted-foreground)]">
                          {item.description}
                        </span>
                      ) : null}
                    </span>
                  </SelectPrimitive.ItemText>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

import { useId, useState } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Icon } from "../../icons";
import { usePortalRoots } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { FieldChrome, controlClass, controlErrorClass, fieldHintId, type BaseInputProps } from "./shared";
import type { SelectItem } from "./select";

export interface ComboboxProps extends BaseInputProps {
  items: SelectItem[];
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  noMatchesLabel?: string;
}

export function Combobox({
  label,
  description,
  error,
  required,
  hideLabel,
  items,
  value,
  onValueChange,
  placeholder = "Search options",
  noMatchesLabel = "No matches"
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerId = useId();
  const listboxId = useId();
  const searchId = useId();
  const selected = items.find((item) => item.value === value);
  const filtered = items.filter((item) =>
    item.label.toLowerCase().includes(query.toLowerCase())
  );
  const { overlayNode } = usePortalRoots();

  return (
    <FieldChrome
      label={label}
      description={description}
      error={error}
      required={required}
      hideLabel={hideLabel}
      htmlFor={triggerId}
    >
      <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
        <PopoverPrimitive.Trigger
          id={triggerId}
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-haspopup="listbox"
          aria-describedby={(error || description) ? fieldHintId(triggerId) : undefined}
          aria-invalid={!!error || undefined}
          className={cx(
            controlClass,
            !!error && controlErrorClass,
            "inline-flex items-center justify-between gap-2 text-left"
          )}
        >
          <span>{selected?.label ?? placeholder}</span>
          <Icon name="chevronDown" size="sm" tone="secondary" />
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal container={overlayNode ?? undefined}>
          <PopoverPrimitive.Content
            sideOffset={8}
            className="modern-surface z-popover w-[var(--radix-popover-trigger-width)] rounded-tokenLg border border-muted p-3 shadow-overlay"
          >
            <div className="space-y-3">
              <input
                id={searchId}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={placeholder}
                aria-label="Filter options"
                aria-autocomplete="list"
                aria-controls={listboxId}
                className={controlClass}
              />
              <div
                id={listboxId}
                role="listbox"
                aria-label={typeof label === "string" ? label : "Options"}
                className="max-h-60 space-y-1 overflow-y-auto"
              >
                {filtered.length === 0 ? (
                  <div className="rounded-tokenMd bg-background px-3 py-2 text-sm text-secondary">
                    {noMatchesLabel}
                  </div>
                ) : (
                  filtered.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      role="option"
                      aria-selected={item.value === value}
                      className="focus-ring flex w-full items-center justify-between rounded-tokenMd px-3 py-2 text-left text-sm text-foreground hover:bg-background"
                      onClick={() => {
                        onValueChange?.(item.value);
                        setOpen(false);
                        setQuery("");
                      }}
                    >
                      <span>{item.label}</span>
                      {item.value === value ? (
                        <Icon name="check" size="sm" tone="accent" />
                      ) : null}
                    </button>
                  ))
                )}
              </div>
            </div>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </FieldChrome>
  );
}

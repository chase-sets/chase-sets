import { useId, useMemo, useState } from "react";
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
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
  const inputId = useId();
  const listboxId = useId();
  const selected = items.find((item) => item.value === value);
  const itemValues = useMemo(() => items.map((item) => item.value), [items]);
  const filteredItems = useMemo(
    () => items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())),
    [items, query]
  );
  const { overlayNode } = usePortalRoots();

  return (
    <FieldChrome
      label={label}
      description={description}
      error={error}
      required={required}
      hideLabel={hideLabel}
      htmlFor={inputId}
    >
      <ComboboxPrimitive.Root
        items={itemValues}
        value={value ?? null}
        inputValue={query}
        open={open}
        onOpenChange={setOpen}
        onInputValueChange={setQuery}
        onValueChange={(nextValue) => {
          if (nextValue !== null) {
            onValueChange?.(nextValue);
            setQuery(items.find((item) => item.value === nextValue)?.label ?? "");
          }
        }}
        itemToStringLabel={(itemValue) =>
          items.find((item) => item.value === itemValue)?.label ?? String(itemValue)
        }
        filter={(itemValue, inputValue) =>
          (items.find((item) => item.value === itemValue)?.label ?? String(itemValue))
            .toLowerCase()
            .includes(inputValue.toLowerCase())
        }
      >
        <ComboboxPrimitive.InputGroup
          className={cx(
            controlClass,
            !!error && controlErrorClass,
            "inline-flex items-center justify-between gap-2 p-0"
          )}
        >
          <ComboboxPrimitive.Input
            id={inputId}
            placeholder={selected?.label ?? placeholder}
            aria-controls={listboxId}
            aria-describedby={(error || description) ? fieldHintId(inputId) : undefined}
            aria-invalid={!!error || undefined}
            className="min-w-0 flex-1 bg-transparent px-4 py-2.5 outline-none"
          />
          <ComboboxPrimitive.Trigger className="focus-ring mr-2 inline-flex h-8 w-8 items-center justify-center rounded-tokenSm">
            <Icon name="chevronDown" size="sm" tone="secondary" />
          </ComboboxPrimitive.Trigger>
        </ComboboxPrimitive.InputGroup>
        <ComboboxPrimitive.Portal container={overlayNode ?? undefined}>
          <ComboboxPrimitive.Positioner sideOffset={8} className="z-popover w-[var(--anchor-width)]">
            <ComboboxPrimitive.Popup className="modern-surface rounded-tokenLg border border-muted p-3 shadow-overlay">
              <ComboboxPrimitive.List
                id={listboxId}
                aria-label={typeof label === "string" ? label : "Options"}
                className="motion-safe-scroll-area max-h-60 space-y-1"
              >
                {filteredItems.length === 0 ? (
                  <ComboboxPrimitive.Empty className="rounded-tokenMd bg-background px-3 py-2 text-sm text-secondary">
                    {noMatchesLabel}
                  </ComboboxPrimitive.Empty>
                ) : (
                  filteredItems.map((item, index) => (
                    <ComboboxPrimitive.Item
                      key={item.value}
                      index={index}
                      value={item.value}
                      disabled={item.disabled}
                      className={(state) => cx(
                        "focus-ring flex w-full cursor-pointer items-center justify-between rounded-tokenMd px-3 py-2 text-left text-sm text-foreground",
                        state.highlighted && "bg-background",
                        state.disabled && "cursor-not-allowed opacity-50"
                      )}
                    >
                      <span>{item.label}</span>
                      <ComboboxPrimitive.ItemIndicator>
                        <Icon name="check" size="sm" tone="accent" />
                      </ComboboxPrimitive.ItemIndicator>
                    </ComboboxPrimitive.Item>
                  ))
                )}
              </ComboboxPrimitive.List>
            </ComboboxPrimitive.Popup>
          </ComboboxPrimitive.Positioner>
        </ComboboxPrimitive.Portal>
      </ComboboxPrimitive.Root>
    </FieldChrome>
  );
}

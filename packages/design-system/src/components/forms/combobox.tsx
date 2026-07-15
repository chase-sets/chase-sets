import { forwardRef, useEffect, useId, useMemo, useState } from "react";
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { Icon } from "../../icons";
import { usePortalRoots } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { useControllableValue } from "../controllable";
import { controlHeightClasses, controlSquareSizeClasses } from "../control-sizing";
import { FieldChrome, compoundControlClass, controlErrorClass, fieldDescribedBy, type BaseInputProps } from "./shared";
import type { SelectItem } from "./select";

export interface ComboboxProps extends BaseInputProps {
  name?: string;
  form?: string;
  items: SelectItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  inputValue?: string;
  defaultInputValue?: string;
  onInputValueChange?: (value: string) => void;
  placeholder?: string;
  noMatchesLabel?: string;
  filterItems?: boolean;
  openOnInputClick?: boolean;
  disabled?: boolean;
}

export const Combobox = forwardRef<HTMLInputElement, ComboboxProps>(function Combobox(
  {
    id,
    name,
    form,
    label,
    description,
    error,
    status,
    counter,
    required,
    hideLabel,
    items,
    value,
    defaultValue,
    onValueChange,
    inputValue,
    defaultInputValue,
    onInputValueChange,
    placeholder = "Search options",
    noMatchesLabel = "No matches",
    filterItems = true,
    openOnInputClick = false,
    disabled = false,
  },
  ref,
) {
  const [open, setOpen] = useState(false);
  const [selectedValue, setSelectedValue] = useControllableValue(value, defaultValue ?? "", onValueChange);
  const [query, setQuery] = useControllableValue(inputValue, defaultInputValue ?? "", onInputValueChange);
  const callerOwnsInput =
    inputValue !== undefined || defaultInputValue !== undefined || onInputValueChange !== undefined;
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const listboxId = useId();
  const selected = items.find((item) => item.value === selectedValue);
  const selectedLabel = selected?.label ?? "";
  const itemValues = useMemo(() => items.map((item) => item.value), [items]);
  const filteredItems = useMemo(
    () => (filterItems ? items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())) : [...items]),
    [filterItems, items, query],
  );
  const { overlayNode } = usePortalRoots();

  useEffect(() => {
    if (!open && !callerOwnsInput) {
      setQuery(selectedLabel);
    }
  }, [callerOwnsInput, open, selectedLabel]);

  return (
    <FieldChrome
      label={label}
      description={description}
      error={error}
      status={status}
      counter={counter}
      required={required}
      hideLabel={hideLabel}
      htmlFor={inputId}
    >
      {name ? <input type="hidden" name={name} form={form} value={selectedValue} disabled={disabled} /> : null}
      <ComboboxPrimitive.Root
        items={itemValues}
        value={selectedValue || null}
        inputValue={query}
        open={open}
        openOnInputClick={openOnInputClick}
        disabled={disabled}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!callerOwnsInput) {
            setQuery(nextOpen ? "" : selectedLabel);
          }
        }}
        onInputValueChange={setQuery}
        onValueChange={(nextValue) => {
          if (nextValue !== null) {
            setSelectedValue(nextValue);
            if (!callerOwnsInput) {
              setQuery(items.find((item) => item.value === nextValue)?.label ?? "");
            }
          }
        }}
        itemToStringLabel={(itemValue) => items.find((item) => item.value === itemValue)?.label ?? String(itemValue)}
        filter={
          filterItems
            ? (itemValue, nextInputValue) =>
                (items.find((item) => item.value === itemValue)?.label ?? String(itemValue))
                  .toLowerCase()
                  .includes(nextInputValue.toLowerCase())
            : null
        }
      >
        <ComboboxPrimitive.InputGroup
          className={cx(
            compoundControlClass,
            !!error && controlErrorClass,
            "inline-flex items-center justify-between gap-2",
          )}
        >
          <ComboboxPrimitive.Input
            id={inputId}
            ref={ref}
            placeholder={placeholder}
            aria-controls={listboxId}
            aria-describedby={fieldDescribedBy({ inputId, description, error, status, counter })}
            aria-invalid={!!error || undefined}
            autoComplete="off"
            disabled={disabled}
            className="min-w-0 flex-1 self-stretch bg-transparent px-[var(--control-md-px)] py-0 outline-none"
          />
          <ComboboxPrimitive.Trigger
            disabled={disabled}
            className={cx(
              "focus-ring inline-flex items-center justify-center rounded-tokenSm disabled:cursor-not-allowed disabled:opacity-disabled",
              controlSquareSizeClasses.md,
            )}
          >
            <Icon name="chevronDown" size="sm" tone="secondary" />
          </ComboboxPrimitive.Trigger>
        </ComboboxPrimitive.InputGroup>
        <ComboboxPrimitive.Portal container={overlayNode ?? undefined}>
          <ComboboxPrimitive.Positioner sideOffset={8} className="z-popover w-[var(--anchor-width)]">
            <ComboboxPrimitive.Popup className="modern-surface rounded-tokenLg border border-muted p-3 shadow-overlay">
              <ComboboxPrimitive.List
                id={listboxId}
                aria-label={typeof label === "string" ? label : "Options"}
                className="motion-safe-scroll-area max-h-[min(15rem,calc(100dvh-8rem))] space-y-1 overscroll-contain [scrollbar-gutter:stable] [touch-action:pan-y]"
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
                      aria-labelledby={`${listboxId}-option-${index}-label`}
                      aria-describedby={item.description ? `${listboxId}-option-${index}-description` : undefined}
                      className={(state) =>
                        cx(
                          "focus-ring flex w-full cursor-pointer items-center justify-between gap-3 rounded-tokenMd px-3 py-2 text-left text-sm text-foreground",
                          controlHeightClasses.md,
                          state.highlighted && "bg-background",
                          state.disabled && "cursor-not-allowed opacity-disabled",
                        )
                      }
                    >
                      <span className="min-w-0 flex-1 space-y-0.5">
                        <span id={`${listboxId}-option-${index}-label`} className="block truncate">
                          {item.label}
                        </span>
                        {item.description ? (
                          <span
                            id={`${listboxId}-option-${index}-description`}
                            className="block truncate text-xs text-secondary"
                          >
                            {item.description}
                          </span>
                        ) : null}
                      </span>
                      <ComboboxPrimitive.ItemIndicator className="shrink-0">
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
});
Combobox.displayName = "Combobox";

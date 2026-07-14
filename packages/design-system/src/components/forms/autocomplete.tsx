import { forwardRef, useId, type ReactNode } from "react";
import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";
import { Icon } from "../../icons";
import { usePortalRoots } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { useControllableValue } from "../controllable";
import { controlHeightClasses, controlSquareSizeClasses } from "../control-sizing";
import { FieldChrome, compoundControlClass, controlErrorClass, fieldDescribedBy, type BaseInputProps } from "./shared";

export interface AutocompleteItem {
  value: string;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
}

export interface AutocompleteProps extends BaseInputProps {
  name?: string;
  form?: string;
  items: AutocompleteItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  noMatchesLabel?: string;
}

export const Autocomplete = forwardRef<HTMLInputElement, AutocompleteProps>(function Autocomplete(
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
    placeholder = "Search",
    noMatchesLabel = "No matches",
  },
  ref,
) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const listboxId = useId();
  const { overlayNode } = usePortalRoots();
  const values = items.map((item) => item.value);
  const [selectedValue, setSelectedValue] = useControllableValue(value, defaultValue ?? "", onValueChange);

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
      {name ? <input type="hidden" name={name} form={form} value={selectedValue} /> : null}
      <AutocompletePrimitive.Root
        items={values}
        value={selectedValue}
        onValueChange={(nextValue) => {
          if (nextValue !== null) {
            setSelectedValue(nextValue);
          }
        }}
        itemToStringValue={(itemValue) => items.find((item) => item.value === itemValue)?.label ?? String(itemValue)}
        openOnInputClick
      >
        <AutocompletePrimitive.InputGroup
          className={cx(
            compoundControlClass,
            !!error && controlErrorClass,
            "inline-flex items-center justify-between gap-2",
          )}
        >
          <AutocompletePrimitive.Input
            id={inputId}
            ref={ref}
            placeholder={placeholder}
            aria-controls={listboxId}
            aria-describedby={fieldDescribedBy({ inputId, description, error, status, counter })}
            aria-invalid={!!error || undefined}
            className="min-w-0 flex-1 self-stretch bg-transparent px-[var(--control-md-px)] py-0 outline-none"
          />
          <AutocompletePrimitive.Trigger
            className={cx(
              "focus-ring inline-flex items-center justify-center rounded-tokenSm",
              controlSquareSizeClasses.md,
            )}
          >
            <Icon name="search" size="sm" tone="secondary" />
          </AutocompletePrimitive.Trigger>
        </AutocompletePrimitive.InputGroup>
        <AutocompletePrimitive.Portal container={overlayNode ?? undefined}>
          <AutocompletePrimitive.Positioner sideOffset={8} className="z-popover w-[var(--anchor-width)]">
            <AutocompletePrimitive.Popup className="modern-surface rounded-tokenLg border border-muted p-3 shadow-overlay">
              <AutocompletePrimitive.List id={listboxId} className="motion-safe-scroll-area max-h-60 space-y-1">
                <AutocompletePrimitive.Empty className="rounded-tokenMd bg-background px-3 py-2 text-sm text-secondary">
                  {noMatchesLabel}
                </AutocompletePrimitive.Empty>
                {items.map((item) => (
                  <AutocompletePrimitive.Item
                    key={item.value}
                    value={item.value}
                    disabled={item.disabled}
                    className={(state) =>
                      cx(
                        "focus-ring cursor-pointer rounded-tokenMd px-3 py-2 text-left text-sm text-foreground",
                        controlHeightClasses.md,
                        state.highlighted && "bg-background",
                        state.disabled && "cursor-not-allowed opacity-disabled",
                      )
                    }
                  >
                    <div className="space-y-0.5">
                      <div>{item.label}</div>
                      {item.description ? <div className="text-xs text-secondary">{item.description}</div> : null}
                    </div>
                  </AutocompletePrimitive.Item>
                ))}
              </AutocompletePrimitive.List>
            </AutocompletePrimitive.Popup>
          </AutocompletePrimitive.Positioner>
        </AutocompletePrimitive.Portal>
      </AutocompletePrimitive.Root>
    </FieldChrome>
  );
});
Autocomplete.displayName = "Autocomplete";

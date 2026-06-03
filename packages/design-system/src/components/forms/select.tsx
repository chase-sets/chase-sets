import { useId, useMemo, type SelectHTMLAttributes } from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Icon as ChaseIcon } from "../../icons";
import { usePortalRoots } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { FieldChrome, controlClass, controlErrorClass, fieldHintId, type BaseInputProps } from "./shared";

export interface SelectItem {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface NativeSelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "className" | "style" | "size">, BaseInputProps {
  items: SelectItem[];
  placeholder?: string;
}

export function NativeSelect({
  id,
  label,
  description,
  error,
  required,
  hideLabel,
  items,
  placeholder,
  ...rest
}: NativeSelectProps) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;

  return (
    <FieldChrome
      label={label}
      description={description}
      error={error}
      required={required}
      hideLabel={hideLabel}
      htmlFor={inputId}
    >
      <select
        {...rest}
        id={inputId}
        required={required}
        aria-describedby={error || description ? fieldHintId(inputId) : undefined}
        aria-invalid={!!error || undefined}
        className={cx(controlClass, !!error && controlErrorClass)}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {items.map((item) => (
          <option key={item.value} value={item.value} disabled={item.disabled}>
            {item.label}
          </option>
        ))}
      </select>
    </FieldChrome>
  );
}

export interface SelectProps extends BaseInputProps {
  id?: string;
  items: SelectItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function Select({
  label,
  description,
  error,
  required,
  hideLabel,
  items,
  value,
  defaultValue,
  onValueChange,
  placeholder = "Choose an option",
  disabled = false,
}: SelectProps) {
  const fallbackId = useId();
  const { overlayNode } = usePortalRoots();
  const itemLabels = useMemo(() => Object.fromEntries(items.map((item) => [item.value, item.label])), [items]);

  return (
    <FieldChrome
      label={label}
      description={description}
      error={error}
      required={required}
      hideLabel={hideLabel}
      htmlFor={fallbackId}
    >
      <SelectPrimitive.Root
        items={itemLabels}
        value={value}
        defaultValue={defaultValue}
        onValueChange={(nextValue) => {
          if (nextValue !== null) {
            onValueChange?.(nextValue);
          }
        }}
        disabled={disabled}
      >
        <SelectPrimitive.Trigger
          id={fallbackId}
          aria-describedby={error || description ? fieldHintId(fallbackId) : undefined}
          aria-invalid={!!error || undefined}
          className={cx(
            controlClass,
            !!error && controlErrorClass,
            "inline-flex items-center justify-between gap-2 text-left",
          )}
        >
          <SelectPrimitive.Value placeholder={placeholder} />
          <SelectPrimitive.Icon>
            <ChaseIcon name="chevronDown" size="sm" tone="secondary" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal container={overlayNode ?? undefined}>
          <SelectPrimitive.Positioner
            sideOffset={8}
            className="z-popover min-w-[var(--anchor-width)] max-w-[calc(100vw-2rem)]"
          >
            <SelectPrimitive.Popup className="modern-surface overflow-hidden rounded-tokenLg border border-muted shadow-overlay">
              <SelectPrimitive.List className="motion-safe-scroll-area max-h-[min(18rem,calc(100dvh-8rem))] overscroll-contain p-2 [scrollbar-gutter:stable] [touch-action:pan-y]">
                {items.map((item) => (
                  <SelectPrimitive.Item
                    key={item.value}
                    value={item.value}
                    disabled={item.disabled}
                    className={(state) =>
                      cx(
                        "focus-ring relative flex cursor-pointer select-none items-center rounded-tokenMd px-3 py-2 text-sm text-foreground outline-none",
                        state.disabled && "cursor-not-allowed opacity-50",
                        state.highlighted && "bg-background",
                      )
                    }
                  >
                    <SelectPrimitive.ItemText>
                      <div className="space-y-0.5">
                        <div>{item.label}</div>
                        {item.description ? <div className="text-xs text-secondary">{item.description}</div> : null}
                      </div>
                    </SelectPrimitive.ItemText>
                    <SelectPrimitive.ItemIndicator className="ml-auto">
                      <ChaseIcon name="check" size="sm" tone="accent" />
                    </SelectPrimitive.ItemIndicator>
                  </SelectPrimitive.Item>
                ))}
              </SelectPrimitive.List>
            </SelectPrimitive.Popup>
          </SelectPrimitive.Positioner>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </FieldChrome>
  );
}

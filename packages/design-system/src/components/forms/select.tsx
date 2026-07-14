import { forwardRef, useId, useMemo, type SelectHTMLAttributes } from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Icon as ChaseIcon } from "../../icons";
import { usePortalRoots } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { useControllableValue } from "../controllable";
import { controlHeightClasses } from "../control-sizing";
import { FieldChrome, controlClass, controlErrorClass, fieldDescribedBy, type BaseInputProps } from "./shared";

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

export const NativeSelect = forwardRef<HTMLSelectElement, NativeSelectProps>(function NativeSelect(
  {
    id,
    label,
    description,
    error,
    status,
    counter,
    required,
    hideLabel,
    items,
    placeholder,
    "aria-describedby": ariaDescribedBy,
    ...rest
  },
  ref,
) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;

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
      <select
        {...rest}
        id={inputId}
        ref={ref}
        required={required}
        aria-describedby={fieldDescribedBy({
          inputId,
          description,
          error,
          status,
          counter,
          describedBy: ariaDescribedBy,
        })}
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
});
NativeSelect.displayName = "NativeSelect";

export interface SelectProps extends BaseInputProps {
  id?: string;
  name?: string;
  form?: string;
  items: SelectItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
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
    placeholder = "Choose an option",
    disabled = false,
  },
  ref,
) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const { overlayNode } = usePortalRoots();
  const itemLabels = useMemo(() => Object.fromEntries(items.map((item) => [item.value, item.label])), [items]);
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
      {name ? <input type="hidden" name={name} form={form} value={selectedValue} disabled={disabled} /> : null}
      <SelectPrimitive.Root
        items={itemLabels}
        value={selectedValue}
        onValueChange={(nextValue) => {
          if (nextValue !== null) {
            setSelectedValue(nextValue);
          }
        }}
        disabled={disabled}
      >
        <SelectPrimitive.Trigger
          id={inputId}
          ref={ref}
          aria-describedby={fieldDescribedBy({
            inputId,
            description,
            error,
            status,
            counter,
          })}
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
                        controlHeightClasses.md,
                        state.disabled && "cursor-not-allowed opacity-disabled",
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
});
Select.displayName = "Select";

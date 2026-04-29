import { useId } from "react";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { FieldChrome, type BaseInputProps } from "./shared";
import type { SelectItem } from "./select";

type CheckedState = boolean | "indeterminate";

export interface CheckboxProps extends BaseInputProps {
  checked?: CheckedState;
  defaultChecked?: CheckedState;
  onCheckedChange?: (checked: CheckedState) => void;
  disabled?: boolean;
}

export function Checkbox({
  label,
  description,
  error,
  required,
  hideLabel,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled = false
}: CheckboxProps) {
  const inputId = useId();

  return (
    <FieldChrome
      label={undefined}
      description={error ? undefined : description}
      error={error}
      required={required}
      hideLabel={hideLabel}
    >
      <label
        htmlFor={inputId}
        className="modern-surface flex cursor-pointer items-start gap-3 rounded-tokenMd border border-muted p-3"
      >
        <CheckboxPrimitive.Root
          id={inputId}
          checked={checked === "indeterminate" ? false : checked}
          defaultChecked={defaultChecked === "indeterminate" ? false : defaultChecked}
          indeterminate={checked === "indeterminate" || defaultChecked === "indeterminate"}
          onCheckedChange={(nextChecked) => onCheckedChange?.(nextChecked)}
          disabled={disabled}
          className={(state) => cx(
            "focus-ring mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-elevated",
            (state.checked || state.indeterminate) && "border-accent bg-accent",
            state.disabled && "opacity-60"
          )}
        >
          <CheckboxPrimitive.Indicator>
            <Icon name={checked === "indeterminate" ? "minus" : "check"} size="sm" tone="inverse" />
          </CheckboxPrimitive.Indicator>
        </CheckboxPrimitive.Root>
        <div className="space-y-1">
          {label ? (
            <div className="text-sm font-medium text-foreground">
              {label}
              {required ? <span className="ml-1 text-accent">*</span> : null}
            </div>
          ) : null}
          {description ? <div className="text-xs text-secondary">{description}</div> : null}
        </div>
      </label>
    </FieldChrome>
  );
}

export interface CheckboxGroupProps extends BaseInputProps {
  items: SelectItem[];
  values: string[];
  onValuesChange?: (values: string[]) => void;
}

export function CheckboxGroup({
  label,
  description,
  error,
  required,
  hideLabel,
  items,
  values,
  onValuesChange
}: CheckboxGroupProps) {
  return (
    <FieldChrome
      label={label}
      description={description}
      error={error}
      required={required}
      hideLabel={hideLabel}
    >
      <div className="space-y-2">
        {items.map((item) => {
          const checked = values.includes(item.value);

          return (
            <Checkbox
              key={item.value}
              label={item.label}
              description={item.description}
              checked={checked}
              onCheckedChange={(state) => {
                const next = state
                  ? [...values, item.value]
                  : values.filter((entry) => entry !== item.value);
                onValuesChange?.(Array.from(new Set(next)));
              }}
            />
          );
        })}
      </div>
    </FieldChrome>
  );
}

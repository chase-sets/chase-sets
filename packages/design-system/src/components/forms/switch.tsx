import { forwardRef, useId } from "react";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cx } from "../../utils/cx";
import { FieldChrome, fieldDescribedBy, type BaseInputProps } from "./shared";

export interface SwitchProps extends BaseInputProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  readOnly?: boolean;
  name?: string;
  form?: string;
  value?: string;
  uncheckedValue?: string;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  {
    id,
    label,
    description,
    error,
    status,
    counter,
    required,
    hideLabel,
    checked,
    defaultChecked,
    onCheckedChange,
    disabled = false,
    readOnly = false,
    name,
    form,
    value,
    uncheckedValue,
  },
  ref,
) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;

  return (
    <FieldChrome
      label={undefined}
      description={description}
      error={error}
      status={status}
      counter={counter}
      required={required}
      hideLabel={hideLabel}
      htmlFor={inputId}
    >
      <label
        htmlFor={inputId}
        className="modern-surface flex cursor-pointer items-center justify-between gap-4 rounded-tokenMd border border-muted p-3"
      >
        <div className="space-y-1">
          {label ? (
            <div className="text-sm font-medium text-foreground">
              {label}
              {required ? <span aria-hidden="true" className="ml-1 text-accent before:content-['*']" /> : null}
            </div>
          ) : null}
        </div>
        <SwitchPrimitive.Root
          id={inputId}
          ref={ref}
          name={name}
          form={form}
          value={value}
          uncheckedValue={uncheckedValue}
          checked={checked}
          defaultChecked={defaultChecked}
          onCheckedChange={(nextChecked) => onCheckedChange?.(nextChecked)}
          disabled={disabled}
          readOnly={readOnly}
          required={required}
          aria-describedby={fieldDescribedBy({ inputId, description, error, status, counter })}
          aria-invalid={!!error || undefined}
          className={(state) =>
            cx(
              "focus-ring relative inline-flex h-7 w-12 items-center rounded-tokenFull bg-muted transition",
              state.checked && "bg-accent",
              state.disabled && "opacity-60",
            )
          }
        >
          <SwitchPrimitive.Thumb
            className={(state) =>
              cx(
                "block h-5 w-5 translate-x-1 rounded-tokenFull bg-elevated shadow-tokenSm transition",
                state.checked && "translate-x-6",
              )
            }
          />
        </SwitchPrimitive.Root>
      </label>
    </FieldChrome>
  );
});
Switch.displayName = "Switch";

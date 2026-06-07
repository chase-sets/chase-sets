import { useId } from "react";
import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { controlIconButtonSizeClasses } from "../control-sizing";
import { FieldChrome, compoundControlClass, controlErrorClass, fieldDescribedBy, type BaseInputProps } from "./shared";

export interface NumberFieldProps extends BaseInputProps {
  name?: string;
  form?: string;
  value?: number | null;
  defaultValue?: number;
  onValueChange?: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number | "any";
  disabled?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  decrementLabel?: string;
  incrementLabel?: string;
}

export function NumberField({
  id,
  label,
  description,
  error,
  status,
  counter,
  required,
  hideLabel,
  name,
  form,
  value,
  defaultValue,
  onValueChange,
  min,
  max,
  step = 1,
  disabled = false,
  readOnly = false,
  placeholder,
  decrementLabel = "Decrease value",
  incrementLabel = "Increase value",
}: NumberFieldProps) {
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
      <NumberFieldPrimitive.Root
        id={inputId}
        name={name}
        form={form}
        value={value}
        defaultValue={defaultValue}
        onValueChange={(nextValue) => onValueChange?.(nextValue)}
        min={min}
        max={max}
        step={step}
        required={required}
        disabled={disabled}
        readOnly={readOnly}
      >
        <NumberFieldPrimitive.Group
          className={cx(
            compoundControlClass,
            !!error && controlErrorClass,
            "grid grid-cols-[var(--control-md-icon-size)_minmax(0,1fr)_var(--control-md-icon-size)] items-center gap-1",
          )}
        >
          <NumberFieldPrimitive.Decrement
            aria-label={decrementLabel}
            className={cx(
              "focus-ring inline-flex items-center justify-center rounded-tokenSm text-secondary hover:bg-background",
              controlIconButtonSizeClasses.md,
            )}
          >
            <Icon name="minus" size="sm" />
          </NumberFieldPrimitive.Decrement>
          <NumberFieldPrimitive.Input
            placeholder={placeholder}
            aria-describedby={fieldDescribedBy({ inputId, description, error, status, counter })}
            aria-invalid={!!error || undefined}
            className="min-w-0 bg-transparent px-2 py-[var(--control-sm-py)] text-center outline-none"
          />
          <NumberFieldPrimitive.Increment
            aria-label={incrementLabel}
            className={cx(
              "focus-ring inline-flex items-center justify-center rounded-tokenSm text-secondary hover:bg-background",
              controlIconButtonSizeClasses.md,
            )}
          >
            <Icon name="plus" size="sm" />
          </NumberFieldPrimitive.Increment>
        </NumberFieldPrimitive.Group>
      </NumberFieldPrimitive.Root>
    </FieldChrome>
  );
}

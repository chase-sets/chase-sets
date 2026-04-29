import { useId } from "react";
import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { FieldChrome, controlClass, controlErrorClass, fieldHintId, type BaseInputProps } from "./shared";

export interface NumberFieldProps extends BaseInputProps {
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
  required,
  hideLabel,
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
  incrementLabel = "Increase value"
}: NumberFieldProps) {
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
      <NumberFieldPrimitive.Root
        id={inputId}
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
            controlClass,
            !!error && controlErrorClass,
            "grid grid-cols-[2rem_minmax(0,1fr)_2rem] items-center gap-1 p-1"
          )}
        >
          <NumberFieldPrimitive.Decrement
            aria-label={decrementLabel}
            className="focus-ring inline-flex h-8 w-8 items-center justify-center rounded-tokenSm text-secondary hover:bg-background"
          >
            <Icon name="minus" size="sm" />
          </NumberFieldPrimitive.Decrement>
          <NumberFieldPrimitive.Input
            placeholder={placeholder}
            aria-describedby={(error || description) ? fieldHintId(inputId) : undefined}
            aria-invalid={!!error || undefined}
            className="min-w-0 bg-transparent px-2 py-1.5 text-center outline-none"
          />
          <NumberFieldPrimitive.Increment
            aria-label={incrementLabel}
            className="focus-ring inline-flex h-8 w-8 items-center justify-center rounded-tokenSm text-secondary hover:bg-background"
          >
            <Icon name="plus" size="sm" />
          </NumberFieldPrimitive.Increment>
        </NumberFieldPrimitive.Group>
      </NumberFieldPrimitive.Root>
    </FieldChrome>
  );
}

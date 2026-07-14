import { forwardRef, useId } from "react";
import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { controlSquareSizeClasses } from "../control-sizing";
import { FieldChrome, compoundControlClass, controlErrorClass, fieldDescribedBy, type BaseInputProps } from "./shared";

export interface QuantityStepperProps extends BaseInputProps {
  name?: string;
  form?: string;
  /** Controlled value. Pass `null` to represent an empty/cleared state. */
  value?: number | null;
  defaultValue?: number;
  onValueChange?: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  /** Show a loading indicator; disables both stepper buttons during optimistic-correction. */
  loading?: boolean;
  /** Accessible label for the decrement (−) button. */
  decrementLabel?: string;
  /** Accessible label for the increment (+) button. */
  incrementLabel?: string;
}

/**
 * QuantityStepper — canonical compact stepper for cart and order-entry flows.
 *
 * Renders −/+ flanking buttons around a centered, editable numeric value built
 * on Base UI NumberField. Supports controlled `value`/`onValueChange`, `min`,
 * `max`, `step`, and an optimistic-correction `loading` state that disables
 * both buttons while a mutation is in-flight.
 *
 * Native number-input spinner chevrons are suppressed globally in styles.css;
 * this component inherits that suppression automatically.
 */
export const QuantityStepper = forwardRef<HTMLInputElement, QuantityStepperProps>(function QuantityStepper(
  {
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
    min = 0,
    max,
    step = 1,
    disabled = false,
    loading = false,
    decrementLabel = "Decrease quantity",
    incrementLabel = "Increase quantity",
  },
  ref,
) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const isInteractionDisabled = disabled || loading;

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
        disabled={isInteractionDisabled}
      >
        <NumberFieldPrimitive.Group
          aria-label={label ? undefined : "Quantity"}
          className={cx(
            compoundControlClass,
            !!error && controlErrorClass,
            isInteractionDisabled && "cursor-not-allowed opacity-60",
            "grid grid-cols-[var(--control-sm-height)_minmax(0,1fr)_var(--control-sm-height)] items-center gap-1",
          )}
        >
          <NumberFieldPrimitive.Decrement
            aria-label={decrementLabel}
            className={cx(
              "focus-ring inline-flex items-center justify-center rounded-tokenSm text-secondary hover:bg-background",
              controlSquareSizeClasses.sm,
              "disabled:pointer-events-none",
            )}
          >
            <Icon name="minus" size="sm" />
          </NumberFieldPrimitive.Decrement>
          <NumberFieldPrimitive.Input
            ref={ref}
            role="spinbutton"
            inputMode="numeric"
            aria-label={label ? undefined : "Quantity"}
            aria-describedby={fieldDescribedBy({ inputId, description, error, status, counter })}
            aria-invalid={!!error || undefined}
            aria-busy={loading || undefined}
            className="min-w-0 bg-transparent px-1 py-[var(--control-sm-py)] text-center text-sm font-medium tabular-nums outline-none"
          />
          <NumberFieldPrimitive.Increment
            aria-label={incrementLabel}
            className={cx(
              "focus-ring inline-flex items-center justify-center rounded-tokenSm text-secondary hover:bg-background",
              controlSquareSizeClasses.sm,
              "disabled:pointer-events-none",
            )}
          >
            <Icon name="plus" size="sm" />
          </NumberFieldPrimitive.Increment>
        </NumberFieldPrimitive.Group>
      </NumberFieldPrimitive.Root>
    </FieldChrome>
  );
});
QuantityStepper.displayName = "QuantityStepper";

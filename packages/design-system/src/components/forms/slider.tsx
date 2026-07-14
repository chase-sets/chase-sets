import { forwardRef, useId } from "react";
import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cx } from "../../utils/cx";
import { controlHeightClasses } from "../control-sizing";
import { FieldChrome, fieldDescribedBy, type BaseInputProps } from "./shared";

export interface SliderProps extends BaseInputProps {
  name?: string;
  form?: string;
  value?: number;
  defaultValue?: number;
  onValueChange?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}

export const Slider = forwardRef<HTMLInputElement, SliderProps>(function Slider(
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
    max = 100,
    step = 1,
    disabled = false,
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
      <div className="modern-surface space-y-2 rounded-tokenMd border border-muted p-4">
        <SliderPrimitive.Root
          id={inputId}
          name={name}
          form={form}
          min={min}
          max={max}
          step={step}
          value={value}
          defaultValue={defaultValue}
          onValueChange={(nextValue) => onValueChange?.(nextValue)}
          disabled={disabled}
          aria-describedby={fieldDescribedBy({ inputId, description, error, status, counter })}
          aria-invalid={!!error || undefined}
          className={cx("relative flex w-full items-center", controlHeightClasses.md)}
        >
          <SliderPrimitive.Control className={cx("relative flex w-full items-center", controlHeightClasses.md)}>
            <SliderPrimitive.Track className="relative h-2 w-full rounded-tokenFull bg-muted">
              <SliderPrimitive.Indicator className="absolute h-full rounded-tokenFull bg-accent" />
            </SliderPrimitive.Track>
            <SliderPrimitive.Thumb
              inputRef={ref}
              className="focus-ring block h-5 w-5 rounded-tokenFull border border-accent bg-elevated shadow-tokenSm"
            />
          </SliderPrimitive.Control>
        </SliderPrimitive.Root>
        <div className="flex justify-between text-xs text-secondary">
          <span>{min}</span>
          <span>{value ?? defaultValue ?? min}</span>
          <span>{max}</span>
        </div>
      </div>
    </FieldChrome>
  );
});
Slider.displayName = "Slider";

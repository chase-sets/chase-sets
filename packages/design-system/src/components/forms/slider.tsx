import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { FieldChrome, type BaseInputProps } from "./shared";

export interface SliderProps extends BaseInputProps {
  value?: number;
  defaultValue?: number;
  onValueChange?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

export function Slider({
  label,
  description,
  error,
  required,
  hideLabel,
  value,
  defaultValue,
  onValueChange,
  min = 0,
  max = 100,
  step = 1
}: SliderProps) {
  return (
    <FieldChrome
      label={label}
      description={description}
      error={error}
      required={required}
      hideLabel={hideLabel}
    >
      <div className="modern-surface space-y-2 rounded-tokenMd border border-muted p-4">
        <SliderPrimitive.Root
          min={min}
          max={max}
          step={step}
          value={value}
          defaultValue={defaultValue}
          onValueChange={(nextValue) => onValueChange?.(nextValue)}
          className="relative flex h-6 w-full items-center"
        >
          <SliderPrimitive.Control className="relative flex h-6 w-full items-center">
            <SliderPrimitive.Track className="relative h-2 w-full rounded-full bg-muted">
              <SliderPrimitive.Indicator className="absolute h-full rounded-full bg-accent" />
            </SliderPrimitive.Track>
            <SliderPrimitive.Thumb className="focus-ring block h-5 w-5 rounded-full border border-accent bg-elevated shadow-tokenSm" />
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
}

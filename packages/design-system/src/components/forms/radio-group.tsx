import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { FieldChrome, type BaseInputProps } from "./shared";
import type { SelectItem } from "./select";

export interface RadioGroupProps extends BaseInputProps {
  items: SelectItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

export function RadioGroup({
  label,
  description,
  error,
  required,
  hideLabel,
  items,
  value,
  defaultValue,
  onValueChange
}: RadioGroupProps) {
  return (
    <FieldChrome
      label={label}
      description={description}
      error={error}
      required={required}
      hideLabel={hideLabel}
    >
      <RadioGroupPrimitive.Root
        value={value}
        defaultValue={defaultValue}
        onValueChange={onValueChange}
        className="space-y-2"
      >
        {items.map((item) => (
          <label
            key={item.value}
            className="modern-surface flex cursor-pointer items-start gap-3 rounded-tokenMd border border-muted p-3"
          >
            <RadioGroupPrimitive.Item
              value={item.value}
              className="focus-ring mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border bg-background"
            >
              <RadioGroupPrimitive.Indicator className="h-2.5 w-2.5 rounded-full bg-accent" />
            </RadioGroupPrimitive.Item>
            <div className="space-y-1">
              <div className="text-sm font-medium text-foreground">{item.label}</div>
              {item.description ? (
                <div className="text-xs text-secondary">{item.description}</div>
              ) : null}
            </div>
          </label>
        ))}
      </RadioGroupPrimitive.Root>
    </FieldChrome>
  );
}

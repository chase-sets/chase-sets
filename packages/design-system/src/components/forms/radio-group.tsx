import { forwardRef, useId } from "react";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cx } from "../../utils/cx";
import { FieldChrome, fieldDescribedBy, type BaseInputProps } from "./shared";
import type { SelectItem } from "./select";

export interface RadioGroupProps extends BaseInputProps {
  items: SelectItem[];
  name?: string;
  form?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  readOnly?: boolean;
}

export const RadioGroup = forwardRef<HTMLButtonElement, RadioGroupProps>(function RadioGroup(
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
    name,
    form,
    value,
    defaultValue,
    onValueChange,
    disabled = false,
    readOnly = false,
  },
  ref,
) {
  const fallbackId = useId();
  const groupId = id ?? fallbackId;
  const legendId = `${groupId}-legend`;

  return (
    <FieldChrome
      label={undefined}
      description={description}
      error={error}
      status={status}
      counter={counter}
      required={required}
      hideLabel={hideLabel}
      htmlFor={groupId}
    >
      {label ? (
        <div id={legendId} className={cx("text-sm font-medium text-foreground", hideLabel && "sr-only")}>
          {label}
          {required ? <span aria-hidden="true" className="ml-1 text-accent before:content-['*']" /> : null}
        </div>
      ) : null}
      <RadioGroupPrimitive
        id={groupId}
        aria-labelledby={label ? legendId : undefined}
        aria-describedby={fieldDescribedBy({ inputId: groupId, description, error, status, counter })}
        aria-invalid={!!error || undefined}
        name={name}
        form={form}
        value={value}
        defaultValue={defaultValue}
        onValueChange={(nextValue) => onValueChange?.(nextValue)}
        required={required}
        disabled={disabled}
        readOnly={readOnly}
        className="space-y-2"
      >
        {items.map((item, index) => {
          const itemId = `${groupId}-option-${index}`;
          const itemLabelId = `${itemId}-label`;
          const itemDescriptionId = item.description ? `${itemId}-description` : undefined;

          return (
            <Radio.Root
              key={item.value}
              ref={index === 0 ? ref : undefined}
              id={itemId}
              value={item.value}
              aria-labelledby={itemLabelId}
              aria-describedby={itemDescriptionId}
              className="modern-surface focus-ring flex w-full cursor-pointer items-start gap-3 rounded-tokenMd border border-muted p-3 text-left"
            >
              <span
                aria-hidden="true"
                className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-tokenFull border border-border bg-background"
              >
                <Radio.Indicator className="h-2.5 w-2.5 rounded-tokenFull bg-accent" />
              </span>
              <span className="space-y-1">
                <span id={itemLabelId} className="block text-sm font-medium text-foreground">
                  {item.label}
                </span>
                {item.description ? (
                  <span id={itemDescriptionId} className="block text-xs text-secondary">
                    {item.description}
                  </span>
                ) : null}
              </span>
            </Radio.Root>
          );
        })}
      </RadioGroupPrimitive>
    </FieldChrome>
  );
});
RadioGroup.displayName = "RadioGroup";

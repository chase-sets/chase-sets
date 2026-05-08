import { useEffect, useId, useRef, useState } from "react";
import { Check, Minus } from "lucide-react";
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
  const inputRef = useRef<HTMLInputElement>(null);
  const controlled = checked !== undefined;
  const [uncontrolledChecked, setUncontrolledChecked] = useState(defaultChecked === true);
  const [uncontrolledIndeterminate, setUncontrolledIndeterminate] = useState(defaultChecked === "indeterminate");

  const visualChecked = controlled ? checked === true : uncontrolledChecked;
  const indeterminate = controlled ? checked === "indeterminate" : uncontrolledIndeterminate;
  const IndicatorIcon = indeterminate ? Minus : Check;

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

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
        <input
          id={inputId}
          ref={inputRef}
          type="checkbox"
          className="peer sr-only"
          disabled={disabled}
          required={required}
          {...(controlled
            ? { checked: checked === true }
            : { defaultChecked: defaultChecked === true })}
          onChange={(event) => {
            const nextChecked = event.currentTarget.checked;
            if (!controlled) {
              setUncontrolledChecked(nextChecked);
              setUncontrolledIndeterminate(false);
            }
            onCheckedChange?.(nextChecked);
          }}
        />
        <span
          aria-hidden="true"
          className={cx(
            "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-elevated peer-focus-visible:shadow-[0_0_0_2px_var(--ring),0_0_0_5px_color-mix(in_srgb,var(--ring)_18%,transparent)]",
            (visualChecked || indeterminate) && "border-accent bg-accent",
            disabled && "opacity-60"
          )}
        >
          {visualChecked || indeterminate ? (
            <IndicatorIcon
              aria-hidden="true"
              className="h-4 w-4 text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)]"
              strokeWidth={2.75}
            />
          ) : null}
        </span>
        <div className="space-y-1">
          {label ? (
            <div className="text-sm font-medium text-foreground">
              {label}
              {required ? <span aria-hidden="true" className="ml-1 text-accent">*</span> : null}
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

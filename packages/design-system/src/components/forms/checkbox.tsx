import { forwardRef, useEffect, useId, useRef, useState } from "react";
// The indeterminate/checked indicator imports lucide icons directly: the DS `Icon`
// does not expose the precise `strokeWidth`/sizing this 16px in-control glyph needs.
// Documented leaf — keep the raw lucide import here.
import { Check, Minus } from "lucide-react";
import { cx } from "../../utils/cx";
import { FieldChrome, RequiredMarker, fieldDescribedBy, type BaseInputProps } from "./shared";
import type { SelectItem } from "./select";

type CheckedState = boolean | "indeterminate";

export interface CheckboxProps extends BaseInputProps {
  checked?: CheckedState;
  defaultChecked?: CheckedState;
  onCheckedChange?: (checked: CheckedState) => void;
  disabled?: boolean;
  readOnly?: boolean;
  name?: string;
  value?: string;
  form?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
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
    value,
    form,
  },
  ref,
) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
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
        className="modern-surface flex cursor-pointer items-start gap-3 rounded-tokenMd border border-muted p-3"
      >
        <input
          id={inputId}
          ref={(node) => {
            inputRef.current = node;
            if (typeof ref === "function") {
              ref(node);
            } else if (ref) {
              ref.current = node;
            }
          }}
          type="checkbox"
          name={name}
          value={value}
          form={form}
          className="peer sr-only"
          disabled={disabled}
          readOnly={readOnly}
          required={required}
          aria-readonly={readOnly || undefined}
          aria-describedby={fieldDescribedBy({ inputId, description, error, status, counter })}
          aria-invalid={!!error || undefined}
          {...(controlled ? { checked: checked === true } : { defaultChecked: defaultChecked === true })}
          onClick={(event) => {
            if (readOnly) {
              event.preventDefault();
            }
          }}
          onChange={(event) => {
            if (readOnly) {
              event.preventDefault();
              return;
            }
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
            "focus-ring mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-elevated",
            (visualChecked || indeterminate) && "border-accent bg-accent",
            disabled && "opacity-60",
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
            <div className={cx("text-sm font-medium text-foreground", hideLabel && "sr-only")}>
              {label}
              {required ? <RequiredMarker /> : null}
            </div>
          ) : null}
        </div>
      </label>
    </FieldChrome>
  );
});
Checkbox.displayName = "Checkbox";

export interface CheckboxGroupProps extends BaseInputProps {
  items: SelectItem[];
  values: string[];
  onValuesChange?: (values: string[]) => void;
  name?: string;
  form?: string;
  disabled?: boolean;
  readOnly?: boolean;
}

export const CheckboxGroup = forwardRef<HTMLInputElement, CheckboxGroupProps>(function CheckboxGroup(
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
    values,
    onValuesChange,
    name,
    form,
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
      <fieldset
        id={groupId}
        disabled={disabled}
        aria-labelledby={label ? legendId : undefined}
        aria-describedby={fieldDescribedBy({ inputId: groupId, description, error, status, counter })}
        aria-invalid={!!error || undefined}
        className="min-w-0 border-0 p-0"
      >
        {label ? (
          <legend id={legendId} className={cx("mb-2 text-sm font-medium text-foreground", hideLabel && "sr-only")}>
            {label}
            {required ? <RequiredMarker /> : null}
          </legend>
        ) : null}
        <div className="space-y-2">
          {items.map((item, index) => {
            const checked = values.includes(item.value);

            return (
              <Checkbox
                key={item.value}
                ref={index === 0 ? ref : undefined}
                label={item.label}
                description={item.description}
                disabled={disabled}
                readOnly={readOnly}
                name={name}
                value={item.value}
                form={form}
                checked={checked}
                onCheckedChange={(state) => {
                  const next = state ? [...values, item.value] : values.filter((entry) => entry !== item.value);
                  onValuesChange?.(Array.from(new Set(next)));
                }}
              />
            );
          })}
        </div>
      </fieldset>
    </FieldChrome>
  );
});
CheckboxGroup.displayName = "CheckboxGroup";

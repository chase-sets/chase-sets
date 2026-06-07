import { useId, type InputHTMLAttributes } from "react";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { FieldChrome, controlClass, controlErrorClass, fieldDescribedBy, type BaseInputProps } from "./shared";

export interface TextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "style" | "size">, BaseInputProps {}

export function TextInput({
  id,
  label,
  description,
  error,
  status,
  counter,
  required,
  hideLabel,
  type = "text",
  "aria-describedby": ariaDescribedBy,
  ...rest
}: TextInputProps) {
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
      <input
        {...rest}
        id={inputId}
        required={required}
        type={type}
        aria-describedby={fieldDescribedBy({
          inputId,
          description,
          error,
          status,
          counter,
          describedBy: ariaDescribedBy,
        })}
        aria-invalid={!!error || undefined}
        className={cx(controlClass, !!error && controlErrorClass)}
      />
    </FieldChrome>
  );
}

export interface NumberInputProps extends TextInputProps {}

export function NumberInput(props: NumberInputProps) {
  return <TextInput {...props} type="number" inputMode="numeric" />;
}

export interface CurrencyInputProps extends TextInputProps {
  currencySymbol?: string;
}

export function CurrencyInput({
  id,
  label,
  description,
  error,
  status,
  counter,
  required,
  hideLabel,
  currencySymbol = "$",
  "aria-describedby": ariaDescribedBy,
  ...rest
}: CurrencyInputProps) {
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
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-[var(--control-md-px)] flex items-center text-secondary">
          {currencySymbol}
        </span>
        <input
          {...rest}
          id={inputId}
          required={required}
          type="number"
          inputMode="decimal"
          aria-describedby={fieldDescribedBy({
            inputId,
            description,
            error,
            status,
            counter,
            describedBy: ariaDescribedBy,
          })}
          aria-invalid={!!error || undefined}
          className={cx(controlClass, !!error && controlErrorClass, "pl-[calc(var(--control-md-px)+1rem)]")}
        />
      </div>
    </FieldChrome>
  );
}

export interface SearchInputProps extends TextInputProps {}

export function SearchInput({
  id,
  label = "Search",
  description,
  error,
  status,
  counter,
  required,
  hideLabel,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: SearchInputProps) {
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
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-[var(--control-md-px)] flex items-center">
          <Icon name="search" size="sm" tone="secondary" />
        </span>
        <input
          {...rest}
          id={inputId}
          required={required}
          type="search"
          aria-describedby={fieldDescribedBy({
            inputId,
            description,
            error,
            status,
            counter,
            describedBy: ariaDescribedBy,
          })}
          aria-invalid={!!error || undefined}
          className={cx(controlClass, !!error && controlErrorClass, "pl-[calc(var(--control-md-px)+1.5rem)]")}
        />
      </div>
    </FieldChrome>
  );
}

export interface DateInputProps extends TextInputProps {}

export function DateInput(props: DateInputProps) {
  return <TextInput {...props} type="date" />;
}

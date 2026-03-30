import { useId, type InputHTMLAttributes } from "react";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { FieldChrome, controlClass, type BaseInputProps } from "./shared";

export interface TextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "style" | "size">,
    BaseInputProps {}

export function TextInput({
  id,
  label,
  description,
  error,
  required,
  hideLabel,
  type = "text",
  ...rest
}: TextInputProps) {
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
      <input {...rest} id={inputId} required={required} type={type} className={controlClass} />
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
  required,
  hideLabel,
  currencySymbol = "$",
  ...rest
}: CurrencyInputProps) {
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
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-4 flex items-center text-secondary">
          {currencySymbol}
        </span>
        <input
          {...rest}
          id={inputId}
          required={required}
          type="number"
          inputMode="decimal"
          className={cx(controlClass, "pl-8")}
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
  required,
  hideLabel,
  ...rest
}: SearchInputProps) {
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
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-4 flex items-center">
          <Icon name="search" size="sm" tone="secondary" />
        </span>
        <input
          {...rest}
          id={inputId}
          required={required}
          type="search"
          className={cx(controlClass, "pl-10")}
        />
      </div>
    </FieldChrome>
  );
}

export interface DateInputProps extends TextInputProps {}

export function DateInput(props: DateInputProps) {
  return <TextInput {...props} type="date" />;
}

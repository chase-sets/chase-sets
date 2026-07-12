import { useId, type InputHTMLAttributes } from "react";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { InputAddon } from "./input-addon";
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
      <InputAddon start={{ content: <Icon name="search" size="sm" tone="secondary" /> }}>
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
      </InputAddon>
    </FieldChrome>
  );
}

export interface DateInputProps extends TextInputProps {}

export function DateInput(props: DateInputProps) {
  return <TextInput {...props} type="date" />;
}

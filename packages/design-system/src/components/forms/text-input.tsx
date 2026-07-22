import { forwardRef, useId, type InputHTMLAttributes } from "react";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import type { ControlSize } from "../control-sizing";
import { InputAddon } from "./input-addon";
import { FieldChrome, controlClassForSize, controlErrorClass, fieldDescribedBy, type BaseInputProps } from "./shared";

export interface TextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "style" | "size">, BaseInputProps {
  controlSize?: ControlSize;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  {
    id,
    label,
    description,
    error,
    status,
    counter,
    required,
    hideLabel,
    type = "text",
    controlSize = "md",
    "aria-describedby": ariaDescribedBy,
    ...rest
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
      <input
        {...rest}
        id={inputId}
        ref={ref}
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
        className={cx(controlClassForSize(controlSize), !!error && controlErrorClass)}
      />
    </FieldChrome>
  );
});
TextInput.displayName = "TextInput";

export interface SearchInputProps extends TextInputProps {}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  {
    id,
    label = "Search",
    description,
    error,
    status,
    counter,
    required,
    hideLabel,
    controlSize = "md",
    "aria-describedby": ariaDescribedBy,
    ...rest
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
      <InputAddon start={{ content: <Icon name="search" size="sm" tone="secondary" /> }}>
        <input
          {...rest}
          id={inputId}
          ref={ref}
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
          className={cx(
            controlClassForSize(controlSize),
            !!error && controlErrorClass,
            "pl-[calc(var(--control-md-px)+1.5rem)]",
          )}
        />
      </InputAddon>
    </FieldChrome>
  );
});
SearchInput.displayName = "SearchInput";

export interface DateInputProps extends TextInputProps {}

export const DateInput = forwardRef<HTMLInputElement, DateInputProps>(function DateInput(props, ref) {
  return <TextInput {...props} ref={ref} type="date" />;
});
DateInput.displayName = "DateInput";

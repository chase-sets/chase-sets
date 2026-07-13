import { forwardRef, useId, type TextareaHTMLAttributes } from "react";
import { cx } from "../../utils/cx";
import { FieldChrome, controlClass, controlErrorClass, fieldDescribedBy, type BaseInputProps } from "./shared";

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className" | "style">, BaseInputProps {}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    id,
    label,
    description,
    error,
    status,
    counter,
    required,
    hideLabel,
    rows = 4,
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
      <textarea
        {...rest}
        id={inputId}
        ref={ref}
        required={required}
        rows={rows}
        aria-describedby={fieldDescribedBy({
          inputId,
          description,
          error,
          status,
          counter,
          describedBy: ariaDescribedBy,
        })}
        aria-invalid={!!error || undefined}
        className={cx(controlClass, !!error && controlErrorClass, "min-h-28 resize-y")}
      />
    </FieldChrome>
  );
});
Textarea.displayName = "Textarea";

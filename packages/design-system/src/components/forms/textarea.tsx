import { useId, type TextareaHTMLAttributes } from "react";
import { cx } from "../../utils/cx";
import { FieldChrome, controlClass, type BaseInputProps } from "./shared";

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className" | "style">,
    BaseInputProps {}

export function Textarea({
  id,
  label,
  description,
  error,
  required,
  hideLabel,
  rows = 4,
  ...rest
}: TextareaProps) {
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
      <textarea
        {...rest}
        id={inputId}
        required={required}
        rows={rows}
        className={cx(controlClass, "min-h-28 resize-y")}
      />
    </FieldChrome>
  );
}

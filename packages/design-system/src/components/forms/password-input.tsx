import { useId, useState } from "react";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { FieldChrome, controlClass, controlErrorClass, fieldHintId } from "./shared";
import type { TextInputProps } from "./text-input";

export interface PasswordInputProps extends TextInputProps {
  showPasswordLabel?: string;
  hidePasswordLabel?: string;
}

export function PasswordInput({
  showPasswordLabel = "Show password",
  hidePasswordLabel = "Hide password",
  id,
  label,
  description,
  error,
  required,
  hideLabel,
  ...rest
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
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
        <input
          {...rest}
          id={inputId}
          required={required}
          type={visible ? "text" : "password"}
          aria-describedby={error || description ? fieldHintId(inputId) : undefined}
          aria-invalid={!!error || undefined}
          className={cx(controlClass, !!error && controlErrorClass, "pr-12")}
        />
        <button
          type="button"
          className="focus-ring absolute inset-y-0 right-3 flex items-center rounded-sm"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? hidePasswordLabel : showPasswordLabel}
        >
          <Icon name={visible ? "eyeOff" : "eye"} size="sm" tone="secondary" />
        </button>
      </div>
    </FieldChrome>
  );
}

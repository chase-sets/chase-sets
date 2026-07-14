import { forwardRef, useId, useState } from "react";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { controlSquareSizeClasses } from "../control-sizing";
import { InputAddon } from "./input-addon";
import { FieldChrome, controlClass, controlErrorClass, fieldDescribedBy } from "./shared";
import type { TextInputProps } from "./text-input";

export interface PasswordInputProps extends TextInputProps {
  showPasswordLabel?: string;
  hidePasswordLabel?: string;
}

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(
  {
    showPasswordLabel = "Show password",
    hidePasswordLabel = "Hide password",
    id,
    label,
    description,
    error,
    status,
    counter,
    required,
    hideLabel,
    ...rest
  },
  ref,
) {
  const [visible, setVisible] = useState(false);
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
      <InputAddon
        end={{
          interactive: true,
          content: (
            <button
              type="button"
              className={cx("focus-ring flex items-center justify-center rounded-sm", controlSquareSizeClasses.md)}
              onClick={() => setVisible((v) => !v)}
              aria-label={visible ? hidePasswordLabel : showPasswordLabel}
            >
              <Icon name={visible ? "eyeOff" : "eye"} size="sm" tone="secondary" />
            </button>
          ),
        }}
      >
        <input
          {...rest}
          id={inputId}
          ref={ref}
          required={required}
          type={visible ? "text" : "password"}
          aria-describedby={fieldDescribedBy({ inputId, description, error, status, counter })}
          aria-invalid={!!error || undefined}
          className={cx(
            controlClass,
            !!error && controlErrorClass,
            "pr-[calc(var(--control-md-px)+var(--control-md-height))]",
          )}
        />
      </InputAddon>
    </FieldChrome>
  );
});
PasswordInput.displayName = "PasswordInput";

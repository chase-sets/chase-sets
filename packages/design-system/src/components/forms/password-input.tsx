import { useId, useState } from "react";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { InputAddon } from "./input-addon";
import { FieldChrome, controlClass, controlErrorClass, fieldDescribedBy } from "./shared";
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
  status,
  counter,
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
              className="focus-ring flex items-center rounded-sm"
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
          required={required}
          type={visible ? "text" : "password"}
          aria-describedby={fieldDescribedBy({ inputId, description, error, status, counter })}
          aria-invalid={!!error || undefined}
          className={cx(controlClass, !!error && controlErrorClass, "pr-[calc(var(--control-md-px)+2rem)]")}
        />
      </InputAddon>
    </FieldChrome>
  );
}

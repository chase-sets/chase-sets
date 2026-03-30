import { useId } from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { FieldChrome, type BaseInputProps } from "./shared";

export interface SwitchProps extends BaseInputProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
}

export function Switch({
  label,
  description,
  error,
  required,
  hideLabel,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled = false
}: SwitchProps) {
  const inputId = useId();

  return (
    <FieldChrome
      label={undefined}
      description={error ? undefined : description}
      error={error}
      required={required}
      hideLabel={hideLabel}
    >
      <label
        htmlFor={inputId}
        className="modern-surface flex cursor-pointer items-center justify-between gap-4 rounded-tokenMd border border-muted p-3"
      >
        <div className="space-y-1">
          {label ? (
            <div className="text-sm font-medium text-foreground">
              {label}
              {required ? <span className="ml-1 text-accent">*</span> : null}
            </div>
          ) : null}
          {description ? <div className="text-xs text-secondary">{description}</div> : null}
        </div>
        <SwitchPrimitive.Root
          id={inputId}
          checked={checked}
          defaultChecked={defaultChecked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          className="focus-ring relative inline-flex h-7 w-12 items-center rounded-full bg-muted transition data-[state=checked]:bg-accent data-[disabled]:opacity-60"
        >
          <SwitchPrimitive.Thumb className="block h-5 w-5 translate-x-1 rounded-full bg-elevated shadow-tokenSm transition data-[state=checked]:translate-x-6" />
        </SwitchPrimitive.Root>
      </label>
    </FieldChrome>
  );
}

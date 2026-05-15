import { type HTMLAttributes, type ReactNode } from "react";
import { Field as BaseField } from "@base-ui/react/field";
import { cx } from "../../utils/cx";

export interface FieldChromeProps {
  label?: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  hideLabel?: boolean;
}

interface FieldFrameProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style">,
    FieldChromeProps {
  htmlFor?: string;
  children?: ReactNode;
}

export { type FieldFrameProps };

export const controlClass =
  "focus-ring touch-target w-full rounded-tokenMd border border-border bg-surface-2 px-4 py-2.5 text-sm text-foreground shadow-tokenSm placeholder:text-tertiary transition duration-150 hover:border-accent disabled:cursor-not-allowed disabled:opacity-60";

export const controlErrorClass =
  "border-danger focus-visible:ring-danger/30";

export function fieldHintId(inputId: string | undefined): string | undefined {
  return inputId ? `${inputId}-hint` : undefined;
}

export function FieldChrome({
  label,
  description,
  error,
  required = false,
  hideLabel = false,
  htmlFor,
  children,
  ...rest
}: FieldFrameProps) {
  const hintId = fieldHintId(htmlFor);

  return (
    <BaseField.Root {...rest} invalid={!!error} className="grid gap-2">
      {label ? (
        <BaseField.Label
          htmlFor={htmlFor}
          className={cx(
            "block text-sm font-medium text-foreground",
            hideLabel && "sr-only"
          )}
        >
          {label}
          {required ? <span className="ml-1 text-accent">*</span> : null}
        </BaseField.Label>
      ) : null}
      {children}
      {error ? (
        <BaseField.Error id={hintId} match className="text-xs font-medium text-danger">
          {error}
        </BaseField.Error>
      ) : description ? (
        <BaseField.Description id={hintId} className="text-xs text-secondary">
          {description}
        </BaseField.Description>
      ) : null}
    </BaseField.Root>
  );
}

export interface BaseInputProps extends FieldChromeProps {
  id?: string;
}

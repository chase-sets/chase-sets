import { type HTMLAttributes, type ReactNode } from "react";
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
  "focus-ring touch-target w-full rounded-tokenMd border border-border bg-elevated px-4 py-3 text-sm text-foreground shadow-tokenSm placeholder:text-secondary transition disabled:cursor-not-allowed disabled:opacity-60";

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
  return (
    <div {...rest} className="space-y-2">
      {label ? (
        <label
          htmlFor={htmlFor}
          className={cx(
            "block text-sm font-medium text-foreground",
            hideLabel && "sr-only"
          )}
        >
          {label}
          {required ? <span className="ml-1 text-accent">*</span> : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <div className="text-xs font-medium text-danger">{error}</div>
      ) : description ? (
        <div className="text-xs text-secondary">{description}</div>
      ) : null}
    </div>
  );
}

export interface BaseInputProps extends FieldChromeProps {
  id?: string;
}

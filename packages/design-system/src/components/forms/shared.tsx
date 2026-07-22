import { type HTMLAttributes, type ReactNode } from "react";
import { Field as BaseField } from "@base-ui/react/field";
import { Text } from "../../primitives/typography";
import { cx } from "../../utils/cx";
import {
  compoundControlInsetClass,
  controlHeightClasses,
  controlPaddingClasses,
  controlTextClasses,
  type ControlSize,
} from "../control-sizing";

export interface FieldChromeProps {
  label?: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  status?: ReactNode;
  counter?: ReactNode;
  required?: boolean;
  hideLabel?: boolean;
}

interface FieldFrameProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style">, FieldChromeProps {
  htmlFor?: string;
  children?: ReactNode;
}

export { type FieldFrameProps };

const controlBaseClass =
  "focus-ring w-full min-w-0 rounded-tokenMd border border-border bg-surface-2 text-foreground shadow-tokenSm placeholder:text-tertiary transition duration-150 hover:border-accent disabled:cursor-not-allowed disabled:opacity-60";

export function controlClassForSize(controlSize: ControlSize = "md"): string {
  return cx(
    controlBaseClass,
    controlHeightClasses[controlSize],
    controlPaddingClasses[controlSize],
    controlTextClasses[controlSize],
  );
}

export const controlClass = controlClassForSize("md");

export const compoundControlClass = cx(
  controlBaseClass,
  controlHeightClasses.md,
  compoundControlInsetClass,
  controlTextClasses.md,
);

export const controlErrorClass = "border-danger focus-visible:ring-danger/30";

export function fieldHintId(inputId: string | undefined): string | undefined {
  return fieldDescriptionId(inputId);
}

export function fieldDescriptionId(inputId: string | undefined): string | undefined {
  return inputId ? `${inputId}-description` : undefined;
}

export function fieldErrorId(inputId: string | undefined): string | undefined {
  return inputId ? `${inputId}-error` : undefined;
}

export function fieldStatusId(inputId: string | undefined): string | undefined {
  return inputId ? `${inputId}-status` : undefined;
}

export function fieldCounterId(inputId: string | undefined): string | undefined {
  return inputId ? `${inputId}-counter` : undefined;
}

export function fieldDescribedBy({
  inputId,
  description,
  error,
  status,
  counter,
  describedBy,
}: {
  inputId: string | undefined;
  description?: ReactNode;
  error?: ReactNode;
  status?: ReactNode;
  counter?: ReactNode;
  describedBy?: string;
}): string | undefined {
  return (
    [
      describedBy,
      description ? fieldDescriptionId(inputId) : undefined,
      error ? fieldErrorId(inputId) : undefined,
      status ? fieldStatusId(inputId) : undefined,
      counter ? fieldCounterId(inputId) : undefined,
    ]
      .filter(Boolean)
      .join(" ") || undefined
  );
}

/**
 * Decorative required-field asterisk. A single host `<span>` leaf shared by every
 * field-chrome label so the `before:content-['*']` marker lives in one place.
 */
export function RequiredMarker() {
  return <span aria-hidden="true" className="ml-1 text-accent before:content-['*']" />;
}

export function FieldChrome({
  label,
  description,
  error,
  status,
  counter,
  required = false,
  hideLabel = false,
  htmlFor,
  children,
  ...rest
}: FieldFrameProps) {
  const descriptionId = fieldDescriptionId(htmlFor);
  const errorId = fieldErrorId(htmlFor);
  const statusId = fieldStatusId(htmlFor);
  const counterId = fieldCounterId(htmlFor);

  return (
    <BaseField.Root {...rest} invalid={!!error} className="grid gap-2">
      {label ? (
        <BaseField.Label
          htmlFor={htmlFor}
          className={cx("block text-sm font-medium text-foreground", hideLabel && "sr-only")}
        >
          {label}
          {required ? <RequiredMarker /> : null}
        </BaseField.Label>
      ) : null}
      {children}
      {description ? (
        <BaseField.Description id={descriptionId} className="text-xs text-secondary">
          {description}
        </BaseField.Description>
      ) : null}
      {error ? (
        <BaseField.Error id={errorId} match role="alert" className="text-xs font-medium text-danger">
          {error}
        </BaseField.Error>
      ) : null}
      {status ? (
        <Text element="div" size="xs" tone="secondary" id={statusId} aria-live="polite">
          {status}
        </Text>
      ) : null}
      {counter ? (
        <Text element="div" size="xs" tone="tertiary" id={counterId} aria-live="polite">
          {counter}
        </Text>
      ) : null}
    </BaseField.Root>
  );
}

export interface BaseInputProps extends FieldChromeProps {
  id?: string;
}

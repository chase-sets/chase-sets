import { type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { cx } from "../../utils/cx";

export interface ValidationSummaryError {
  fieldId?: string;
  fieldName?: ReactNode;
  message: ReactNode;
}

export interface ValidationSummaryProps {
  id?: string;
  title?: ReactNode;
  description?: ReactNode;
  errors: readonly ValidationSummaryError[];
  className?: string;
}

export interface ValidationMessageListProps {
  messages: readonly ReactNode[];
}

export function ValidationMessageList({ messages }: ValidationMessageListProps) {
  if (messages.length === 0) {
    return null;
  }

  return (
    <ul className="m-0 grid gap-1 pl-5 text-sm text-danger">
      {messages.map((message, index) => (
        <li key={index}>{message}</li>
      ))}
    </ul>
  );
}

function focusValidationTarget(fieldId: string) {
  // ValidationSummary only receives stable field ids, so the id remains the
  // compatibility bridge for controls whose refs now point at their natural
  // focus target. A ref registry here would add context and lifecycle coupling
  // without improving the public ValidationSummary contract.
  const target = document.getElementById(fieldId);
  if (!target) {
    return;
  }

  const focusableTarget = target.matches("button, input, select, textarea, [tabindex]")
    ? target
    : target.querySelector("button, input, select, textarea, [tabindex]");

  if (focusableTarget instanceof HTMLElement) {
    focusableTarget.focus();
  }
}

export function ValidationSummary({
  id,
  title = "Check the form",
  description,
  errors,
  className,
}: ValidationSummaryProps) {
  if (errors.length === 0) {
    return null;
  }

  function handleFieldLinkActivation(event: MouseEvent<HTMLAnchorElement>, fieldId: string) {
    if (event.defaultPrevented) {
      return;
    }
    focusValidationTarget(fieldId);
  }

  function handleFieldLinkKeyDown(event: KeyboardEvent<HTMLAnchorElement>, fieldId: string) {
    if (event.defaultPrevented || event.key !== "Enter") {
      return;
    }
    focusValidationTarget(fieldId);
  }

  return (
    <section
      id={id}
      role="alert"
      aria-live="assertive"
      className={cx("rounded-tokenMd border border-danger bg-surface-2 p-4 text-sm shadow-tokenSm", className)}
    >
      <div className="grid gap-2">
        <h2 className="m-0 text-sm font-semibold text-danger">{title}</h2>
        {description ? <p className="m-0 text-sm leading-6 text-secondary">{description}</p> : null}
        <ul className="m-0 grid gap-1 pl-5 text-danger">
          {errors.map((error, index) => (
            <li key={`${error.fieldId ?? "form"}-${index}`}>
              {error.fieldId ? (
                <a
                  className="font-medium underline underline-offset-2"
                  href={`#${error.fieldId}`}
                  onClick={(event) => handleFieldLinkActivation(event, error.fieldId ?? "")}
                  onKeyDown={(event) => handleFieldLinkKeyDown(event, error.fieldId ?? "")}
                >
                  {error.fieldName ? <>{error.fieldName}: </> : null}
                  {error.message}
                </a>
              ) : (
                <span className="font-medium">
                  {error.fieldName ? <>{error.fieldName}: </> : null}
                  {error.message}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

import { type MouseEvent, type ReactNode } from "react";
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

function focusValidationTarget(fieldId: string) {
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

  function handleFieldLinkClick(event: MouseEvent<HTMLAnchorElement>, fieldId: string) {
    if (event.defaultPrevented) {
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
                  onClick={(event) => handleFieldLinkClick(event, error.fieldId ?? "")}
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

import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { Form as ReactRouterForm } from "react-router";
import { cx } from "../../utils/cx";
import { FormProvider, type FormStatus } from "./form";

export interface RouterFormProps extends Omit<ComponentPropsWithoutRef<typeof ReactRouterForm>, "style"> {
  children?: ReactNode;
  disabled?: boolean;
  submitting?: boolean;
  status?: FormStatus;
  validationSummaryId?: string;
  spacing?: "none" | "sm" | "md" | "lg";
}

const spacingClasses = {
  none: "",
  sm: "grid gap-3",
  md: "grid gap-4",
  lg: "grid gap-6",
} satisfies Record<NonNullable<RouterFormProps["spacing"]>, string>;

export const RouterForm = forwardRef<HTMLFormElement, RouterFormProps>(function RouterForm(
  {
    children,
    disabled = false,
    submitting = false,
    status = submitting ? "submitting" : "idle",
    validationSummaryId,
    spacing = "md",
    className,
    id,
    "aria-describedby": ariaDescribedBy,
    ...rest
  },
  ref,
) {
  const controlsDisabled = disabled || submitting;
  const describedBy = [ariaDescribedBy, validationSummaryId].filter(Boolean).join(" ") || undefined;

  return (
    <FormProvider
      disabled={disabled}
      submitting={submitting}
      status={status}
      formId={id}
      validationSummaryId={validationSummaryId}
    >
      <ReactRouterForm
        {...rest}
        ref={ref}
        id={id}
        aria-busy={submitting || undefined}
        aria-describedby={describedBy}
        aria-disabled={disabled || undefined}
        data-form-status={status}
        data-submitting={submitting || undefined}
        className={cx(spacingClasses[spacing], className)}
      >
        {controlsDisabled ? (
          <fieldset disabled={controlsDisabled} className="contents">
            {children}
          </fieldset>
        ) : (
          children
        )}
      </ReactRouterForm>
    </FormProvider>
  );
});

import { createContext, forwardRef, useContext, type FormHTMLAttributes, type ReactNode } from "react";
import { cx } from "../../utils/cx";

export type FormStatus = "idle" | "submitting" | "success" | "error";

export interface FormContextValue {
  disabled: boolean;
  submitting: boolean;
  status: FormStatus;
  formId?: string;
  validationSummaryId?: string;
}

const defaultFormContext: FormContextValue = {
  disabled: false,
  submitting: false,
  status: "idle",
};

const FormContext = createContext<FormContextValue>(defaultFormContext);

export function useFormContext(): FormContextValue {
  return useContext(FormContext);
}

export interface FormProviderProps extends Partial<FormContextValue> {
  children?: ReactNode;
}

export function FormProvider({
  children,
  disabled = false,
  submitting = false,
  status = submitting ? "submitting" : "idle",
  formId,
  validationSummaryId,
}: FormProviderProps) {
  const contextValue: FormContextValue = {
    disabled,
    submitting,
    status,
    formId,
    validationSummaryId,
  };

  return <FormContext.Provider value={contextValue}>{children}</FormContext.Provider>;
}

export interface FormProps extends Omit<FormHTMLAttributes<HTMLFormElement>, "style"> {
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
} satisfies Record<NonNullable<FormProps["spacing"]>, string>;

export const Form = forwardRef<HTMLFormElement, FormProps>(function Form(
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
      <form
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
      </form>
    </FormProvider>
  );
});

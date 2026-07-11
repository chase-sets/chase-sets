import { forwardRef, useCallback, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { Form as ReactRouterForm, useLocation, useNavigate } from "react-router";
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

/**
 * Wires an AdminResourceListPage's `limit`/`offset` pagination onto client-side navigation:
 * clicking a page updates the `limit`/`offset` search params via `useNavigate` instead of a full
 * page reload. Returns a no-op when `pagination` is undefined (unpaginated lists).
 */
export function useAdminResourceListPageChange(
  pagination: Readonly<{ limit: number; offset: number; total: number }> | undefined,
): (page: number) => void {
  const navigate = useNavigate();
  const location = useLocation();

  return useCallback(
    (page: number) => {
      if (!pagination) {
        return;
      }

      const searchParams = new URLSearchParams(location.search);
      searchParams.set("limit", String(pagination.limit));
      searchParams.set("offset", String((page - 1) * pagination.limit));
      navigate(`${location.pathname}?${searchParams.toString()}${location.hash}`);
    },
    [navigate, location, pagination],
  );
}

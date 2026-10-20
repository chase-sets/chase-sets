import { forwardRef, useCallback, useEffect, useRef, useState, type ComponentPropsWithoutRef, type FormEvent, type ReactNode } from "react";
import { Form as ReactRouterForm, Link as ReactRouterLink, useLocation, useNavigate, useNavigation } from "react-router";
import { cx } from "../../utils/cx";
import type { LinkAdapterProps, LinkComponent } from "../../theme/link-adapter";
import { FormProvider, type FormContextValue, type FormStatus } from "./form";

export interface RouterFormProps extends Omit<ComponentPropsWithoutRef<typeof ReactRouterForm>, "style"> {
  children?: ReactNode;
  errorAnnouncement?: FormContextValue["errorAnnouncement"];
  disabled?: boolean;
  submitting?: boolean;
  pendingAnnouncement?: string;
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
    errorAnnouncement,
    disabled = false,
    submitting,
    pendingAnnouncement,
    status = submitting ? "submitting" : "idle",
    validationSummaryId,
    spacing = "md",
    className,
    id,
    "aria-describedby": ariaDescribedBy,
    onSubmit,
    ...rest
  },
  ref,
) {
  const formRef = useRef<HTMLFormElement>(null);
  const sawNavigation = useRef(false);
  const navigation = useNavigation();
  const [pendingSubmitter, setPendingSubmitter] = useState<HTMLButtonElement | HTMLInputElement | null>(null);
  const derivedPending = submitting === undefined && pendingSubmitter !== null;
  const effectiveSubmitting = submitting ?? derivedPending;
  const effectiveStatus = status ?? (effectiveSubmitting ? "submitting" : "idle");
  const controlsDisabled = disabled || submitting === true;
  const describedBy = [ariaDescribedBy, validationSummaryId].filter(Boolean).join(" ") || undefined;

  useEffect(() => {
    if (!pendingSubmitter) return;
    if (navigation.state !== "idle") {
      sawNavigation.current = true;
    } else if (sawNavigation.current) {
      sawNavigation.current = false;
      setPendingSubmitter(null);
    }
  }, [navigation, pendingSubmitter]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (derivedPending) {
      event.preventDefault();
      return;
    }
    onSubmit?.(event);
    if (event.defaultPrevented || submitting !== undefined) return;
    const method = event.currentTarget.method.toLowerCase() || "get";
    if (method === "get") return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    if (submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement) {
      setPendingSubmitter(submitter);
    }
  };

  return (
    <FormProvider
      errorAnnouncement={errorAnnouncement}
      disabled={disabled}
      submitting={effectiveSubmitting}
      pendingSubmitter={pendingSubmitter}
      pendingAnnouncement={pendingAnnouncement}
      status={effectiveStatus}
      formId={id}
      validationSummaryId={validationSummaryId}
    >
      <ReactRouterForm
        {...rest}
        ref={(node) => {
          formRef.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        id={id}
        onSubmit={handleSubmit}
        aria-busy={effectiveSubmitting || undefined}
        aria-describedby={describedBy}
        aria-disabled={disabled || undefined}
        data-form-status={effectiveStatus}
        data-submitting={effectiveSubmitting || undefined}
        className={cx(spacingClasses[spacing], className)}
      >
        {pendingAnnouncement ? <div aria-live="polite" className="sr-only">{derivedPending ? pendingAnnouncement : ""}</div> : null}
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

/**
 * React Router 7 implementation of the DS's `LinkComponent` contract. Pass this as
 * `ChaseRoot`'s `linkComponent` prop to give every DS nav surface (NavigationItem,
 * LinkButton, Breadcrumbs, ...) client-side transitions: `<Link>` still renders a
 * real `<a href>`, so keyboard activation, middle-click, and cmd/ctrl-click to open a
 * new tab keep working exactly as they do for a plain anchor.
 */
export const RouterLinkAdapter: LinkComponent = forwardRef<HTMLAnchorElement, LinkAdapterProps>(
  function RouterLinkAdapter({ href, children, ...rest }, ref) {
    return (
      <ReactRouterLink ref={ref} to={href ?? ""} {...rest}>
        {children}
      </ReactRouterLink>
    );
  },
);

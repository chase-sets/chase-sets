import {
  createElement,
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentPropsWithoutRef,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Form as ReactRouterForm,
  Link as ReactRouterLink,
  useFormAction,
  useLocation,
  useNavigate,
  useNavigation,
} from "react-router";
import { cx } from "../../utils/cx";
import type { LinkAdapterProps, LinkComponent } from "../../theme/link-adapter";
import { FormProvider, type FormContextValue, type FormStatus } from "./form";

export interface RouterFormProps extends Omit<
  ComponentPropsWithoutRef<typeof ReactRouterForm>,
  "style" | "reloadDocument"
> {
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
const nativeFormTag = "form";

type RouterNavigation = {
  state: "idle" | "submitting" | "loading";
  formMethod?: string;
  formAction?: string;
};

type SubmissionOwner = {
  token: number;
  ownerId: number;
  method: string;
  formAction: string;
};

let nextOwnerId = 1;
let nextSubmissionToken = 1;
let latestSubmission: SubmissionOwner | null = null;
let submissionVersion = 0;
const submissionListeners = new Set<() => void>();

function notifySubmissionChange() {
  submissionVersion += 1;
  for (const listener of submissionListeners) listener();
}

function claimSubmission(ownerId: number, method: string, formAction: string): number {
  const token = nextSubmissionToken++;
  latestSubmission = { token, ownerId, method, formAction };
  notifySubmissionChange();
  return token;
}

function releaseSubmission(token: number) {
  if (latestSubmission?.token !== token) return;
  latestSubmission = null;
  notifySubmissionChange();
}

function useSafeNavigation(): RouterNavigation | null {
  try {
    return useNavigation() as RouterNavigation;
  } catch {
    return null;
  }
}

function useSafeFormAction(action: string | undefined): string | null {
  try {
    return useFormAction(action);
  } catch {
    return null;
  }
}

export const RouterForm = forwardRef<HTMLFormElement, RouterFormProps>(function RouterForm(
  {
    children,
    errorAnnouncement,
    disabled = false,
    submitting,
    pendingAnnouncement,
    status,
    validationSummaryId,
    spacing = "md",
    className,
    id,
    action,
    method,
    navigate,
    fetcherKey,
    "aria-describedby": ariaDescribedBy,
    onSubmit,
    ...rest
  },
  ref,
) {
  const ownerIdRef = useRef(0);
  if (ownerIdRef.current === 0) ownerIdRef.current = nextOwnerId++;
  const ownerId = ownerIdRef.current;
  const navigation = useSafeNavigation();
  const formAction = useSafeFormAction(action);
  const submissionStoreVersion = useSyncExternalStore(
    (listener) => {
      submissionListeners.add(listener);
      return () => submissionListeners.delete(listener);
    },
    () => submissionVersion,
    () => 0,
  );
  const [pendingSubmitter, setPendingSubmitter] = useState<HTMLButtonElement | HTMLInputElement | null>(null);
  const [ownedSubmissionToken, setOwnedSubmissionToken] = useState<number | null>(null);
  const startedTokenRef = useRef<number | null>(null);
  const previousNavigationStateRef = useRef<RouterNavigation["state"]>("idle");
  const latestOwner = latestSubmission;
  const ownedSubmission = latestOwner?.token === ownedSubmissionToken && latestOwner.ownerId === ownerId;
  const navigationMatches = Boolean(
    navigation &&
    navigation.state !== "idle" &&
    latestOwner &&
    latestOwner.ownerId === ownerId &&
    navigation.formMethod?.toLowerCase() === latestOwner.method &&
    navigation.formAction === latestOwner.formAction,
  );
  const navigationHasIdentity = Boolean(navigation?.formMethod || navigation?.formAction);
  const continuingNavigation = Boolean(
    navigation &&
    navigation.state !== "idle" &&
    ownedSubmission &&
    (navigationMatches ||
      (startedTokenRef.current === ownedSubmissionToken &&
        !navigationHasIdentity &&
        previousNavigationStateRef.current !== "idle")),
  );
  const derivedPending =
    submitting === undefined &&
    ownedSubmission &&
    Boolean(navigation) &&
    (navigation?.state === "idle"
      ? startedTokenRef.current !== ownedSubmissionToken
      : continuingNavigation || !navigationHasIdentity);
  const effectiveSubmitting = submitting ?? derivedPending;
  const effectiveStatus = status ?? (effectiveSubmitting ? "submitting" : "idle");
  const controlsDisabled = disabled || submitting === true;
  const describedBy = [ariaDescribedBy, validationSummaryId].filter(Boolean).join(" ") || undefined;
  const setFormRef = useCallback(
    (node: HTMLFormElement | null) => {
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  const formChildren = (
    <>
      {pendingAnnouncement ? (
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {derivedPending ? pendingAnnouncement : ""}
        </div>
      ) : null}
      {controlsDisabled ? <fieldset disabled={controlsDisabled}>{children}</fieldset> : children}
    </>
  );
  useEffect(() => {
    if (ownedSubmissionToken !== null && !ownedSubmission) {
      setOwnedSubmissionToken(null);
      setPendingSubmitter(null);
      startedTokenRef.current = null;
      return;
    }
    if (navigation) {
      if (navigationMatches && ownedSubmissionToken !== null) {
        startedTokenRef.current = ownedSubmissionToken;
      } else if (ownedSubmission && navigation.state !== "idle" && navigationHasIdentity && !navigationMatches) {
        releaseSubmission(ownedSubmissionToken!);
        setOwnedSubmissionToken(null);
        setPendingSubmitter(null);
      } else if (ownedSubmission && navigation.state === "idle" && startedTokenRef.current === ownedSubmissionToken) {
        releaseSubmission(ownedSubmissionToken!);
        setOwnedSubmissionToken(null);
        setPendingSubmitter(null);
        startedTokenRef.current = null;
      }
    }
    previousNavigationStateRef.current = navigation?.state ?? "idle";
  }, [
    navigation,
    navigationMatches,
    navigationHasIdentity,
    ownedSubmission,
    ownedSubmissionToken,
    submissionStoreVersion,
  ]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (derivedPending) {
      event.preventDefault();
      return;
    }
    onSubmit?.(event);
    if (event.defaultPrevented || submitting !== undefined || navigate === false || fetcherKey) return;
    const acceptedMethod = (method ?? "get").toLowerCase();
    if (acceptedMethod === "get") return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const token = claimSubmission(ownerId, acceptedMethod, formAction ?? event.currentTarget.action);
    setOwnedSubmissionToken(token);
    if (submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement) {
      setPendingSubmitter(submitter);
    }
  };

  const formProps = {
    ...rest,
    action,
    method,
    id,
    onSubmit: handleSubmit,
    ref: setFormRef,
    "aria-busy": effectiveSubmitting || undefined,
    "aria-describedby": describedBy,
    "aria-disabled": disabled || undefined,
    "data-form-status": effectiveStatus,
    "data-submitting": effectiveSubmitting || undefined,
    className: cx(spacingClasses[spacing], className),
  };

  return (
    <FormProvider
      errorAnnouncement={errorAnnouncement}
      disabled={disabled}
      submitting={effectiveSubmitting}
      pendingSubmitter={pendingSubmitter}
      status={effectiveStatus}
      formId={id}
      validationSummaryId={validationSummaryId}
    >
      {navigation ? (
        <ReactRouterForm {...formProps} navigate={navigate} fetcherKey={fetcherKey}>
          {formChildren}
        </ReactRouterForm>
      ) : (
        createElement(nativeFormTag, formProps, formChildren)
      )}
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

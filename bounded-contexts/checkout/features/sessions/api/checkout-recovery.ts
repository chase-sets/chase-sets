import {
  POST_WRITE_RECOVERY_KINDS,
  postWriteRecoveryKindForFreshWriteReadError,
  readApiErrorCode,
  readFreshWriteTokenState,
  recoverFreshWriteReadError,
  type PostWriteRecoveryKind,
} from "@chase-sets/http/responses";
import { t } from "@chase-sets/localization";
import { CheckoutApiError } from "../../../support/request-support/api-client";

export type CheckoutRecoveryAction = Readonly<{
  href: string;
  label: string;
  leadingIcon: "cart" | "lock" | "refreshCcw" | "search";
  tone?: "secondary";
}>;

export type CheckoutRecoveryKind =
  | "access-required"
  | "cart-empty"
  | "checkout-handoff-expired"
  | "checkout-preparing"
  | "guest-access-expired"
  | "request-validation"
  | "session-not-found"
  | "wrong-account";

export type CheckoutPostWriteResult =
  | Readonly<{
      kind: "bounded-pending";
      reason: "projection-lag";
      recoveryKind: "pending-projection" | "refreshable-catching-up";
      retryable: true;
    }>
  | Readonly<{
      kind: "source-readiness-disagreement";
      reason: "readiness-snapshot-stale" | "split-group-handoff-stale";
      recoveryKind: "action-required";
      retryable: false;
    }>
  | Readonly<{
      kind: "auth-blocker";
      reason: "authentication-required" | "authorization-forbidden";
      recoveryKind: "action-required";
      retryable: false;
    }>
  | Readonly<{
      kind: "validation-blocker";
      reason: "validation-failed";
      recoveryKind: "action-required";
      retryable: false;
    }>
  | Readonly<{
      kind: "domain-blocker";
      reason: "cart-empty" | "unresolved-fulfillment" | "projection-lag-without-fresh-receipt";
      recoveryKind: "action-required" | "stale-projection";
      retryable: boolean;
    }>
  | Readonly<{
      kind: "permanent-not-found";
      reason: "session-not-found" | "expired-handoff";
      recoveryKind: "terminal-failure" | "expired-handoff";
      retryable: false;
    }>;

export type CheckoutRecovery = Readonly<{
  kind: CheckoutRecoveryKind;
  recoveryKind: PostWriteRecoveryKind;
  postWriteResult: CheckoutPostWriteResult;
  status: number;
  title: string;
  description: string;
  trustCue: string;
  primaryAction: CheckoutRecoveryAction;
  secondaryAction?: CheckoutRecoveryAction;
}>;

type CheckoutActor = Readonly<{ roleKey?: string | null }> | null | undefined;

function checkoutRecoveryAction(
  href: string,
  label: string,
  leadingIcon: CheckoutRecoveryAction["leadingIcon"],
  tone?: CheckoutRecoveryAction["tone"],
): CheckoutRecoveryAction {
  return {
    href,
    label,
    leadingIcon,
    ...(tone ? { tone } : {}),
  };
}

function recoveryKindForCheckoutRecoveryKind(kind: CheckoutRecoveryKind): PostWriteRecoveryKind {
  switch (kind) {
    case "checkout-preparing":
      return "refreshable-catching-up";
    case "checkout-handoff-expired":
      return "expired-handoff";
    case "access-required":
    case "cart-empty":
    case "guest-access-expired":
    case "request-validation":
    case "wrong-account":
      return "action-required";
    case "session-not-found":
      return "terminal-failure";
  }
}

function defaultPostWriteResultForRecoveryKind(
  kind: CheckoutRecoveryKind,
  recoveryKind: PostWriteRecoveryKind,
): CheckoutPostWriteResult {
  if (kind === "checkout-preparing") {
    if (recoveryKind === "pending-projection" || recoveryKind === "refreshable-catching-up") {
      return {
        kind: "bounded-pending",
        reason: "projection-lag",
        recoveryKind,
        retryable: true,
      };
    }

    return {
      kind: "domain-blocker",
      reason: "projection-lag-without-fresh-receipt",
      recoveryKind: "stale-projection",
      retryable: true,
    };
  }

  if (kind === "checkout-handoff-expired") {
    return {
      kind: "permanent-not-found",
      reason: "expired-handoff",
      recoveryKind: "expired-handoff",
      retryable: false,
    };
  }

  if (kind === "session-not-found") {
    return {
      kind: "permanent-not-found",
      reason: "session-not-found",
      recoveryKind: "terminal-failure",
      retryable: false,
    };
  }

  if (kind === "access-required" || kind === "guest-access-expired" || kind === "wrong-account") {
    return {
      kind: "auth-blocker",
      reason: kind === "wrong-account" ? "authorization-forbidden" : "authentication-required",
      recoveryKind: "action-required",
      retryable: false,
    };
  }

  if (kind === "cart-empty") {
    return {
      kind: "domain-blocker",
      reason: "cart-empty",
      recoveryKind: "action-required",
      retryable: false,
    };
  }

  return {
    kind: "validation-blocker",
    reason: "validation-failed",
    recoveryKind: "action-required",
    retryable: false,
  };
}

export function checkoutRecoveryForKind(
  kind: CheckoutRecoveryKind,
  currentPath = "/checkout/buy/readiness",
  recoveryKind: PostWriteRecoveryKind = recoveryKindForCheckoutRecoveryKind(kind),
  postWriteResult: CheckoutPostWriteResult = defaultPostWriteResultForRecoveryKind(kind, recoveryKind),
): CheckoutRecovery {
  const signInPath = `/sign-in?returnTo=${encodeURIComponent(currentPath)}`;
  const browseAction = checkoutRecoveryAction(
    "/search",
    t("checkout.routes.checkoutRecovery.browse.marketplace"),
    "search",
  );
  const cartAction = checkoutRecoveryAction(
    "/account/cart",
    t("checkout.routes.checkoutRecovery.view.buy.cart"),
    "cart",
  );
  const signInAction = checkoutRecoveryAction(
    signInPath,
    t("checkout.routes.checkoutSession.sign.in.to.continue"),
    "lock",
    "secondary",
  );
  const refreshAction = checkoutRecoveryAction(
    currentPath,
    t("checkout.routes.checkoutRecovery.refresh.checkout"),
    "refreshCcw",
  );

  switch (kind) {
    case "access-required":
      return {
        kind,
        recoveryKind,
        postWriteResult,
        status: 401,
        title: t("checkout.routes.checkoutSession.checkout.access.required"),
        description: t("checkout.routes.checkoutSession.checkout.access.required.description"),
        trustCue: t("checkout.routes.checkoutSession.payment.has.not.started"),
        primaryAction: browseAction,
        secondaryAction: signInAction,
      };
    case "cart-empty":
      return {
        kind,
        recoveryKind,
        postWriteResult,
        status: 400,
        title: t("checkout.routes.checkoutRecovery.buy.cart.empty"),
        description: t("checkout.routes.checkoutRecovery.buy.cart.empty.description"),
        trustCue: t("checkout.routes.checkoutSession.payment.has.not.started"),
        primaryAction: cartAction,
        secondaryAction: browseAction,
      };
    case "checkout-preparing":
      return {
        kind,
        recoveryKind,
        postWriteResult,
        status: 202,
        title: t("checkout.routes.checkoutRecovery.checkout.preparing"),
        description: t("checkout.routes.checkoutRecovery.checkout.preparing.description"),
        trustCue: t("checkout.routes.checkoutSession.payment.has.not.started"),
        primaryAction: refreshAction,
        secondaryAction: browseAction,
      };
    case "checkout-handoff-expired":
      return {
        kind,
        recoveryKind,
        postWriteResult,
        status: 410,
        title: t("checkout.routes.checkoutRecovery.checkout.handoff.expired"),
        description: t("checkout.routes.checkoutRecovery.checkout.handoff.expired.description"),
        trustCue: t("checkout.routes.checkoutSession.payment.has.not.started"),
        primaryAction: cartAction,
        secondaryAction: browseAction,
      };
    case "guest-access-expired":
      return {
        kind,
        recoveryKind,
        postWriteResult,
        status: 401,
        title: t("checkout.routes.checkoutSession.guest.checkout.access.expired"),
        description: t("checkout.routes.checkoutSession.guest.checkout.access.expired.description"),
        trustCue: t("checkout.routes.checkoutSession.payment.has.not.started"),
        primaryAction: browseAction,
        secondaryAction: signInAction,
      };
    case "request-validation":
      return {
        kind,
        recoveryKind,
        postWriteResult,
        status: 400,
        title: t("checkout.routes.checkoutRecovery.checkout.needs.attention"),
        description: t("checkout.routes.checkoutRecovery.checkout.needs.attention.description"),
        trustCue: t("checkout.routes.checkoutSession.payment.has.not.started"),
        primaryAction: cartAction,
        secondaryAction: browseAction,
      };
    case "session-not-found":
      return {
        kind,
        recoveryKind,
        postWriteResult,
        status: 404,
        title: t("checkout.routes.checkoutSession.checkout.session.not.found"),
        description: t("checkout.routes.checkoutSession.checkout.session.not.found.description"),
        trustCue: t("checkout.routes.checkoutSession.payment.has.not.started"),
        primaryAction: browseAction,
        secondaryAction: signInAction,
      };
    case "wrong-account":
      return {
        kind,
        recoveryKind,
        postWriteResult,
        status: 403,
        title: t("checkout.routes.checkoutSession.checkout.belongs.to.another.account"),
        description: t("checkout.routes.checkoutSession.checkout.belongs.to.another.account.description"),
        trustCue: t("checkout.routes.checkoutSession.payment.has.not.started"),
        primaryAction: signInAction,
        secondaryAction: browseAction,
      };
  }
}

function errorBodyCode(error: CheckoutApiError) {
  return readApiErrorCode(error.body);
}

function sourceReadinessPostWriteResult(
  reason: Extract<CheckoutPostWriteResult, { kind: "source-readiness-disagreement" }>["reason"],
): CheckoutPostWriteResult {
  return {
    kind: "source-readiness-disagreement",
    reason,
    recoveryKind: "action-required",
    retryable: false,
  };
}

export function checkoutRecoveryForError(
  error: unknown,
  actor: CheckoutActor,
  currentPath = "/checkout/buy/readiness",
): CheckoutRecovery | null {
  if (!(error instanceof CheckoutApiError)) {
    return null;
  }

  if (error.status === 401) {
    return checkoutRecoveryForKind(actor ? "guest-access-expired" : "access-required", currentPath);
  }

  if (error.status === 403) {
    if (actor?.roleKey === "guest-buyer") {
      return checkoutRecoveryForKind("guest-access-expired", currentPath);
    }

    if (!actor) {
      return checkoutRecoveryForKind("access-required", currentPath);
    }

    return checkoutRecoveryForKind("wrong-account", currentPath);
  }

  if (error.status === 404) {
    return checkoutRecoveryForKind("session-not-found", currentPath);
  }

  if (error.status === 503 && errorBodyCode(error) === "projection_freshness_timeout") {
    return checkoutRecoveryForKind("checkout-preparing", currentPath, "stale-projection");
  }

  if (error.status === 400) {
    const code = errorBodyCode(error);
    if (code === "cart_empty") {
      return checkoutRecoveryForKind("cart-empty", currentPath);
    }

    if (code === "readiness_snapshot_stale") {
      return checkoutRecoveryForKind(
        "request-validation",
        currentPath,
        "action-required",
        sourceReadinessPostWriteResult("readiness-snapshot-stale"),
      );
    }

    if (code === "split_group_handoff_stale") {
      return checkoutRecoveryForKind(
        "request-validation",
        currentPath,
        "action-required",
        sourceReadinessPostWriteResult("split-group-handoff-stale"),
      );
    }

    if (code === "unresolved_fulfillment") {
      return checkoutRecoveryForKind("request-validation", currentPath, "action-required", {
        kind: "domain-blocker",
        reason: "unresolved-fulfillment",
        recoveryKind: "action-required",
        retryable: false,
      });
    }

    if (code === "validation_failed") {
      return checkoutRecoveryForKind("request-validation", currentPath);
    }
  }

  return null;
}

export function checkoutRecoveryForFreshWriteError(
  error: unknown,
  actor: CheckoutActor,
  request: Request,
  currentPath = "/checkout/buy/readiness",
): CheckoutRecovery | null {
  if (!(error instanceof CheckoutApiError)) {
    return checkoutRecoveryForError(error, actor, currentPath);
  }

  const freshWriteRecovery = recoverFreshWriteReadError({
    request,
    error,
    recoverTransient: (classification) =>
      checkoutRecoveryForKind(
        "checkout-preparing",
        currentPath,
        postWriteRecoveryKindForFreshWriteReadError(classification),
      ),
  });
  if (freshWriteRecovery) {
    return freshWriteRecovery;
  }

  if (error.status === 404 && readFreshWriteTokenState(request).kind === "expired") {
    return checkoutRecoveryForKind("checkout-handoff-expired", currentPath);
  }

  return checkoutRecoveryForError(error, actor, currentPath);
}

function isCheckoutRecoveryAction(value: unknown): value is CheckoutRecoveryAction {
  if (!value || typeof value !== "object") {
    return false;
  }

  const action = value as Record<string, unknown>;
  return typeof action.href === "string" && typeof action.label === "string";
}

function isPostWriteRecoveryKind(value: unknown): value is PostWriteRecoveryKind {
  return typeof value === "string" && (POST_WRITE_RECOVERY_KINDS as readonly string[]).includes(value);
}

function isCheckoutPostWriteResult(value: unknown): value is CheckoutPostWriteResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const result = value as Record<string, unknown>;
  return (
    typeof result.kind === "string" &&
    typeof result.reason === "string" &&
    isPostWriteRecoveryKind(result.recoveryKind) &&
    typeof result.retryable === "boolean"
  );
}

export function isCheckoutRecovery(value: unknown): value is CheckoutRecovery {
  if (!value || typeof value !== "object") {
    return false;
  }

  const recovery = value as Record<string, unknown>;
  return (
    typeof recovery.kind === "string" &&
    isPostWriteRecoveryKind(recovery.recoveryKind) &&
    isCheckoutPostWriteResult(recovery.postWriteResult) &&
    typeof recovery.status === "number" &&
    typeof recovery.title === "string" &&
    typeof recovery.description === "string" &&
    typeof recovery.trustCue === "string" &&
    isCheckoutRecoveryAction(recovery.primaryAction) &&
    (recovery.secondaryAction === undefined || isCheckoutRecoveryAction(recovery.secondaryAction))
  );
}

export function createCheckoutRecoveryResponse(recovery: CheckoutRecovery) {
  return new Response(JSON.stringify(recovery), {
    status: recovery.status,
    statusText: recovery.title,
    headers: { "Content-Type": "application/json" },
  });
}

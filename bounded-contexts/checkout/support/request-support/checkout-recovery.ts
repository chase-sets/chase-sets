import { classifyFreshWriteReadError, readApiErrorCode } from "@chase-sets/http/responses";
import { t } from "@chase-sets/localization";
import { CheckoutApiError } from "./api-client";

export type CheckoutRecoveryAction = Readonly<{
  href: string;
  label: string;
  leadingIcon: "cart" | "lock" | "refreshCcw" | "search";
  tone?: "secondary";
}>;

export type CheckoutRecoveryKind =
  | "access-required"
  | "cart-empty"
  | "checkout-preparing"
  | "guest-access-expired"
  | "request-validation"
  | "session-not-found"
  | "wrong-account";

export type CheckoutRecovery = Readonly<{
  kind: CheckoutRecoveryKind;
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

export function checkoutRecoveryForKind(kind: CheckoutRecoveryKind, currentPath = "/checkout/start"): CheckoutRecovery {
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
        status: 503,
        title: t("checkout.routes.checkoutRecovery.checkout.preparing"),
        description: t("checkout.routes.checkoutRecovery.checkout.preparing.description"),
        trustCue: t("checkout.routes.checkoutSession.payment.has.not.started"),
        primaryAction: refreshAction,
        secondaryAction: browseAction,
      };
    case "guest-access-expired":
      return {
        kind,
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

export function checkoutRecoveryForError(
  error: unknown,
  actor: CheckoutActor,
  currentPath = "/checkout/start",
): CheckoutRecovery | null {
  if (!(error instanceof CheckoutApiError)) {
    return null;
  }

  if (error.status === 401) {
    return checkoutRecoveryForKind(actor ? "guest-access-expired" : "access-required", currentPath);
  }

  if (error.status === 403) {
    return checkoutRecoveryForKind("wrong-account", currentPath);
  }

  if (error.status === 404) {
    return checkoutRecoveryForKind("session-not-found", currentPath);
  }

  if (error.status === 400) {
    const code = errorBodyCode(error);
    if (code === "cart_empty") {
      return checkoutRecoveryForKind("cart-empty", currentPath);
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
  currentPath = "/checkout/start",
): CheckoutRecovery | null {
  if (!(error instanceof CheckoutApiError)) {
    return checkoutRecoveryForError(error, actor, currentPath);
  }

  const freshWriteError = classifyFreshWriteReadError({ request, error });
  if (freshWriteError.transient) {
    return checkoutRecoveryForKind("checkout-preparing", currentPath);
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

export function isCheckoutRecovery(value: unknown): value is CheckoutRecovery {
  if (!value || typeof value !== "object") {
    return false;
  }

  const recovery = value as Record<string, unknown>;
  return (
    typeof recovery.kind === "string" &&
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

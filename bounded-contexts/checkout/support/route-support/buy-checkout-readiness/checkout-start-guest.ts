import { t } from "@chase-sets/localization";
import { redirectDocument } from "react-router";
import { appendFreshWriteToken } from "@chase-sets/http/responses";
import type { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { navigateAfterWriteFromSourcesWithPlatformPostWriteToken } from "@chase-sets/platform-runtime/post-write-tokens";
import { AuthApiError, createAuthRequestApiClient } from "@chase-sets/auth/server";
import { CheckoutApiError, createCheckoutRequestApiClient } from "../../request-support/api-client";
import {
  appendClearedAnonymousCartCookie,
  appendGuestCheckoutCookie,
  CHECKOUT_GUEST_COOKIE_NAME,
} from "../../request-support/guest-checkout";
import {
  checkoutSessionRequestFromForm,
  ensureCartReadinessSnapshot,
  type CheckoutRequestApi,
} from "./checkout-start-source";

const ACCOUNT_SIGN_IN_REQUIRED_CODE = "account_sign_in_required";
const MERGED_CART_PROJECTION_WAIT_MS = 15_000;
const MERGED_CART_PROJECTION_POLL_MS = 300;

export type CheckoutActor = Awaited<ReturnType<typeof resolveActorFromAuthApi>>;

export type GuestCheckoutStart = Readonly<{
  accountId: string;
  guestToken: string;
  expiresAt: string;
}>;

export function currentPathWithSearch(request: Request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

export function requestWithFreshWriteSource(request: Request, source: unknown) {
  const freshPath = appendFreshWriteToken(currentPathWithSearch(request), source);
  return new Request(new URL(freshPath, request.url), { headers: request.headers });
}

function mergedCartLineCount(source: unknown) {
  if (typeof source !== "object" || source === null || !("mergedLineCount" in source)) {
    return 0;
  }

  const count = Number((source as { mergedLineCount?: unknown }).mergedLineCount);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded merged-cart projection wait: after a guest cart merges into the
 * account, poll the account cart until the merged lines are visible so the
 * readiness snapshot taken next sees them. Times out as a customer-safe
 * projection-freshness recovery. */
export async function waitForMergedCartProjection(api: CheckoutRequestApi, mergeResult: unknown) {
  const expectedLineCount = mergedCartLineCount(mergeResult);
  if (expectedLineCount === 0) {
    return;
  }

  const deadline = Date.now() + MERGED_CART_PROJECTION_WAIT_MS;
  while (Date.now() <= deadline) {
    const cart = await api.getCart();
    if (cart.count >= expectedLineCount) {
      return;
    }

    await delay(MERGED_CART_PROJECTION_POLL_MS);
  }

  throw new CheckoutApiError(503, {
    error: {
      code: "projection_freshness_timeout",
      message: t("checkout.routes.checkoutRecovery.checkout.preparing.description"),
    },
  });
}

export async function checkoutSessionPath(
  session: Readonly<{ session_id: string }>,
  writeSources: readonly unknown[] = [],
) {
  return navigateAfterWriteFromSourcesWithPlatformPostWriteToken(
    [...writeSources, session],
    `/checkout/buy/session/${session.session_id}`,
  );
}

export function signInPathForReturnTo(returnTo: string) {
  return `/sign-in?returnTo=${encodeURIComponent(returnTo)}`;
}

export function isAccountSignInRequiredError(error: unknown) {
  if (!(error instanceof AuthApiError) || error.status !== 409) {
    return false;
  }

  const body = error.body;
  return Boolean(
    body &&
    typeof body === "object" &&
    "error" in body &&
    (body as { error?: { code?: unknown } }).error?.code === ACCOUNT_SIGN_IN_REQUIRED_CODE,
  );
}

export function isCheckoutAuthorizationError(error: unknown) {
  return error instanceof CheckoutApiError && error.status === 403;
}

function isGuestCheckoutActor(actor: CheckoutActor) {
  return actor?.roleKey === "guest-buyer";
}

export function canRecoverGuestCheckoutMismatch(sourceType: string, anonymousCartId: string | null) {
  return sourceType === "buy-now" || (sourceType === "cart" && Boolean(anonymousCartId));
}

async function loadGuestCheckoutStartContact(
  request: Request,
): Promise<Readonly<{ email: string; contactName: string }> | null> {
  try {
    const context = await createAuthRequestApiClient(request).getGuestCheckoutClaimContext<{
      contactEmail?: string | null;
      contactName?: string | null;
    }>({});
    const email = String(context.contactEmail ?? "").trim();
    if (!email) {
      return null;
    }

    return {
      email,
      contactName: String(context.contactName ?? "").trim(),
    };
  } catch {
    return null;
  }
}

export function guestCheckoutContactFromForm(formData: FormData) {
  return {
    contactName: String(formData.get("contactName") ?? "").trim(),
    email: String(formData.get("email") ?? "").trim(),
  };
}

export function hasGuestCheckoutContact(contact: Readonly<{ contactName: string; email: string }>) {
  return Boolean(contact.contactName && contact.email);
}

export async function createGuestCheckoutStart(
  request: Request,
  contact: Readonly<{ contactName: string; email: string }>,
): Promise<GuestCheckoutStart> {
  return createAuthRequestApiClient(request).startGuestCheckout<GuestCheckoutStart>({
    displayName: contact.contactName,
    email: contact.email,
  });
}

/** Creates the checkout session under a freshly started guest checkout
 * identity: merges any anonymous cart, waits for the merged projection,
 * ensures a readiness snapshot, and redirects into the session with the
 * guest cookie applied. */
export async function startGuestCheckoutSession(
  request: Request,
  formData: FormData,
  params: Readonly<{
    anonymousCartId: string | null;
    sourceType: string;
    guest: GuestCheckoutStart;
  }>,
) {
  const guestHeaders = {
    cookie: `${CHECKOUT_GUEST_COOKIE_NAME}=${encodeURIComponent(params.guest.guestToken)}`,
  };
  let guestApi = createCheckoutRequestApiClient(request, {
    headers: {
      ...guestHeaders,
    },
  });
  const writeSources: unknown[] = [];
  const forceReadinessRefresh = params.sourceType === "cart" && Boolean(params.anonymousCartId);
  if (params.sourceType === "cart" && params.anonymousCartId) {
    const mergeResult = await guestApi.mergeGuestCartToAccount(params.anonymousCartId);
    writeSources.push(mergeResult);
    await waitForMergedCartProjection(guestApi, mergeResult);
    guestApi = createCheckoutRequestApiClient(requestWithFreshWriteSource(request, mergeResult), {
      headers: guestHeaders,
    });
  }

  const sessionRequest = await ensureCartReadinessSnapshot(guestApi, checkoutSessionRequestFromForm(formData), {
    forceRefresh: forceReadinessRefresh,
  });
  const session = await guestApi.createCheckoutSession(sessionRequest);
  const response = redirectDocument(await checkoutSessionPath(session, writeSources));
  appendGuestCheckoutCookie(response.headers, params.guest.guestToken, request, params.guest.expiresAt);
  appendClearedAnonymousCartCookie(response.headers, request);

  return response;
}

/** Recovers a signed-in-as-guest checkout whose guest access no longer
 * matches the session it is trying to start: mint a fresh guest checkout
 * from the recorded contact and retry once. */
export async function recoverGuestCheckoutStartMismatch(
  error: unknown,
  actor: CheckoutActor,
  request: Request,
  formData: FormData,
  params: Readonly<{ anonymousCartId: string | null; sourceType: string }>,
) {
  if (
    !isCheckoutAuthorizationError(error) ||
    !isGuestCheckoutActor(actor) ||
    !canRecoverGuestCheckoutMismatch(params.sourceType, params.anonymousCartId)
  ) {
    return null;
  }

  const contact = await loadGuestCheckoutStartContact(request);
  if (!contact) {
    return null;
  }

  try {
    const guest = await createGuestCheckoutStart(request, contact);
    return await startGuestCheckoutSession(request, formData, { ...params, guest });
  } catch (recoveryError) {
    if (isCheckoutAuthorizationError(recoveryError)) {
      return null;
    }

    throw recoveryError;
  }
}

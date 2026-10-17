import { redirectDocument } from "react-router";
import type { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { navigateAfterWriteFromSourcesWithPlatformPostWriteToken } from "@chase-sets/platform-runtime/post-write-tokens";
import { createAuthRequestApiClient } from "@chase-sets/auth/server";
import { CheckoutApiError, createCheckoutRequestApiClient } from "../../request-support/api-client";
import {
  appendClearedAnonymousCartCookie,
  appendGuestCheckoutCookie,
  CHECKOUT_GUEST_COOKIE_NAME,
} from "../../request-support/guest-checkout";
import { checkoutSessionRequestFromForm, ensureCartReadinessSnapshot } from "./checkout-start-source";
import type { CheckoutStartSource } from "../../../features/sessions/ui/checkout-start-page-types";

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

export function isCheckoutAuthorizationError(error: unknown) {
  return error instanceof CheckoutApiError && error.status === 403;
}

function isGuestCheckoutActor(actor: CheckoutActor) {
  return actor?.roleKey === "guest-buyer";
}

export function canRecoverGuestCheckoutMismatch(sourceType: string, anonymousCartId: string | null) {
  return sourceType === "buy-now" || (sourceType === "cart" && Boolean(anonymousCartId));
}

export async function createGuestCheckoutStart(request: Request): Promise<GuestCheckoutStart> {
  return createAuthRequestApiClient(request).startGuestCheckout<GuestCheckoutStart>({});
}

/** Creates the checkout session under a freshly started guest checkout
 * identity: attempts the continuity merge, creates readiness/session from the
 * Account-plus-presented-anonymous union, and applies cookies only after the
 * session succeeds. */
export async function startGuestCheckoutSession(
  request: Request,
  formData: FormData,
  params: Readonly<{
    anonymousCartId: string | null;
    sourceType: string;
    source: CheckoutStartSource | null;
    guest: GuestCheckoutStart;
  }>,
) {
  const guestHeaders = {
    cookie: `${CHECKOUT_GUEST_COOKIE_NAME}=${encodeURIComponent(params.guest.guestToken)}`,
    ...(params.anonymousCartId ? { "x-checkout-anonymous-cart-id": params.anonymousCartId } : {}),
  };
  const guestApi = createCheckoutRequestApiClient(request, { headers: guestHeaders });
  const writeSources: unknown[] = [];
  const forceReadinessRefresh = params.sourceType === "cart" && Boolean(params.anonymousCartId);
  if (params.sourceType === "cart" && params.anonymousCartId) {
    try {
      writeSources.push(await guestApi.mergeGuestCartToAccount(params.anonymousCartId));
    } catch {
      // The cart API emits the fixed redacted failure event. The same client
      // retains the anonymous source header for readiness and session union.
    }
  }

  const sessionRequest = await ensureCartReadinessSnapshot(
    guestApi,
    checkoutSessionRequestFromForm(formData, params.source),
    { forceRefresh: forceReadinessRefresh },
  );
  const session = await guestApi.createCheckoutSession(sessionRequest);
  const response = redirectDocument(await checkoutSessionPath(session, writeSources));
  appendGuestCheckoutCookie(response.headers, params.guest.guestToken, request, params.guest.expiresAt);
  appendClearedAnonymousCartCookie(response.headers, request);

  return response;
}

/** Recovers a signed-in-as-guest checkout whose guest access no longer
 * matches the session it is trying to start by minting one fresh contact-less
 * guest identity and retrying once. */
export async function recoverGuestCheckoutStartMismatch(
  error: unknown,
  actor: CheckoutActor,
  request: Request,
  formData: FormData,
  params: Readonly<{
    anonymousCartId: string | null;
    sourceType: string;
    source: CheckoutStartSource | null;
  }>,
) {
  if (
    !isCheckoutAuthorizationError(error) ||
    !isGuestCheckoutActor(actor) ||
    !canRecoverGuestCheckoutMismatch(params.sourceType, params.anonymousCartId)
  ) {
    return null;
  }

  try {
    const guest = await createGuestCheckoutStart(request);
    return await startGuestCheckoutSession(request, formData, { ...params, guest });
  } catch (recoveryError) {
    if (isCheckoutAuthorizationError(recoveryError)) {
      return null;
    }

    throw recoveryError;
  }
}

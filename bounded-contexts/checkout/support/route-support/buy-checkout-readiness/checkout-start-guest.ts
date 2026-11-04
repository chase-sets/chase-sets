import { redirect } from "react-router";
import type { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { navigateAfterWriteFromSourcesWithPlatformPostWriteToken } from "@chase-sets/platform-runtime/post-write-tokens";
import { createAuthRequestApiClient } from "@chase-sets/auth/server";
import { CheckoutApiError } from "../../request-support/api-client";
import { appendGuestCheckoutCookie } from "../../request-support/guest-checkout";

export type CheckoutActor = Awaited<ReturnType<typeof resolveActorFromAuthApi>>;

type GuestCheckoutStart = Readonly<{
  accountId: string;
  guestToken: string;
  expiresAt: string;
}>;

/** Marks the followed POST of a guest entry `307`. */
const GUEST_ENTRY_PARAM = "guestEntry";

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

function isCheckoutAuthorizationError(error: unknown) {
  return error instanceof CheckoutApiError && error.status === 403;
}

function isGuestCheckoutActor(actor: CheckoutActor) {
  return actor?.roleKey === "guest-buyer";
}

function canRecoverGuestCheckoutMismatch(sourceType: string, anonymousCartId: string | null) {
  return sourceType === "buy-now" || (sourceType === "cart" && Boolean(anonymousCartId));
}

async function createGuestCheckoutStart(request: Request): Promise<GuestCheckoutStart> {
  return createAuthRequestApiClient(request).startGuestCheckout<GuestCheckoutStart>({});
}

/** Whether this POST is the one a guest entry `307` sent on, presenting the guest it minted. */
export function isGuestEntryRequest(request: Request) {
  return new URL(request.url).searchParams.get(GUEST_ENTRY_PARAM) === "1";
}

/**
 * Mints one contact-less guest and answers a plain (not document) `307` to the
 * same path plus `guestEntry=1`, carrying only the guest cookie. The browser or
 * data router re-sends the same method and body, so the followed POST opens the
 * Session as the guest it presents. This request makes no Checkout call.
 */
export async function startGuestCheckoutEntry(request: Request) {
  const guest = await createGuestCheckoutStart(request);
  const url = new URL(request.url);
  url.searchParams.set(GUEST_ENTRY_PARAM, "1");
  const response = redirect(`${url.pathname}${url.search}`, 307);
  appendGuestCheckoutCookie(response.headers, guest.guestToken, request, guest.expiresAt);

  return response;
}

/**
 * Recovers a signed-in-as-guest checkout whose guest access no longer matches
 * the Session it is trying to start: mints one fresh contact-less guest and
 * hands the same POST to it through the guest entry `307`. A followed guest
 * entry never recovers again, so a refused new guest cannot loop.
 */
export async function recoverGuestCheckoutStartMismatch(
  error: unknown,
  actor: CheckoutActor,
  request: Request,
  params: Readonly<{
    anonymousCartId: string | null;
    sourceType: string;
  }>,
) {
  if (
    !isCheckoutAuthorizationError(error) ||
    !isGuestCheckoutActor(actor) ||
    isGuestEntryRequest(request) ||
    !canRecoverGuestCheckoutMismatch(params.sourceType, params.anonymousCartId)
  ) {
    return null;
  }

  return startGuestCheckoutEntry(request);
}

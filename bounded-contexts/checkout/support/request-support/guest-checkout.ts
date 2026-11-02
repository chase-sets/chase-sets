import { AUTH_GUEST_CHECKOUT_COOKIE_NAME } from "@chase-sets/auth-context";
import { serializeCookie } from "@chase-sets/http/cookies";
import { createId } from "@chase-sets/primitives/typed-ids";

export const CHECKOUT_ANONYMOUS_CART_COOKIE_NAME = "chase_sets_anonymous_cart";
export const CHECKOUT_ANONYMOUS_SELL_LIST_COOKIE_NAME = "chase_sets_anonymous_sell_list";
const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;
const ONE_DAY_SECONDS = 60 * 60 * 24;

function parseCookieHeader(cookieHeader: string | null) {
  if (!cookieHeader) {
    return new Map<string, string>();
  }

  return new Map(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf("=");
        if (separatorIndex < 0) {
          return [part, ""];
        }

        return [part.slice(0, separatorIndex), decodeURIComponent(part.slice(separatorIndex + 1))];
      }),
  );
}

export function readAnonymousCartId(request: Request) {
  const value = parseCookieHeader(request.headers.get("cookie")).get(CHECKOUT_ANONYMOUS_CART_COOKIE_NAME) ?? null;
  return value?.startsWith("anon_") ? value : null;
}

export function ensureAnonymousCartId(request: Request) {
  return readAnonymousCartId(request) ?? `anon_${createId("cmd")}`;
}

export function readAnonymousSellListId(request: Request) {
  const value = parseCookieHeader(request.headers.get("cookie")).get(CHECKOUT_ANONYMOUS_SELL_LIST_COOKIE_NAME) ?? null;
  return value?.startsWith("anon_") ? value : null;
}

export function ensureAnonymousSellListId(request: Request) {
  return readAnonymousSellListId(request) ?? `anon_${createId("cmd")}`;
}

export function appendAnonymousCartCookie(headers: Headers, anonymousCartId: string, request?: Request) {
  headers.append(
    "Set-Cookie",
    serializeCookie(CHECKOUT_ANONYMOUS_CART_COOKIE_NAME, anonymousCartId, {
      maxAgeSeconds: THIRTY_DAYS_SECONDS,
      request,
    }),
  );
}

export function appendAnonymousSellListCookie(headers: Headers, anonymousSellListId: string, request?: Request) {
  headers.append(
    "Set-Cookie",
    serializeCookie(CHECKOUT_ANONYMOUS_SELL_LIST_COOKIE_NAME, anonymousSellListId, {
      maxAgeSeconds: THIRTY_DAYS_SECONDS,
      request,
    }),
  );
}

/**
 * Max-Age tracks the auth-issued guest checkout token's `expiresAt` (the
 * server-side TTL is env-configurable) rather than a second, locally
 * hardcoded duration, so the cookie can never outlive -- or diverge from --
 * the token it carries. Falls back to the prior default when no `expiresAt`
 * is supplied, matching prior behavior exactly.
 */
export function appendGuestCheckoutCookie(headers: Headers, guestToken: string, request?: Request, expiresAt?: string) {
  const maxAgeSeconds = expiresAt
    ? Math.max(Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000), 0)
    : ONE_DAY_SECONDS;
  headers.append(
    "Set-Cookie",
    serializeCookie(AUTH_GUEST_CHECKOUT_COOKIE_NAME, guestToken, { maxAgeSeconds, request }),
  );
}

export function appendClearedAnonymousCartCookie(headers: Headers, request?: Request) {
  headers.append("Set-Cookie", serializeCookie(CHECKOUT_ANONYMOUS_CART_COOKIE_NAME, "", { maxAgeSeconds: 0, request }));
}

export function appendClearedAnonymousSellListCookie(headers: Headers, request?: Request) {
  headers.append(
    "Set-Cookie",
    serializeCookie(CHECKOUT_ANONYMOUS_SELL_LIST_COOKIE_NAME, "", { maxAgeSeconds: 0, request }),
  );
}

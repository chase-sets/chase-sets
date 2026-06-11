import { createId } from "@chase-sets/primitives/typed-ids";

export const DISCOVERY_ANONYMOUS_PRODUCT_ALERT_COOKIE_NAME = "chase_sets_anonymous_product_alerts";
const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;

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

function isHttpsRequest(request?: Request) {
  return request ? new URL(request.url).protocol === "https:" : false;
}

function serializeCookie(name: string, value: string, maxAgeSeconds: number, request?: Request) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    ...(isHttpsRequest(request) ? ["Secure"] : []),
  ].join("; ");
}

export function readAnonymousProductAlertOwnerId(request: Request) {
  const value =
    parseCookieHeader(request.headers.get("cookie")).get(DISCOVERY_ANONYMOUS_PRODUCT_ALERT_COOKIE_NAME) ?? null;
  return value?.startsWith("anon_") ? value : null;
}

export function ensureAnonymousProductAlertOwnerId(request: Request) {
  return readAnonymousProductAlertOwnerId(request) ?? `anon_${createId("cmd")}`;
}

export function appendAnonymousProductAlertCookie(headers: Headers, anonymousOwnerId: string, request?: Request) {
  headers.append(
    "Set-Cookie",
    serializeCookie(DISCOVERY_ANONYMOUS_PRODUCT_ALERT_COOKIE_NAME, anonymousOwnerId, THIRTY_DAYS_SECONDS, request),
  );
}

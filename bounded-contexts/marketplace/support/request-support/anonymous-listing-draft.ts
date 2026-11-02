import { serializeCookie } from "@chase-sets/http/cookies";
import { createId } from "@chase-sets/primitives/typed-ids";

export const MARKETPLACE_ANONYMOUS_LISTING_DRAFT_COOKIE_NAME = "chase_sets_anonymous_listing_drafts";
export const MARKETPLACE_ANONYMOUS_REPORT_COOKIE_NAME = "chase_sets_anonymous_reports";
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

export function readAnonymousListingDraftOwnerId(request: Request) {
  const value =
    parseCookieHeader(request.headers.get("cookie")).get(MARKETPLACE_ANONYMOUS_LISTING_DRAFT_COOKIE_NAME) ?? null;
  return value?.startsWith("anon_") ? value : null;
}

export function ensureAnonymousListingDraftOwnerId(request: Request) {
  return readAnonymousListingDraftOwnerId(request) ?? `anon_${createId("cmd")}`;
}

export function appendAnonymousListingDraftCookie(headers: Headers, anonymousOwnerId: string, request?: Request) {
  headers.append(
    "Set-Cookie",
    serializeCookie(MARKETPLACE_ANONYMOUS_LISTING_DRAFT_COOKIE_NAME, anonymousOwnerId, {
      maxAgeSeconds: THIRTY_DAYS_SECONDS,
      request,
    }),
  );
}

export function readAnonymousReportId(request: Request) {
  const value = parseCookieHeader(request.headers.get("cookie")).get(MARKETPLACE_ANONYMOUS_REPORT_COOKIE_NAME) ?? null;
  return value?.startsWith("anon_") ? value : null;
}

export function ensureAnonymousReportId(request: Request) {
  return readAnonymousReportId(request) ?? `anon_${createId("cmd")}`;
}

export function appendAnonymousReportCookie(headers: Headers, anonymousReportId: string, request?: Request) {
  headers.append(
    "Set-Cookie",
    serializeCookie(MARKETPLACE_ANONYMOUS_REPORT_COOKIE_NAME, anonymousReportId, {
      maxAgeSeconds: THIRTY_DAYS_SECONDS,
      request,
    }),
  );
}

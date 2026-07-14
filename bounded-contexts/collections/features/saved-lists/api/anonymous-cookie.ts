import { createId } from "@chase-sets/primitives/typed-ids";

export const COLLECTIONS_ANONYMOUS_SAVED_LIST_COOKIE_NAME = "chase_sets_anonymous_saved_lists";
const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;

export function readAnonymousSavedListOwnerId(request: Request) {
  const value = parseCookieHeader(request.headers.get("cookie")).get(COLLECTIONS_ANONYMOUS_SAVED_LIST_COOKIE_NAME);
  return value?.startsWith("anon_") ? value : null;
}

export function ensureAnonymousSavedListOwnerId(request: Request) {
  return readAnonymousSavedListOwnerId(request) ?? `anon_${createId("cmd")}`;
}

export function appendAnonymousSavedListCookie(headers: Headers, anonymousOwnerId: string, request?: Request) {
  const secure = request && new URL(request.url).protocol === "https:" ? "; Secure" : "";
  headers.append(
    "Set-Cookie",
    `${COLLECTIONS_ANONYMOUS_SAVED_LIST_COOKIE_NAME}=${encodeURIComponent(anonymousOwnerId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${THIRTY_DAYS_SECONDS}${secure}`,
  );
}

function parseCookieHeader(cookieHeader: string | null) {
  if (!cookieHeader) return new Map<string, string>();
  return new Map(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index < 0 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

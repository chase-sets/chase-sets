import { createForwardedAuthHeaders } from "@chase-sets/bounded-context-runtime/http";
import { createAuthRequestApiClient } from "../request-support/api-client";
import {
  AUTH_ACCOUNT_SELECTION_COOKIE_NAME,
  AUTH_SESSION_COOKIE_NAME,
} from "../request-support/cookies";

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

        return [
          part.slice(0, separatorIndex),
          decodeURIComponent(part.slice(separatorIndex + 1)),
        ];
      }),
  );
}

function serializeCookie(
  name: string,
  value: string,
  options: Readonly<{
    request?: Request;
    maxAgeSeconds?: number;
  }> = {},
) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (typeof options.maxAgeSeconds === "number") {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }

  const protocol = options.request
    ? new URL(options.request.url).protocol
    : "http:";

  if (protocol === "https:") {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function readCookie(request: Request, name: string) {
  return parseCookieHeader(request.headers.get("cookie")).get(name) ?? null;
}

function createRedirectResponse(location: string, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Location", location);
  return new Response(null, { status: 302, headers: responseHeaders });
}

function appendSessionCookie(
  headers: Headers,
  sessionToken: string,
  request?: Request,
) {
  headers.append(
    "Set-Cookie",
    serializeCookie(AUTH_SESSION_COOKIE_NAME, sessionToken, {
      request,
      maxAgeSeconds: 60 * 60 * 24 * 14,
    }),
  );
}

function clearSessionCookie(
  headers: Headers,
  request?: Request,
) {
  headers.append(
    "Set-Cookie",
    serializeCookie(AUTH_SESSION_COOKIE_NAME, "", {
      request,
      maxAgeSeconds: 0,
    }),
  );
}

function appendAccountSelectionCookie(
  headers: Headers,
  selectionToken: string,
  request?: Request,
) {
  headers.append(
    "Set-Cookie",
    serializeCookie(AUTH_ACCOUNT_SELECTION_COOKIE_NAME, selectionToken, {
      request,
      maxAgeSeconds: 60 * 10,
    }),
  );
}

function clearAccountSelectionCookie(
  headers: Headers,
  request?: Request,
) {
  headers.append(
    "Set-Cookie",
    serializeCookie(AUTH_ACCOUNT_SELECTION_COOKIE_NAME, "", {
      request,
      maxAgeSeconds: 0,
    }),
  );
}

function isSafeReturnTo(value: string | null): value is string {
  return Boolean(value && value.startsWith("/") && !value.startsWith("//"));
}

export function getSafeReturnTo(request: Request, fallback: string) {
  const returnTo = new URL(request.url).searchParams.get("returnTo");
  return isSafeReturnTo(returnTo) ? returnTo : fallback;
}

export { createAuthRequestApiClient };

export function requireAccountSelectionTokenOrRedirect(
  request: Request,
  options: Readonly<{
    signInPath?: string;
    fallbackPath?: string;
  }> = {},
) {
  const selectionToken =
    readCookie(request, AUTH_ACCOUNT_SELECTION_COOKIE_NAME);
  if (!selectionToken) {
    throw createRedirectResponse(
      `${options.signInPath ?? "/sign-in"}?returnTo=${encodeURIComponent(
        getSafeReturnTo(request, options.fallbackPath ?? "/"),
      )}`,
    );
  }

  return selectionToken;
}

export function completeBrowserAuthentication(
  request: Request,
  result: Readonly<{
    requiresAccountSelection?: boolean;
    selectionToken?: string;
    sessionToken?: string;
  }>,
  options: Readonly<{
    defaultSuccessPath: string;
    accountSelectionPath: string;
  }>,
) {
  const headers = new Headers();
  clearAccountSelectionCookie(headers, request);

  if (result.requiresAccountSelection) {
    if (!result.selectionToken) {
      return { error: "Account selection could not be started." };
    }

    appendAccountSelectionCookie(headers, result.selectionToken, request);
    throw createRedirectResponse(
      `${options.accountSelectionPath}?returnTo=${encodeURIComponent(
        getSafeReturnTo(request, options.defaultSuccessPath),
      )}`,
      headers,
    );
  }

  if (!result.sessionToken) {
    return { error: "Authentication did not return a session." };
  }

  appendSessionCookie(headers, result.sessionToken, request);
  throw createRedirectResponse(
    getSafeReturnTo(request, options.defaultSuccessPath),
    headers,
  );
}

export async function signOutActorViaAuthApi(
  request: Request,
  options: Readonly<{
    returnTo?: string;
  }> = {},
) {
  const headers = new Headers();
  clearAccountSelectionCookie(headers, request);
  clearSessionCookie(headers, request);

  try {
    const api = createAuthRequestApiClient(request);
    await api.signOutCurrentSession();
  } catch {
    try {
      await globalThis.fetch(new URL("sign-out", new URL("/api/auth/", request.url)), {
        method: "POST",
        headers: createForwardedAuthHeaders(request),
        credentials: "include",
      });
    } catch {
      // Clearing local cookies is enough to end the browser session.
    }
  }

  return createRedirectResponse(options.returnTo ?? "/", headers);
}

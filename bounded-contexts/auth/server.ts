import {
  hasPermission as hasActorPermission,
  requireActorFromAuthApi,
  resolveActorFromAuthApi,
  type ResolvedActor,
} from "@chase-sets/auth-runtime";
import {
  createForwardedAuthHeaders,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";

export const AUTH_SESSION_COOKIE_NAME = "chase_sets_session";
export const AUTH_ACCOUNT_SELECTION_COOKIE_NAME =
  "chase_sets_account_selection";

export type { ResolvedActor } from "@chase-sets/auth-runtime";

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

export function readCookie(request: Request, name: string) {
  return parseCookieHeader(request.headers.get("cookie")).get(name) ?? null;
}

function createRedirectResponse(location: string, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Location", location);
  return new Response(null, { status: 302, headers: responseHeaders });
}

function isSafeReturnTo(value: string | null): value is string {
  return Boolean(value && value.startsWith("/") && !value.startsWith("//"));
}

export function getSafeReturnTo(request: Request, fallback: string) {
  const returnTo = new URL(request.url).searchParams.get("returnTo");
  return isSafeReturnTo(returnTo) ? returnTo : fallback;
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

export function hasPermission(
  actor: ResolvedActor | null | undefined,
  permission: string,
) {
  return hasActorPermission(actor, permission);
}

export async function resolveActorFromAuthContext(options: Readonly<{
  request: Request;
  authApiBasePath?: string;
  fetch?: typeof globalThis.fetch;
}>) {
  return resolveActorFromAuthApi({
    request: options.request,
    authApiBaseUrl: resolveRequestApiBaseUrl(
      options.request,
      options.authApiBasePath ?? "/api/auth",
    ),
    sessionPath: "session",
    fetch: options.fetch,
  });
}

export async function requireActorFromAuthContext(options: Readonly<{
  request: Request;
  permission?: string;
  signInPath?: string;
  authApiBasePath?: string;
  fetch?: typeof globalThis.fetch;
}>) {
  return requireActorFromAuthApi({
    request: options.request,
    permission: options.permission,
    signInPath: options.signInPath,
    authApiBaseUrl: resolveRequestApiBaseUrl(
      options.request,
      options.authApiBasePath ?? "/api/auth",
    ),
    sessionPath: "session",
    fetch: options.fetch,
  });
}

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
    authApiBasePath?: string;
    returnTo?: string;
    fetch?: typeof globalThis.fetch;
  }> = {},
) {
  const headers = new Headers();
  clearAccountSelectionCookie(headers, request);
  clearSessionCookie(headers, request);

  try {
    const authApiBaseUrl = resolveRequestApiBaseUrl(
      request,
      options.authApiBasePath ?? "/api/auth",
    );
    await (options.fetch ?? globalThis.fetch)(
      new URL("sign-out", `${authApiBaseUrl}/`),
      {
        method: "POST",
        headers: createForwardedAuthHeaders(request),
        credentials: "include",
      },
    );
  } catch {
    // Clearing local cookies is enough to end the browser session.
  }

  return createRedirectResponse(options.returnTo ?? "/", headers);
}

import {
  createActorEventStoreContext as createGenericActorEventStoreContext,
  hasPermission as hasActorPermission,
  requireActorFromAuthApi,
  resolveActorFromAuthApi,
  type ResolvedActor,
} from "@chase-sets/auth-runtime";
import { resolveRequestApiBaseUrl } from "@chase-sets/bounded-context-runtime";
import type { PermissionKey } from "./common";
import {
  IDENTITY_BOOTSTRAP_TENANT_ID,
} from "./constants";
import { getSessionByTokenHash } from "./auth-support/store";
import type { IdentityServices } from "./services";

export const IDENTITY_SESSION_COOKIE_NAME = "chase_sets_session";
export const IDENTITY_ACCOUNT_SELECTION_COOKIE_NAME =
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

export function readIdentitySessionToken(request: Request) {
  const cookieToken = readCookie(request, IDENTITY_SESSION_COOKIE_NAME);
  if (cookieToken) {
    return cookieToken;
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  return authorization.slice("Bearer ".length).trim() || null;
}

export function readAccountSelectionToken(request: Request) {
  return readCookie(request, IDENTITY_ACCOUNT_SELECTION_COOKIE_NAME);
}

function createRedirectResponse(location: string, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Location", location);
  return new Response(null, { status: 302, headers: responseHeaders });
}

function buildCurrentPath(request: Request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function resolveIdentityApiBaseUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/api/auth";
  } else if (url.pathname === "/api/identity") {
    url.pathname = "/api/auth";
  }

  return url.toString().replace(/\/$/, "");
}

function isSafeReturnTo(value: string | null) {
  return Boolean(value && value.startsWith("/") && !value.startsWith("//"));
}

export function getSafeReturnTo(request: Request, fallback: string) {
  const returnTo = new URL(request.url).searchParams.get("returnTo");
  return isSafeReturnTo(returnTo) ? returnTo! : fallback;
}

export function appendIdentitySessionCookie(
  headers: Headers,
  sessionToken: string,
  request?: Request,
) {
  headers.append(
    "Set-Cookie",
    serializeCookie(IDENTITY_SESSION_COOKIE_NAME, sessionToken, {
      request,
      maxAgeSeconds: 60 * 60 * 24 * 14,
    }),
  );
}

export function clearIdentitySessionCookie(
  headers: Headers,
  request?: Request,
) {
  headers.append(
    "Set-Cookie",
    serializeCookie(IDENTITY_SESSION_COOKIE_NAME, "", {
      request,
      maxAgeSeconds: 0,
    }),
  );
}

export function appendAccountSelectionCookie(
  headers: Headers,
  selectionToken: string,
  request?: Request,
) {
  headers.append(
    "Set-Cookie",
    serializeCookie(IDENTITY_ACCOUNT_SELECTION_COOKIE_NAME, selectionToken, {
      request,
      maxAgeSeconds: 60 * 10,
    }),
  );
}

export function clearAccountSelectionCookie(
  headers: Headers,
  request?: Request,
) {
  headers.append(
    "Set-Cookie",
    serializeCookie(IDENTITY_ACCOUNT_SELECTION_COOKIE_NAME, "", {
      request,
      maxAgeSeconds: 0,
    }),
  );
}

export function hasPermission(
  actor: ResolvedActor | null | undefined,
  permission: PermissionKey,
) {
  return hasActorPermission(actor, permission);
}

export function createActorEventStoreContext(
  actor: ResolvedActor,
) {
  return createGenericActorEventStoreContext(actor);
}

export async function resolveActorFromSessionToken(
  services: IdentityServices,
  sessionToken: string,
): Promise<ResolvedActor | null> {
  const tokenRecord = await getSessionByTokenHash(
    services.db,
    services.auth.hashSecret(sessionToken),
  );

  if (!tokenRecord || new Date(tokenRecord.expires_at).getTime() <= Date.now()) {
    return null;
  }

  const session = await services.sessions.getSession(tokenRecord.session_id);
  if (
    !session ||
    session.status !== "active" ||
    new Date(session.expires_at).getTime() <= Date.now()
  ) {
    return null;
  }

  const membership =
    await services.memberships.getActiveMembershipForUserAccount(
      session.user_id,
      session.account_id,
    );

  if (!membership) {
    return null;
  }

  return {
    sessionId: session.session_id,
    tenantId: IDENTITY_BOOTSTRAP_TENANT_ID,
    userId: session.user_id,
    accountId: session.account_id,
    membershipId: membership.membership_id,
    roleKey: membership.role_key,
    permissions: membership.role_permissions as readonly PermissionKey[],
  };
}

export async function resolveActorFromRequest(
  services: IdentityServices,
  request: Request,
): Promise<ResolvedActor | null> {
  const sessionToken = readIdentitySessionToken(request);
  if (!sessionToken) {
    return null;
  }

  return resolveActorFromSessionToken(services, sessionToken);
}

export function createForwardedAuthHeaders(
  request: Request,
  initHeaders?: HeadersInit,
) {
  const headers = new Headers(initHeaders);
  const cookie = request.headers.get("cookie");
  const authorization = request.headers.get("authorization");

  if (cookie && !headers.has("cookie")) {
    headers.set("cookie", cookie);
  }

  if (authorization && !headers.has("authorization")) {
    headers.set("authorization", authorization);
  }

  return headers;
}

export function createForwardedAuthFetch(
  request: Request,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return (input, init = {}) =>
    fetchImpl(input, {
      ...init,
      credentials: init.credentials ?? "include",
      headers: createForwardedAuthHeaders(request, init.headers),
    });
}

export async function resolveActorFromIdentityApi(options: Readonly<{
  identityApiBaseUrl: string;
  request: Request;
  fetch?: typeof globalThis.fetch;
}>): Promise<ResolvedActor | null> {
  return resolveActorFromAuthApi({
    authApiBaseUrl: resolveIdentityApiBaseUrl(options.identityApiBaseUrl),
    request: options.request,
    fetch: options.fetch,
  });
}

export async function requireActorFromIdentityApi(options: Readonly<{
  request: Request;
  permission?: PermissionKey;
  signInPath?: string;
  identityApiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
}>): Promise<ResolvedActor> {
  return requireActorFromAuthApi({
    request: options.request,
    permission: options.permission,
    signInPath: options.signInPath,
    authApiBaseUrl:
      options.identityApiBaseUrl
        ? resolveIdentityApiBaseUrl(options.identityApiBaseUrl)
        : resolveRequestApiBaseUrl(options.request, "/api/auth"),
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
  const selectionToken = readAccountSelectionToken(request);
  if (!selectionToken) {
    throw createRedirectResponse(
      `${options.signInPath ?? "/sign-in"}?returnTo=${encodeURIComponent(
        getSafeReturnTo(request, options.fallbackPath ?? "/account"),
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

  appendIdentitySessionCookie(headers, result.sessionToken, request);
  throw createRedirectResponse(
    getSafeReturnTo(request, options.defaultSuccessPath),
    headers,
  );
}

export async function signOutActorViaIdentityApi(
  request: Request,
  options: Readonly<{
    identityApiBaseUrl?: string;
    returnTo?: string;
    fetch?: typeof globalThis.fetch;
  }> = {},
) {
  const headers = new Headers();
  clearAccountSelectionCookie(headers, request);
  clearIdentitySessionCookie(headers, request);

  try {
    const identityApiBaseUrl =
      options.identityApiBaseUrl ??
      resolveRequestApiBaseUrl(request, "/api/auth");
    await (options.fetch ?? globalThis.fetch)(
      new URL("sign-out", `${identityApiBaseUrl}/`),
      {
        method: "POST",
        headers: createForwardedAuthHeaders(request),
        credentials: "include",
      },
    );
  } catch {
    // Clearing the local cookies is enough to end the browser session.
  }

  return createRedirectResponse(options.returnTo ?? "/search", headers);
}

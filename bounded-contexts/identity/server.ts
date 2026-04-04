import type { ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PermissionKey } from "./common";
import {
  IDENTITY_BOOTSTRAP_TENANT_ID,
} from "./constants";
import { getSessionByTokenHash } from "./auth-support/store";
import type { IdentityServices } from "./services";

export const IDENTITY_SESSION_COOKIE_NAME = "chase_sets_session";
export const IDENTITY_ACCOUNT_SELECTION_COOKIE_NAME =
  "chase_sets_account_selection";

export type { ResolvedActor } from "@chase-sets/auth-context";

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function resolveIdentityApiUrl(baseUrl: string, path: string) {
  const normalizedPath = path.replace(/^\/+/, "");

  if (/\/api\/identity\/?$/i.test(baseUrl)) {
    return new URL(normalizedPath, normalizeBaseUrl(baseUrl));
  }

  return new URL(`api/identity/${normalizedPath}`, normalizeBaseUrl(baseUrl));
}

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
  return actor?.permissions.includes(permission) ?? false;
}

export function createActorEventStoreContext(
  actor: ResolvedActor,
): EventStoreContext {
  return {
    tenantId: actor.tenantId as never,
    audit: {
      performedByUserId: actor.userId as never,
      forAccountId: actor.accountId as never,
    },
    trace: {},
  };
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
  const response = await (options.fetch ?? globalThis.fetch)(
    resolveIdentityApiUrl(options.identityApiBaseUrl, "auth/session"),
    {
      headers: createForwardedAuthHeaders(options.request),
      credentials: "include",
    },
  );

  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Unable to resolve current actor. Status ${response.status}.`);
  }

  const body = (await response.json()) as { actor: ResolvedActor };
  return body.actor;
}

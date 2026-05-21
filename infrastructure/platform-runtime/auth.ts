import type { ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createForwardedAuthHeaders, resolveRequestApiBaseUrl } from "./http";

export type { ResolvedActor } from "@chase-sets/auth-context";

const TRANSIENT_AUTH_RESOLUTION_STATUSES = new Set([502, 503, 504]);

export class AuthResolutionError extends Error {
  readonly authApiBaseUrl: string;
  readonly status: number;

  constructor(authApiBaseUrl: string, status: number) {
    super(`Unable to resolve current actor from '${authApiBaseUrl}'. Status ${status}.`);
    this.name = "AuthResolutionError";
    this.authApiBaseUrl = authApiBaseUrl;
    this.status = status;
  }
}

export function isTransientAuthResolutionError(error: unknown) {
  return error instanceof AuthResolutionError && TRANSIENT_AUTH_RESOLUTION_STATUSES.has(error.status);
}

export function hasPermission(actor: ResolvedActor | null | undefined, permission: string) {
  return actor?.permissions.includes(permission) ?? false;
}

export function createActorEventStoreContext(actor: ResolvedActor): EventStoreContext {
  return {
    tenantId: actor.tenantId as never,
    audit: {
      performedByUserId: actor.userId as never,
      forAccountId: actor.accountId as never,
    },
    trace: {},
  };
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function normalizeAuthApiBaseUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/api/auth";
  } else if (url.pathname === "/api/identity") {
    url.pathname = "/api/auth";
  }

  return url.toString().replace(/\/$/, "");
}

function resolveAuthSessionUrl(baseUrl: string, sessionPath: string) {
  const normalizedPath = sessionPath.replace(/^\/+/, "");
  return new URL(normalizedPath, normalizeBaseUrl(baseUrl));
}

function createRedirectResponse(location: string) {
  return new Response(null, {
    status: 302,
    headers: { Location: location },
  });
}

function buildCurrentPath(request: Request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

export async function resolveActorFromAuthApi(
  options: Readonly<{
    request: Request;
    authApiBaseUrl?: string;
    authApiBasePath?: string;
    sessionPath?: string;
    fetch?: typeof globalThis.fetch;
  }>,
): Promise<ResolvedActor | null> {
  const authApiBaseUrl = options.authApiBaseUrl
    ? normalizeAuthApiBaseUrl(options.authApiBaseUrl)
    : resolveRequestApiBaseUrl(options.request, options.authApiBasePath ?? "/api/auth");
  const response = await (options.fetch ?? globalThis.fetch)(
    resolveAuthSessionUrl(authApiBaseUrl, options.sessionPath ?? "session"),
    {
      headers: createForwardedAuthHeaders(options.request),
      credentials: "include",
    },
  );

  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new AuthResolutionError(authApiBaseUrl, response.status);
  }

  const body = (await response.json()) as { actor: ResolvedActor };
  return body.actor;
}

export async function requireActorFromAuthApi(
  options: Readonly<{
    request: Request;
    permission?: string;
    signInPath?: string;
    authApiBaseUrl?: string;
    authApiBasePath?: string;
    sessionPath?: string;
    fetch?: typeof globalThis.fetch;
  }>,
): Promise<ResolvedActor> {
  const actor = await resolveActorFromAuthApi(options);

  if (!actor) {
    throw createRedirectResponse(
      `${options.signInPath ?? "/sign-in"}?returnTo=${encodeURIComponent(buildCurrentPath(options.request))}`,
    );
  }

  if (options.permission && !hasPermission(actor, options.permission)) {
    throw new Response("Forbidden.", { status: 403 });
  }

  return actor;
}

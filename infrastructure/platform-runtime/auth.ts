import type { ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createForwardedAuthHeaders, resolveRequestApiBaseUrl } from "./http";

export type { ResolvedActor } from "@chase-sets/auth-context";

const TRANSIENT_AUTH_RESOLUTION_STATUSES = new Set([502, 503, 504]);

export class AuthResolutionError extends Error {
  readonly authApiBaseUrl: string;
  readonly status: number;

  constructor(authApiBaseUrl: string, status: number, options: ErrorOptions = {}) {
    super(`Unable to resolve current actor from '${authApiBaseUrl}'. Status ${status}.`);
    this.name = "AuthResolutionError";
    this.authApiBaseUrl = authApiBaseUrl;
    this.status = status;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
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
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw new Error("authApiBaseUrl must be a valid absolute URL.", { cause: error });
  }
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
    : resolveRequestApiBaseUrl(options.request, options.authApiBasePath ?? "/api/auth", {
        requireInternalApiOrigin: true,
      });
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(
      resolveAuthSessionUrl(authApiBaseUrl, options.sessionPath ?? "session"),
      {
        headers: createForwardedAuthHeaders(options.request, undefined, { readTargetContextName: "auth" }),
        credentials: "include",
      },
    );
  } catch (error) {
    throw new AuthResolutionError(authApiBaseUrl, 503, { cause: error });
  }

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

export type RequiredActorFromAuthApiResult =
  | Readonly<{
      kind: "authorized";
      actor: ResolvedActor;
    }>
  | Readonly<{
      kind: "signed-out";
      response: Response;
    }>
  | Readonly<{
      kind: "forbidden";
      actor: ResolvedActor;
      requiredPermission: string;
    }>;

export async function resolveRequiredActorFromAuthApi(
  options: Readonly<{
    request: Request;
    permission?: string;
    signInPath?: string;
    authApiBaseUrl?: string;
    authApiBasePath?: string;
    sessionPath?: string;
    fetch?: typeof globalThis.fetch;
  }>,
): Promise<RequiredActorFromAuthApiResult> {
  const actor = await resolveActorFromAuthApi(options);

  if (!actor) {
    return {
      kind: "signed-out",
      response: createRedirectResponse(
        `${options.signInPath ?? "/sign-in"}?returnTo=${encodeURIComponent(buildCurrentPath(options.request))}`,
      ),
    };
  }

  if (options.permission && !hasPermission(actor, options.permission)) {
    return {
      kind: "forbidden",
      actor,
      requiredPermission: options.permission,
    };
  }

  return {
    kind: "authorized",
    actor,
  };
}

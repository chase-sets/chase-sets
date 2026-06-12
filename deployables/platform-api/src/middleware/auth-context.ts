import type { Context, Next } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { createAuthBootstrapContext } from "@chase-sets/auth-context";
import { createActorEventStoreContext, type ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { PLATFORM_INTERNAL_AUTH_HEADER, resolvePlatformInternalAuthSecret } from "@chase-sets/platform-runtime/http";
import type { PlatformIdentityServices } from "../app";
import { resolveActorFromRequest } from "../auth-request-context";
import { authenticationRequiredResponse } from "@chase-sets/http/responses";
import { attachActiveTraceContext } from "@chase-sets/observability";

const TENANT_HEADER = "x-tenant-id";
const USER_HEADER = "x-user-id";
const ACCOUNT_HEADER = "x-account-id";

export type TenantContextEnv = {
  Variables: {
    actor: ResolvedActor | null;
    context: EventStoreContext | null;
  };
};

const ANONYMOUS_ROUTES = new Set([
  "POST /api/auth/register",
  "POST /api/auth/password-sign-in",
  "POST /api/auth/magic-link/request",
  "POST /api/auth/magic-link/consume",
  "POST /api/auth/passkeys/challenge",
  "POST /api/auth/passkeys/register",
  "POST /api/auth/passkeys/sign-in",
  "POST /api/auth/invitations/accept",
  "POST /api/auth/guest-checkout/start",
  "POST /api/auth/guest-checkout/claim-link/request",
  "POST /api/auth/guest-checkout/claim-with-magic-link",
  "POST /api/auth/guest-checkout/claim-with-passkey",
  "POST /api/auth/account-selection/resolve",
  "POST /api/auth/account-selection/complete",
  "POST /api/identity/api-keys/resolve",
]);

function isAnonymousAllowed(method: string, pathname: string) {
  const signature = `${method.toUpperCase()} ${pathname}`;
  if (ANONYMOUS_ROUTES.has(signature)) {
    return true;
  }

  if (method.toUpperCase() === "GET" && pathname.startsWith("/api/auth/social/")) {
    return true;
  }

  return false;
}

function isInternalIdentityAuthRoute(pathname: string) {
  return pathname.startsWith("/api/identity/internal/auth/");
}

function isInternalGuestCheckoutClaimRoute(pathname: string) {
  return (
    pathname === "/api/auth/guest-checkout/claim-context" ||
    pathname === "/api/auth/guest-checkout/claim-link/request" ||
    pathname === "/api/auth/guest-checkout/claim-with-magic-link" ||
    pathname === "/api/auth/guest-checkout/claim-with-passkey"
  );
}

function hasInternalCapability(request: Request, secret: string) {
  return request.headers.get(PLATFORM_INTERNAL_AUTH_HEADER) === secret;
}

function createContextFromHeaders(request: Request) {
  const tenantId = request.headers.get(TENANT_HEADER);
  const userId = request.headers.get(USER_HEADER);
  const accountId = request.headers.get(ACCOUNT_HEADER);

  if (!tenantId || !userId || !accountId) {
    return null;
  }

  return {
    tenantId: tenantId as TenantId,
    audit: {
      performedByUserId: userId as UserId,
      forAccountId: accountId as AccountId,
    },
    trace: {},
  } satisfies EventStoreContext;
}

export function createIdentityAuthMiddleware(
  services: PlatformIdentityServices,
  options: Readonly<{ internalAuthSecret?: string }> = {},
) {
  const internalAuthSecret = options.internalAuthSecret ?? resolvePlatformInternalAuthSecret();
  return async function identityAuthMiddleware(c: Context<TenantContextEnv>, next: Next): Promise<Response | void> {
    const pathname = new URL(c.req.url).pathname;
    const headerContext = createContextFromHeaders(c.req.raw);

    if (isInternalIdentityAuthRoute(pathname) || isInternalGuestCheckoutClaimRoute(pathname)) {
      if (!hasInternalCapability(c.req.raw, internalAuthSecret)) {
        return c.json(authenticationRequiredResponse(), 401);
      }

      if (isInternalIdentityAuthRoute(pathname)) {
        c.set("actor", null);
        c.set("context", attachActiveTraceContext(createAuthBootstrapContext(services.auth)));
        await next();
        return;
      }
    }

    if (headerContext) {
      c.set("context", attachActiveTraceContext(headerContext));
      c.set("actor", null);
      await next();
      return;
    }

    const actor = await resolveActorFromRequest(services, c.req.raw);
    if (actor) {
      c.set("actor", actor);
      c.set("context", attachActiveTraceContext(createActorEventStoreContext(actor)));
      await next();
      return;
    }

    if (isAnonymousAllowed(c.req.method, pathname)) {
      c.set("actor", null);
      c.set("context", attachActiveTraceContext(createAuthBootstrapContext(services.auth)));
      await next();
      return;
    }

    return c.json(authenticationRequiredResponse(), 401);
  };
}

export type PlatformActorResolver = (request: Request) => Promise<ResolvedActor | null>;

export function createPlatformActorMiddleware(resolveActor: PlatformActorResolver) {
  return async function platformActorMiddleware(c: Context<TenantContextEnv>, next: Next): Promise<void> {
    const actor = await resolveActor(c.req.raw);

    c.set("actor", actor);
    c.set("context", actor ? attachActiveTraceContext(createActorEventStoreContext(actor)) : null);

    await next();
  };
}

import type { Context, Next } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createAuthBootstrapContext } from "@chase-sets/auth-context";
import { createActorEventStoreContext, type ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { PLATFORM_INTERNAL_AUTH_HEADER, resolvePlatformInternalAuthSecret } from "@chase-sets/platform-runtime/http";
import { verifyPlatformInternalAuthSecret } from "@chase-sets/platform-runtime/internal-auth";
import type { PlatformIdentityServices } from "../app";
import { authenticationRequiredResponse } from "@chase-sets/http/responses";
import { attachActiveTraceContext } from "@chase-sets/observability";

export type TenantContextEnv = {
  Variables: {
    actor: ResolvedActor | null;
    context: EventStoreContext | null;
  };
};

export type AnonymousRouteDeclaration = Readonly<{
  routePath: string;
  methods: readonly string[];
  match?: "exact" | "prefix";
}>;

function isAnonymousAllowed(routes: readonly AnonymousRouteDeclaration[], method: string, pathname: string) {
  const normalizedMethod = method.toUpperCase();
  return routes.some((route) => {
    if (!route.methods.map((entry) => entry.toUpperCase()).includes(normalizedMethod)) {
      return false;
    }
    return route.match === "prefix" ? pathname.startsWith(route.routePath) : pathname === route.routePath;
  });
}

function isInternalIdentityAuthRoute(pathname: string) {
  return pathname.startsWith("/api/identity/internal/auth/");
}

function isInternalGuestCheckoutCapabilityRoute(pathname: string) {
  return (
    pathname === "/api/auth/guest-checkout/contact" ||
    pathname === "/api/auth/guest-checkout/claim-context" ||
    pathname === "/api/auth/guest-checkout/claim-link/request" ||
    pathname === "/api/auth/guest-checkout/claim-with-magic-link" ||
    pathname === "/api/auth/guest-checkout/claim-with-continuation" ||
    pathname === "/api/auth/guest-checkout/claim-with-passkey"
  );
}

function hasInternalCapability(request: Request, secret: string) {
  return verifyPlatformInternalAuthSecret(request.headers.get(PLATFORM_INTERNAL_AUTH_HEADER), secret);
}

export function createIdentityAuthMiddleware(
  services: PlatformIdentityServices,
  options: Readonly<{
    internalAuthSecret?: string;
    anonymousRoutes?: readonly AnonymousRouteDeclaration[];
    resolveActor: PlatformActorResolver;
  }>,
) {
  const internalAuthSecret = options.internalAuthSecret ?? resolvePlatformInternalAuthSecret();
  const anonymousRoutes = options.anonymousRoutes ?? [];
  return async function identityAuthMiddleware(c: Context<TenantContextEnv>, next: Next): Promise<Response | void> {
    const pathname = new URL(c.req.url).pathname;

    if (isInternalIdentityAuthRoute(pathname) || isInternalGuestCheckoutCapabilityRoute(pathname)) {
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

    const actor = await options.resolveActor(c.req.raw);
    if (actor) {
      c.set("actor", actor);
      c.set("context", attachActiveTraceContext(createActorEventStoreContext(actor)));
      await next();
      return;
    }

    if (isAnonymousAllowed(anonymousRoutes, c.req.method, pathname)) {
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

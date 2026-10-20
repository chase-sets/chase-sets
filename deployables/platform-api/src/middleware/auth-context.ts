import type { Context, Next } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  AUTH_GUEST_CHECKOUT_COOKIE_NAME,
  AUTH_SESSION_COOKIE_NAME,
  createAuthBootstrapContext,
} from "@chase-sets/auth-context";
import { createActorEventStoreContext, type ResolvedActor } from "@chase-sets/platform-runtime/auth";
import {
  PLATFORM_INTERNAL_AUTH_HEADER,
  resolvePlatformInternalAuthSecret,
  resolvePublicRequestOrigin,
  sharesRegistrableDomain,
} from "@chase-sets/platform-runtime/http";
import { verifyPlatformInternalAuthSecret } from "@chase-sets/platform-runtime/internal-auth";
import type { PlatformIdentityServices } from "../app";
import { authenticationRequiredResponse, forbiddenResponse } from "@chase-sets/http/responses";
import {
  attachActiveTraceContext,
  recordHttpCrossSiteRejection,
  type HttpCrossSiteRejectionSignal,
} from "@chase-sets/observability";

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

const NON_MUTATING_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function carriesAuthCookie(request: Request) {
  return (request.headers.get("cookie") ?? "").split(";").some((part) => {
    const name = part.trim().split("=", 1)[0];
    return name === AUTH_SESSION_COOKIE_NAME || name === AUTH_GUEST_CHECKOUT_COOKIE_NAME;
  });
}

/**
 * The browser attaches the auth cookies to requests other sites start, so a cookie-authenticated
 * mutation must come from the same site: `Sec-Fetch-Site` decides when the browser sends it, otherwise
 * an `Origin` must share the public origin's registrable domain. Requests carrying neither auth cookie
 * authenticate with a credential the browser does not attach on its own and are not checked.
 */
function crossSiteRejectionRule(request: Request): HttpCrossSiteRejectionSignal["rule"] | null {
  if (NON_MUTATING_METHODS.has(request.method.toUpperCase()) || !carriesAuthCookie(request)) {
    return null;
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null) {
    return fetchSite === "cross-site" ? "fetch-metadata" : null;
  }

  const origin = request.headers.get("origin");
  return origin === null || sharesRegistrableDomain(origin, resolvePublicRequestOrigin(request)) ? null : "origin";
}

function rejectCrossSiteCookieMutation(c: Context<TenantContextEnv>) {
  const rule = crossSiteRejectionRule(c.req.raw);
  if (rule === null) {
    return null;
  }

  recordHttpCrossSiteRejection({ rule });
  return c.json(forbiddenResponse(), 403);
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
    const internalCapabilityRoute =
      isInternalIdentityAuthRoute(pathname) || isInternalGuestCheckoutCapabilityRoute(pathname);

    if (internalCapabilityRoute) {
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

    // A capability-gated route is a server-to-server call, so the browser-provenance rule does not apply.
    const crossSiteRejection = internalCapabilityRoute ? null : rejectCrossSiteCookieMutation(c);
    if (crossSiteRejection) {
      return crossSiteRejection;
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

/**
 * Declared anonymous routes are matched before the actor is resolved, so an exempt request performs
 * no actor resolution at all. Every request that does not match an exact declaration keeps the
 * resolver-first behaviour and its existing downstream semantics.
 */
export function createPlatformActorMiddleware(
  resolveActor: PlatformActorResolver,
  options: Readonly<{ anonymousRoutes?: readonly AnonymousRouteDeclaration[] }> = {},
) {
  const anonymousRoutes = options.anonymousRoutes ?? [];
  return async function platformActorMiddleware(c: Context<TenantContextEnv>, next: Next): Promise<Response | void> {
    if (isAnonymousAllowed(anonymousRoutes, c.req.method, new URL(c.req.url).pathname)) {
      c.set("actor", null);
      c.set("context", null);

      await next();
      return;
    }

    const crossSiteRejection = rejectCrossSiteCookieMutation(c);
    if (crossSiteRejection) {
      return crossSiteRejection;
    }

    const actor = await resolveActor(c.req.raw);

    c.set("actor", actor);
    c.set("context", actor ? attachActiveTraceContext(createActorEventStoreContext(actor)) : null);

    await next();
  };
}

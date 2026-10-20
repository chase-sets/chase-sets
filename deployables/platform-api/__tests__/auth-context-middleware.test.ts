import { createAccountUserTestActor } from "@chase-sets/bounded-context-runtime/test-support";
import { forbiddenResponse } from "@chase-sets/http/responses";
import { httpCrossSiteRejectionMetricRecord, type HttpCrossSiteRejectionSignal } from "@chase-sets/observability";
import {
  CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV,
  PLATFORM_INTERNAL_AUTH_HEADER,
} from "@chase-sets/platform-runtime/http";
import { Hono, type Context } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformIdentityServices } from "../src/app";
import {
  createIdentityAuthMiddleware,
  createPlatformActorMiddleware,
  type AnonymousRouteDeclaration,
  type PlatformActorResolver,
  type TenantContextEnv,
} from "../src/middleware/auth-context";

const recordHttpCrossSiteRejection = vi.hoisted(() => vi.fn<(event: HttpCrossSiteRejectionSignal) => void>());

vi.mock("@chase-sets/observability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/observability")>()),
  recordHttpCrossSiteRejection,
}));

const guestCapabilityPaths = [
  "/api/auth/guest-checkout/contact",
  "/api/auth/guest-checkout/claim-context",
  "/api/auth/guest-checkout/claim-link/request",
  "/api/auth/guest-checkout/claim-with-magic-link",
  "/api/auth/guest-checkout/claim-with-continuation",
  "/api/auth/guest-checkout/claim-with-passkey",
] as const;

function buildApp(resolveActor: PlatformActorResolver) {
  const app = new Hono<TenantContextEnv>();
  app.use(
    "*",
    createIdentityAuthMiddleware({} as PlatformIdentityServices, {
      internalAuthSecret: "server-secret",
      resolveActor,
    }),
  );
  for (const path of guestCapabilityPaths) {
    app.post(path, (context) => context.json({ accountId: context.var.actor?.accountId }));
  }
  return app;
}

describe("platform Auth capability middleware", () => {
  it("gates contact and all five guest claim capabilities", async () => {
    const guestActor = createAccountUserTestActor({
      accountId: "acc_guest",
      roleKey: "guest-buyer",
      permissions: ["guest-checkout.manage"],
    });
    const resolveActor = vi.fn(async () => guestActor);
    const app = buildApp(resolveActor);

    for (const path of guestCapabilityPaths) {
      for (const internalHeader of [undefined, "wrong-secret"]) {
        const response = await app.request(path, {
          method: "POST",
          headers: internalHeader ? { [PLATFORM_INTERNAL_AUTH_HEADER]: internalHeader } : undefined,
        });
        expect(response.status, `${path} must reject ${internalHeader ? "wrong" : "missing"} capability`).toBe(401);
      }
    }
    expect(resolveActor).not.toHaveBeenCalled();

    for (const path of guestCapabilityPaths) {
      const response = await app.request(path, {
        method: "POST",
        headers: { [PLATFORM_INTERNAL_AUTH_HEADER]: "server-secret" },
      });
      expect(response.status, `${path} must admit the internal capability plus guest actor`).toBe(200);
      await expect(response.json()).resolves.toEqual({ accountId: "acc_guest" });
    }
    expect(resolveActor).toHaveBeenCalledTimes(guestCapabilityPaths.length);

    const missingGuestTokenResolver = vi.fn(async () => null);
    const missingGuestTokenResponse = await buildApp(missingGuestTokenResolver).request(
      "/api/auth/guest-checkout/contact",
      {
        method: "POST",
        headers: { [PLATFORM_INTERNAL_AUTH_HEADER]: "server-secret" },
      },
    );
    expect(missingGuestTokenResponse.status).toBe(401);
    expect(missingGuestTokenResolver).toHaveBeenCalledTimes(1);
  });
});

const PROVIDER_MODE_ROUTE_PATH = "/api/marketplace/payment-provider-mode";

const platformActorProbePaths = [
  PROVIDER_MODE_ROUTE_PATH,
  `${PROVIDER_MODE_ROUTE_PATH}/extra`,
  "/api/marketplace/account/payments",
  "/api/marketplace",
] as const;

function buildPlatformActorApp(
  resolveActor: PlatformActorResolver,
  anonymousRoutes: readonly AnonymousRouteDeclaration[],
) {
  const app = new Hono<TenantContextEnv>();
  app.use("*", createPlatformActorMiddleware(resolveActor, { anonymousRoutes }));
  for (const path of platformActorProbePaths) {
    const handler = (context: Context<TenantContextEnv>) =>
      context.json({
        actor: context.var.actor?.accountId ?? null,
        eventStoreContext: context.var.context === null ? "null" : "present",
      });
    app.get(path, handler);
    app.post(path, handler);
  }
  return app;
}

describe("platform actor middleware anonymous declarations", () => {
  it("exempts only an exact declared method and path", async () => {
    const resolveActor = vi.fn(async () => null);
    const app = buildPlatformActorApp(resolveActor, [{ routePath: PROVIDER_MODE_ROUTE_PATH, methods: ["GET"] }]);

    const response = await app.request(PROVIDER_MODE_ROUTE_PATH);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ actor: null, eventStoreContext: "null" });
    expect(resolveActor, "the exempt request must perform zero actor resolution").not.toHaveBeenCalled();

    // The discriminating mutant, and the reason composition refuses a prefix declaration outright: a
    // middleware that treats a declaration as a prefix exempts sibling account routes as well.
    const widenedResolveActor = vi.fn(async () => null);
    const widened = buildPlatformActorApp(widenedResolveActor, [
      { routePath: "/api/marketplace", methods: ["GET"], match: "prefix" },
    ]);
    await widened.request("/api/marketplace/account/payments");
    expect(widenedResolveActor, "a prefix declaration would escape into the account routes").not.toHaveBeenCalled();
  });

  it("resolves the actor for every undeclared request", async () => {
    const declaredActor = createAccountUserTestActor({
      accountId: "acc_platform",
      roleKey: "platform-user",
      permissions: ["orders.view"],
    });
    const resolveActor = vi.fn(async () => declaredActor);
    const app = buildPlatformActorApp(resolveActor, [{ routePath: PROVIDER_MODE_ROUTE_PATH, methods: ["GET"] }]);

    // The exact declaration must not widen to another method, to a longer path that merely starts
    // with it, or to a sibling route under the same mount.
    const undeclaredRequests = [
      { path: PROVIDER_MODE_ROUTE_PATH, method: "POST" },
      { path: `${PROVIDER_MODE_ROUTE_PATH}/extra`, method: "GET" },
      { path: "/api/marketplace/account/payments", method: "GET" },
      { path: "/api/marketplace", method: "GET" },
    ] as const;

    for (const [index, undeclared] of undeclaredRequests.entries()) {
      const response = await app.request(undeclared.path, { method: undeclared.method });
      expect(response.status, `${undeclared.method} ${undeclared.path} must reach the resolver`).toBe(200);
      await expect(response.json()).resolves.toEqual({ actor: "acc_platform", eventStoreContext: "present" });
      expect(resolveActor).toHaveBeenCalledTimes(index + 1);
    }
  });

  it("treats an empty declaration list as resolver-first for every request", async () => {
    const resolveActor = vi.fn(async () => null);
    const app = buildPlatformActorApp(resolveActor, []);

    const response = await app.request(PROVIDER_MODE_ROUTE_PATH);

    expect(response.status).toBe(200);
    expect(resolveActor).toHaveBeenCalledTimes(1);
  });
});

const PUBLIC_ORIGIN = "https://marketplace.chasesets.com";
const SESSION_COOKIE = "chase_sets_session=session-token";

const cookieActor = createAccountUserTestActor({
  accountId: "acc_cookie",
  roleKey: "buyer",
  permissions: ["orders.view"],
});

const identityServices = {
  auth: { identity: { bootstrapTenantId: "00000000-0000-4000-8000-000000000001" } },
} as unknown as PlatformIdentityServices;

// One route behind each actor-resolving middleware: the rule must hold in both.
const actorMiddlewares = [
  {
    middleware: "createIdentityAuthMiddleware",
    path: "/api/auth/account/profile",
    create: (resolveActor: PlatformActorResolver) =>
      createIdentityAuthMiddleware(identityServices, { internalAuthSecret: "server-secret", resolveActor }),
  },
  {
    middleware: "createPlatformActorMiddleware",
    path: "/api/marketplace/account/payments",
    create: (resolveActor: PlatformActorResolver) => createPlatformActorMiddleware(resolveActor),
  },
] as const;

function buildGuardedApp(entry: (typeof actorMiddlewares)[number]) {
  const resolveActor = vi.fn(async () => cookieActor);
  const route = vi.fn();
  const app = new Hono<TenantContextEnv>();
  app.use("*", entry.create(resolveActor));
  app.all("*", (context) => {
    route();
    return context.json({ accountId: context.var.actor?.accountId ?? null });
  });
  return { app, resolveActor, route };
}

describe("platform actor middleware cross-site cookie mutations", () => {
  afterEach(() => {
    recordHttpCrossSiteRejection.mockClear();
    vi.unstubAllEnvs();
  });

  it("fetch metadata decides cookie mutations", async () => {
    const fetchSites = [
      ["cross-site", false],
      ["same-origin", true],
      ["same-site", true],
      ["none", true],
    ] as const;

    for (const entry of actorMiddlewares) {
      for (const cookie of [SESSION_COOKIE, "theme=dark; chase_sets_guest_checkout=guest-token"]) {
        for (const [fetchSite, admitted] of fetchSites) {
          const { app, resolveActor, route } = buildGuardedApp(entry);

          const response = await app.request(`${PUBLIC_ORIGIN}${entry.path}`, {
            method: "POST",
            headers: { cookie, "sec-fetch-site": fetchSite },
          });

          const label = `${entry.middleware} with "${cookie}" and Sec-Fetch-Site: ${fetchSite}`;
          expect(response.status, label).toBe(admitted ? 200 : 403);
          expect(route, `${label} must ${admitted ? "" : "never "}reach the route`).toHaveBeenCalledTimes(
            admitted ? 1 : 0,
          );
          expect(resolveActor, `${label} must be decided before actor resolution`).toHaveBeenCalledTimes(
            admitted ? 1 : 0,
          );
        }
      }
    }
  });

  it("Origin fallback compares registrable domains", async () => {
    const rows = [
      { publicOrigin: PUBLIC_ORIGIN, origin: null, admitted: true },
      { publicOrigin: PUBLIC_ORIGIN, origin: "https://admin.chasesets.com", admitted: true },
      { publicOrigin: PUBLIC_ORIGIN, origin: "https://pr-12-marketplace.preview.chasesets.com", admitted: true },
      { publicOrigin: PUBLIC_ORIGIN, origin: "http://admin.chasesets.com:8443", admitted: true },
      { publicOrigin: PUBLIC_ORIGIN, origin: "https://evil.com", admitted: false },
      { publicOrigin: PUBLIC_ORIGIN, origin: "https://chasesets.com.evil.com", admitted: false },
      { publicOrigin: PUBLIC_ORIGIN, origin: "null", admitted: false },
      { publicOrigin: PUBLIC_ORIGIN, origin: "admin.chasesets.com", admitted: false },
      { publicOrigin: "http://localhost:3000", origin: "http://localhost:5173", admitted: true },
      { publicOrigin: "http://localhost:3000", origin: "http://127.0.0.1:5173", admitted: false },
    ] as const;

    for (const entry of actorMiddlewares) {
      for (const { publicOrigin, origin, admitted } of rows) {
        const { app, route } = buildGuardedApp(entry);

        const response = await app.request(`${publicOrigin}${entry.path}`, {
          method: "POST",
          headers: { cookie: SESSION_COOKIE, ...(origin === null ? {} : { origin }) },
        });

        const label = `${entry.middleware} at ${publicOrigin} with Origin: ${origin ?? "(absent)"}`;
        expect(response.status, label).toBe(admitted ? 200 : 403);
        expect(route, label).toHaveBeenCalledTimes(admitted ? 1 : 0);
      }
    }
  });

  it("resolves the public origin through forwarded headers only when they are trusted", async () => {
    // Behind the ingress the request URL names the pod; only trusted forwarded headers name the site.
    const podRequest = {
      method: "POST",
      headers: {
        cookie: SESSION_COOKIE,
        origin: "https://admin.chasesets.com",
        "x-forwarded-host": "marketplace.chasesets.com",
        "x-forwarded-proto": "https",
      },
    };

    for (const entry of actorMiddlewares) {
      for (const [trust, admitted] of [
        ["true", true],
        ["false", false],
      ] as const) {
        vi.stubEnv(CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV, trust);
        const { app } = buildGuardedApp(entry);

        const response = await app.request(`http://10.0.0.12:8787${entry.path}`, podRequest);

        expect(response.status, `${entry.middleware} with forwarded-header trust ${trust}`).toBe(admitted ? 200 : 403);
      }
    }
  });

  it("checks every cookie-authenticated method except GET, HEAD and OPTIONS", async () => {
    const methods = [
      ["GET", true],
      ["HEAD", true],
      ["OPTIONS", true],
      ["POST", false],
      ["PUT", false],
      ["PATCH", false],
      ["DELETE", false],
    ] as const;

    for (const entry of actorMiddlewares) {
      for (const [method, admitted] of methods) {
        const { app } = buildGuardedApp(entry);

        const response = await app.request(`${PUBLIC_ORIGIN}${entry.path}`, {
          method,
          headers: { cookie: SESSION_COOKIE, "sec-fetch-site": "cross-site" },
        });

        expect(response.status, `${entry.middleware} ${method}`).toBe(admitted ? 200 : 403);
      }
    }
  });

  it("ignores fetch metadata for non-cookie credentials", async () => {
    const crossSite = { "sec-fetch-site": "cross-site", origin: "https://evil.com" };

    for (const entry of actorMiddlewares) {
      const { app, route } = buildGuardedApp(entry);
      const send = (headers: Record<string, string>) =>
        app.request(`${PUBLIC_ORIGIN}${entry.path}`, { method: "POST", headers: { ...crossSite, ...headers } });

      const apiKey = await send({ authorization: "Bearer cs_api_key_synthetic" });
      expect(apiKey.status, `${entry.middleware} must admit a cross-site API-key request`).toBe(200);
      expect(route).toHaveBeenCalledTimes(1);

      // A session cookie beside the same bearer token makes the request cookie-authenticated.
      const apiKeyWithCookie = await send({ authorization: "Bearer cs_api_key_synthetic", cookie: SESSION_COOKIE });
      expect(apiKeyWithCookie.status, `${entry.middleware} must check a bearer request carrying a cookie`).toBe(403);
      expect(route).toHaveBeenCalledTimes(1);
    }

    // Internal-capability routes keep their server-to-server behaviour, with or without a cookie.
    const [identityEntry] = actorMiddlewares;
    for (const path of ["/api/auth/guest-checkout/contact", "/api/identity/internal/auth/sessions"]) {
      for (const cookie of [null, "chase_sets_guest_checkout=guest-token"]) {
        const { app, route } = buildGuardedApp(identityEntry);

        const response = await app.request(`${PUBLIC_ORIGIN}${path}`, {
          method: "POST",
          headers: {
            ...crossSite,
            [PLATFORM_INTERNAL_AUTH_HEADER]: "server-secret",
            ...(cookie === null ? {} : { cookie }),
          },
        });

        expect(response.status, `${path} with cookie ${cookie ?? "(absent)"}`).toBe(200);
        expect(route).toHaveBeenCalledTimes(1);
      }
    }
  });

  it("leaves declared anonymous routes that skip actor resolution unchecked", async () => {
    const resolveActor = vi.fn(async () => cookieActor);
    const app = buildPlatformActorApp(resolveActor, [{ routePath: PROVIDER_MODE_ROUTE_PATH, methods: ["POST"] }]);
    const crossSiteCookie = { method: "POST", headers: { cookie: SESSION_COOKIE, "sec-fetch-site": "cross-site" } };

    const declared = await app.request(PROVIDER_MODE_ROUTE_PATH, crossSiteCookie);
    expect(declared.status).toBe(200);
    expect(resolveActor).not.toHaveBeenCalled();

    const undeclared = await app.request("/api/marketplace/account/payments", crossSiteCookie);
    expect(undeclared.status).toBe(403);
  });

  it("counts chase_sets_http_cross_site_rejections_total once per rejection under its rule", async () => {
    const rules = [
      {
        rule: "fetch-metadata",
        rejected: { "sec-fetch-site": "cross-site" },
        control: { "sec-fetch-site": "same-site" },
      },
      { rule: "origin", rejected: { origin: "https://evil.com" }, control: { origin: "https://admin.chasesets.com" } },
    ] as const;

    for (const entry of actorMiddlewares) {
      for (const { rule, rejected, control } of rules) {
        const { app } = buildGuardedApp(entry);
        const send = (headers: Record<string, string>) =>
          app.request(`${PUBLIC_ORIGIN}${entry.path}`, {
            method: "POST",
            headers: { cookie: SESSION_COOKIE, "content-type": "application/json", ...headers },
            body: JSON.stringify({ displayName: "request-body-marker" }),
          });
        recordHttpCrossSiteRejection.mockClear();

        const response = await send(rejected);
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual(forbiddenResponse());
        expect(recordHttpCrossSiteRejection.mock.calls, `${entry.middleware} ${rule}`).toEqual([[{ rule }]]);
        const [[signal]] = recordHttpCrossSiteRejection.mock.calls as [[HttpCrossSiteRejectionSignal]];
        expect(httpCrossSiteRejectionMetricRecord(signal)).toEqual({
          name: "chase_sets_http_cross_site_rejections_total",
          attributes: { rule },
        });

        expect((await send(control)).status).toBe(200);
        expect(recordHttpCrossSiteRejection, "an admitted request must not count").toHaveBeenCalledTimes(1);
      }
    }
  });
});

import { createAccountUserTestActor } from "@chase-sets/bounded-context-runtime/test-support";
import { PLATFORM_INTERNAL_AUTH_HEADER } from "@chase-sets/platform-runtime/http";
import { Hono, type Context } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PlatformIdentityServices } from "../src/app";
import {
  createIdentityAuthMiddleware,
  createPlatformActorMiddleware,
  type AnonymousRouteDeclaration,
  type PlatformActorResolver,
  type TenantContextEnv,
} from "../src/middleware/auth-context";

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

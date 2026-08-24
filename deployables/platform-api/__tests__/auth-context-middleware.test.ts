import { createAccountUserTestActor } from "@chase-sets/bounded-context-runtime/test-support";
import { PLATFORM_INTERNAL_AUTH_HEADER } from "@chase-sets/platform-runtime/http";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PlatformIdentityServices } from "../src/app";
import {
  createIdentityAuthMiddleware,
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

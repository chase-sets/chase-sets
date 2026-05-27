import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { ApiHostRuntime } from "@chase-sets/platform-runtime/api";
import { buildAdminSupportApiApp } from "../src/app";

function createEmptyRuntime(): ApiHostRuntime {
  return {
    mountedContexts: [],
    mountedModules: [],
    services: {},
    projectionGroups: [],
    subscriptionRunners: [],
  };
}

function createAuthRuntime(): ApiHostRuntime {
  const authRouter = new Hono();
  authRouter.get("/social/providers", (c) => c.json({ providers: [] }));
  authRouter.get("/private", (c) => c.json({ ok: true }));
  const authServices = {
    identity: {
      bootstrapTenantId: "tnt_identity_bootstrap",
    },
  };
  const authModule = {
    contextName: "auth",
    apiMounts: [
      {
        mountPath: "/api/auth",
        kind: "primary",
        requiresAuth: false,
      },
    ],
    buildApis: () => [authRouter],
  };

  return {
    mountedContexts: [
      {
        contextName: "auth",
        mountRole: "active",
        module: authModule,
        services: authServices,
        pool: {},
        projectionHandlerSets: [],
      },
    ],
    mountedModules: [{ module: authModule, services: authServices }],
    services: {
      auth: authServices,
      identity: {},
    },
    projectionGroups: [],
    subscriptionRunners: [],
  } as unknown as ApiHostRuntime;
}

describe("admin-support API app", () => {
  it("serves readiness under the same-origin API prefix", async () => {
    const app = buildAdminSupportApiApp(createEmptyRuntime(), {
      readinessChecks: [
        {
          name: "test",
          check: async () => undefined,
        },
      ],
    });

    const response = await app.request("/api/health/ready");

    expect(response.status).toBe(200);
  });

  it("blocks admin self-registration unless explicitly enabled", async () => {
    const app = buildAdminSupportApiApp(createEmptyRuntime(), {
      adminRegistrationEnabled: false,
    });

    const response = await app.request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "registration_disabled" },
    });
  });

  it("allows anonymous social login discovery through the production admin API", async () => {
    const app = buildAdminSupportApiApp(createAuthRuntime());

    const response = await app.request("/api/auth/social/providers");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ providers: [] });
  });

  it("still requires authentication for other Auth API reads", async () => {
    const app = buildAdminSupportApiApp(createAuthRuntime());

    const response = await app.request("/api/auth/private");

    expect(response.status).toBe(401);
  });

  it("requires platform operations permission for projection operations", async () => {
    const app = buildAdminSupportApiApp(createEmptyRuntime(), {
      resolveActor: async () => ({
        sessionId: "ses_test",
        tenantId: "tnt_test",
        userId: "usr_test",
        accountId: "acc_test",
        membershipId: "mem_test",
        roleKey: "catalog-admin",
        permissions: ["catalog.view"],
      }),
    });

    const response = await app.request("/api/platform/projections");

    expect(response.status).toBe(403);
  });

  it("returns projection operations status for platform operators", async () => {
    const app = buildAdminSupportApiApp(createEmptyRuntime(), {
      resolveActor: async () => ({
        sessionId: "ses_test",
        tenantId: "tnt_test",
        userId: "usr_test",
        accountId: "acc_test",
        membershipId: "mem_test",
        roleKey: "platform-admin",
        permissions: ["security.manage"],
      }),
    });

    const response = await app.request("/api/platform/projections");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      summary: {
        status: "ok",
        totalGroups: 0,
      },
      projectionGroups: [],
      blockedProjections: [],
      projectionStatusSource: "runtime-memory",
      workers: [],
      runners: [],
    });
  });
});
